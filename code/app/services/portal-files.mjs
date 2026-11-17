import { createHash, randomUUID } from 'node:crypto';
import * as h from './hr-common.mjs';

const MAX_FILE = 8 * 1024 * 1024;
const FILE_REF = /^pf:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const aad = r => ['tyhr-original-v1',r.group_id,r.owner_kind,r.owner_key,r.field_key,r.owner_id,r.file_key].join(':');
const fieldKey = v => /^[a-z][a-z0-9_]{0,63}$/.test(v || '') ? v : h.bad('附件字段编码无效');
function shape(v, keys) {
  h.obj(v); if (Object.keys(v).some(k => !keys.includes(k))) h.bad('附件包含未登记参数');
}
async function installed(t) {
  if (!(await h.one(t,"SELECT to_regclass('public.ty_pf_attachment')IS NOT NULL ok")).ok) h.bad('原件存储迁移尚未就绪');
}
function original(input) {
  shape(input,['filename','mime','content_base64']);
  const filename=h.text(input.filename,'原件名称',1,240),mime=h.text(input.mime,'原件类型',1,150);
  if (/[\x00-\x1f\\/]/.test(filename) || filename==='.' || filename==='..') h.bad('原件名称不能是路径');
  const text=input.content_base64;
  if (typeof text!=='string'||!text.length||text.length>Math.ceil(MAX_FILE/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) h.bad('原件须为不超过8MB的标准Base64字节');
  const bytes=Buffer.from(text,'base64');
  if (!bytes.length||bytes.length>MAX_FILE||bytes.toString('base64')!==text) h.bad('原件字节或大小无效');
  const signatures={
    'application/pdf':b=>b.subarray(0,5).toString()==='%PDF-',
    'image/png':b=>b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    'image/jpeg':b=>b[0]===255&&b[1]===216&&b[2]===255,
    'text/plain':b=>!b.includes(0)&&Buffer.from(b.toString('utf8'),'utf8').equals(b),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':b=>b.subarray(0,4).equals(Buffer.from([80,75,3,4])),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':b=>b.subarray(0,4).equals(Buffer.from([80,75,3,4])),
  };
  if (!signatures[mime]||!signatures[mime](bytes)) h.bad('原件类型与字节不符，支持PDF、图片、文本或Office原件');
  return {filename,mime,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
}
async function rowByRef(t, ref, lock=false) {
  const m=FILE_REF.exec(ref || ''); if (!m) h.bad('请选择真实上传的原件引用');
  const r=await h.one(t,'SELECT * FROM ty_pf_attachment WHERE file_key=$1'+(lock?' FOR UPDATE':''),[m[1]]);
  if (!r||r.status!=='ready') h.missing(); return r;
}
function metadata(r) {
  const box=h.unseal(r.metadata_box,aad(r)+':metadata');
  return {id:r.id,file_ref:'pf:'+r.file_key,filename:box.filename,mime:r.mime,sha256:r.sha256,byte_length:r.byte_length};
}

// These helpers are server-only. A caller supplies its typed domain owner and
// a real authorization function; none of these arguments can come from JSON.
export async function storeOwnedOriginal(t,{userId,ownerKind,ownerId,groupId,companyId=null,fieldKey:field,input,authorize}) {
  await installed(t);
  if (typeof authorize!=='function') h.deny('原件须由对应业务核准当前访问范围');
  await authorize(t,{userId,action:'upload',ownerKind,ownerId,groupId,companyId,fieldKey:field});
  const operator=await h.actor(t,userId,groupId),kind=h.text(ownerKind,'原件所属类型',1,64),key=h.text(String(ownerId),'原件业务关联',1,160);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(kind)) h.bad('原件所属类型无效');fieldKey(field);
  const source=original(input),existing=await h.one(t,"SELECT * FROM ty_pf_attachment WHERE owner_id=$1 AND owner_kind=$2 AND owner_key=$3 AND field_key=$4 AND sha256=$5",[userId,kind,key,field,source.sha256]);
  if (existing) {if(existing.status!=='ready'||!h.same(existing.group_id,operator.group_id)||!h.same(existing.company_id,companyId)||existing.mime!==source.mime)h.conflict('同一原件已有不同范围或处理状态');return metadata(existing);}
  const row={file_key:randomUUID(),group_id:operator.group_id,company_id:companyId,owner_kind:kind,owner_key:key,field_key:field,owner_id:userId};
  const encrypted=h.sealBytes(source.bytes,aad(row)),box=h.seal({filename:source.filename},aad(row)+':metadata');
  const made=await h.one(t,`INSERT INTO ty_pf_attachment(file_key,group_id,company_id,owner_kind,owner_key,form_id,field_key,owner_id,metadata_box,mime,byte_length,sha256,cipher,iv,tag)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)RETURNING *`,
    [row.file_key,row.group_id,companyId,kind,key,kind==='form'?h.id(ownerId):null,field,userId,JSON.stringify(box),source.mime,source.bytes.length,source.sha256,encrypted.cipher,encrypted.iv,encrypted.tag]);
  await h.audit(t,userId,row.group_id,'original.uploaded','original',made.id,{owner_kind:kind,owner_key:key,byte_length:source.bytes.length,sha256:source.sha256});
  return metadata(made);
}
export async function readOwnedOriginal(t,{userId,fileRef,ownerKind,ownerId,authorize,download=false}) {
  await installed(t);const r=await rowByRef(t,fileRef);
  if (r.owner_kind!==ownerKind||r.owner_key!==String(ownerId)) h.deny('原件不能借给另一个业务事项');
  if (typeof authorize!=='function') h.deny();
  await h.actor(t,userId,r.group_id);await authorize(t,{userId,action:download?'download':'read',ownerKind,ownerId,groupId:r.group_id,companyId:r.company_id,fieldKey:r.field_key,attachment:r});
  const out=metadata(r);if(download){const bytes=h.unsealBytes(r,aad(r));if(bytes.length!==r.byte_length||createHash('sha256').update(bytes).digest('hex')!==r.sha256)h.conflict('原件完整性核验失败');out.content_base64=bytes.toString('base64');}return out;
}
async function formAccess(t,userId,formId,companyId,field,action) {
  const f=await h.one(t,'SELECT * FROM ty_form_definition WHERE id=$1',[h.id(formId)]);if(!f)h.missing();
  const operator=await h.actor(t,userId,f.group_id);if(operator.profile_code==='config_admin')h.deny('系统配置不能上传或读取业务申请原件');
  if(f.company_id&&!h.same(f.company_id,companyId))h.deny('原件公司须与原表单一致');
  if(!f.schema.fields.some(x=>x.key===field&&x.type==='file'))h.bad('请选择原表单已声明的附件字段');
  if(action==='upload'&&f.status!=='published')h.bad('仅已发布表单可接收申请原件');
  await h.requireAccess(t,userId,'workflow_self',action==='upload'?'submit':'read',{group_id:f.group_id,company_id:companyId,person_id:operator.person_id,department_id:await(await import('./workflow-scope.mjs')).subjectDepartment(t,{groupId:f.group_id,companyId,personId:operator.person_id}),fields:[field]});
  return f;
}
export async function uploadFormOriginal(t,{userId,input,operationId}) {
  shape(input,['form_id','company_id','field_key','filename','mime','content_base64']);await installed(t);
  const company=h.id(input.company_id,true),field=fieldKey(input.field_key),form=await formAccess(t,userId,input.form_id,company,field,'upload');
  return h.command(t,{userId,groupId:form.group_id,operation:'portal.file.upload',operationId,input,
    execute:async()=>{const r=await storeOwnedOriginal(t,{userId,ownerKind:'form',ownerId:form.id,groupId:form.group_id,companyId:company,fieldKey:field,input:{filename:input.filename,mime:input.mime,content_base64:input.content_base64},authorize:(tx)=>formAccess(tx,userId,form.id,company,field,'upload')});return{file_ref:r.file_ref};},
    project:async r=>({...await queryFormOriginal(t,{userId,input:{file_ref:r.file_ref}}),replayed:!!r.replayed})});
}
export async function validateFormAttachments(t,{userId,form,values,companyId}) {
  for(const field of form.schema.fields.filter(f=>f.type==='file')){
    const refs=values[field.key]||[];if(!Array.isArray(refs)||refs.length>10||new Set(refs).size!==refs.length)h.bad('每个附件字段最多10份不同原件');
    for(const ref of [...refs].sort()){const r=await rowByRef(t,ref,true);if(r.owner_kind!=='form'||!h.same(r.form_id,form.id)||!h.same(r.owner_id,userId)||r.field_key!==field.key||!h.same(r.company_id,companyId))h.deny('仅可提交本人在原表单、字段与公司范围上传的原件');}
  }
}
export async function bindFormAttachments(t,{userId,instance,form,values,companyId}) {
  for(const field of form.schema.fields.filter(f=>f.type==='file'))for(const ref of values[field.key]||[]){const r=await rowByRef(t,ref,true);await t.query('INSERT INTO ty_pf_attachment_use(attachment_id,instance_id,field_key,submitted_company_id,created_by)VALUES($1,$2,$3,$4,$5)',[r.id,instance.id,field.key,companyId,userId]);}
}
export async function queryFormOriginal(t,{userId,input}) {
  shape(input,['file_ref','download']);if(input.download!==undefined&&typeof input.download!=='boolean')h.bad('下载参数无效');
  await installed(t);const r=await rowByRef(t,input.file_ref);if(r.owner_kind!=='form')h.deny('此原件须在对应业务中查看');
  return readOwnedOriginal(t,{userId,fileRef:input.file_ref,ownerKind:'form',ownerId:r.form_id,download:!!input.download,
    authorize:async(tx)=>{const uses=await h.q(tx,'SELECT * FROM ty_pf_attachment_use WHERE attachment_id=$1 ORDER BY instance_id',[r.id]);if(!uses.length){if(!h.same(r.owner_id,userId))h.deny();await formAccess(tx,userId,r.form_id,r.company_id,r.field_key,'read');return;}
      for(const used of uses){try{const instance=await(await import('./platform-workflow.mjs')).projectInstance(tx,userId,used.instance_id,{fields:[r.field_key]});if(instance.values?.[r.field_key]?.includes(input.file_ref))return;}catch(e){if(e.code!=='E_TY_FORBIDDEN')throw e;}}h.deny('当前字段权限不允许读取此申请原件');}});
}
