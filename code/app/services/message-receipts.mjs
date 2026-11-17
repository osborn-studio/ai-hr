//225 has already authenticated the raw provider envelope. Source classes are
// evaluated independently; a match never becomes an HR approval.
import{receiveWorkflowReceipt}from'./notification-receipts.mjs';
import{receiveBusinessReminderReceipt}from'./business-reminder-receipts.mjs';
export async function receiveMessageReceipt(t,args){const workflow=await receiveWorkflowReceipt(t,args),business=await receiveBusinessReminderReceipt(t,args);return{supported:!!(workflow.supported||business.supported),received:(workflow.received??0)+(business.received??0),native_approval_changed:false};}
