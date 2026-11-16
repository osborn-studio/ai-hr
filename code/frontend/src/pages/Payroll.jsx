import React, { useEffect, useState } from 'react';
import { withScope } from '../api.mjs';
import { amount, array, canWrite, date, label, same, text } from '../domain.mjs';
import { Badge, Button, DataTable, EmptyState, ErrorState, Icon, Loading, Modal, Notice, PageHeading, Stat, Tabs, useRemote } from '../components/UI.jsx';

const BASE = '/api/customer-payroll';
const payrollQuery = (path, scope) => withScope(BASE + path, scope);
export function PayrollPage(props) { return props.batchId ? <BatchPage key={props.batchId + props.scopeKey} {...props}/> : <BatchesPage {...props}/>; }

function BatchesPage({ api, scope, scopeKey, go }) {
  const state = useRemote(signal => api.request(payrollQuery('/batches', scope), { signal }), `batches:${scopeKey}`);
  const [period, setPeriod] = useState(''); const [status, setStatus] = useState('');
  if (state.loading) return <Loading/>;
  if (state.error) return <ErrorState error={state.error} retry={state.reload}/>;
  const all = array(state.data.batches); const batches = all.filter(b => (!period || b.period === period) && (!status || b.status === status));
  return <><PageHeading eyebrow="PAYROLL CENTER" title="工资计算" description="以工资批次核对人员、输入与规则版本，试算后再复核确认。" actions={<><Button onClick={() => go('payroll/rules')}>工资项目与方案</Button><Button onClick={state.reload}><Icon name="refresh" size={16}/>刷新</Button></>}/><div className="stats-grid"><Stat title="可见工资批次" value={all.length} unit="批" icon="wallet"/><Stat title="待复核" value={all.filter(b => b.status !== 'confirmed').length} unit="批" caption="确认状态不等同银行支付状态"/><Stat title="已确认" value={all.filter(b => b.status === 'confirmed').length} unit="批" caption="不同币种分别核算，不跨币种求和"/></div><section className="panel"><div className="panel-title"><h2>工资批次</h2><div className="inline-filters"><label>工资月<input aria-label="筛选工资月" type="month" value={period} onChange={e => setPeriod(e.target.value)}/></label><label>状态<select aria-label="筛选批次状态" value={status} onChange={e => setStatus(e.target.value)}><option value="">全部状态</option><option value="draft">草稿</option><option value="validated">已校验</option><option value="confirmed">已确认</option></select></label></div></div><DataTable rows={batches} columns={[
    { key: 'batch', title: '工资批次', render: b => <button className="stacked-link" onClick={() => go(`payroll/batch/${b.id}`)}><b>{b.label || `工资批次 ${b.id}`}</b><small>#{b.id} · {label(b.kind)}</small></button> },
    { key: 'period', title: '工资月' }, { key: 'currency', title: '币种' }, { key: 'region_code', title: '适用地区', render: b => label(b.region_code) },
    { key: 'row_count', title: '可见记录', numeric: true }, { key: 'status', title: '状态', render: b => <Badge value={b.status}/> },
    { key: 'scope', title: '范围', render: b => <span className={b.scope_complete ? 'subtle' : 'warning-text'}>{b.scope_complete ? '整批可见' : '局部可见'}</span> },
    { key: 'action', title: '', render: b => <button className="text-link" onClick={() => go(`payroll/batch/${b.id}`)}>进入核算 →</button> },
  ]} searchPlaceholder="搜索批次、月份、币种"/></section><Notice>新建与导入批次的统一页面尚在接入；本页读取实际业务服务返回的批次，不自动创建或填充工资。</Notice></>;
}

function BatchPage({ api, batchId, scope, scopeKey, session, go, notify }) {
  const state = useRemote(async signal => {
    const report = await api.request(payrollQuery(`/batches/${encodeURIComponent(batchId)}/report`, scope), { signal });
    let rules = [], rulesError = null;
    try { rules = array((await api.request(payrollQuery('/rules', { group_id: scope.group_id }), { signal })).rulesets); } catch (error) { if (error.name === 'AbortError') throw error; rulesError = error; }
    return { report, rules, rulesError };
  }, `batch:${batchId}:${scopeKey}`);
  const [tab, setTab] = useState('rows'); const [busy, setBusy] = useState(''); const [modal, setModal] = useState(null); const [lastAction, setLastAction] = useState(null); const [row, setRow] = useState(null);
  if (state.loading) return <Loading/>;
  if (state.error) return <ErrorState error={state.error} retry={state.reload}/>;
  const { report, rules, rulesError } = state.data; const { batch, rows = [], summary = {} } = report;
  const editable = canWrite(session.capabilities, 'payroll_run') && report.scope_complete && batch.status !== 'confirmed';
  const availableRules = rules.filter(rule => rule.currency === batch.currency && (!batch.region_code || rule.region === batch.region_code || rule.region === 'CUSTOM'));
  const post = async (action, input = {}) => {
    if (busy) return; setBusy(action); setLastAction(null);
    try { const result = await api.request(payrollQuery(`/batches/${encodeURIComponent(batchId)}/${action}`, scope), { method: 'POST', body: input }); setLastAction({ action, result }); setModal(null); state.reload(); notify(action === 'calculate' ? '试算请求已完成，请核对结果和待处理项。' : action === 'confirm' ? '批次已确认并锁定；银行支付状态另行记录。' : '校验请求已完成，请查看待处理项。'); }
    catch (error) { setLastAction({ error }); }
    finally { setBusy(''); }
  };
  const download = async () => {
    if (busy) return; setBusy('export'); try { const blob = await api.request(payrollQuery(`/batches/${encodeURIComponent(batchId)}/export.csv`, scope), { responseType: 'blob' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `工资_${batch.period}_${batch.currency}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (error) { setLastAction({ error }); } finally { setBusy(''); }
  };
  const issues = rows.flatMap(r => array(r.validation?.issues).map((issue, index) => ({ ...issue, id: `${r.id}:${index}`, person_name: r.full_name || r.source_data?.source_person_name || r.source_key })));
  return <><div className="back-row"><button className="text-link" onClick={() => go('payroll')}>← 工资计算</button></div><PageHeading eyebrow={`PAYROLL · ${batch.period} · ${batch.currency}`} title={batch.label || '工资批次'} description={report.notice} actions={<><Button busy={busy === 'export'} disabled={!!busy} onClick={download}>导出工资表</Button><Button disabled={!editable || !!busy || !!rulesError || !availableRules.length} onClick={() => setModal('calculate')}>按规则试算</Button><Button variant="primary" disabled={!editable || !!busy} onClick={() => setModal('confirm')}>复核并确认</Button></>}/><div className="batch-meta"><Badge value={batch.status}/><span>{label(batch.kind)}</span><span>{label(batch.region_code)}</span><span>批次 #{batch.id}</span><span>{report.scope_complete ? '整批可见' : '仅当前授权范围'}</span></div>{!report.scope_complete && <Notice tone="warning">当前显示局部范围，整批试算和确认已禁用。请切换到具备完整权限的批次范围。</Notice>}{lastAction?.error && <Notice tone="danger">{lastAction.error.code}：{lastAction.error.message}</Notice>}{rulesError && <Notice tone="warning">规则版本暂时无法读取：{rulesError.message}。试算功能暂不可用。</Notice>}<div className="stats-grid four"><Stat title="可见工资记录" value={rows.length} unit="条"/><Stat title="计算实发合计" value={rows.some(r => r.result) ? amount(summary.net_pay) : '待试算'} unit={batch.currency}/><Stat title="个人承担" value={rows.some(r => r.result) ? amount(summary.employee_contribution) : '—'} unit={batch.currency}/><Stat title="待处理项" value={issues.length} unit="项" caption="不将缺失结果视为核验通过"/></div><section className="panel"><Tabs value={tab} onChange={setTab} items={[{ id: 'rows', label: '工资明细', count: rows.length }, { id: 'issues', label: '核验与差异', count: issues.length }, { id: 'source', label: '来源与版本' }]}/>{tab === 'rows' ? <DataTable rows={rows} columns={[
    { key: 'person', title: '人员', render: r => <button className="stacked-link" onClick={() => setRow(r)}><b>{r.full_name || r.source_data?.source_person_name || '待匹配'}</b><small>{r.person_number || r.source_data?.source_person_number || r.source_key}</small></button> },
    { key: 'company_name', title: '公司 / 门店', render: r => r.company_name || r.source_data?.source_company_name || '待匹配' },
    { key: 'source', title: '来源实发', numeric: true, render: r => amount(r.source_data?.source_totals?.net_pay) },
    { key: 'calculated', title: '计算实发', numeric: true, render: r => amount(r.result?.totals?.net_pay) },
    { key: 'validation', title: '核验', render: r => <Badge tone={r.validation?.ok ? 'success' : 'warning'}>{r.validation?.ok ? '通过' : `${array(r.validation?.issues).length} 项待核`}</Badge> },
    { key: 'detail', title: '', render: r => <button className="text-link" onClick={() => setRow(r)}>查看明细</button> },
  ]} searchPlaceholder="搜索人员、工号、公司或来源键" searchText={r => `${r.full_name} ${r.person_number} ${r.company_name} ${r.source_key} ${r.source_data?.source_person_name || ''}`}/> : tab === 'issues' ? <div><div className="padded"><Button disabled={!editable || !!busy} busy={busy === 'validate'} onClick={() => post('validate')}>重新校验</Button></div><DataTable rows={issues} columns={[{ key: 'person_name', title: '人员' }, { key: 'code', title: '问题编码' }, { key: 'message', title: '待处理事项' }]} empty="接口未返回待处理项"/></div> : <div className="padded"><div className="facts-grid"><Fact label="工资月" value={batch.period}/><Fact label="地区 / 币种" value={`${label(batch.region_code)} / ${batch.currency}`}/><Fact label="规则版本" value={batch.ruleset_id ? `#${batch.ruleset_id}` : '未指定'}/><Fact label="确认时间" value={batch.confirmed_at || '未确认'}/><Fact label="来源适配" value={batch.metadata?.adapter}/><Fact label="来源SHA256" value={batch.metadata?.source_sha256 || '局部范围不展示'}/></div><Notice>批次确认、工资支付、供款及税务申报属于独立状态。本页尚未接入资金执行或申报回执。</Notice></div>}</section>{modal === 'calculate' && <CalculateModal rules={availableRules} currentId={batch.ruleset_id} busy={!!busy} error={lastAction?.error} onClose={() => setModal(null)} onSubmit={id => post('calculate', { ruleset_id: id })}/>} {modal === 'confirm' && <ConfirmModal busy={!!busy} error={lastAction?.error} onClose={() => setModal(null)} onSubmit={() => post('confirm')}/>} {row && <Modal title="工资记录明细" wide onClose={() => setRow(null)}><div className="row-detail-heading"><div><h3>{row.full_name || row.source_data?.source_person_name || '待匹配人员'}</h3><p>{row.company_name || '待匹配公司'} · {row.person_number || row.source_key}</p></div>{row.person_id && <Button onClick={() => { setRow(null); go(`people/detail/${row.person_id}`); }}>查看员工全貌<Icon name="arrow" size={16}/></Button>}</div><div className="facts-grid"><Fact label="计算实发" value={`${amount(row.result?.totals?.net_pay)} ${batch.currency}`}/><Fact label="来源实发" value={`${amount(row.source_data?.source_totals?.net_pay)} ${batch.currency}`}/></div><h4>计算工资项目</h4><DataTable rows={array(row.result?.items).map((item, i) => ({ ...item, id: i }))} columns={[{ key: 'code', title: '项目编码' }, { key: 'label', title: '名称', render: i => i.name || i.label || i.code }, { key: 'kind', title: '性质', render: i => label(i.kind) }, { key: 'amount', title: '金额', numeric: true, render: i => amount(i.amount) }]} empty="尚无计算工资项目"/><h4>输入与来源核验</h4><DataTable rows={Object.entries(row.effective_inputs || {}).map(([key, value]) => ({ id: key, key, value }))} columns={[{ key: 'key', title: '变量' }, { key: 'value', title: '输入值', render: r => text(r.value) }]} empty="未返回输入变量"/>{array(row.validation?.issues).length > 0 && <Notice tone="warning">{row.validation.issues.map((i, n) => <p key={n}>{i.code}：{i.message}</p>)}</Notice>}</Modal>}</>;
}

function Fact({ label, value }) { return <div className="fact"><span>{label}</span><b>{text(value)}</b></div>; }
function CalculateModal({ rules, currentId, onSubmit, onClose, busy, error }) {
  const [id, setId] = useState(currentId ? String(currentId) : '');
  const chosen = rules.find(r => same(r.id, id));
  return <Modal title="按规则版本试算" onClose={onClose}><p>本次试算会更新该批次的计算结果，来源快照保留。</p><label>工资规则版本<select value={id} onChange={e => setId(e.target.value)}><option value="">请选择同币种、同适用地区的规则</option>{rules.map(r => <option value={String(r.id)} key={r.id}>{r.name} · {label(r.status)} · #{r.id}</option>)}</select></label>{chosen && <Notice tone={chosen.status === 'approved' ? 'info' : 'warning'}>{chosen.status === 'approved' ? '使用已启用规则；试算后仍需核对并确认。' : '草稿规则仅供试算，不能据此确认工资。'}</Notice>}{error && <Notice tone="danger">{error.code}：{error.message}</Notice>}<div className="modal-actions"><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" busy={busy} disabled={!chosen} onClick={() => onSubmit(id)}>开始试算</Button></div></Modal>;
}
function ConfirmModal({ onSubmit, onClose, busy, error }) {
  const [ack, setAck] = useState(false);
  return <Modal title="确认并锁定工资批次" onClose={onClose}><Notice tone="warning">确认后本批次不可继续修改。服务端会再次核验权限、来源、规则和差异；确认不代表银行已支付。</Notice><label className="checkbox"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)}/>我已核对人员、工资项目和待处理差异，确认本次批次结果。</label>{error && <Notice tone="danger">{error.code}：{error.message}</Notice>}<div className="modal-actions"><Button onClick={onClose} disabled={busy}>返回检查</Button><Button variant="primary" busy={busy} disabled={!ack} onClick={onSubmit}>确认并锁定</Button></div></Modal>;
}

export function RulesPage({ api, scope, scopeKey }) {
  const state = useRemote(signal => api.request(payrollQuery('/rules', { group_id: scope.group_id }), { signal }), `rules:${scopeKey}`);
  const [selected, setSelected] = useState(null);
  useEffect(() => setSelected(null), [scopeKey]);
  if (state.loading) return <Loading/>;
  if (state.error) return <ErrorState error={state.error} retry={state.reload}/>;
  const rules = array(state.data.rulesets);
  const items = selected ? array(typeof selected.rules === 'string' ? JSON.parse(selected.rules) : selected.rules) : [];
  return <><PageHeading eyebrow="PAYROLL CONFIGURATION" title="工资项目与方案" description="查看业务服务中已有的工资规则版本。新版可视化公式与规则发布编辑器将另行接入。" actions={<Button onClick={state.reload}><Icon name="refresh" size={16}/>刷新</Button>}/><Notice>本页当前仅查看，不创建、启用或修改规则。地区与币种读取配置，不按品牌名称推断。</Notice><section className="panel"><DataTable rows={rules} columns={[{ key: 'name', title: '规则名称', render: r => <button className="text-link" onClick={() => setSelected(r)}>{r.name}</button> }, { key: 'region', title: '适用地区', render: r => label(r.region) }, { key: 'currency', title: '币种' }, { key: 'status', title: '状态', render: r => <Badge value={r.status}/> }, { key: 'created_at', title: '创建日期', render: r => date(r.created_at) }, { key: 'id', title: '版本编号', render: r => `#${r.id}` }]}/></section>{selected && <Modal title={selected.name} wide onClose={() => setSelected(null)}><div className="batch-meta"><Badge value={selected.status}/><span>{label(selected.region)} / {selected.currency}</span><span>版本 #{selected.id}</span></div>{selected.policy_notes && <Notice>{selected.policy_notes}</Notice>}<DataTable rows={items.map((item, i) => ({ ...item, id: i }))} columns={[{ key: 'code', title: '项目编码' }, { key: 'name', title: '项目名称', render: i => i.name || i.label || i.code }, { key: 'kind', title: '性质', render: i => label(i.kind) }, { key: 'formula', title: '计算表达式', render: i => <code className="formula">{formatFormula(i.formula)}</code> }]}/></Modal>}</>;
}
function formatFormula(ast) {
  if (typeof ast === 'string' || typeof ast === 'number' || typeof ast === 'boolean') return String(ast);
  if (!ast) return '—';
  if (ast.var) return ast.var;
  if (ast.value !== undefined) return String(ast.value);
  if (ast.op) return `${ast.op}(${array(ast.args).map(formatFormula).join(', ')})`;
  return JSON.stringify(ast);
}
