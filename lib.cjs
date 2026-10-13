'use strict';
// Logica pura del cobro cripto (sin red ni Firestore) para poder testearla.
// Montos en "micro" = unidades de 6 decimales (USDT/USDC en Polygon). 35.0417 USDT = 35041700.

const TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TAG_STEP=100;      // 0.0001 USDT
const TAG_MAX=999;       // monto unico entre +0.0001 y +0.0999

function amountMicro(price,tag){
 if(!Number.isInteger(price)||price<0)throw Error('Precio invalido: '+price);
 if(!Number.isInteger(tag)||tag<1||tag>TAG_MAX)throw Error('Tag invalido: '+tag);
 return price*1e6+tag*TAG_STEP;
}
function formatMicro(micro){
 const whole=Math.floor(micro/1e6),frac=String(micro%1e6).padStart(6,'0').slice(0,4);
 return whole+'.'+frac;
}
const lower=a=>String(a||'').toLowerCase();
function padTopic(address){
 const a=lower(address).replace(/^0x/,'');
 if(!/^[0-9a-f]{40}$/.test(a))throw Error('Direccion de wallet invalida: '+address);
 return '0x'+a.padStart(64,'0');
}
// Convierte un log ERC-20 Transfer en un pago. Devuelve null si no es a nuestra wallet o el token no es uno de los aceptados.
function parseTransfer(log,{wallet,tokens}){
 if(!log||lower(log.topics?.[0])!==TRANSFER_TOPIC||log.removed)return null;
 const token=Object.entries(tokens).find(([,t])=>lower(t.address)===lower(log.address));
 if(!token)return null;
 if(lower(log.topics[2])!==padTopic(wallet))return null;
 const raw=BigInt(log.data);
 const [symbol,{decimals}]=token;
 // Normaliza a 6 decimales. Si un token tuviera mas decimales, solo matchea si el sobrante es 0.
 let micro=raw;
 if(decimals>6){const f=10n**BigInt(decimals-6);if(raw%f!==0n)micro=-1n;else micro=raw/f;}
 else if(decimals<6)micro=raw*10n**BigInt(6-decimals);
 return {
  id:lower(log.transactionHash)+'-'+parseInt(log.logIndex,16),
  txHash:lower(log.transactionHash),
  logIndex:parseInt(log.logIndex,16),
  blockNumber:parseInt(log.blockNumber,16),
  token:symbol,
  from:'0x'+lower(log.topics[1]).slice(-40),
  micro:micro>0n&&micro<=BigInt(Number.MAX_SAFE_INTEGER)?Number(micro):null,
  raw:raw.toString()
 };
}
// Un lock acepta el pago si sigue abierto y el bloque cae dentro de su ventana de pago.
function lockAccepts(lock,blockTimeMs,payableMinutes){
 if(!lock)return 'sin pedido con ese monto';
 if(lock.status!=='open')return 'pedido ya pagado ('+lock.status+')';
 const created=lock.createdAtMs;
 if(!(created>0))return 'pedido sin fecha';
 // 2 min de tolerancia por diferencias de reloj entre la red y Firestore.
 if(blockTimeMs<created-120000)return 'pago anterior al pedido';
 if(blockTimeMs>created+payableMinutes*60000)return 'pago fuera de la ventana del pedido';
 return null;
}
// Nueva fecha de vencimiento: suma dias desde hoy, o desde el vencimiento actual si todavia esta vigente.
function nextExpiry(sub,nowMs,days){
 const current=sub&&sub.active===true&&sub.expiresAtMs>nowMs?sub.expiresAtMs:nowMs;
 return current+days*86400000;
}
// Si ya tiene un plan mayor vigente, no lo baja: suma tiempo y conserva el plan mas alto.
// rank (config.planRank): orden de los planes; mismo rango = gana el comprado.
function mergeGrant(sub,grant,nowMs,RANK={}){
 const vigente=sub&&sub.active===true&&sub.expiresAtMs>nowMs;
 if(vigente&&(RANK[sub.plan]||0)>(RANK[grant.plan]||0))return {plan:sub.plan,rooms:sub.rooms||grant.rooms};
 if(vigente&&sub.plan===grant.plan)return {plan:grant.plan,rooms:[...new Set([...(sub.rooms||[]),...grant.rooms])]};
 return {plan:grant.plan,rooms:[...grant.rooms]};
}
function validateConfig(cfg){
 const errors=[];
 if(!/^0x[0-9a-fA-F]{40}$/.test(cfg.wallet||''))errors.push('wallet vacia o invalida en pagos/config.json');
 for(const [id,p] of Object.entries(cfg.plans||{})){
  if(!/^[a-z]+-[a-z0-9]+$/.test(id))errors.push('id de plan invalido: '+id);
  if(!Number.isInteger(p.price)||!(p.price>0||(p.test===true&&p.price===0)))errors.push('precio invalido en '+id);
  if(!p.grant||!/^[a-z0-9_]+$/.test(p.grant.plan||'')||p.grant.plan==='trial'||!Array.isArray(p.grant.rooms)||!p.grant.rooms.length)errors.push('grant invalido en '+id);
 }
 for(const [s,t] of Object.entries(cfg.tokens||{}))if(!/^0x[0-9a-fA-F]{40}$/.test(t.address))errors.push('token invalido: '+s);
 return errors;
}
module.exports={TRANSFER_TOPIC,TAG_STEP,TAG_MAX,amountMicro,formatMicro,padTopic,parseTransfer,lockAccepts,nextExpiry,mergeGrant,validateConfig};
