'use strict';
const crypto=require('crypto');
const FEE_CENTS=100;
function athensDay(value=new Date()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  const obj=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return obj.year+'-'+obj.month+'-'+obj.day;
}
function eligible(order,storeId){return order.status==='delivered'&&order.billingModel==='shop-fixed-v1'&&order.shopFeeCents===FEE_CENTS&&typeof order.completedAt==='string'&&Number.isFinite(Date.parse(order.completedAt))&&(order.storeId||'default')===storeId;}
function settlementSummary(orders,settlements,storeId='default',today=athensDay()){
  const rows=new Map();
  const history=settlements.filter(x=>x.storeId===storeId);
  const settled=new Set(history.flatMap(x=>x.orderIds));
  for(const order of orders){
    if(!eligible(order,storeId))continue;
    const day=athensDay(order.completedAt);
    if(!rows.has(day))rows.set(day,{day,completed:0,feeCents:0,settledCents:0,outstandingCents:0});
    const row=rows.get(day);row.completed++;row.feeCents+=FEE_CENTS;
    if(settled.has(order.id))row.settledCents+=FEE_CENTS;else row.outstandingCents+=FEE_CENTS;
  }
  const days=[...rows.values()].sort((a,b)=>b.day.localeCompare(a.day));
  return {pilot:true,feePerOrderCents:FEE_CENTS,today,days,outstandingCents:days.reduce((sum,row)=>sum+row.outstandingCents,0),history:history.slice().sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt))};
}
function recordSettlement(orders,settlements,storeId,day,expectedCents,now=new Date()){
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||day>athensDay(now))throw Object.assign(new Error('Μη έγκυρη ημέρα εκκαθάρισης.'),{statusCode:400});
  const paid=new Set(settlements.filter(s=>s.storeId===storeId).flatMap(s=>s.orderIds));
  const pending=orders.filter(o=>eligible(o,storeId)&&athensDay(o.completedAt)===day&&!paid.has(o.id));
  const amountCents=pending.length*FEE_CENTS;
  if(!amountCents||expectedCents!==amountCents)throw Object.assign(new Error('Η οφειλή άλλαξε ή δεν υπάρχει. Ανανέωσε πριν την εκκαθάριση.'),{statusCode:409});
  return {id:crypto.randomUUID(),storeId,day,amountCents,orderIds:pending.map(o=>o.id),recordedAt:now.toISOString(),mode:'pilot_manual'};
}
module.exports={FEE_CENTS,athensDay,settlementSummary,recordSettlement};
