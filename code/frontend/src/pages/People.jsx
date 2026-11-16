import React, { useEffect, useMemo, useState } from 'react';
import { array, companiesInScope, currentEmployment, date, label, personRows, same, text, within } from '../domain.mjs';
import { Badge, Button, DataTable, EmptyState, ErrorState, Icon, Loading, Notice, PageHeading, Stat, Tabs, useRemote } from '../components/UI.jsx';

const nameOf = (rows, id) => rows.find(row => same(row.id, id))?.name || '—';
const personColumns = go => [
  { key: 'person', title: '人员', render: row => <button className="person-link" onClick={() => go(`people/detail/${row.id}`)}><span className="mini-avatar">{(row.full_name || '员').slice(-2)}</span><span><b>{row.full_name}</b><small>{row.person_number}</small></span></button> },
  { key: 'company_names', title: '当前公司 / 门店' }, { key: 'department_names', title: '部门' }, { key: 'position_names', title: '岗位' },
  { key: 'employment_label', title: '任职状态', render: row => <Badge tone={row.active.length ? 'success' : ''}>{row.employment_label}</Badge> },
  { key: 'history', title: '关系记录', render: row => `${row.relationships.length} 段` },
];

export function PeoplePage({ data, scope, session, go }) {
  const [status, setStatus] = useState('all');
  const rows = useMemo(() => personRows(data, scope, session.me.today || ''), [data, scope, session.me.today]);
  const shown = status === 'active' ? rows.filter(r => r.active.length) : status === 'historical' ? rows.filter(r => !r.active.length) : rows;
  return <><PageHeading eyebrow="PEOPLE DIRECTORY" title="人事花名册" description="以永久人员编号识别同一个人，查看授权范围内的任职与经历。"/><div className="stats-grid"><Stat title="范围内人员" value={rows.length} unit="人" icon="people"/><Stat title="当前在职" value={rows.filter(r => r.active.length).length} unit="人"/><Stat title="多段经历" value={rows.filter(r => r.relationships.length > 1).length} unit="人" caption="按当前可见关系统计"/></div><section className="panel"><Tabs value={status} onChange={setStatus} items={[{ id: 'all', label: '全部人员', count: rows.length }, { id: 'active', label: '当前在职' }, { id: 'historical', label: '历史与待任职' }]}/><DataTable rows={shown} columns={personColumns(go)} searchPlaceholder="搜索姓名、永久编号、公司、部门、岗位" searchText={r => `${r.full_name} ${r.person_number} ${r.company_names} ${r.department_names} ${r.position_names} ${r.relationships.map(e => e.employee_no || '').join(' ')}`}/></section></>;
}

export function PersonPage({ api, personId, scopeKey, go, session }) {
  const state = useRemote(signal => api.request(`/api/foundation/people/${encodeURIComponent(personId)}/timeline`, { signal }), `person:${personId}:${scopeKey}`);
  const [tab, setTab] = useState('history');
  if (state.loading) return <Loading/>;
  if (state.error) return <ErrorState error={state.error} retry={state.reload}/>;
  const { person, employments = [] } = state.data;
  const active = employments.filter(e => currentEmployment(e, session.me.today));
  return <><div className="back-row"><button className="text-link" onClick={() => go('people')}>← 人事花名册</button></div><PageHeading eyebrow="EMPLOYEE PROFILE" title="员工全貌" description="显示当前账号有权查看的经历；永久人员身份不会随调店或复聘改变。"/><section className="person-profile panel"><span className="profile-avatar">{(person.full_name || '人员').slice(-2)}</span><div><h2>{person.full_name}<Badge tone={active.length ? 'success' : ''}>{active.length ? '有在职关系' : '历史 / 待任职'}</Badge></h2><p>永久人员编号 <b>{person.person_number}</b></p><small>人员ID {person.id}</small></div><div className="profile-summary"><b>{employments.length}<small>段可见关系</small></b><b>{active.length}<small>段当前在职</small></b></div></section><section className="panel"><Tabs value={tab} onChange={setTab} items={[{ id: 'history', label: '入离职与任职经历', count: employments.length }, { id: 'identity', label: '基本资料' }, { id: 'related', label: '其他业务资料' }]}/>{tab === 'history' ? <div className="employment-timeline">{employments.length ? employments.map(e => <article key={e.id} className="employment-card"><span className="timeline-dot"/><header><div><h3>{e.company_name}</h3><small>{e.ledger_name}</small></div><Badge value={e.status}/></header><div className="facts-grid"><Fact label="入职日期" value={date(e.hire_date)}/><Fact label="离职日期（含当天）" value={e.leave_date ? date(e.leave_date) : '未结束'}/><Fact label="用工类型" value={label(e.employment_type)}/><Fact label="实际雇佣主体" value={e.legal_subject_name || '待核实'}/></div>{array(e.assignments).length ? <div className="assignment-list">{e.assignments.map(a => <div key={a.id}><span className="assignment-period">{date(a.valid_from)} — {a.valid_to ? date(a.valid_to) : '持续'}</span><b>{a.position_name}</b><span>{a.department_name}{a.work_area_name ? ` / ${a.work_area_name}` : ''}</span><Badge>{a.is_primary ? '主任职' : '兼任'}</Badge></div>)}</div> : <p className="subtle">此雇佣段暂无已返回的任职记录。</p>}</article>) : <EmptyState title="暂无可查看的雇佣经历"/>}</div> : tab === 'identity' ? <div className="facts-grid padded"><Fact label="姓名" value={person.full_name}/><Fact label="永久人员编号" value={person.person_number}/><Fact label="人员状态" value={label(person.status)}/><Fact label="创建时间" value={date(person.created_at)}/></div> : <div className="padded"><Notice>合同、薪酬、考勤、绩效、培训及证件将统一穿透到此页；目前人员详情接口仅返回基本资料和任职经历，此处不生成其他模块记录。</Notice></div>}</section></>;
}

function Fact({ label, value }) { return <div className="fact"><span>{label}</span><b>{text(value)}</b></div>; }

export function OrganizationPage({ data, scope, session, go }) {
  const [mode, setMode] = useState('department'); const [selected, setSelected] = useState(null); const [query, setQuery] = useState('');
  useEffect(() => { setSelected(null); setQuery(''); }, [scope.group_id, scope.ledger_id, scope.company_id]);
  const companies = useMemo(() => companiesInScope(data, scope), [data, scope]);
  const companyIds = new Set(companies.map(c => String(c.id)));
  const departments = array(data.departments).filter(d => companyIds.has(String(d.company_id)));
  const people = useMemo(() => personRows(data, scope, session.me.today || ''), [data, scope, session.me.today]);
  const selectedPosition = selected?.type === 'position' ? array(data.positions).find(p => same(p.id, selected.id)) : null;
  const selectedDepartment = selectedPosition ? departments.find(d => same(d.id, selectedPosition.department_id)) : selected?.type === 'department' ? departments.find(d => same(d.id, selected.id)) : null;
  const selectedCompany = selected?.type === 'company' ? companies.find(c => same(c.id, selected.id)) : selectedDepartment ? companies.find(c => same(c.id, selectedDepartment.company_id)) : null;
  const selectedRows = people.filter(p => p.active.length > 0).filter(p => selectedPosition ? p.assignments.some(a => same(a.position_id, selectedPosition.id)) : selectedDepartment ? p.assignments.some(a => same(a.department_id, selectedDepartment.id)) : selectedCompany ? p.active.some(e => within(companies, e.company_id, selectedCompany.id)) : true);
  const findText = query.trim().toLocaleLowerCase();
  const roots = companies.filter(c => !companyIds.has(String(c.parent_company_id)));
  const matchCompany = company => !findText || companies.some(c => within(companies, c.id, company.id) && `${c.name} ${c.code}`.toLocaleLowerCase().includes(findText)) || departments.some(d => within(companies, d.company_id, company.id) && `${d.name} ${d.code}`.toLocaleLowerCase().includes(findText)) || array(data.positions).some(p => within(companies, p.company_id, company.id) && `${p.name} ${p.code}`.toLocaleLowerCase().includes(findText));
  const companyNode = (company, visited = new Set()) => {
    if (visited.has(String(company.id)) || !matchCompany(company)) return null;
    const seen = new Set([...visited, String(company.id)]);
    const children = companies.filter(c => same(c.parent_company_id, company.id));
    const ownedDepartments = departments.filter(d => same(d.company_id, company.id));
    const ownIds = new Set(ownedDepartments.map(d => String(d.id)));
    const deptNode = (department, seenDepartments = new Set()) => {
      if (seenDepartments.has(String(department.id))) return null;
      const next = new Set([...seenDepartments, String(department.id)]);
      const positions = array(data.positions).filter(p => same(p.department_id, department.id));
      return <li key={`d:${department.id}`}><button className={`tree-node department ${same(selectedDepartment?.id, department.id) ? 'active' : ''}`} onClick={() => setSelected({ type: 'department', id: department.id })}><span className="tree-symbol">◇</span><span>{department.name}</span>{mode === 'position' && <small>{positions.length} 岗位</small>}</button>{mode === 'position' && <ul>{positions.map(position => <li key={`p:${position.id}`}><button className={`tree-node position ${same(selectedPosition?.id, position.id) ? 'active' : ''}`} onClick={() => setSelected({ type: 'position', id: position.id })}><span>⊞</span><span>{position.name}</span></button></li>)}</ul>}{ownedDepartments.some(d => same(d.parent_department_id, department.id)) && <ul>{ownedDepartments.filter(d => same(d.parent_department_id, department.id)).map(d => deptNode(d, next))}</ul>}</li>;
    };
    return <li key={`c:${company.id}`}><details open><summary><button className={`tree-node ${selected?.type === 'company' && same(selected.id, company.id) ? 'active' : ''}`} onClick={e => { e.preventDefault(); setSelected({ type: 'company', id: company.id }); }}><Icon name="building" size={17}/><span>{company.name}</span><small>{{ group: '集团', brand: '品牌公司', store: '门店' }[company.org_level] || '公司'}</small></button></summary><ul>{ownedDepartments.filter(d => !ownIds.has(String(d.parent_department_id))).map(d => deptNode(d))}{children.map(c => companyNode(c, seen))}</ul></details></li>;
  };
  return <><PageHeading eyebrow="ORGANIZATION" title="人事组织架构" description="选择组织、部门或岗位，查看明细与关联人员。"/><div className="organization-layout"><section className="panel organization-tree"><div className="panel-title"><h2>组织导航</h2><span>{companies.length} 个组织</span></div><div className="padded compact"><label className="search-field"><Icon name="search" size={16}/><input aria-label="搜索组织" placeholder="搜索公司、门店或部门" value={query} onChange={e => setQuery(e.target.value)}/></label></div><Tabs value={mode} onChange={setMode} items={[{ id: 'department', label: '部门维度' }, { id: 'position', label: '岗位维度' }]}/><div className="tree-scroll"><button className={`tree-node group-root ${!selected ? 'active' : ''}`} onClick={() => setSelected(null)}><Icon name="building"/><span>{nameOf(array(data.groups), scope.group_id)}</span></button><ul className="org-tree">{roots.map(c => companyNode(c))}</ul>{!roots.length && <EmptyState title="当前范围没有组织"/>}</div></section><section className="panel organization-detail"><div className="panel-title"><div><span className="eyebrow">组织详情</span><h2>{selectedPosition?.name || selectedDepartment?.name || selectedCompany?.name || '当前组织范围'}</h2></div><Badge>{selectedPosition ? '岗位' : selectedDepartment ? '部门' : selectedCompany ? '组织公司' : '集团范围'}</Badge></div><div className="facts-grid padded"><Fact label="编码" value={selectedPosition?.code || selectedDepartment?.code || selectedCompany?.code || '当前范围'}/><Fact label="上级组织" value={selectedPosition ? selectedDepartment?.name : selectedDepartment ? selectedCompany?.name : nameOf(companies, selectedCompany?.parent_company_id)}/><Fact label="独立法定主体" value={selectedCompany?.legal_name || '未核实 / 未返回'}/><Fact label="地点" value={selectedCompany?.address || '未填写'}/></div><div className="section-label">关联人员 <span>{selectedRows.length} 人 · 当前可见在职关系</span></div><DataTable rows={selectedRows} columns={personColumns(go).filter(c => !['department_names', 'history'].includes(c.key))} searchPlaceholder="搜索关联人员"/></section></div></>;
}
