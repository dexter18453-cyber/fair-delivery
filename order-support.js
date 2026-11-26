'use strict';
const {randomUUID}=require('node:crypto');
const categories=Object.freeze(['missing_item','wrong_item','late','cancellation','fee_question','other']);
const decisions=Object.freeze(['reviewed','refund_review','not_upheld']);
function fail(statusCode,message){throw Object.assign(new Error(message),{statusCode});}
function ownOrder(orders,id,userId){const order=orders.find(o=>o.id===id&&o.customerId===userId&&userId);if(!order)fail(404,'Η παραγγελία δεν βρέθηκε.');return order;}
function tickets(order){return Array.isArray(order.supportTickets)?order.supportTickets:[];}
function createTicket(order,category,at){
 if(!categories.includes(category))fail(400,'Επίλεξε έγκυρη κατηγορία.');
 const existing=tickets(order).find(t=>t.category===category&&t.status==='open');
 if(existing)return {ticket:existing,created:false};
 if(tickets(order).length>=12)fail(409,'Έχει συμπληρωθεί το όριο αιτημάτων της παραγγελίας.');
 const ticket={id:randomUUID(),category,status:'open',createdAt:at};
 return {ticket,created:true};
}
function resolveTicket(ticket,decision,at){
 if(!decisions.includes(decision))fail(400,'Μη έγκυρη απόφαση.');
 if(ticket.status!=='open')fail(409,'Το αίτημα έχει ήδη εξεταστεί.');
 return {...ticket,status:'reviewed',decision,reviewedAt:at};
}
function audit(order,status,actor,reason,at){
 const prior=Array.isArray(order.operationalHistory)?order.operationalHistory:[];
 order.operationalHistory=[...prior,{status,actor,reason,at}];
}
function timing(order){
 const h=Array.isArray(order.operationalHistory)?order.operationalHistory:[];
 const ready=h.find(e=>e.status==='ready')?.at;
 const assigned=h.find(e=>e.status==='assigned')?.at;
 const pickup=h.find(e=>e.status==='picked_up')?.at;
 function mins(a,b){const x=Date.parse(a),y=Date.parse(b);return Number.isFinite(x)&&Number.isFinite(y)&&y>=x?Math.round((y-x)/60000*10)/10:null;}
 return {readyToPickupMinutes:mins(ready,pickup),assignmentToPickupMinutes:mins(assigned,pickup)};
}
module.exports={ownOrder,tickets,createTicket,resolveTicket,audit,timing};
