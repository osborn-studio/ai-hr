// Industry-scheme casual employees are not regular monthly MPF. All fractions
// stay exact until output; wage-cycle groups and qualified workdays are explicit.
import{fraction,amount,compare,sum,over,minus,times}from'./payroll-calculations.mjs';
const error=m=>{throw Object.assign(new RangeError(m),{code:'E_PAYROLL_INDUSTRY_INPUT'});};
const date=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00Z'))||new Date(v+'T00:00Z').toISOString().slice(0,10)!==v)error('Valid ISO date required');return v;};
const num=v=>{if(typeof v!=='string'||!/^\d{1,24}(?:\.\d{1,12})?$/.test(v))error('Explicit nonnegative decimal text required');return v;};
const bool=v=>{if(typeof v!=='boolean')error('Confirmed eligibility must be true or false');return v;};
function bandsOf(input){if(!Array.isArray(input)||!input.length||input.length>100)error('Complete contribution scale required');let next='0';for(const[bIndex,b]of input.entries()){if(num(b.lower)!==next||!Object.hasOwn(b,'upper'))error('Contribution bands must be contiguous from0 with explicit upper');num(b.employee);num(b.employer);if(b.upper===null){if(bIndex!==input.length-1)error('Only final band may be unbounded');}else{num(b.upper);if(compare(b.upper,b.lower)<=0||bIndex===input.length-1)error('Final band must be explicitly unbounded');next=b.upper;}}return input;}
function pick(bands,income){return bands.find(b=>compare(income,b.lower)>=0&&(b.upper===null||compare(income,b.upper)<0));}
export function hkIndustryCasual(input){
 const{mode,groups,bands,eligibility,alreadyEmployeeTarget,alreadyEmployerTarget}=input;
 if(!['daily_rated','non_daily_rated'].includes(mode))error('Daily-rated or non-daily-rated wage basis required');
 if(!eligibility||eligibility.verified!==true||eligibility.industry!==true||eligibility.casual!==true||eligibility.industryScheme!==true||eligibility.contributionHoliday!==false)error('Verified industry casual membership without contribution holiday required');
 const scale=bandsOf(bands);num(alreadyEmployeeTarget);num(alreadyEmployerTarget);if(!Array.isArray(groups)||groups.length>100||!groups.length&&input.verifiedNoWork!==true)error('Verified wage-period work facts required');
 const seenFacts=new Set(),seenDates=new Set(),periods=[],details=[];let employee=null,employer=null;
 for(const group of groups){const from=date(group.from),to=date(group.to);if(to<=from||!group.key||periods.some(p=>from<p.to&&to>p.from))error('Explicit nonoverlapping original wage periods required');periods.push({from,to});if(!Array.isArray(group.facts)||!group.facts.length)error('Each wage period requires actual qualified workdays');const days=new Map();
  for(const f of group.facts){date(f.date);num(f.income);bool(f.employeeEligible);bool(f.employerEligible);if(!f.key||seenFacts.has(f.key)||f.date<from||f.date>=to)error('Fact identity must be unique and within original wage period');seenFacts.add(f.key);let d=days.get(f.date);if(!d){if(seenDates.has(f.date))error('A working day cannot be split into multiple wage periods');seenDates.add(f.date);d={date:f.date,income:'0',employeeEligible:f.employeeEligible,employerEligible:f.employerEligible,fact_keys:[]};days.set(f.date,d);}if(d.employeeEligible!==f.employeeEligible||d.employerEligible!==f.employerEligible)error('Eligibility conflict on same workday');d.income=sum([d.income,f.income]);d.fact_keys.push(f.key);}
  const average=over(sum([...days.values()].map(d=>d.income)),String(days.size));
  for(const d of days.values()){const basis=mode==='daily_rated'?d.income:average,b=pick(scale,basis);if(!b)error('Income outside contribution scale');const ee=d.employeeEligible?b.employee:null,er=d.employerEligible?b.employer:null;if(ee!==null)employee=sum([employee||'0',ee]);if(er!==null)employer=sum([employer||'0',er]);details.push({group_key:group.key,date:d.date,fact_keys:d.fact_keys,actual_income:amount(d.income),band_basis:fraction(basis),lower:b.lower,upper:b.upper,employee:ee===null?null:amount(ee),employer:er===null?null:amount(er)});}
 }
 if(!groups.length){employee='0';employer='0';}
 const side=(value,prior)=>value===null?{state:'not_applicable',target:null,delta:null,requiresReversalReview:compare(prior,'0')>0}:{state:compare(value,'0')===0?'confirmed_zero':'calculated',target:amount(value),delta:amount(minus(value,prior)),exact:fraction(value)};
 return{mode,work_days:details.length,employee:side(employee,alreadyEmployeeTarget),employer:side(employer,alreadyEmployerTarget),details,contribution_holiday:false,remittance_created:false};
}
