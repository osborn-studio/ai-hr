import assert from 'node:assert/strict';
import { createApp } from '../app/server.mjs';
import { withTx } from '../app/db.mjs';
import { assertLegacyPayrollRegion } from '../app/services/payroll-jurisdiction.mjs';
const {db,server}=await createApp();let checks=0;
const q=async(s,p=[]) => (await db.query(s,p)).rows;
const add=async(table,data)=>{const keys=Object.keys(data);return(await q(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(data)))[0];};
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('PASS '+name);};
const reject=async(name,fn,pattern)=>{await assert.rejects(fn,pattern);checks++;console.log('PASS '+name);};
try{
 const g=await add('ty_group',{code:'LEGACY-HK-TEST',name:'虚构香港区域验证'});
 const b=await add('ty_brand',{group_id:g.id,code:'HK',name:'虚构香港品牌',region_code:'HK',currency_code:'HKD'});
 const l=await add('ty_ledger',{group_id:g.id,brand_id:b.id,scope_mode:'brand',code:'HK',name:'香港测试帐套'});
 const c=await add('ty_company',{group_id:g.id,brand_id:b.id,ledger_id:l.id,code:'HK01',name:'虚构香港一店'});
 const org=90001,entity=90001;
 await db.query("INSERT INTO org_unit(id,name,path,kind) VALUES($1,'虚构兼容门店','99999.001','dept')",[org]);
 await db.query("INSERT INTO legal_entity(id,name) VALUES($1,'虚构香港用工主体')",[entity]);
 await add('ty_legacy_company_binding',{company_id:c.id,legacy_org_id:org,payroll_legal_entity_id:entity,si_legal_entity_id:entity,effective_from:'2026-01-01',created_by:1});
 await reject('服务清楚引导香港主体进入新核算',()=>withTx(db,t=>assertLegacyPayrollRegion(t,entity)),/香港|对应地区/);
 await reject('直接SQL不能给香港主体开原内地工资批次',()=>db.query("INSERT INTO pay_run(period,legal_entity_id) VALUES('2026-11',$1)",[entity]),/香港|非内地/);
 await reject('直接SQL不能给香港主体开原内地年终奖',()=>db.query("INSERT INTO pay_run(period,legal_entity_id,kind) VALUES('2026-12',$1,'bonus')",[entity]),/香港|非内地/);
 await withTx(db,t=>assertLegacyPayrollRegion(t,1));check('原本未映射香港的内地演示入口保持可用',true);
 console.log(`旧算薪地域守卫 · ${checks} 条通过 · 驱动 ${db.driver}`);
}finally{server.close();await db.close();}
