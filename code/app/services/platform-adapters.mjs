import{one,deny}from'./platform-core.mjs';
import * as foundation from './foundation.mjs';

export async function isManagedAccount(t,userId){if(!(await one(t,"SELECT to_regclass('public.ty_auth_managed') IS NOT NULL ok"))?.ok)return false;return!!(await one(t,`SELECT EXISTS(SELECT 1 FROM ty_auth_managed WHERE account_id=$1)OR EXISTS(SELECT 1 FROM ty_access_grant WHERE account_id=$1 AND platform_source_key IS NOT NULL)ok`,[userId])).ok;}
export async function guardCoarseAdapter(t,userId){if(await isManagedAccount(t,userId))deny('此业务查询正在接入完整授权；当前账号请使用支持完整授权的业务页面');}
export async function bootstrap(t,args){return foundation.bootstrap(t,args);}
