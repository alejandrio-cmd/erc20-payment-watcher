#!/usr/bin/env node
'use strict';
// Verificador de pagos ERC-20 directos a una wallet (sin pasarela).
// Lee las transferencias USDT/USDC que llegaron a la wallet (red de config.json: Ethereum o Polygon), las cruza con los pedidos
// (amountLocks/{monto}) que crea la web y activa/extiende subscriptions/{uid}.
//
// Uso:
//   node pagos/verificar-pagos.cjs            # procesa bloques nuevos y escribe en Firestore
//   node pagos/verificar-pagos.cjs --dry-run  # solo muestra lo que haria (no escribe nada)
//
// Credenciales (una de las dos):
//   FIREBASE_SERVICE_ACCOUNT = JSON completo de la cuenta de servicio (asi lo usa GitHub Actions)
//   GOOGLE_APPLICATION_CREDENTIALS = ruta al .json de la cuenta de servicio
// Opcionales: RPC_URL (otro nodo de la red), PAGOS_WALLET (pisa config.wallet).
//
// Salida: 0 = ok; 1 = error; 2 = ok pero hay pagos nuevos sin pedido (GitHub te avisa por mail
// cuando un workflow falla: asi te enteras de revisar la coleccion payments).
const fs=require('node:fs'),path=require('node:path');
const {Timestamp,FieldValue}=require('firebase-admin/firestore');
const L=require('./lib.cjs');

const CHUNK_START=500,MAX_BLOCKS_PER_RUN=20000; // primera corrida: cfg.firstRunLookback bloques (~1 h)
const hex=n=>'0x'+n.toString(16);
const tsMs=v=>v&&typeof v.toMillis==='function'?v.toMillis():null;

function rpcClient(url){
 let id=0;
 return async function rpc(method,params){
  for(let attempt=1;;attempt++){
   try{
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(20000)});
    const body=await r.json();
    if(body.error)throw Object.assign(Error(method+': '+body.error.message),{rpc:body.error});
    if(!r.ok)throw Error(method+': HTTP '+r.status);
    return body.result;
   }catch(e){if(attempt>=3)throw e;await new Promise(res=>setTimeout(res,1500*attempt));}
  }
 };
}

// db: Firestore (admin). rpc: funcion JSON-RPC. emailOf(uid): email de Auth para suscripciones nuevas.
async function run({db,rpc,cfg,emailOf,dry=false,log=console.log,now=()=>Date.now()}){
 const blockTimes=new Map();
 async function blockTime(n){
  if(!blockTimes.has(n)){const b=await rpc('eth_getBlockByNumber',[hex(n),false]);blockTimes.set(n,parseInt(b.timestamp,16)*1000);}
  return blockTimes.get(n);
 }
 const getLogs=(from,to)=>rpc('eth_getLogs',[{fromBlock:hex(from),toBlock:hex(to),address:Object.values(cfg.tokens).map(t=>t.address),topics:[L.TRANSFER_TOPIC,null,L.padTopic(cfg.wallet)]}]);

 async function processTransfer(t){
  const payRef=db.doc('payments/'+t.id);
  const base={txHash:t.txHash,logIndex:t.logIndex,blockNumber:t.blockNumber,blockTime:Timestamp.fromMillis(t.blockTimeMs),
   token:t.token,from:t.from,amount:t.micro?L.formatMicro(t.micro):t.raw,micro:t.micro,network:cfg.network,explorer:cfg.explorerTx+t.txHash,seenAt:FieldValue.serverTimestamp()};
  return db.runTransaction(async tx=>{
   if((await tx.get(payRef)).exists)return {status:'repetido'};
   const lockRef=t.micro?db.doc('amountLocks/'+t.micro):null;
   const lockSnap=lockRef?await tx.get(lockRef):null;
   const lock=lockSnap&&lockSnap.exists?{...lockSnap.data(),createdAtMs:tsMs(lockSnap.data().createdAt)}:null;
   let reason=t.micro?L.lockAccepts(lock,t.blockTimeMs,cfg.payableMinutes):'monto no reconocido';
   const plan=!reason&&cfg.plans[lock.planId];
   const tag=plan?(t.micro-plan.price*1e6)/L.TAG_STEP:0;
   if(!reason&&(!plan||lock.priceUsd!==plan.price||!Number.isInteger(tag)||tag<1||tag>L.TAG_MAX))reason='el pedido no coincide con un plan vigente';
   if(reason){
    if(!dry)tx.set(payRef,{...base,status:'unmatched',reason});
    return {status:'unmatched',reason};
   }
   const subRef=db.doc('subscriptions/'+lock.uid),checkoutRef=db.doc('checkouts/'+lock.uid);
   const subSnap=await tx.get(subRef),checkoutSnap=await tx.get(checkoutRef);
   const prev=subSnap.exists?{...subSnap.data(),expiresAtMs:tsMs(subSnap.data().expiresAt)}:null;
   const at=now(),expires=L.nextExpiry(prev,at,plan.days||cfg.daysPerPayment),grant=L.mergeGrant(prev,plan.grant,at,cfg.planRank);
   const subUpdate={active:true,plan:grant.plan,rooms:grant.rooms,expiresAt:Timestamp.fromMillis(expires),planId:lock.planId,lastPaymentId:t.id};
   if(!subSnap.exists)Object.assign(subUpdate,{email:await emailOf(lock.uid),disabled:false});
   if(!dry){
    tx.set(subRef,subUpdate,{merge:true});
    tx.update(lockRef,{status:'paid',paymentId:t.id});
    if(checkoutSnap.exists&&checkoutSnap.data().amountMicro===t.micro)
     tx.update(checkoutRef,{status:'paid',paymentId:t.id,txHash:t.txHash,paidAt:FieldValue.serverTimestamp(),paidUntil:Timestamp.fromMillis(expires)});
    tx.set(payRef,{...base,status:'credited',uid:lock.uid,planId:lock.planId,priceUsd:plan.price,expiresAt:Timestamp.fromMillis(expires)});
   }
   return {status:'credited',uid:lock.uid,planId:lock.planId,until:new Date(expires).toISOString()};
  });
 }

 const stateRef=db.doc('pagosState/'+(cfg.networkId||cfg.network.toLowerCase()));
 const head=parseInt(await rpc('eth_blockNumber',[]),16)-cfg.confirmations;
 const state=(await stateRef.get()).data();
 let from=state&&state.lastBlock!=null?state.lastBlock+1:head-(cfg.firstRunLookback||1800);
 const stop=Math.min(head,from+MAX_BLOCKS_PER_RUN-1);
 log(`${cfg.network}: bloques ${from}..${stop} (head confirmado ${head})${dry?' [dry-run]':''}`);
 let chunk=CHUNK_START;const results=[];
 while(from<=stop){
  const to=Math.min(stop,from+chunk-1);
  let logs;
  try{logs=await getLogs(from,to);}
  catch(e){if(chunk>25){chunk=Math.floor(chunk/2);continue;}throw e;}
  for(const entry of logs){
   const t=L.parseTransfer(entry,cfg);if(!t)continue;
   t.blockTimeMs=await blockTime(t.blockNumber);
   const r=await processTransfer(t);
   const line=`${r.status.padEnd(9)} ${t.micro?L.formatMicro(t.micro):t.raw} ${t.token} ${t.txHash}${r.uid?' -> '+r.uid+' '+r.planId+' hasta '+r.until:''}${r.reason?' ('+r.reason+')':''}`;
   log(line);results.push({...r,id:t.id,line});
  }
  if(!dry)await stateRef.set({lastBlock:to,updatedAt:FieldValue.serverTimestamp()},{merge:true});
  from=to+1;
 }
 const credited=results.filter(r=>r.status==='credited').length,unmatched=results.filter(r=>r.status==='unmatched').length;
 log(`Listo: ${credited} acreditados, ${unmatched} sin pedido.`);
 return {credited,unmatched,results};
}

module.exports={run};

if(require.main===module){
 const {initializeApp,cert,applicationDefault}=require('firebase-admin/app');
 const {getFirestore}=require('firebase-admin/firestore');
 const {getAuth}=require('firebase-admin/auth');
 // PAGOS_CONFIG (JSON completo, p. ej. un secret de GitHub) reemplaza a config.json: asi el repo publico no lleva datos reales.
 const cfg=JSON.parse(process.env.PAGOS_CONFIG||fs.readFileSync(path.join(__dirname,'config.json'),'utf8'));
 if(process.env.PAGOS_WALLET)cfg.wallet=process.env.PAGOS_WALLET.trim();
 const problems=L.validateConfig(cfg);
 if(problems.length){console.error('Config invalida:\n - '+problems.join('\n - '));process.exit(1);}
 initializeApp({credential:process.env.FIREBASE_SERVICE_ACCOUNT?cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)):applicationDefault()});
 run({db:getFirestore(),rpc:rpcClient(process.env.RPC_URL||cfg.rpcUrl),cfg,dry:process.argv.includes('--dry-run'),
  emailOf:async uid=>(await getAuth().getUser(uid)).email||''})
 .then(r=>{
  if(process.env.GITHUB_STEP_SUMMARY&&r.results.length)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'### Pagos\n```\n'+r.results.map(x=>x.line).join('\n')+'\n```\n');
  process.exit(r.unmatched?2:0);
 })
 .catch(e=>{console.error(e.stack||e.message);process.exit(1);});
}
