#!/usr/bin/env python3
"""演示库验收闸门（纯 HTTP，只读；不打开数据库、不写数据）。

用法：
    python3 code/tools/accept-demo.py           # 默认 http://127.0.0.1:8899，含 8 次串行 tree
    python3 code/tools/accept-demo.py 8890      # 指定端口
    python3 code/tools/accept-demo.py 8899 --no-perf   # 跳过 8 次连打（更快）

设计原则（今晚踩出来的）：
  1. **SKIP 不算通过**：拿不到可判定的数据（500/403/空）计 FAIL，不计 PASS。
  2. **观测带身份**：开始时记 PID + 数据目录 + uptime_s，结束时再记 PID；变了则整批标注作废。
  3. **不把会变的量当基线**：不判响应字节数；`gap` 用 `quota − subtree` 而非 `quota − headcount`。
  4. 退出码：全绿 0，否则 1。
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

PORT = int(next((a for a in sys.argv[1:] if a.isdigit()), int(os.environ.get('PORT', 8899))))
BASE = f'http://127.0.0.1:{PORT}'
PERF = '--no-perf' not in sys.argv

# v5 期望基准
EXP = dict(nodes=67, depts=60, regions=6,
           grp_quota=396, grp_alloc=394, grp_avail=2, grp_used=374, grp_hireable=2, grp_gap=22,
           cities=[('深圳', 149), ('上海', 121), ('广州', 56), ('珠海', 28), ('金华', 20), ('义乌', 20)],
           store_count=60, store_quota=388, store_short=14, store_hireables={0, 2, 3},
           stations=261, station_quota=283, station_gap=14, positions=14,
           runs=3, slips_per_run=374, print_groups=60, gross_total='2644512.00')

ok = fail = 0
lines = []


def rec(good, name, detail=''):
    global ok, fail
    if good:
        ok += 1
        lines.append(f'  [OK]   {name} {detail}')
    else:
        fail += 1
        lines.append(f'  [FAIL] {name} {detail}')


def call(path, token=None, method='GET'):
    req = urllib.request.Request(BASE + path, method=method)
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, json.loads(r.read()), dict(r.headers)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read()), dict(e.headers)
        except Exception:
            return e.code, {}, dict(e.headers)
    except Exception as e:
        return 0, {'error': str(e)}, {}


def login(uid, pwd):
    st, b, _ = call(f'/login?user={uid}&pwd={pwd}', method='POST')
    return b.get('token') if st == 200 else None


def sh(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return ''


pid0 = sh(f"lsof -nP -iTCP:{PORT} -sTCP:LISTEN -t")
dbdir = sh(f"lsof -p {pid0} 2>/dev/null | grep -oE '/tmp/[A-Za-z0-9_.-]+' | sort -u | head -1") if pid0 else ''
st, live, _ = call('/livez')
lines.append(f'=== 身份：PID={pid0 or "none"} DB={dbdir or "?"} '
             f'livez={st} uptime_s={live.get("uptime_s") if isinstance(live, dict) else "?"} ===')
if not pid0:
    lines.append('  [FAIL] 服务未监听 —— 后面全部无意义')
    print('\n'.join(lines))
    sys.exit(1)

T = {u: login(u, 'admin1234' if u == 1 else 'demo1234') for u in (1, 3, 5, 7, 67)}
rec(all(T.values()), '登录（admin/boss/薪酬/店长/店员）')

# ---- A. tree ----
st, tree, _ = call('/api/org/tree', T[1])
rows = tree.get('rows') or []
dept = [r for r in rows if r.get('kind') == 'dept']
reg = [r for r in rows if r.get('kind') == 'region']
grp = next((r for r in rows if r.get('kind') == 'group'), {})
rec(st == 200 and len(rows) == EXP['nodes'], 'tree 节点数', f'{len(rows)}/{EXP["nodes"]}')
rec(len(dept) == EXP['depts'], 'dept(=门店) 数', f'{len(dept)}')
rec(len(reg) == EXP['regions'], '城市数', f'{len(reg)}')
rec(sum(int(r.get('quota') or 0) for r in dept) == EXP['store_quota'],
    'Σ门店编', str(sum(int(r.get('quota') or 0) for r in dept)))
rec(sum(int(r.get('gap') or 0) for r in dept) == EXP['store_short'],
    'Σ门店 gap', str(sum(int(r.get('gap') or 0) for r in dept)))
rec(sum(int(r.get('stations') or 0) for r in dept) == EXP['stations'],
    'Σ档口实例', str(sum(int(r.get('stations') or 0) for r in dept)))
rec(sum(int(r.get('station_gap') or 0) for r in dept) == EXP['station_gap'],
    'Σ缺岗', str(sum(int(r.get('station_gap') or 0) for r in dept)))
# 父节点：gap 必须 == quota − subtree（不是 quota − headcount）
rec(grp.get('gap') == (grp.get('quota') or 0) - (grp.get('subtree') or 0),
    '集团 gap == quota − subtree',
    f'gap={grp.get("gap")} quota={grp.get("quota")} subtree={grp.get("subtree")} headcount={grp.get("headcount")}')
rec(grp.get('has_kids') is True and all(r.get('has_kids') is False for r in dept),
    'has_kids：父 true / 叶 false')

# ---- B. headcount 三层 ----
st, hc, _ = call('/api/headcount?period=2026-06', T[1])
h = {r['id']: r for r in hc.get('rows') or []}
g = h.get(grp.get('id'), {})
rec(st == 200 and g.get('quota') == EXP['grp_quota'], '集团 quota', str(g.get('quota')))
rec(g.get('allocated') == EXP['grp_alloc'], '集团 已分', str(g.get('allocated')))
rec(g.get('available') == EXP['grp_avail'], '集团 available', str(g.get('available')))
rec(g.get('used') == EXP['grp_used'], '集团 在编', str(g.get('used')))
rec(g.get('hireable') == EXP['grp_hireable'], '集团 可招', str(g.get('hireable')))
for name, quota in EXP['cities']:
    row = next((r for r in hc.get('rows') or [] if r.get('name') == name), {})
    rec(row.get('quota') == quota and row.get('available') == 1 and row.get('hireable') == 1,
        f'城市 {name}', f'quota={row.get("quota")} avail={row.get("available")} hire={row.get("hireable")}')
neg = [r for r in hc.get('rows') or [] if (r.get('hireable') or 0) < 0]
rec(not neg, '可招无负数', f'{len(neg)} 个负数节点')
stores = [r for r in (hc.get('rows') or []) if r.get('parent_id') not in (1, None) and (r.get('quota') or 0) > 0]
rec(len(stores) == EXP['store_count'], '有编门店数', str(len(stores)))
rec({r.get('hireable') for r in stores} == EXP['store_hireables'],
    '门店可招集合', str(sorted({r.get('hireable') for r in stores})))
rec(sum(int(r.get('quota') or 0) for r in stores) == EXP['store_quota'],
    'Σ门店编(headcount)', str(sum(int(r.get('quota') or 0) for r in stores)))

# ---- C. 工资条：行闸 + 金额 ----
for role, uid, exp_rows, eid in (('店长', 7, 1, 1), ('店员', 67, 1, 5), ('薪酬专员', 5, 374, None)):
    st, body, _ = call('/api/payroll/slips?run=1', T[uid])
    rr = body.get('rows') or []
    good = st == 200 and len(rr) == exp_rows
    if eid is not None:
        good = good and all(r.get('employee_id') == eid for r in rr)
    rec(good, f'{role} slips 行数', f'{len(rr)}/{exp_rows}')
    if rr:
        amt = rr[0]
        rec(amt.get('gross_amount') is not None and amt.get('net_amount') is not None,
            f'{role} 金额可见（self 口径）',
            f'gross={amt.get("gross_amount")} net={amt.get("net_amount")}')

# ---- D. 批次 / 打印 / 档口 / 岗位 ----
st, runs, _ = call('/api/payroll/runs', T[1])
rl = runs.get('rows') or []
rec(st == 200 and len(rl) == EXP['runs'], '批次期数', str(len(rl)))
for run in rl[:1]:
    st, sl, _ = call(f'/api/payroll/slips?run={run["id"]}', T[5])
    rr = sl.get('rows') or []
    tot = sum(float(x.get('gross_amount') or 0) for x in rr)
    rec(len(rr) == EXP['slips_per_run'], f'{run.get("period")} 工资条', str(len(rr)))
    rec(f'{tot:.2f}' == EXP['gross_total'], f'{run.get("period")} 应发合计', f'{tot:,.2f}')
    st, pr, _ = call(f'/api/payroll/print?run={run["id"]}', T[5])
    groups = (pr.get('groups') or pr.get('rows') or []) if isinstance(pr, dict) else []
    rec(st == 200 and len(groups) == EXP['print_groups'], f'{run.get("period")} 打印分组', str(len(groups)))
st, pos, _ = call('/api/positions', T[1])
rec(st == 200 and len(pos.get('rows') or []) == EXP['positions'], '岗位数', str(len(pos.get('rows') or [])))

# ---- E. 档口幂等（写但零变化） ----
st, idem, _ = call('/api/org/station/enable?store=3&station=1&from=2026-07-01', T[1], method='POST')
rec(st == 200 and idem.get('idempotent') is True and idem.get('from') and idem.get('requested_from'),
    'enable 幂等命中带 idempotent/from/requested_from',
    f'{json.dumps(idem, ensure_ascii=False)[:110]}')

# ---- F. 性能：/livez 基线 + 8 次串行 tree ----
if PERF:
    import time
    times = []
    for _ in range(8):
        t0 = time.time()
        call('/api/org/tree', T[1])
        times.append(time.time() - t0)
    first5, sixth = times[:5], times[5]
    rec(sixth < max(first5) * 2.5,
        'tree 第 6 次不劣化（plan-cache）',
        ' '.join(f'{t:.3f}' for t in times))

pid1 = sh(f"lsof -nP -iTCP:{PORT} -sTCP:LISTEN -t")
lines.append(f'=== 结束：PID={pid1} {"（未变，读数有效）" if pid0 == pid1 else "★变了，整批作废"} ===')

print('\n'.join(lines))
print(f'\n===== v5 验收：通过 {ok} · 失败 {fail} =====')
if fail:
    print('提示：SKIP/拿不到可判行一律计 FAIL —— "没失败"不等于"没测到"。')
sys.exit(0 if fail == 0 else 1)
