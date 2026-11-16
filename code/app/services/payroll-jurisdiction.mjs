import { bizErr } from '../errors.mjs';
const bad=message=>{throw bizErr('E_TY_ARGUMENT',message);};
export const JURISDICTION_MODULES=['BASE','HK_MPF','CN_IIT','CN_SOCIAL_INSURANCE'];
export async function assertLegacyPayrollRegion(tx,entityId){
 const outside=(await tx.query(`SELECT EXISTS(SELECT 1 FROM ty_legacy_company_binding b
  CROSS JOIN LATERAL fn_ty_company_locale(b.company_id) loc WHERE b.payroll_legal_entity_id=$1
   AND loc.region_code IS NOT NULL AND loc.region_code<>'CN') blocked`,[entityId])).rows[0].blocked;
 if(outside)bad('此主体包含香港或其他非内地公司，请在“薪酬核算”选择对应地区规则，不能使用原内地算薪入口');
}
export function regionCode(value,{nullable=true,generic=false}={}){
 if((value===null||value===undefined||value==='')&&nullable)return null;
 if(typeof value!=='string')bad('地区须为明确的两位地区码');
 const code=value.trim().toUpperCase();
 if(!/^[A-Z]{2}$/.test(code)&&!(generic&&code==='CUSTOM'))bad('地区须为两位地区码，通用规则可选择CUSTOM');
 return code;
}
export async function companyLocale(tx,companyIds,{region=null,currency,requireRegion=false}={}){
 const ids=[...new Set(companyIds.filter(Boolean).map(Number))];
 const locales=ids.length?(await tx.query(`SELECT c.id company_id,loc.* FROM ty_company c
  CROSS JOIN LATERAL fn_ty_company_locale(c.id) loc WHERE c.id=ANY($1::bigint[])`,[ids])).rows:[];
 if(locales.length!==ids.length)bad('地区核验包含不存在的公司');
 const known=[...new Set(locales.map(l=>l.region_code).filter(Boolean))];
 if(known.length>1)bad('同一工资批次或绩效周期必须按公司地区拆分');
 const selected=regionCode(region)??known[0]??null;
 for(const locale of locales){
  if(locale.currency_code&&locale.currency_code!==currency)bad('工资或绩效币种与公司帐套/品牌配置不一致');
  if(locale.region_code&&selected&&locale.region_code!==selected)bad('工资或绩效地区与公司帐套/品牌配置不一致');
 }
 if(requireRegion&&!selected)bad('确认前须明确地区；不能从币种或名称推断');
 return{region_code:selected,currency_code:currency,locales};
}
export function ruleJurisdiction(rules,ruleRegion,businessRegion){
 const selected=regionCode(ruleRegion,{nullable:false,generic:true});
 if(selected!=='CUSTOM'&&businessRegion&&selected!==businessRegion)bad('工资规则地区与批次公司地区不一致');
 for(const rule of rules){
  const module=rule.jurisdiction_module||'BASE';
  if(!JURISDICTION_MODULES.includes(module))bad('工资规则的地区模块无效');
  const required=module==='HK_MPF'?'HK':['CN_IIT','CN_SOCIAL_INSURANCE'].includes(module)?'CN':null;
  if(required&&(selected!==required||businessRegion&&businessRegion!==required))bad('地区专属工资模块不能用于其他地区或CUSTOM通用规则');
 }
 return selected;
}
