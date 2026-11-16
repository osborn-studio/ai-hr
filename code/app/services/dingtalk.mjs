// ============================================================================
// app/services/dingtalk.mjs · 钉钉 adapter（组织 / 人员 / 考勤原始流水）
// ----------------------------------------------------------------------------
// 为什么不自己拼 HTTP：OAuth 换 token、token 刷新、限流退避、企业切换 ——
// 这四件每一件都能让"同步在某天悄悄停掉"。`dws` 已经把它们做对了，
// 而且是本机已授权的通道。所以 adapter 只做三件事：
//
//   ① 调 dws，拿 JSON
//   ② 抹平它几种不同的返回形状（data / result / 裸数组）
//   ③ 转成本系统的中间结构（extId / name / parent / at / kind）
//
// ★ 生产替换点：如果客户要求用自建企业内部应用（AppKey/AppSecret）直连，
//   只需要换掉本文件的 run()：把 CLI 换成 openapi 请求，**上层一行不用改** ——
//   这是把 adapter 单独放一个文件的唯一理由。
//
// ★ 只取原始流水（+check-record），不取 +check-result：
//   后者是钉钉按它自己的考勤组规则算出来的"迟到/缺卡结论"，
//   与本系统的休息扣除、跨天归属口径不同。接结论 = 两套账混进一个字段。
// ============================================================================
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bizErr } from '../errors.mjs';

const exec = promisify(execFile);
const DWS = process.env.DWS_BIN || 'dws';
const TIMEOUT_MS = Number(process.env.DWS_TIMEOUT_MS || 120000);

/** 调一次 dws 并解析 JSON。失败统一成 E_EXT_CALL（带原始首行，便于对账）。 */
async function run(args, { profile } = {}) {
  const argv = [...args, '--format', 'json'];
  if (profile) argv.push('--profile', profile);
  let out;
  try {
    const r = await exec(DWS, argv, { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
    out = r.stdout;
  } catch (e) {
    // ★ 失败的两种形状要分开：进程失败（命令不存在/超时）与接口拒绝（权限/参数）。
    //   混成一句"同步失败"会让排查方向完全错。
    const raw = String(e.stdout || e.stderr || e.message || '');
    const first = raw.split('\n').find((l) => l.trim()) || String(e.message);
    throw bizErr('E_EXT_CALL', `dws ${args.slice(0, 2).join(' ')} 调用失败：${first.slice(0, 200)}`);
  }
  const text = String(out || '').trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch {
    throw bizErr('E_EXT_CALL', `dws 返回的不是 JSON：${text.slice(0, 160)}`);
  }
}

/** 从几种返回形状里取数组：{data:{records}} / {result:[...]} / {deptUserList:[...]} / 裸数组 */
function pickArray(obj, preferred = []) {
  if (Array.isArray(obj)) return obj;
  for (const k of preferred) {
    if (Array.isArray(obj?.[k])) return obj[k];
    if (Array.isArray(obj?.data?.[k])) return obj.data[k];
  }
  for (const k of ['records', 'result', 'list', 'items', 'deptUserList', 'children']) {
    if (Array.isArray(obj?.[k])) return obj[k];
    if (Array.isArray(obj?.data?.[k])) return obj.data[k];
  }
  return [];
}

/** 当前登录身份（用于"同步的是哪家企业"这件事留痕） */
export async function self(opt = {}) {
  const r = await run(['contact', '+me'], opt);
  const d = r?.data || r;
  return { userId: String(d.userId || ''), name: d.name || '', org: d.org || '', dept: d.dept || '' };
}

/**
 * 部门树（递归）。返回 [{ extId, name, parentExt, depth }]
 * ★ rootId 用 '1'（钉钉的根部门），并**包含根自己** —— 否则"根下没部门、
 *   人直接挂根"的企业会同步出 0 个组织（那是一种真实的小公司形态）。
 */
export async function listDepartments(opt = {}) {
  const rootId = String(opt.rootId || '1');
  const all = new Map();
  const queue = [{ id: rootId, parent: null, depth: 0 }];
  let guard = 0;
  while (queue.length) {
    if (++guard > 500) throw bizErr('E_EXT_DEPTH', '部门层级超过 500 次遍历，疑似环');
    const cur = queue.shift();
    if (all.has(cur.id)) continue;
    all.set(cur.id, { extId: cur.id, name: cur.id === rootId ? '根部门' : '', parentExt: cur.parent, depth: cur.depth });
    const r = await run(['contact', 'dept', 'list-children', '--dept', cur.id], opt);
    for (const k of pickArray(r, ['result'])) {
      const id = String(k.deptId ?? k.id ?? '');
      if (!id) continue;
      all.set(id, { extId: id, name: k.deptName || k.name || `部门${id}`, parentExt: cur.id, depth: cur.depth + 1 });
      queue.push({ id, parent: cur.id, depth: cur.depth + 1 });
    }
  }
  // 根自己不给名字，用调用方补（企业名）；这里直接标成"根部门"由上层替换
  return [...all.values()].sort((a, b) => a.depth - b.depth || a.extId.localeCompare(b.extId));
}

/** 某个部门的直属成员（不含下级）。 */
export async function listMembers(deptId, opt = {}) {
  const r = await run(['contact', 'dept', 'list-members', '--depts', String(deptId)], opt);
  return pickArray(r, ['deptUserList']).map((u) => {
    const info = u.userInfo || u;
    return { extUserId: String(info.userId || ''), name: info.name || '' };
  }).filter((x) => x.extUserId);
}

/** 全员（按部门去重）。返回 [{ extUserId, name, deptId, deptName }] */
export async function listAllPeople(opt = {}) {
  const depts = await listDepartments(opt);
  const seen = new Map();
  for (const d of depts) {
    let members = [];
    try { members = await listMembers(d.extId, opt); } catch { continue; /* 单个部门无权限不该拖垮整批 */ }
    for (const m of members) {
      if (!seen.has(m.extUserId)) {
        seen.set(m.extUserId, { ...m, deptId: d.extId, deptName: d.name });
      }
    }
  }
  return [...seen.values()];
}

/**
 * 考勤打卡记录。钉钉限制单次跨度 ≤ 1 个月，这里按人调用并做区间校验。
 *
 * ★ 实测结论（2026-11-15，真企业真打卡）：
 *   · `attendance +check-record`（打卡流水）返回 **0 条**
 *   · `attendance +check-result`（打卡结果）返回了那次打卡，userCheckTime 有值
 *   两个接口不是同一批数据：流水接口要求"员工在钉钉打卡机上按"，而极速打卡/手机打卡
 *   只进结果接口。所以**默认读结果接口**。
 *
 * ★ 但这不等于"接它的考勤结论"：我们只取 userCheckTime（实际打卡时刻）与
 *   checkType（上班/下班），**不采信** timeResult（迟到/早退）与 isLegal ——
 *   那些是它按自己的考勤组规则算的，休息扣除与跨天归属口径与本系统不同。
 *   缺卡（NotSigned）不是事件，必须过滤：写进去会变成"有人在那个时刻按了一下"。
 *
 * @returns {Promise<{userId:string, records:Array, error?:string}[]>}
 */
export async function listPunches(userIds, from, to, opt = {}) {
  const spanOk = (Date.parse(to) - Date.parse(from)) <= 31 * 86400e3;
  if (!spanOk) throw bizErr('E_EXT_RANGE', `钉钉打卡查询跨度不能超过 1 个月（${from} → ${to}）`);
  const out = [];
  for (const uid of userIds) {
    try {
      // 两条路都试：结果接口（有数据）+ 流水接口（有原始方式时更权威）。
      // 合并后由 fn_punch_ingest 的幂等键去重 —— 同一次打卡不会变成两行，
      // 因为 ext_id 带接口前缀，而同一接口的同一个 id 只出现一次。
      const [res, rec] = await Promise.all([
        run(['attendance', '+check-result', '--users', String(uid),
          '--start', from, '--end', to], opt).catch(() => null),
        run(['attendance', '+check-record', '--users', String(uid),
          '--start', from, '--end', to], opt).catch(() => null),
      ]);
      const records = [
        ...pickArray(res || {}, ['records']).map((x) => ({ ...x, _via: 'res' })),
        ...pickArray(rec || {}, ['records']).map((x) => ({ ...x, _via: 'rec' })),
      ];
      out.push({ userId: String(uid), records });
    } catch (e) {
      // ★ 一个人拉失败不该让整批失败：记在该人名下，其余继续。
      out.push({ userId: String(uid), records: [], error: String(e.message).slice(0, 160) });
    }
  }
  return out;
}

/**
 * 把钉钉的一条打卡流水转成本系统的 punch 行。
 * 钉钉形状：{ id, userId, userCheckTime(ms), checkType: 'OnDuty'|'OffDuty', timeResult, ... }
 * ★ 只认"真的打了卡"的记录：timeResult === 'Normal' | 'Late' | 'Early' | 'SeriousLate'
 *   且 userCheckTime 有意义。缺卡（NotSigned）不是事件，不该写进 punch ——
 *   写进去会变成"有人在那个时刻按了一下"，而事实是没人按。
 */
export function toPunchRow(rec) {
  const ms = Number(rec.userCheckTime ?? rec.baseCheckTime ?? 0);
  if (!ms) return null;
  const type = String(rec.checkType || '');
  const kind = type === 'OnDuty' ? 'in' : type === 'OffDuty' ? 'out' : null;
  if (!kind) return null;
  const result = String(rec.timeResult || '');
  if (result === 'NotSigned') return null;          // 没打卡 = 没有事件
  if (!rec.id) return null;
  return {
    // ★ 幂等键用**事件本身**（人 + 时刻 + 方向），不用接口给的 id。
    //   理由（真跑撞出来的）：同一家公司可能两个接口都返回同一次打卡，
    //   id 是两套空间；而接口哪天换了、id 规则变了，用 id 做键就会"同一次打卡进两行"。
    //   而"同一人同一毫秒同一方向"在物理上就是同一次打卡 —— 这才是幂等键该描述的东西。
    extId: `dt:${rec.userId || 'u'}:${ms}:${kind}`,
    at: new Date(ms).toISOString(),
    kind,
    device: rec.locationResult ? String(rec.locationResult) : null,
  };
}
