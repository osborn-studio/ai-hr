import {one,bad,deny,currentOperator,text} from './platform-core.mjs';

// This is a transaction-completion receipt, not a business approval, payment,
// filing or external-delivery receipt. It contains no old command material.
export async function commandStatus(t,{userId,input}) {
  if (!input||typeof input!=='object'||Object.keys(input).some(k=>!['operation','operation_id'].includes(k))) bad('原操作核查参数无效');
  const operation=text(input.operation,'原操作类型',1,160),key=text(input.operation_id,'原操作号',8,160);
  if(!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(operation))bad('原操作类型无效');
  const operator=await currentOperator(t,userId);if(!operator||operator.status!=='active')deny('当前账号不可核查原操作');
  let receipt;
  if((await one(t,"SELECT to_regclass('public.ty_domain_command_completion')IS NOT NULL ok")).ok) receipt=await one(t,'SELECT completed_at FROM ty_domain_command_completion WHERE actor_id=$1 AND operation=$2 AND operation_key=$3',[userId,operation,key]);
  if(!receipt&&(await one(t,"SELECT to_regclass('public.ty_platform_command')IS NOT NULL ok")).ok) receipt=await one(t,'SELECT created_at completed_at FROM ty_platform_command WHERE actor_id=$1 AND operation=$2 AND operation_key=$3',[userId,operation.replace(/^system\./,''),key]);
  return {operation,operation_id:key,status:receipt?'completed':'unknown',...(receipt?{completed_at:receipt.completed_at}:{}),business_effect_verified:false};
}
