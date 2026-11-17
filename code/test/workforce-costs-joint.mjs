import assert from'node:assert/strict';
import{bossCosts}from'../app/services/payroll-source.mjs';
import{amount,plus}from'../app/payroll-calculations.mjs';
export async function enableCostReader({db}){await db.query("INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)VALUES(9801,'payroll_cost',true,false)ON CONFLICT(role_id,resource_code)DO UPDATE SET can_read=true");}
export async function checkPendingSupplierCost({db,check,g,legacyCorrection}){
 await enableCostReader({db});
 const report=await bossCosts(db,{userId:9805,input:{group_id:g.id,period:'2026-10',page_size:100}}),id=(await db.query('SELECT root_id FROM ty_wf_bill_version WHERE id=$1',[legacyCorrection.id])).rows[0].root_id;
 await check('COST01 unknown historical supplier cost remains pending rather than zero',async()=>{const row=report.rows.find(r=>r.id==='workforce-opening:'+id);assert.ok(row);assert.equal(row.amount,null);assert.equal(row.requires_cost_review,true);assert.equal(report.totals_complete,false);});
}
export async function runWorkforceCostChecks({db,withTx,check,g,c,saveGrant}){
 const query=(input={},userId=9805)=>bossCosts(db,{userId,input:{group_id:g.id,period:'2026-10',page_size:100,...input}}),report=await query();
 const target=(await db.query("SELECT coalesce(sum(l.amount),0)::text n FROM ty_wf_payable p JOIN ty_wf_bill_root r ON r.id=p.root_id JOIN ty_wf_bill_version v ON v.id=p.last_version_id JOIN ty_wf_bill_line l ON l.version_id=v.id WHERE r.group_id=$1 AND r.period='2026-10-01'AND r.currency='CNY'AND v.status='posted'AND l.cost_membership='independent'AND l.purpose<>'agency_funds'",[g.id])).rows[0].n;
 const vendor=report.rows.filter(r=>r.source_domain==='workforce_supplier'&&r.amount!==null&&r.amount!==undefined);
 await check('COST02 actual posted supplier expense reaches boss report through the current confirmed bill target',async()=>{assert.ok(vendor.length);assert.equal(amount(vendor.reduce((n,r)=>plus(n,r.amount),'0')),amount(target));});
 const native=(await db.query("SELECT coalesce(sum(c.amount),0)::text n FROM ty_pay_cost_entry c JOIN ty_pay_batch b ON b.id=c.batch_id WHERE c.group_id=$1 AND c.period='2026-10-01'AND c.currency='CNY'AND b.status='confirmed'",[g.id])).rows[0].n;
 await check('COST03 payroll costs and supplier costs sum once in CNY without using net cash movement',async()=>assert.equal(report.by_currency.CNY,amount(plus(native,target))));
 await check('COST04 earlier posted bill revisions are not added again as full expense',async()=>{const old=(await db.query("SELECT coalesce(sum(l.amount),0)::text n FROM ty_wf_bill_version v JOIN ty_wf_bill_root r ON r.id=v.root_id JOIN ty_wf_bill_line l ON l.version_id=v.id WHERE r.group_id=$1 AND r.period='2026-10-01'AND v.status='posted'AND l.cost_membership='independent'AND l.purpose<>'agency_funds'",[g.id])).rows[0].n;assert.notEqual(amount(old),amount(target));for(const row of vendor){const r=(await db.query('SELECT p.last_version_id FROM ty_wf_payable p JOIN ty_wf_bill_root x ON x.id=p.root_id WHERE p.last_version_id=$1',[row.source_bill_id])).rows[0];assert.ok(r);}});
 await check('COST05 entrusted employee payment funds do not become supplier expense',async()=>{assert.ok(Number((await db.query("SELECT count(*)n FROM ty_wf_bill_line l JOIN ty_wf_bill_version v ON v.id=l.version_id JOIN ty_wf_bill_root r ON r.id=v.root_id WHERE r.group_id=$1 AND l.purpose='agency_funds'AND l.amount>0",[g.id])).rows[0].n)>0);assert.ok(vendor.every(r=>r.economic_component==='供应商服务成本'));});
 await check('COST06 company and fuzzy source filters keep the exact authorized supplier subset',async()=>{const scoped=await query({company_id:c.id});assert.ok(scoped.rows.every(r=>String(r.company_id)===String(c.id)));const sample=vendor[0];assert.ok((await query({q:sample.source_ref})).rows.some(r=>r.id===sample.id));});
 let seq=0;const grant=fields=>withTx(db,t=>saveGrant(t,{userId:9801,operationId:'WF-COST-GRANT-'+(++seq),input:{group_id:g.id,subject_type:'account',account_id:9805,resource:'payroll_cost',actions:['read'],company_id:c.id,fields_allow:fields,valid_from:'2020-01-01T00:00:00+08:00',reason:'成本字段组合与撤权核验'}}));
 await grant(['amount']);await grant(['currency']);
 await check('COST07 disjoint monetary field grants cannot form a supplier expense payload or currency total',async()=>{const limited=await query();assert.ok(!limited.rows.some(r=>r.source_domain==='workforce_supplier'));assert.deepEqual(limited.by_currency,{});});
 await db.query("UPDATE ty_auth_grant SET status='revoked'WHERE account_id=9805 AND resource='payroll_cost'");
 await check('COST08 revoking cost authority removes native and supplier costs before counts or search',async()=>{const revoked=await query();assert.equal(revoked.total,0);assert.deepEqual(revoked.by_currency,{});});
}
