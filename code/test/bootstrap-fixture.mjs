import{readFileSync,readdirSync}from'node:fs';
export async function setupBootstrapFixture(db){
 if(Number((await db.query("SELECT count(*)n FROM pg_tables WHERE schemaname='public'")).rows[0].n)!==0)throw Error('Empty isolated database required');
 await db.exec('CREATE EXTENSION IF NOT EXISTS btree_gist');for(const f of readdirSync(new URL('../db/',import.meta.url)).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.exec(readFileSync(new URL('../db/'+f,import.meta.url),'utf8'));await db.initSession();
 await db.exec(`INSERT INTO sys_account(id,login,display_name)OVERRIDING SYSTEM VALUE VALUES(9500,'bootstrap_it','系统配置'),(9501,'bootstrap_hr','熊予安'),(9502,'bootstrap_staff','周知礼'),(9503,'bootstrap_group_hr','宋知夏');
 INSERT INTO sys_data_scope(id,name,combinator)VALUES(9500,'本次隔离核验范围','intersection');
 INSERT INTO sys_role(id,code,name)VALUES(9505,'bootstrap_self','员工本人');INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)VALUES(9505,'hr_self',true,false),(9505,'employee_roster',true,false);
 INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason)SELECT n,CASE WHEN n=9502 THEN 9505 ELSE 10 END,9500,'2020-01-01','ROLE','isolated bootstrap directory fixture'FROM generate_series(9500,9503)n;
 INSERT INTO ty_group(id,code,name)VALUES(9500,'BOOTSTRAP','天意集团'),(9501,'SEPARATE','山海集团');
 INSERT INTO ty_ledger(id,group_id,code,name,scope_mode,region_code,currency_code)VALUES(9500,9500,'G','天意集团帐','group','CN','CNY'),(9501,9501,'G','山海集团帐','group','CN','CNY');
 INSERT INTO ty_company(id,group_id,ledger_id,code,name)VALUES(9500,9500,9500,'JA','香香鱼米静安店'),(9501,9500,9500,'XH','香香鱼米徐汇店'),(9502,9501,9501,'PDT','山海浦东店');
 INSERT INTO ty_person(id,group_id,person_number,full_name)VALUES(9500,9500,'TY0001','周知礼'),(9501,9500,'TY0002','陈予安'),(9502,9501,'SH0001','林舟');
 INSERT INTO ty_employment(id,group_id,person_id,company_id,hire_date,legal_subject_name,rehire_link)VALUES(9500,9500,9500,9500,'2020-01-01','香香鱼米静安店',NULL),(9501,9500,9501,9501,'2020-02-02','香香鱼米徐汇店',NULL),(9502,9501,9502,9502,'2020-03-03','山海浦东店',NULL);
 INSERT INTO ty_department(id,company_id,code,name)VALUES(9500,9500,'SERVICE','前厅部'),(9501,9501,'SERVICE','前厅部');
 INSERT INTO ty_job(id,group_id,code,name)VALUES(9500,9500,'SERVICE','服务员');
 INSERT INTO ty_company_position(id,group_id,company_id,department_id,job_id,code,name)VALUES(9500,9500,9500,9500,9500,'SERVICE','前厅服务员'),(9501,9500,9501,9501,9500,'SERVICE','前厅服务员');
 INSERT INTO ty_position_assignment(id,group_id,company_id,employment_id,department_id,position_id,is_primary,valid_from)VALUES(9500,9500,9500,9500,9500,9500,true,'2020-01-01'),(9501,9500,9501,9501,9501,9501,true,'2020-02-02');
 INSERT INTO ty_test_account_profile(account_id,group_id,person_id,company_id,profile_code,seed_version)VALUES(9500,9500,NULL,NULL,'config_admin','BOOTSTRAP'),(9501,9500,NULL,NULL,'group_hr_director','BOOTSTRAP'),(9502,9500,9500,9500,'store_staff','BOOTSTRAP'),(9503,9500,NULL,NULL,'group_hr_director','BOOTSTRAP');
 INSERT INTO ty_access_grant(account_id,group_id,company_id,can_read,can_write,valid_from)VALUES(9500,9500,NULL,true,true,'2020-01-01'),(9501,9500,NULL,true,true,'2020-01-01'),(9502,9500,9500,true,false,'2020-01-01'),(9503,9500,NULL,true,true,'2020-01-01');
 INSERT INTO ty_auth_managed(account_id,group_id,resource)VALUES(9501,9500,'hr_people');
 INSERT INTO ty_auth_grant(group_id,subject_type,account_id,resource,actions,company_id,fields_allow,fields_deny,valid_from,reason,created_by)VALUES(9500,'account',9501,'hr_people',ARRAY['read'],9500,ARRAY['full_name','person_number','employment_id','company_id','hire_date','department_id','position_id'],ARRAY['leave_date','rehire_link','legal_subject_name','status'],'2020-01-01','本次核验仅静安店有限人事字段',9500);
 `);
}
