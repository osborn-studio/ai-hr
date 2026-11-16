// Identity equivalence is based on stored employee bindings, never names,
// request JSON, role labels or a different login for the same person.
export async function humanIdentity(t,accountId){
 const account=(await t.query('SELECT id,person_id FROM sys_account WHERE id=$1',[accountId])).rows[0];if(!account)return null;
 let binding=null,profile=null;
 if((await t.query("SELECT to_regclass('public.ty_operator_binding') IS NOT NULL ok")).rows[0].ok)binding=(await t.query('SELECT group_id,person_id FROM ty_operator_binding WHERE account_id=$1',[accountId])).rows[0];
 if(!binding&&(await t.query("SELECT to_regclass('public.ty_test_account_profile') IS NOT NULL ok")).rows[0].ok)profile=(await t.query('SELECT group_id,person_id FROM ty_test_account_profile WHERE account_id=$1',[accountId])).rows[0];
 const source=binding||profile;
 return{account_id:String(account.id),group_id:source?.group_id==null?null:String(source.group_id),person_id:source?.person_id==null?null:String(source.person_id),legacy_person_id:account.person_id==null?null:String(account.person_id)};
}
export async function sameHuman(t,leftAccount,rightAccount){
 if(leftAccount==null||rightAccount==null)return false;
 if(String(leftAccount)===String(rightAccount))return true;
 const left=await humanIdentity(t,leftAccount),right=await humanIdentity(t,rightAccount);if(!left||!right)return false;
 if(left.account_id===right.account_id)return true;
 if(left.person_id&&right.person_id&&left.group_id&&right.group_id&&left.person_id===right.person_id&&left.group_id===right.group_id)return true;
 return!!left.legacy_person_id&&left.legacy_person_id===right.legacy_person_id;
}
export async function humanIsPerson(t,accountId,groupId,personId){
 if(groupId==null||personId==null)return false;const identity=await humanIdentity(t,accountId);if(!identity)return false;
 if(identity.person_id===String(personId)&&identity.group_id===String(groupId))return true;
 if(!identity.legacy_person_id||!(await t.query("SELECT to_regclass('public.ty_person') IS NOT NULL ok")).rows[0].ok)return false;
 const person=(await t.query('SELECT legacy_person_id FROM ty_person WHERE id=$1 AND group_id=$2',[personId,groupId])).rows[0];return person?.legacy_person_id!=null&&String(person.legacy_person_id)===identity.legacy_person_id;
}
