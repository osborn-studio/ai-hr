import React, { useEffect, useId, useRef, useState } from 'react';
import { label, pageRows, text } from '../domain.mjs';

const paths = {
  wallet: 'M3 6h17v14H3z M3 6V3h14v3 M15 11h6v5h-6z',
  calendar: 'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4',
  chart: 'M4 3v18h17 M8 16v-5 M13 16V6 M18 16V9',
  people: 'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21v-3c0-4 14-4 14 0v3 M17 4c5 0 5 7 0 7 M19 15c3 0 3 3 3 5',
  building: 'M4 21V5l8-3 8 3v16 M2 21h20 M8 8h1 M15 8h1 M8 12h1 M15 12h1 M10 21v-5h4v5',
  book: 'M12 5C6 2 3 4 3 4v16s4-2 9 1c5-3 9-1 9-1V4s-3-2-9 1z M12 5v16',
  settings: 'M4 7h16 M4 17h16 M9 4v6 M16 14v6',
  link: 'M10 14l4-4 M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
  search: 'M20 20l-5-5 M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14z',
  arrow: 'M5 12h14 M13 6l6 6-6 6', close: 'M5 5l14 14 M19 5L5 19',
  menu: 'M3 6h18 M3 12h18 M3 18h18', exit: 'M10 4H4v16h6 M9 12h12 M16 7l5 5-5 5',
  check: 'M4 12l5 5L20 6', refresh: 'M20 8a8 8 0 1 0 0 8 M20 3v5h-5',
  lock: 'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4',
  home: 'M3 11l9-8 9 8 M5 9v12h14V9 M9 21v-7h6v7',
};
export function Icon({ name = 'arrow', size = 20, ...props }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] || paths.arrow}/></svg>; }
export function Badge({ value, children, tone }) { return <span className={`badge ${tone || (['confirmed', 'approved', 'active', true].includes(value) ? 'success' : ['draft', 'pending', 'blocked'].includes(value) ? 'warning' : '')}`}>{children || label(value)}</span>; }
export function Button({ children, variant = '', busy = false, disabled = false, type = 'button', ...props }) { return <button className={`button ${variant}`} type={type} aria-busy={busy || undefined} disabled={busy || disabled} {...props}>{busy ? <span className="spinner small"/> : null}{children}</button>; }
export function PageHeading({ eyebrow, title, description, actions }) { return <header className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="heading-actions">{actions}</div>}</header>; }
export function Notice({ children, tone = 'info' }) { return <div className={`notice ${tone}`} role={tone === 'danger' ? 'alert' : undefined}>{children}</div>; }
export function ErrorState({ error, retry }) { return <section className="state-panel error-state" role="alert"><div className="state-icon">!</div><h2>{error?.status === 403 ? '暂无访问权限' : '暂时无法读取'}</h2><p>{error?.message || '请稍后重试'}</p>{error?.code && <small>{error.code}{error.ref ? ` · ${error.ref}` : ''}</small>}{retry && <Button onClick={retry}><Icon name="refresh"/>重新读取</Button>}</section>; }
export function Loading({ children = '正在读取业务资料' }) { return <div className="state-panel loading" role="status"><span className="spinner"/><p>{children}</p></div>; }
export function EmptyState({ title = '暂无记录', children, action }) { return <div className="state-panel empty-state"><div className="state-icon">—</div><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>; }
export function Stat({ title, value, unit, icon, caption }) { return <div className="stat-card"><div className="stat-label">{title}{icon && <Icon name={icon}/>}</div><div className="stat-value">{value ?? '—'}{unit && <small>{unit}</small>}</div>{caption && <div className="stat-caption">{caption}</div>}</div>; }
export function Tabs({ items, value, onChange, label: ariaLabel = '页面分区' }) { return <nav className="tabs" aria-label={ariaLabel}>{items.map(item => <button key={item.id} type="button" className={value === item.id ? 'active' : ''} onClick={() => onChange(item.id)} aria-current={value === item.id ? 'page' : undefined}>{item.label}{item.count !== undefined && <span>{item.count}</span>}</button>)}</nav>; }

export function DataTable({ rows = [], columns, searchLabel = '搜索当前授权结果', searchPlaceholder = '输入姓名、编号或关键字', getKey = row => row.id, searchText, empty = '当前范围暂无记录', onRowClick, initialPageSize = 10, pagination, searchable = true }) {
  const [query, setQuery] = useState(''); const [page, setPage] = useState(1); const [size, setSize] = useState(initialPageSize);
  const view = pagination ? { rows, total: pagination.total, pages: Math.max(1, Math.ceil(pagination.total / pagination.pageSize)), page: pagination.page } : pageRows(rows, query, page, size, searchText);
  useEffect(() => setPage(1), [rows, query, size]);
  return <div className="data-table"><div className="table-toolbar">{searchable && <label className="search-field"><Icon name="search"/><input type="search" aria-label={searchLabel} placeholder={searchPlaceholder} value={query} onChange={e => setQuery(e.target.value)}/></label>}<span className="result-count">{query ? '筛选后 ' : ''}<b>{view.total}</b> 条</span></div><div className="table-scroll"><table><thead><tr>{columns.map(column => <th key={column.key} className={column.numeric ? 'numeric' : ''}>{column.title}</th>)}</tr></thead><tbody>{view.rows.map((row, index) => <tr key={getKey(row) ?? index}>{columns.map(column => <td key={column.key} className={column.numeric ? 'numeric' : ''}>{column.render ? column.render(row) : column.key === 'name' && onRowClick ? <button className="text-link" onClick={() => onRowClick(row)}>{text(row[column.key])}</button> : text(row[column.key])}</td>)}</tr>)}</tbody></table>{!view.rows.length && <EmptyState title={query ? '没有匹配的结果' : empty}>{query ? '可以更换关键字或清除筛选。' : '请切换工作范围或稍后刷新。'}</EmptyState>}</div><div className="table-pagination"><span>第 {view.page} / {view.pages} 页 <span className="subtle">· 本页 {view.rows.length} 条</span></span><label>每页<select aria-label="每页条数" value={pagination?.pageSize || size} onChange={e => pagination ? pagination.onPageSize(Number(e.target.value)) : setSize(Number(e.target.value))}>{[10, 15, 20, 30, 50].map(n => <option key={n} value={n}>{n}</option>)}</select></label><Button disabled={view.page <= 1} onClick={() => pagination ? pagination.onPage(view.page - 1) : setPage(view.page - 1)}>上一页</Button><Button disabled={view.page >= view.pages} onClick={() => pagination ? pagination.onPage(view.page + 1) : setPage(view.page + 1)}>下一页</Button></div></div>;
}

export function Modal({ title, children, onClose, wide = false }) {
  const ref = useRef(null); const id = useId();
  useEffect(() => { const dialog = ref.current; dialog.showModal(); const cancel = e => { e.preventDefault(); onClose(); }; dialog.addEventListener('cancel', cancel); return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); }; }, []);
  return <dialog ref={ref} aria-labelledby={id} className={`modal ${wide ? 'wide' : ''}`}><div className="modal-heading"><h2 id={id}>{title}</h2><button className="icon-button" aria-label="关闭对话框" onClick={onClose}><Icon name="close"/></button></div><div className="modal-body">{children}</div></dialog>;
}
export function useRemote(loader, key) {
  const [state, setState] = useState({ loading: true, data: null, error: null }); const [revision, reload] = useState(0);
  useEffect(() => { const controller = new AbortController(); let current = true; setState({ loading: true, data: null, error: null });
    Promise.resolve().then(() => loader(controller.signal)).then(data => { if (current) setState({ loading: false, data, error: null }); }).catch(error => { if (current && error.name !== 'AbortError') setState({ loading: false, data: null, error }); });
    return () => { current = false; controller.abort(); };
  }, [key, revision]);
  return { ...state, reload: () => reload(v => v + 1) };
}
