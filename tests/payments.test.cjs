// Verificador de pagos de punta a punta con blockchain y Firestore simulados.
// npm ci; npm test. All blockchain and database access is simulated.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Timestamp}=require('firebase-admin/firestore');
const {run}=require('../verificar-pagos.cjs');
const L=require('../lib.cjs');
const base={"network":"Ethereum (ERC20)","networkId":"ethereum","chainId":1,"rpcUrl":"https://ethereum-rpc.publicnode.com","explorerTx":"https://etherscan.io/tx/","wallet":"0x0000000000000000000000000000000000000000","confirmations":12,"firstRunLookback":300,"orderMinutes":60,"payableMinutes":180,"daysPerPayment":30,"tokens":{"USDT":{"address":"0xdAC17F958D2ee523a2206206994597C13D831ec7","decimals":6},"USDC":{"address":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","decimals":6}},"plans":{"base-nl500":{"price":35,"label":"Suscripción regular · Hasta NL500","grant":{"plan":"regular_nl500","rooms":["coinpoker","chico","ipoker","wpt","p888"]}},"base-max":{"price":55,"label":"Suscripción regular · Hasta NL1K","grant":{"plan":"regular_nl1k","rooms":["coinpoker","chico","ipoker","wpt","p888"]}},"qq-nl500":{"price":50,"label":"QQPoker incluido · Hasta NL500","grant":{"plan":"qq_nl500","rooms":["qqpk","coinpoker","chico","ipoker","wpt","p888"]}},"ultra-max":{"price":125,"label":"High Stakes · NL MAX","grant":{"plan":"high_stakes","rooms":["qqpk","coinpoker","chico","ipoker","wpt","p888"]}},"test-0":{"price":0,"test":true,"days":1,"label":"Pago de prueba (solo admin)","grant":{"plan":"high_stakes","rooms":["qqpk","coinpoker","chico","ipoker","wpt","p888"]}}},"planRank":{"trial":0,"nl200":1,"regular_nl500":1,"regular_nl1k":2,"qq_nl500":2,"high_stakes":3,"unlimited":3}};
const WALLET='0x1111111111111111111111111111111111111111';
const cfg={...base,wallet:WALLET};
const DAY=86400000,NOW=Date.UTC(2026,9,13,15);

function fakeDb(init={}){
 const store=new Map(Object.entries(init));
 const snap=p=>({exists:store.has(p),data:()=>store.get(p)});
 const write=(p,v,o)=>store.set(p,o&&o.merge?{...(store.get(p)||{}),...v}:{...v});
 const update=(p,v)=>{if(!store.has(p))throw Error('update de doc inexistente '+p);store.set(p,{...store.get(p),...v});};
 // Consultas simples (coleccion + where con >=, como usa el verificador).
 const num=v=>v&&typeof v.toMillis==='function'?v.toMillis():v;
 const query=(col,filters=[])=>({col,filters,where:(f,op,v)=>query(col,[...filters,[f,op,v]])});
 const runQuery=q=>({docs:[...store.keys()].filter(k=>k.startsWith(q.col+'/')&&!k.slice(q.col.length+1).includes('/'))
  .filter(k=>q.filters.every(([f,op,v])=>{if(op!=='>=')throw Error('op no soportado '+op);const x=num(store.get(k)[f]);return x!=null&&x>=num(v);}))
  .map(k=>({id:k.split('/')[1],ref:{path:k},data:()=>store.get(k)}))});
 return {store,
  doc:p=>({path:p,get:async()=>snap(p),set:async(v,o)=>write(p,v,o)}),
  collection:c=>query(c),
  runTransaction:async fn=>{const ops=[];let wrote=false;
   const tx={get:async r=>{if(wrote)throw Error('lectura despues de escritura en la transaccion');return r.col?runQuery(r):snap(r.path);},
    set:(r,v,o)=>{wrote=true;ops.push(()=>write(r.path,v,o));},update:(r,v)=>{wrote=true;ops.push(()=>update(r.path,v));}};
   const out=await fn(tx);ops.forEach(f=>f());return out;}};
}
// Cadena simulada: transfers = [{block, micro, token, tx}]
function fakeChain({head=10000,transfers=[],blockTime=b=>NOW-(10000-b)*2000,failOver=Infinity}={}){
 const calls=[];
 const rpc=async(method,params)=>{
  calls.push(method);
  if(method==='eth_blockNumber')return '0x'+(head+cfg.confirmations).toString(16);
  if(method==='eth_getBlockByNumber')return {timestamp:'0x'+Math.floor(blockTime(parseInt(params[0],16))/1000).toString(16)};
  if(method==='eth_getLogs'){
   const {fromBlock,toBlock,address,topics}=params[0],from=parseInt(fromBlock,16),to=parseInt(toBlock,16);
   if(to-from+1>failOver)throw Error('range too large');
   assert.equal(topics[2],L.padTopic(WALLET));
   return transfers.filter(t=>t.block>=from&&t.block<=to).map(t=>({address:cfg.tokens[t.token||'USDT'].address,removed:false,
    topics:[L.TRANSFER_TOPIC,'0x'+'0'.repeat(24)+'2'.repeat(40),t.to?L.padTopic(t.to):topics[2]],data:'0x'+BigInt(t.micro).toString(16).padStart(64,'0'),
    transactionHash:t.tx||'0xt'+t.block,logIndex:'0x'+(t.logIndex??0).toString(16),blockNumber:'0x'+t.block.toString(16)}))
    .filter(l=>address.map(a=>a.toLowerCase()).includes(l.address.toLowerCase()));
  }
  throw Error('rpc inesperado '+method);
 };
 return {rpc,calls};
}
const ts=ms=>Timestamp.fromMillis(ms);
const silent=()=>{};
function pedido(uid,planId,tag,createdMs){
 const price=cfg.plans[planId].price,micro=L.amountMicro(price,tag);
 return {[`amountLocks/${micro}`]:{uid,planId,priceUsd:price,amountMicro:micro,createdAt:ts(createdMs),status:'open'},
  [`checkouts/${uid}`]:{planId,priceUsd:price,amountMicro:micro,createdAt:ts(createdMs),status:'pending'},micro};
}

test('pago correcto activa la suscripcion, marca pedido y lock, y no acredita dos veces',async()=>{
 const p=pedido('alice','qq-nl500',417,NOW-20*60000);delete p.micro;
 const db=fakeDb({...p,'subscriptions/alice':{email:'a@x',active:false,plan:'trial',rooms:['qqpk'],expiresAt:null,disabled:false},['pagosState/'+cfg.networkId]:{lastBlock:9000}});
 const chain=fakeChain({transfers:[{block:9990,micro:50041700,token:'USDC',tx:'0xAAA'}]});
 const r=await run({db,rpc:chain.rpc,cfg,emailOf:async()=>'x',log:silent,now:()=>NOW});
 assert.deepEqual([r.credited,r.unmatched],[1,0]);
 const sub=db.store.get('subscriptions/alice');
 assert.deepEqual([sub.active,sub.plan,sub.rooms,sub.planId,sub.email,sub.disabled],[true,'qq_nl500',cfg.plans['qq-nl500'].grant.rooms,'qq-nl500','a@x',false]);
 assert.equal(sub.expiresAt.toMillis(),NOW+30*DAY);
 assert.equal(db.store.get('amountLocks/50041700').status,'paid');
 const c=db.store.get('checkouts/alice');assert.equal(c.status,'paid');assert.equal(c.txHash,'0xaaa');assert.equal(c.paidUntil.toMillis(),NOW+30*DAY);
 const pay=db.store.get('payments/0xaaa-0');assert.deepEqual([pay.status,pay.uid,pay.amount,pay.token],['credited','alice','50.0417','USDC']);
 assert.equal(db.store.get('pagosState/'+cfg.networkId).lastBlock,10000);
 // Reproceso de los mismos bloques (p. ej. estado perdido): no suma otros 30 dias.
 db.store.set('pagosState/'+cfg.networkId,{lastBlock:9000});
 const again=await run({db,rpc:chain.rpc,cfg,emailOf:async()=>'x',log:silent,now:()=>NOW+DAY});
 assert.equal(again.results[0].status,'repetido');assert.equal(db.store.get('subscriptions/alice').expiresAt.toMillis(),NOW+30*DAY);
});
test('renovacion suma desde el vencimiento vigente y crea la suscripcion si no existe',async()=>{
 const a=pedido('alice','base-nl500',1,NOW-5*60000),b=pedido('bob','ultra-max',2,NOW-5*60000);delete a.micro;delete b.micro;
 const db=fakeDb({...a,...b,'subscriptions/alice':{active:true,plan:'unlimited',rooms:['qqpk'],expiresAt:ts(NOW+10*DAY)},['pagosState/'+cfg.networkId]:{lastBlock:9900}});
 const chain=fakeChain({transfers:[{block:9950,micro:35000100},{block:9951,micro:125000200}]});
 await run({db,rpc:chain.rpc,cfg,emailOf:async uid=>uid+'@mail',log:silent,now:()=>NOW});
 assert.equal(db.store.get('subscriptions/alice').expiresAt.toMillis(),NOW+40*DAY);
 const bob=db.store.get('subscriptions/bob');assert.deepEqual([bob.email,bob.disabled,bob.plan],['bob@mail',false,'high_stakes']);
 assert.equal(db.store.get('subscriptions/alice').plan,'unlimited','no baja un plan mayor vigente');
});
test('montos sin pedido, fuera de ventana, pedido ya pagado u otra wallet quedan para revision',async()=>{
 const viejo=pedido('carol','base-max',5,NOW-4*3600000);delete viejo.micro;
 const pagado=pedido('dan','base-nl500',9,NOW-10*60000);delete pagado.micro;pagado['amountLocks/35000900'].status='paid';
 const db=fakeDb({...viejo,...pagado,['pagosState/'+cfg.networkId]:{lastBlock:9000}});
 const chain=fakeChain({transfers:[
  {block:9990,micro:35000000,tx:'0x1'},              // precio pelado, sin tag
  {block:9991,micro:55000500,tx:'0x2'},              // pedido de hace 4 h
  {block:9992,micro:35000900,tx:'0x3'},              // pedido ya pagado
  {block:9993,micro:35000100,tx:'0x4',to:'0x'+'9'.repeat(40)}]}); // a otra wallet: se ignora
 const r=await run({db,rpc:chain.rpc,cfg,emailOf:async()=>'x',log:silent,now:()=>NOW});
 assert.deepEqual([r.credited,r.unmatched],[0,3]);
 assert.match(db.store.get('payments/0x1-0').reason,/sin pedido/);
 assert.match(db.store.get('payments/0x2-0').reason,/fuera de la ventana/);
 assert.match(db.store.get('payments/0x3-0').reason,/ya pagado/);
 assert.equal(db.store.has('payments/0x4-0'),false);
 assert.equal(db.store.get('amountLocks/55000500').status,'open');
});
test('dry-run no escribe nada',async()=>{
 const p=pedido('alice','base-nl500',3,NOW-60000);delete p.micro;
 const db=fakeDb({...p,['pagosState/'+cfg.networkId]:{lastBlock:9000}});const before=JSON.stringify([...db.store]);
 const r=await run({db,rpc:fakeChain({transfers:[{block:9999,micro:35000300}]}).rpc,cfg,emailOf:async()=>'x',dry:true,log:silent,now:()=>NOW});
 assert.equal(r.credited,1);assert.equal(JSON.stringify([...db.store]),before);
});
test('primera corrida mira ~1 h atras y achica el rango si el nodo lo rechaza',async()=>{
 const db=fakeDb();const chain=fakeChain({failOver:100});
 await run({db,rpc:chain.rpc,cfg,emailOf:async()=>'x',log:silent,now:()=>NOW});
 assert.equal(db.store.get('pagosState/'+cfg.networkId).lastBlock,10000);
 assert.ok(chain.calls.filter(c=>c==='eth_getLogs').length>=5);
});
test('pago de prueba test-0 (centavos) da 1 dia',async()=>{
 const p=pedido('alice','test-0',417,NOW-60000);delete p.micro;
 const db=fakeDb({...p,['pagosState/'+cfg.networkId]:{lastBlock:9000}});
 const r=await run({db,rpc:fakeChain({transfers:[{block:9999,micro:41700}]}).rpc,cfg,emailOf:async()=>'a@x',log:silent,now:()=>NOW});
 assert.equal(r.credited,1);assert.equal(db.store.get('subscriptions/alice').expiresAt.toMillis(),NOW+DAY);
 assert.equal(db.store.get('payments/0xt9999-0').amount,'0.0417');
});
test('monto aproximado (125.5 para el pedido 125.0500): se acredita al unico pedido abierto que cubre',async()=>{
 const p=pedido('payer','ultra-max',500,NOW-30*60000);delete p.micro;
 const otro=pedido('eve','base-nl500',3,NOW-20*60000);delete otro.micro; // otro pedido abierto, de 35: 125.5 se pasa de su monto + tolerancia
 const db=fakeDb({...p,...otro,'subscriptions/payer':{email:'l@x',active:false,plan:'trial',rooms:['qqpk'],expiresAt:null,disabled:false},['pagosState/'+cfg.networkId]:{lastBlock:9000}});
 const r=await run({db,rpc:fakeChain({transfers:[{block:9990,micro:125500000,tx:'0xPAYER',logIndex:206}]}).rpc,cfg,emailOf:async()=>'x',log:silent,now:()=>NOW});
 assert.deepEqual([r.credited,r.unmatched],[1,0]);
 const sub=db.store.get('subscriptions/payer');
 assert.deepEqual([sub.active,sub.plan,sub.planId],[true,'high_stakes','ultra-max']);
 assert.equal(sub.expiresAt.toMillis(),NOW+30*DAY);
 assert.equal(db.store.get('amountLocks/125050000').status,'paid');
 assert.equal(db.store.get('checkouts/payer').status,'paid');
 assert.equal(db.store.get('amountLocks/35000300').status,'open');
 const pay=db.store.get('payments/0xpayer-206');
 assert.deepEqual([pay.status,pay.uid,pay.amount,pay.approx,pay.orderAmount],['credited','payer','125.5000',true,'125.0500']);
 assert.match(r.results[0].line,/monto aproximado; pedido de 125\.0500/);
});
test('el precio sin los decimales tambien se acredita si hay un solo pedido posible',async()=>{
 const p=pedido('bob','qq-nl500',417,NOW-10*60000);delete p.micro;
 const db=fakeDb({...p,['pagosState/'+cfg.networkId]:{lastBlock:9000}});
 const r=await run({db,rpc:fakeChain({transfers:[{block:9990,micro:50000000,tx:'0xB'}]}).rpc,cfg,emailOf:async()=>'b@x',log:silent,now:()=>NOW});
 assert.equal(r.credited,1);
 assert.equal(db.store.get('subscriptions/bob').plan,'qq_nl500');
 assert.equal(db.store.get('checkouts/bob').status,'paid');
});
test('si reabrio el checkout, el pago aproximado va a su ultimo pedido',async()=>{
 const viejo=pedido('ana','ultra-max',11,NOW-90*60000),nuevo=pedido('ana','ultra-max',22,NOW-15*60000);delete viejo.micro;delete nuevo.micro;
 const db=fakeDb({...viejo,...nuevo,['pagosState/'+cfg.networkId]:{lastBlock:9000}}); // checkouts/ana queda con el ultimo, como en la web
 const r=await run({db,rpc:fakeChain({transfers:[{block:9990,micro:126000000,tx:'0xA'}]}).rpc,cfg,emailOf:async()=>'a@x',log:silent,now:()=>NOW});
 assert.equal(r.credited,1);
 assert.equal(db.store.get('amountLocks/125002200').status,'paid');
 assert.equal(db.store.get('amountLocks/125001100').status,'open');
 assert.equal(db.store.get('checkouts/ana').status,'paid');
});
test('montos aproximados con duda quedan para revision: dos usuarios posibles, de menos, muy de mas o plan de prueba',async()=>{
 const a=pedido('u1','ultra-max',100,NOW-30*60000),b=pedido('u2','ultra-max',200,NOW-20*60000),c=pedido('u3','base-max',7,NOW-10*60000),t0=pedido('admin','test-0',50,NOW-5*60000);
 for(const x of [a,b,c,t0])delete x.micro;
 const db=fakeDb({...a,...b,...c,...t0,['pagosState/'+cfg.networkId]:{lastBlock:9000}});
 const chain=fakeChain({transfers:[
  {block:9990,micro:125500000,tx:'0x1'},  // dos pedidos de 125 abiertos: no se sabe de quien es
  {block:9991,micro:54000700,tx:'0x2'},   // menos que el precio (comision de un exchange)
  {block:9992,micro:60000000,tx:'0x3'},   // muy por encima del pedido de 55
  {block:9993,micro:500000,tx:'0x4'}]});  // 0.5 con un pedido de prueba abierto: los de prueba solo con monto exacto
 const r=await run({db,rpc:chain.rpc,cfg,emailOf:async()=>'x',log:silent,now:()=>NOW});
 assert.deepEqual([r.credited,r.unmatched],[0,4]);
 assert.match(db.store.get('payments/0x1-0').reason,/2 pedidos posibles/);
 for(const id of ['0x2-0','0x3-0','0x4-0'])assert.match(db.store.get('payments/'+id).reason,/sin pedido/);
 for(const k of ['amountLocks/125010000','amountLocks/125020000','amountLocks/55000700','amountLocks/5000'])assert.equal(db.store.get(k).status,'open');
});
test('reprocesar vuelve a evaluar los pagos unmatched y no toca los acreditados',async()=>{
 const p=pedido('payer','ultra-max',500,NOW-30*60000);delete p.micro;
 const db=fakeDb({...p,['pagosState/'+cfg.networkId]:{lastBlock:9000}});
 const chain=fakeChain({transfers:[{block:9990,micro:125500000,tx:'0xL'}]});
 const first=await run({db,rpc:chain.rpc,cfg:{...cfg,approxToleranceUsd:0},emailOf:async()=>'x',log:silent,now:()=>NOW}); // como el watcher anterior
 assert.deepEqual([first.credited,first.unmatched],[0,1]);
 const seen=db.store.get('payments/0xl-0').seenAt;
 db.store.set('pagosState/'+cfg.networkId,{lastBlock:9000});
 const again=await run({db,rpc:chain.rpc,cfg,emailOf:async()=>'x',log:silent,now:()=>NOW+DAY});
 assert.deepEqual([again.credited,again.unmatched],[1,0]);
 assert.equal(db.store.get('payments/0xl-0').status,'credited');
 assert.equal(db.store.get('payments/0xl-0').seenAt,seen,'conserva cuando lo vio por primera vez');
 db.store.set('pagosState/'+cfg.networkId,{lastBlock:9000});
 const third=await run({db,rpc:chain.rpc,cfg,emailOf:async()=>'x',log:silent,now:()=>NOW+2*DAY});
 assert.equal(third.results[0].status,'repetido');
 assert.equal(db.store.get('subscriptions/payer').expiresAt.toMillis(),NOW+DAY+30*DAY);
});

test('one dollar over order within five minutes is credited and cannot be applied twice',async()=>{
 const paidAt=Date.UTC(2026,9,21,14,12,59),createdAt=Date.UTC(2026,9,21,14,8,12);
 const p=pedido('payer','ultra-max',331,createdAt);delete p.micro;
 const db=fakeDb({...p,['pagosState/'+cfg.networkId]:{lastBlock:9000}});
 const chain=fakeChain({blockTime:()=>paidAt,transfers:[{block:9990,micro:126033100,token:'USDC',tx:'0xregression'}]});
 const args={db,rpc:chain.rpc,cfg,emailOf:async()=>'payer@example.test',log:silent,now:()=>paidAt};
 const r=await run(args);assert.equal(r.credited,1);assert.equal(r.unmatched,0);
 const pay=db.store.get('payments/0xregression-0');assert.equal(pay.approx,true);assert.equal(pay.orderAmount,'125.0331');assert.equal(pay.amount,'126.0331');
 assert.equal(db.store.get('amountLocks/125033100').status,'paid');assert.equal(db.store.get('checkouts/payer').status,'paid');
 const expiry=db.store.get('subscriptions/payer').expiresAt.toMillis();db.store.set('pagosState/'+cfg.networkId,{lastBlock:9000});
 assert.equal((await run(args)).results[0].status,'repetido');assert.equal(db.store.get('subscriptions/payer').expiresAt.toMillis(),expiry);
});

test('approximate payment respects tolerance and time boundaries',()=>{
 const lock={uid:'payer',planId:'ultra-max',priceUsd:125,amountMicro:125033100,createdAtMs:NOW-180*60000,status:'open'};
 assert.equal(L.approxCandidates([lock],127033100,NOW,cfg).length,1);
 assert.equal(L.approxCandidates([lock],127033101,NOW,cfg).length,0);
 assert.equal(L.approxCandidates([lock],124999999,NOW,cfg).length,0);
 assert.equal(L.approxCandidates([lock],126033100,NOW+1,cfg).length,0);
 assert.equal(L.approxCandidates([lock],126033100,NOW,{...cfg,approxToleranceUsd:0}).length,0);
 assert.equal(L.approxCandidates([{...lock,status:'paid'}],126033100,NOW,cfg).length,0);
});
