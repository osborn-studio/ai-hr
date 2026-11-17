export const PLATFORM_OPERATIONS = new Set([
  'system.operator.create', 'system.operator.update', 'system.operator.reset_password',
  'system.role.save', 'system.role.assign', 'system.role.revoke_member', 'system.grant.save', 'system.grant.revoke', 'system.form.save',
  'system.form.publish', 'system.workflow.save', 'system.workflow.publish',
  'system.instance.submit', 'system.instance.cancel', 'system.instance.decide', 'system.instance.transfer',
  'system.instance.delegate', 'system.instance.execute', 'system.integration.save',
  'system.integration.validate', 'system.integration.snapshot', 'system.integration.mapping',
]);
export const NODE_TYPES = [
  ['start', '开始'], ['approval', '审批'], ['condition', '条件分支'], ['notify', '抄送'], ['end', '结束'],
];
export const FIELD_TYPES = [
  ['text', '文本'], ['number', '数字'], ['money', '金额'], ['date', '日期'],
  ['person', '人员'], ['company', '公司'], ['select', '单选'], ['file', '附件'],
];
export const STATE_NAMES = {
  not_applicable: '通用表单无需业务入账', running: '审批中', applied: '已生效', disabled: '停用', retired: '已停用版本', unmatched: '未匹配', review: '待核对', confirmed: '已确认', conflict: '有冲突', partial: '部分完成', not_sent: '未发出', recorded: '已记录', unread: '未读', transferred: '已转交', delegated: '已委托', submitted: '已提交', 'task.created': '已生成待办', 'task.approved': '审批已通过', 'task.rejected': '审批已驳回', 'task.transferred': '已转交', 'task.delegated': '已委托', 'business.blocked':'业务来源变化待核','business.executed': '业务执行已核验', draft: '草稿', published: '已发布', pending: '待办理', approved: '已批准',
  rejected: '已驳回', cancelled: '已取消', active: '启用', inactive: '停用',
  completed: '已完成', executed: '业务已生效', blocked: '受阻待核', failed: '失败',
  unknown: '结果待核', not_verified: '未验证', unconfigured: '未配置', sent: '已发出', delivered: '已送达', read: '已读', not_configured: '未配置', configured: '已配置',
  simulated: '演示模拟', not_connected: '未连接', queued: '待执行', processing: '处理中',
};
export const list = value => Array.isArray(value) ? value : [];
export const identity = value => String(value ?? '');
export const clone = value => JSON.parse(JSON.stringify(value));
export function newKey(prefix, uuid = () => crypto.randomUUID()) { return prefix + '-' + uuid(); }
export function blankWorkflow(uuid) {
  const start = newKey('start', uuid), approval = newKey('approval', uuid), end = newKey('end', uuid);
  return { notification_policy:{applicant_on_result:true}, nodes: [{ id: start, type: 'start', label: '开始', x: 80, y: 110, next: approval }, { id: approval, type: 'approval', label: '审批人', x: 320, y: 110, next: end, mode: 'any', approver_ids: [], role_codes: [] }, { id: end, type: 'end', label: '结束', x: 560, y: 110 }] };
}
export function graphEdges(graph) {
  return list(graph?.nodes).flatMap(node => node.type === 'condition'
    ? list(node.branches).map((branch, index) => ({ from: node.id, to: branch.next, index, label: branch.else ? '其他情况' : [branch.when?.field, branch.when?.op, String(branch.when?.value ?? '')].join(' ') }))
    : node.next ? [{ from: node.id, to: node.next, label: '' }] : []);
}
export function validateWorkflow(graph) {
  const nodes = list(graph?.nodes), errors = [], ids = new Set(nodes.map(n => n.id));
  if (nodes.length < 3 || nodes.length > 128) errors.push('流程需要3至128个节点。');
  if (ids.size !== nodes.length) errors.push('节点编号重复。');
  if (nodes.filter(n => n.type === 'start').length !== 1) errors.push('流程必须有且只有一个开始节点。');
  if (nodes.filter(n => n.type === 'end').length !== 1) errors.push('流程必须有且只有一个结束节点。');
  for (const n of nodes) {
    if (!NODE_TYPES.some(([type]) => type === n.type)) errors.push('存在不支持的节点类型。');
    if (!String(n.label || '').trim()) errors.push('请填写节点名称。');
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) errors.push('节点坐标无效。');
    if (n.type === 'approval' && !list(n.approver_ids).length && !list(n.role_codes).length) errors.push(n.label + '：请选择审批人员或角色。');
    if (n.type === 'approval' && !['any', 'all'].includes(n.mode)) errors.push(n.label + '：请选择或签或会签。');
    if (n.type === 'condition') {
      const branches = list(n.branches);
      if (branches.filter(b => b.else === true).length !== 1) errors.push(n.label + '：必须配置一个兜底分支。');
      for (const b of branches) if (!b.else && (!b.when?.field || !['eq', 'gt', 'gte', 'in'].includes(b.when?.op))) errors.push(n.label + '：分支条件尚不完整。');
    } else if (n.type !== 'end' && !n.next) errors.push(n.label + '：请连接下一节点。');
    if (n.type === 'end' && n.next) errors.push('结束节点不能再连接下一节点。');
  }
  const edges = graphEdges(graph);
  for (const edge of edges) if (!edge.to || !ids.has(edge.to)) errors.push('存在未连接或指向已删除节点的连线。');
  const visited = new Set(), stack = new Set();
  const visit = id => { if (stack.has(id)) { errors.push('流程含循环连接，请改为有明确结束的路径。'); return; } if (visited.has(id)) return; visited.add(id); stack.add(id); edges.filter(e => e.from === id).forEach(e => visit(e.to)); stack.delete(id); };
  const start = nodes.find(n => n.type === 'start'); if (start) visit(start.id);
  if (nodes.some(n => !visited.has(n.id))) errors.push('存在从开始节点无法到达的节点。');
  return [...new Set(errors)];
}
export function connectNode(graph, sourceId, targetId, branchIndex) {
  if (sourceId === targetId) throw new Error('节点不能连接自身。');
  const result = clone(graph), source = result.nodes.find(n => n.id === sourceId), target = result.nodes.find(n => n.id === targetId);
  if (!source || !target || source.type === 'end' || target.type === 'start') throw new Error('此连接不适用。');
  if (source.type === 'condition') {
    if (!source.branches?.[branchIndex]) throw new Error('先在属性中选择要连接的分支。');
    source.branches[branchIndex].next = targetId;
  } else source.next = targetId;
  return result;
}
export function removeNode(graph, nodeId) {
  const result = clone(graph); result.nodes = result.nodes.filter(n => n.id !== nodeId);
  for (const n of result.nodes) { if (n.next === nodeId) delete n.next; for (const branch of list(n.branches)) if (branch.next === nodeId) delete branch.next; }
  return result;
}
export function validateForm(schema) {
  const errors = [], keys = new Set();
  for (const field of list(schema?.fields)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(field.key || '')) errors.push('字段编码需以小写字母开头，仅用字母、数字和下划线，最多64位。');
    if (keys.has(field.key)) errors.push('字段编码重复：' + field.key); keys.add(field.key);
    if (!String(field.label || '').trim()) errors.push('请填写字段名称。');
    if (!FIELD_TYPES.some(([type]) => type === field.type)) errors.push('字段类型无效。');
    if (field.type === 'select' && !list(field.options).length) errors.push(field.label + '：至少设置一个选项。');
    if (!['normal', 'restricted'].includes(field.sensitivity)) errors.push(field.label + '：请选择普通或受限字段。');
  }
  if (!keys.size) errors.push('表单至少需要一个字段。');
  return [...new Set(errors)];
}
export function parseFormValues(schema, values) {
  const result = {};
  for (const f of list(schema?.fields)) {
    const value = values[f.key];
    if(f.type==='file'&&value!==undefined&&value!==null&&(!Array.isArray(value)||f.required&&!value.length||value.length>10||value.some(x=>!/^pf:[0-9a-f-]{36}$/.test(x))))throw new Error('请选择'+f.label+'的已上传原件');
    if (f.required && (value === '' || value === undefined || value === null)) throw new Error('请填写' + f.label);
    if (value === '' || value === undefined || value === null) continue;
    if (['number', 'money'].includes(f.type) && !/^-?\d+(\.\d+)?$/.test(String(value))) throw new Error(f.label + '需为有效数字');
    // Keep exact decimal strings. Backend validates precision, bounds and authority.
    result[f.key] = value;
  }
  return result;
}
export function safeConnection(connection) {
  const allowed = ['id', 'provider', 'name', 'status', 'mode', 'enabled', 'secret_configured', 'secret_masked', 'connection_state', 'revision', 'organization_id', 'last_validated_at'];
  return Object.fromEntries(allowed.filter(key => connection?.[key] !== undefined).map(key => [key, connection[key]]));
}

export function businessLocalInput(value) {
  if (!value) return '';
  const parsed = new Date(value); if (Number.isNaN(parsed.valueOf())) return '';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed).replace(' ', 'T');
}
export function mergePageSelection(previous, pageRows, chosen) {
  const currentPage = new Set(pageRows.map(row => String(row.id)));
  return [...new Set([...list(previous).map(String).filter(id => !currentPage.has(id)), ...chosen.map(String)])];
}

export function fieldVisibilityLabel(access) {
  if (typeof access === 'string') return {denied:'不可见',allowed:'可见',read:'可读',write:'可读写'}[access] || access;
  return (typeof access === 'boolean' ? access : access?.allowed === true) ? '可见' : '不可见';
}

export const BUSINESS_TYPES = [['time_change','排班调整与跨店支援'],['time_punch_correction','补卡核定'],["payroll_finance", "工资资金与申报"], ["workforce_profile", "供应商资格与收款"], ["workforce_price", "合同价目"], ["workforce_contract", "供应商服务合同"], ["workforce_order", "供应商服务订单"], ["workforce_engagement", "服务人员关系"], ["workforce_acceptance", "服务量与工作地"], ["workforce_bill", "供应商对账"], ["workforce_opening", "供应商资金期初"], ["workforce_bank_receipt", "供应商银行事实"], ["workforce_advance", "供应商预付款"], ["workforce_payment", "供应商付款"], ["workforce_mandate", "个人代发授权"], ["workforce_instruction", "净工资代发指令"], ["workforce_personal_receipt", "逐人到账结果"],['personal_service','住宿与物品领用'],['general','普通表单'],['leave_request','请假申请'],['leave_lifecycle_proposal','假期权益核定'],['hr_change','入转调离办理'],['hr_requisition','招聘需求核定'],['hr_offer','录用条件核定'],['hr_contract_sign','合同签署登记'],['hr_contract_term','合同条款核定'],['payroll_source_preview','工资来源复核'],['payroll_batch','工资批次确认'],['performance_result','逐人成绩核准'],['learning_result','考试成绩核准'],['learning_application','培训考试结果应用']];
export const businessTypeLabel = value => BUSINESS_TYPES.find(([code]) => code === value)?.[1] || '其他业务（执行器待核验）';
