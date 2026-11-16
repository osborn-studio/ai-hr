# 平台配置与门户接口约定 V1

与前端并行实现的固定约定；尚未接入前不得宣称能力已完成。

## 工作区

`system.workspace` query 输入：kind=permissions/forms/workflows/integrations/portal；group_id/company_id、view、id、q、page=1、page_size=10。

所有分页返回 `rows,total,page,page_size`；对应当前view还给同一数组别名：operators/roles/grants/forms/workflows/instances/tasks/connections/mappings/jobs/alerts。只渲染当前任务表，不能把所有数组上下堆成长页。未安装业务域通过unavailable_modules显式列原因，不把查询失败变空数组。

公共返回 current_operator={id,login,display_name,profile_code}、companies、resource_catalogue、fields_catalogue、capabilities、as_of。

capabilities固定布尔键：can_manage_operators、can_manage_roles、can_manage_grants、can_design_forms、can_publish_forms、can_design_workflows、can_publish_workflows、can_manage_integrations、can_submit、can_approve、can_execute、can_simulate。按钮按它显示，后端每次仍做当前授权。

permissions view=operators/roles/grants，默认operators；workflows view=definitions/instances/tasks，默认definitions；forms view=definitions；integrations view=connections/mappings/jobs，默认connections；portal view=tasks/requests/alerts，默认tasks。

资源目录行 {code,label,actions:[{code,label}],fields:[{key,label,sensitivity}]}。角色行 {id,code,name,status,revision}。授权行 {id,subject_type:'account'|'role',account_id,role_id,resource,actions,group_id,company_id,department_ids,person_ids,fields_allow,fields_deny,valid_from,valid_to,status,revision}，时间为明确ISO时区时间。一个授权包含动作、范围和字段，不跨授权拼接扩大。

## 设计对象

表单行 {id,code,name,version,status,revision,business_type,workflow_id,schema:{fields:[{key,label,type,required,options,sensitivity}]}}。workflow_id引用确切已发布工作流版本；表单字段type=text/number/money/date/person/company/select/file。附件上传能力尚未接入时，只允许真实已有附件引用并显示限制。

工作流行 {id,code,name,version,status,revision,business_type,graph:{nodes:[...]}}。节点type=start/approval/condition/notify/end，含id,label,x,y,next；审批节点mode=any/all,approver_ids,role_codes；条件branches=[{when:{field,op,value},next},{else:true,next}]。发布校验连通、无环、可到结束、无空审批、分支fallback且冻结版本。`system.workflow.preview`纯查询，不保存意图，返回 {valid,issues,path,resolved_approvers}；仿真不代替实例的当前解析和授权。

实例行 {id,form_id,form_version,workflow_id,workflow_version,revision,title,applicant_id,company_id,status,business_state,values,subject_type,subject_id}。审批状态和业务生效分列。任务行 {id,instance_id,node_id,approver_id,status,revision,actions:[{code,label}]}；actions才是该任务当前可做动作。decide输入 task_id/approve/reason/expected_revision；transfer输入task_id/to_account_id/reason/expected_revision；delegate输入to_account_id/valid_from/valid_to/reason。execute输入instance_id/expected_revision；实例没批准或源变更时不执行。

## 操作者和凭据

operator.create输入login/display_name/person_id(可选)/group_id；operator.update输入id/display_name/status/expected_revision；reset_password只传id/reason，不把新口令写冻结journal。服务器按本地策略生成初始凭据，一次性响应credential_once，持久回执不存明文，重试仅返回已完成及credential_available=false。用户可明确再发起另一次重置，不能无限读取旧口令。

integration.save仅存配置，不传secret。连接行 {id,provider,code,name,status,revision,config,secret_configured,secret_masked,capabilities,connection_state}，provider=dingtalk/feishu/wecom/device。敏感录入单独`system.integration.secret`，明文只在内存，持久化只保留operationId与脱敏指纹；服务端加密，查询永不返回secret。`system.operation.status`按当前actor+operationId查状态，不能借旧回执读取被撤权限的数据。

validate输入connection_id，只做当前配置/能力核对；外部连接未实连必须显示unconfigured/not_verified，不返回success=sent。snapshot输入connection_id/source_revision/departments/users/evidence_ref，来源为获核外部快照；mapping输入mapping_id/local_type/local_id/expected_revision/reason，人工确认不得直接造雇佣。消息发出、送达、已读、业务办结分状态。

## 所有命令

POST `/api/v2/command/{name}`，Idempotency-Key冻结；name为system.operator.create/update/reset_password、system.role.save、system.grant.save/revoke、system.form.save/publish、system.workflow.save/publish、system.instance.submit/decide/transfer/delegate/execute、system.integration.save/secret/validate/snapshot/mapping。保存输入同对应行字段+expected_revision；新建无id。submit输入form_id/values/title/company_id，当前操作者服务端绑定。

金额和额度保持字符串；输入不含userId/actor/role替身；列表联想、计数、详情、文件、日志与导出使用同一完整授权。系统配置不自动取得个人工资或医疗材料。
