import assert from'node:assert/strict';
import{createDb}from'../app/db.mjs';import{payrollInternals}from'../app/services/payroll-source.mjs';import{setupBootstrapFixture}from'./bootstrap-fixture.mjs';
const db=await createDb({url:process.env.DATABASE_URL||undefined});
try{
 await setupBootstrapFixture(db);
 await db.query("INSERT INTO ty_auth_managed(account_id,group_id,resource)VALUES(9501,9500,'payroll_cost')ON CONFLICT DO NOTHING");
 for(const fields of[['amount','person_number'],['currency','full_name']])await db.query("INSERT INTO ty_auth_grant(group_id,subject_type,account_id,resource,actions,company_id,fields_allow,reason,created_by)VALUES(9500,'account',9501,'payroll_cost',ARRAY['read'],9500,$1,'独立字段范围核验',9503)",[fields]);
 const source={id:1,group_id:9500,company_id:9500,person_id:9500,amount:'10.00',currency:'CNY',person_number:'TY0001',full_name:'周知礼'};
 const projected=await payrollInternals.project(db,9501,'payroll_cost',source,source);
 assert.ok(projected);assert.ok(!(Object.hasOwn(projected,'amount')&&Object.hasOwn(projected,'currency')),'different field grants never form one composite payroll DTO');
 assert.ok([['amount','person_number'],['currency','full_name']].some(fields=>Object.keys(projected).every(k=>fields.includes(k))));
 const full=await payrollInternals.project(db,9503,'payroll_cost',source,source);assert.equal(full.amount,'10.00');assert.equal(full.currency,'CNY');
 const other=await payrollInternals.project(db,9501,'payroll_cost',{...source,company_id:9501},source);assert.equal(other,null);
 await db.query("UPDATE ty_auth_grant SET status='revoked'WHERE account_id=9501 AND resource='payroll_cost'");assert.equal(await payrollInternals.project(db,9501,'payroll_cost',source,source),null);
 console.log(JSON.stringify({suite:'payroll-single-grant-projection',driver:db.driver,checks:5,passed:5,external_calls:0}));
}finally{await db.close();}
