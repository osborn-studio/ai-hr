const same=(a,b)=>String(a)===String(b);
export function within(rows,id,root,parent){if(!root)return true;const seen=new Set();while(id&&!seen.has(String(id))){if(same(id,root))return true;seen.add(String(id));id=rows.find(x=>same(x.id,id))?.[parent];}return false;}
export function inContext(data,company,context){return within(data.ledgers||[],company.ledger_id,context.ledger_id,'parent_ledger_id')&&within(data.companies||[],company.id,context.company_id,'parent_company_id');}
