// Opt-in financial scenes on already confirmed demonstration wages. No wage,
// identity, bank transfer, official submission or historical fact is rewritten.
import{createHash}from'node:crypto';
import{withTx}from'../app/db.mjs';
import{one,q,same}from'../app/services/platform-core.mjs';
import{sameHuman}from'../app/services/human-identity.mjs';
import*as finance from'../app/services/payroll-extensions.mjs';
import*as formats from'../app/services/payroll-finance-formats.mjs';
import*as flow from'../app/services/platform-workflow.mjs';
import{compare}from'../app/payroll-calculations.mjs';
export const VERSION='TY-PAYROLL-FINANCE-202610-V1';
const fail=m=>{throw Error(m);},hash=v=>createHash('sha256').update(v).digest('hex');
async function fingerprint(t,g){const v=[];for(const table of['ty_person','ty_employment','ty_test_account_profile','ty_pay_config','ty_pay_batch','ty_pay_row','ty_pay_preview'])v.push([table,await q(t,table==='ty_pay_preview'?'SELECT x.*FROM ty_pay_preview x JOIN ty_pay_batch b ON b.id=x.batch_id WHERE b.group_id=$1 ORDER BY x.id':'SELECT*FROM '+table+' WHERE group_id=$1 ORDER BY 1',[g])]);return hash(JSON.stringify(v));}
export async function seedPayrollFinanceDemo(db,{confirmSynthetic=false}={}){
 if(confirmSynthetic!==true)fail('须明确确认既有演示帐套');
 return withTx(db,async t=>{
  const g=await one(t,"SELECT*FROM ty_group WHERE code='TY-TEST'FOR UPDATE");if(!g)fail('没有完整演示帐套');
  if(!(await one(t,"SELECT to_regclass('public.ty_pay_finance_subject')IS NOT NULL ok")).ok)fail('须先受控安装227；工具不迁移现库');
  const proof=await one(t,"SELECT after_data FROM ty_audit WHERE action='seed'AND entity_kind='test_workspace'AND entity_id=$1 ORDER BY id DESC LIMIT 1",[g.id]),size=await one(t,'SELECT(SELECT count(*)FROM ty_person WHERE group_id=$1)::int people,(SELECT count(*)FROM ty_test_account_profile WHERE group_id=$1)::int accounts',[g.id]);
  if(!proof?.after_data?.synthetic||!proof.after_data.complete||size.people!==62||size.accounts!==77)fail('仅处理62人77账号的完整演示帐套');
  const prior=await one(t,"SELECT after_data FROM ty_audit WHERE action='seed'AND entity_kind='payroll_finance_demo'AND entity_id=$1 AND after_data->>'version'=$2 ORDER BY id DESC LIMIT 1",[g.id,VERSION]);if(prior?.after_data.complete)return{...prior.after_data,replayed:true};
  const existingFinance=await one(t,"SELECT count(*)::int n FROM ty_pay_finance_subject WHERE group_id=$1 AND kind IN('recipient','order','receipt','filing','filing_event')",[g.id]);if(existingFinance.n)fail('已有本组收款、付款或申报业务，不覆盖；须使用新建演示版本');
  const before=await fingerprint(t,g.id),actors=await q(t,'SELECT a.id,a.login FROM sys_account a JOIN ty_test_account_profile p ON p.account_id=a.id WHERE p.group_id=$1 AND a.status=\'active\'',[g.id]),author=actors.find(a=>a.login==='group_hr_director'),reviewer=actors.find(a=>a.login==='demo');
  if(!author||!reviewer||await sameHuman(t,author.id,reviewer.id))fail('缺少独立集团人事与演示复核身份');
  let seq=0;const run=(fn,input,actor=author,extra={})=>fn(t,{userId:actor.id,input,operationId:VERSION+':'+(++seq),...extra}),scenes=[];
  const graph={nodes:[{id:'start',type:'start',next:'review'},{id:'review',type:'approval',label:'资金独立复核',approver_ids:[reviewer.id],mode:'all',next:'end'},{id:'end',type:'end'}]},wf=(await run(flow.saveDefinition,{group_id:g.id,code:'PAYROLL-FINANCE-REVIEW',name:'工资资金与薪税核对流程',business_type:'payroll_finance',graph},author,{kind:'workflow'})).workflow;
  await run(flow.publishDefinition,{id:wf.id,expected_revision:wf.revision},reviewer,{kind:'workflow'});
  const form=(await run(flow.saveDefinition,{group_id:g.id,code:'PAYROLL-FINANCE-REQUEST',name:'工资资金与薪税业务办理',business_type:'payroll_finance',workflow_id:wf.id,schema:{fields:[{key:'request_id',label:'业务申请编号',type:'number',required:true}]}},author,{kind:'form'})).form;await run(flow.publishDefinition,{id:form.id,expected_revision:form.revision},reviewer,{kind:'form'});
  async function approve(kind,row){const subject=await one(t,'SELECT id,company_id FROM ty_pay_finance_subject WHERE kind=$1 AND source_id=$2',[kind,row.id]);if(!subject)fail('资金业务缺少审批引用');const i=(await run(flow.submitInstance,{form_id:form.id,company_id:subject.company_id,subject_id:subject.id,values:{request_id:String(subject.id)}})).instance,task=await one(t,"SELECT*FROM ty_workflow_task WHERE instance_id=$1 AND approver_id=$2 AND status='pending'",[i.id,reviewer.id]);await run(flow.decideInstance,{task_id:task.id,expected_revision:task.revision,approve:true,reason:'已逐项核对来源、分项、凭据与本次用途'},reviewer);const current=await one(t,'SELECT revision FROM ty_workflow_instance WHERE id=$1',[i.id]);await run(flow.executeInstance,{instance_id:i.id,expected_revision:current.revision});return i;}
  const anchors=await q(t,"SELECT DISTINCT r.employment_id,r.company_id,b.period::text,b.currency,b.pay_subject_key,rc.data->>'actual_employer_key'actual_employer_key,rc.data->>'actual_relationship_key'actual_relationship_key FROM ty_pay_row r JOIN ty_pay_batch b ON b.id=r.batch_id JOIN ty_pay_config rc ON rc.id=r.relationship_config_id WHERE r.group_id=$1 AND b.status='confirmed'AND b.period='2026-10-01'ORDER BY b.currency,r.employment_id",[g.id]),chosen=[],seen=new Set();
  for(const currency of['CNY','HKD'])for(const a of anchors.filter(x=>x.currency===currency)){const key=a.employment_id+':'+a.actual_relationship_key;if(seen.has(key)||chosen.some(x=>same(x.company_id,a.company_id))||chosen.filter(x=>x.currency===currency).length>=4)continue;const s=await finance.getWageFundingSource(t,{userId:author.id,input:{...a,group_id:g.id}});if(s.parent_id||s.source_demo_mode!=='demo'||compare(s.net_wage,'300')<0)continue;seen.add(key);chosen.push(s);}
  if(chosen.length!==8)fail('需八份两地已确认演示工资，不补造工资');
  for(let n=0;n<chosen.length;n++){
   const s=chosen[n],selector={group_id:g.id,employment_id:s.employment_id,actual_employer_key:s.actual_employer_key,actual_relationship_key:s.actual_relationship_key,period:'2026-10',pay_subject_key:s.pay_subject_key,currency:s.currency};
   const recipient=(await run(finance.createRecipient,{...selector,bank:{bank_code:'DEMO-BANK-'+s.currency,account_number:'DEMO-ACCOUNT-'+s.employment_id,holder_name:s.full_name},evidence_ref:'员工收款信息核对单与人事编号一致'})).recipient;
   if(n===7){scenes.push({key:'RECIPIENT-PENDING',route:'payroll/finance',person_id:s.person_id,recipient_id:recipient.id,expected:'收款资料待独立审批，资金期初未知'});continue;}await approve('recipient',recipient);
   if(n===6){scenes.push({key:'OPENING-UNKNOWN',route:'payroll/finance',person_id:s.person_id,recipient_id:recipient.id,expected:'收款资料已核，资金期初待核，不能申请付款'});continue;}
   const bytes=Buffer.from(s.full_name+' 2026年10月全部渠道资金核对单\n历史已付0；待核占款0；依据银行与服务商对账记录逐项核对。\n','utf8'),opening=(await run(finance.createFundingOpening,{...selector,kind:'reviewed_fresh_start',net_wage_paid:'0.00',reimbursement_paid:'0.00',net_wage_held:'0.00',reimbursement_held:'0.00',as_of:'2026-11-17T09:00:00+08:00',evidence_ref:'十月工资全部渠道对账清单，银行及服务商逐项复核',document_hash:hash(bytes)})).opening;
   await run(finance.uploadPayrollDocument,{owner_type:'opening',id:opening.id,evidence_role:'original_basis',file:{filename:s.full_name+'-十月资金核对单.txt',mime:'text/plain',content_base64:bytes.toString('base64')}});
   if(n===5){scenes.push({key:'OPENING-PENDING',route:'payroll/finance',person_id:s.person_id,opening_id:opening.id,expected:'期初原件已上传，等待另一操作人员复核'});continue;}await approve('opening',opening);
   const fresh=await finance.getWageFundingSource(t,{userId:author.id,input:selector}),order=(await run(finance.createPaymentOrder,{...selector,recipient_id:recipient.id,source_hash:fresh.source_hash,amount:'200.00',allocation:{net_wage:'200.00',reimbursement:'0.00'},expected_payment_date:'2026-11-20',reason:'十月工资分批结算，先行申请本笔净工资款'})).order;
   if(n===0){scenes.push({key:'PAYMENT-DRAFT',route:'payroll/finance',person_id:s.person_id,order_id:order.id,expected:'付款申请待审批，未形成已付'});continue;}await approve('order',order);
   if(n===1){scenes.push({key:'PAYMENT-APPROVED',route:'payroll/finance',person_id:s.person_id,order_id:order.id,expected:'审批通过待生成文件，尚未员工到账'});continue;}
   const system=s.currency==='CNY'?'CN_PAYROLL':'HK_PAYROLL',institution='DEMO-BANK-'+s.currency,columns=['reference','currency','amount','holder_name','bank_code','account_number','net_wage_amount','reimbursement_amount'].map((key,i)=>({key,header:['付款参考','币种','本次金额','户名','银行','账户','净工资','报销'][i]})),fmt=(await run(formats.createFinanceFormat,{company_id:s.company_id,system,currency:s.currency,kind:'BANK_PAYMENT',stable_key:'MONTHLY-WAGE-TRANSFER',data:{format:'delimited',separator:'comma',newline:'CRLF',bom:true,columns,specification_title:'门店工资付款目标列核对清单',specification_ref:'资金台账/付款文件列说明/2026-10',specification_sha256:hash('October salary column map '+s.company_id),institution_code:institution}})).format;
   await run(formats.approveFinanceFileConfig,{id:fmt.id,type:'format',review_ref:'已按目标列说明独立核定，不作为银行格式认证'},reviewer);
   const reg=(await run(formats.createFinanceRegistration,{company_id:s.company_id,system,currency:s.currency,kind:'BANK_PAYMENT',subject_key:s.pay_subject_key,institution_code:institution,demo_only:true,employer_identifier:'DEMO-EMPLOYER-'+s.company_id,payer_account:'DEMO-PAYER-'+s.company_id,payer_name:'DEMO-'+s.company_name,evidence_ref:'付款主体及账户核对清单'})).registration;await run(formats.approveFinanceFileConfig,{id:reg.id,type:'registration',review_ref:'付款主体、账户用途和机构信息已交叉核对'},reviewer);
   const output=await run(formats.createConfiguredExport,{owner_type:'order',id:order.id,format_id:fmt.id,registration_id:reg.id,identity_ids:[]});
   if(n===2){scenes.push({key:'PAYMENT-EXTERNAL-UNKNOWN',route:'payroll/finance',person_id:s.person_id,order_id:order.id,artifact_id:output.artifact.id,expected:'保留同一原文件与200元占款，外部结果未知'});continue;}
   const received=n===3?'80.00':'200.00',receiptBytes=Buffer.from(s.full_name+' 十月工资分批核对凭证\n本次员工到账金额 '+received+' '+s.currency+'\n','utf8'),receipt=(await run(finance.recordPaymentReceipt,{order_id:order.id,kind:'settled',amount:received,source_kind:'demo_simulated',issuer:'DEMO-BANK-'+s.currency,external_ref:'DEMO-OCTOBER-'+s.employment_id,line_key:'1',document_hash:hash(receiptBytes),source_locator:'工资资金台账/本笔结果核对原件',observed_on:'2026-11-17'})).receipt;
   await run(finance.uploadPayrollDocument,{owner_type:'receipt',id:receipt.id,evidence_role:'original_basis',file:{filename:s.full_name+'-工资核对凭证.txt',mime:'text/plain',content_base64:receiptBytes.toString('base64')}});await approve('receipt',receipt);
   if(n===4){const eventBytes=Buffer.from(s.full_name+' 十月资金期初补充对账\n补充核对以前净工资已付30.00\n','utf8'),event=(await run(finance.recordFundingOpeningEvent,{opening_id:opening.id,component:'net_wage',kind:'prior_paid_discovered',amount:'30.00',source_kind:'demo_simulated',issuer:'DEMO-CHANNEL-RECONCILIATION',external_ref:'DEMO-OCTOBER-OPENING-'+s.employment_id,line_key:'1',document_hash:hash(eventBytes),evidence_ref:'银行渠道补充对账明细，经员工编号匹配'})).event;await run(finance.uploadPayrollDocument,{owner_type:'opening_event',id:event.id,evidence_role:'original_basis',file:{filename:s.full_name+'-资金补充对账.txt',mime:'text/plain',content_base64:eventBytes.toString('base64')}});await approve('opening_event',event);scenes.push({key:'OPENING-APPENDED',route:'payroll/finance',person_id:s.person_id,event_id:event.id,expected:'补充对账追加30元以前已付，保留原期初与新旧核对依据'});}
   scenes.push({key:n===3?'PAYMENT-PARTIAL':'PAYMENT-SETTLED',route:'payroll/finance',person_id:s.person_id,order_id:order.id,receipt_id:receipt.id,artifact_id:output.artifact.id,expected:n===3?'200元指令已核到账80，120元继续占款':'本笔200元已核到账，不代表当月全部工资已付'});
  }
  // Filing amounts come solely from native confirmed statutory wage lines.
  const companies=['CNY','HKD'].flatMap(ccy=>[...new Map(chosen.filter(s=>s.currency===ccy).map(s=>[String(s.company_id),s])).values()].slice(0,2));let filingCount=0;
  for(const s of companies){if(filingCount>=4)break;const system=s.currency==='CNY'?'CN_PAYROLL':'HK_PAYROLL',kind=s.currency==='CNY'?'CN_IIT':'HK_MPF',filing=(await run(finance.createFiling,{company_id:s.company_id,system,kind,period:'2026-10'})).filing;
   if(!filing.snapshot.rows.length)continue;
   if(filingCount++===0){scenes.push({key:'FILING-REVIEW',route:'payroll/finance',filing_id:filing.id,expected:'已确认工资生成的申报底稿，待独立复核'});continue;}await approve('filing',filing);
   if(filingCount>=3){
    const output=await filingOutput(run,reviewer,s,filing);
    if(filingCount===4){const bytes=Buffer.from('十月供款底稿参考 '+filing.id+'\n已取得受理核对凭证；供款资金结果另核。\n','utf8'),event=(await run(finance.recordFilingEvent,{filing_id:filing.id,kind:'accepted',external_ref:'DEMO-MPF-REFERENCE-'+filing.id,document_hash:hash(bytes),evidence_ref:'供款台账/本月机构结果核对原件'})).event;await run(finance.uploadPayrollDocument,{owner_type:'filing_event',id:event.id,evidence_role:'original_basis',file:{filename:'十月供款结果核对单.txt',mime:'text/plain',content_base64:bytes.toString('base64')}});await approve('filing_event',event);scenes.push({key:'FILING-RECEIPT-REVIEWED',route:'payroll/finance',filing_id:filing.id,event_id:event.id,artifact_id:output.artifact.id,expected:'机构结果凭据已独立核对，供款实缴不自动推定'});}
    else scenes.push({key:'FILING-EXTERNAL-UNKNOWN',route:'payroll/finance',filing_id:filing.id,artifact_id:output.artifact.id,expected:'原文件保存，机构外部结果待核'});
   }else scenes.push({key:'FILING-CHECKED-'+filing.id,route:'payroll/finance',filing_id:filing.id,expected:'已核供款或个税底稿，尚未对外提交'});
  }
  if(await fingerprint(t,g.id)!==before)fail('身份、工资档案或已确认工资变化，全部回滚');
  const result={version:VERSION,synthetic:true,complete:true,scenes,forms_created:1,workflows_created:1,people:62,accounts:77,external_calls:0,real_bank_payments:0,official_submissions:0};await t.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data)VALUES($1,'seed','payroll_finance_demo',$2,$3::jsonb)",[author.id,g.id,JSON.stringify(result)]);return result;
 });
}

async function filingOutput(run,reviewer,source,filing){
 const system=source.currency==='CNY'?'CN_PAYROLL':'HK_PAYROLL',kind=filing.kind,tax=kind==='CN_IIT',institution='DEMO-TAX-CONTRIB-'+source.currency,subjectKey=filing.snapshot.rows[0][tax?'tax_subject_key':'contribution_subject_key'];
 const keys=tax?['period','employer_identifier','employee_identifier','employee_name','tax_amount']:['period','employer_identifier','employee_identifier','employee_name','employee_amount','employer_amount'];
 const columns=keys.map((key,i)=>({key,header:['归属月','机构登记','员工参考','姓名',tax?'代扣税额':'个人供款','雇主供款'][i]}));
 const fmt=(await run(formats.createFinanceFormat,{company_id:source.company_id,system,currency:source.currency,kind,stable_key:'MONTHLY-STATUTORY-LEDGER',data:{format:'delimited',separator:'comma',newline:'CRLF',bom:true,columns,specification_title:'薪税供款目标列核对清单',specification_ref:'薪税台账/机构列说明/2026-10',specification_sha256:hash('Contribution column map '+source.company_id),institution_code:institution}})).format;
 await run(formats.approveFinanceFileConfig,{id:fmt.id,type:'format',review_ref:'已逐项独立核对目标列说明，保存本版机构依据'},reviewer);
 const reg=(await run(formats.createFinanceRegistration,{company_id:source.company_id,system,currency:source.currency,kind,subject_key:subjectKey,institution_code:institution,demo_only:true,employer_identifier:'DEMO-CONTRIB-'+source.company_id,evidence_ref:'本月雇主供款主体登记核对清单'})).registration;
 await run(formats.approveFinanceFileConfig,{id:reg.id,type:'registration',review_ref:'机构登记及供款主体已核对'},reviewer);
 const ids=[],seen=new Set();
 for(const r of filing.snapshot.rows){
  if(seen.has(String(r.employment_id)))continue;seen.add(String(r.employment_id));
  const identity=(await run(formats.createFilingIdentity,{employment_id:r.employment_id,actual_employer_key:r.actual_employer_key,system,currency:source.currency,identity_type:'EMPLOYEE_REFERENCE',demo_only:true,identifier:'DEMO-STAFF-'+r.employment_id,evidence_ref:'已按机构允许的员工参考号逐人匹配人事编码'})).identity;
  await run(formats.approveFinanceFileConfig,{id:identity.id,type:'identity',review_ref:'人员关系、所属雇主和参考号已独立核定'},reviewer);ids.push(identity.id);
 }
 return run(formats.createConfiguredExport,{owner_type:'filing',id:filing.id,format_id:fmt.id,registration_id:reg.id,identity_ids:ids});
}
