// ============================================================================
// app/services/signoff.mjs · 工资表会签（139）
// ----------------------------------------------------------------------------
// 只做四件事：看状态、发起、签字/提异议、封账。
// 所有判断都在库里（只能签自己那行、异议必须写原因、没签完不许封账）——
// 这一层只负责权限与参数，不在 JS 里重复一遍规则。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { run: 'payroll_run' };

const isId = (v) => Number.isInteger(v) && v > 0;

/** 会签状态 + 可选签字人列表（界面要渲染"这张表发给谁"） */
export async function status(tx, { userId, runId }) {
  await requireSession(tx, { userId, resource: RESOURCES.run, action: 'read' });
  if (!isId(runId)) throw bizErr('E_ARG_INVALID', 'run 必须是正整数（批次 id）');

  const run = (await tx.query(
    `SELECT id, period, status, sealed_at, sealed_by FROM pay_run WHERE id=$1`, [runId])).rows[0];
  if (!run) throw bizErr('E_RUN_NOT_FOUND', `批次 ${runId} 不存在`);

  const rows = (await tx.query(
    `SELECT id, role_code, role_name, seq, assignee, assignee_name, status,
            decided_at, decided_by_name, note, is_required, can_seal
       FROM fn_signoff_status($1) ORDER BY seq, role_code`, [runId])).rows;

  const roles = (await tx.query(
    `SELECT code, name, seq, default_user_id FROM pay_signoff_role
      WHERE is_active ORDER BY seq, code`)).rows;

  // 签字人候选：有薪酬读权限的账号。★ 不给全量账号 —— 会签人要能看到工资表，
  //   把"没有薪酬权限的人"列进去，等于让人选了却签不了（点了报 403，像系统坏了）。
  // ★ 候选签字人来自**登录身份表**（sys_user_credential），不是 sys_account：
  //   sys_account 是建帐开出来的档案，没走建帐的帐套会是空的 ——
  //   那样"可选签字人"列表空着，会签根本发不出去。
  const accounts = (await tx.query(
    `SELECT c.user_id AS id,
            COALESCE(a.display_name, '账号 ' || c.user_id) AS display_name
       FROM sys_user_credential c
       LEFT JOIN sys_account a ON a.id = c.user_id
      WHERE fn_role_can(c.user_id, 'payroll_run', 'read')
      ORDER BY c.user_id`)).rows;

  const canWrite = (await tx.query(
    `SELECT fn_role_can($1,'payroll_run','write') o`, [userId])).rows[0].o;

  // ★ 累计链条（143）：能不能封账不只看会签签完没有，还要看"本期之前都封了没有"。
  //   页面的按钮状态必须与库里封账门禁同一个判据 —— 否则人看着绿的按钮点下去报红，
  //   下一次他就会先来问"到底能不能封"，而不是相信这个页面。
  const chain = (await tx.query(
    `SELECT upstream_draft, downstream_sealed, stale_count, stale_names, can_seal, reason
       FROM fn_payrun_chain($1)`, [runId])).rows[0];

  const required = rows.length ? rows[0].is_required : null;
  const canSign = rows.length > 0
    ? rows.every(r => r.can_seal)
    : (run.status === 'draft' && required === false);
  return {
    run: { ...run, status: run.status },
    rows,
    roles,
    accounts,
    canWrite,
    // 能不能封账：与库里封账门禁同一个判据（rows[].can_seal 由同一个函数给出）
    chain,
    // canSeal        = 直接点就能封（会签过了 + 顺序对 + 无过期）
    // canSealConfirm = 能封，但要先确认（会签过了 + 顺序对 + 有人的累计过期）
    // ★ 分成两个而不是一个：门禁默认对"过期"拒，把"确认后放行"的出路也表达出来，
    //   否则页面上那条路根本点不到（按钮灰着），人只能去改库。
    canSeal: canSign && !!chain.can_seal,
    canSealConfirm: canSign && run.status === 'draft'
      && !chain.upstream_draft && Number(chain.stale_count) > 0,
    pending: rows.filter(r => r.status === 'pending').length,
    objected: rows.filter(r => r.status === 'objected').length,
  };
}

/** 发起 / 重新发起：users 是 {roleCode: accountId}，缺省用角色上的默认人 */
export async function start(tx, { userId, runId, users }) {
  await requireSession(tx, { userId, resource: RESOURCES.run, action: 'write' });
  if (!isId(runId)) throw bizErr('E_ARG_INVALID', 'run 必须是正整数');

  const u = users && typeof users === 'object' ? users : {};
  for (const [k, v] of Object.entries(u)) {
    if (!isId(Number(v))) throw bizErr('E_ARG_INVALID', `角色 ${k} 的签字人不是有效账号`);
  }
  const n = (await tx.query(
    `SELECT fn_signoff_start($1,$2,$3::jsonb) n`,
    [runId, String(userId), JSON.stringify(u)])).rows[0].n;
  return { run_id: runId, created: Number(n), _log: { run: runId, rows: Number(n) } };
}

/** 签字（ok=true）或提异议（ok=false，必须写意见） */
export async function decide(tx, { userId, id, ok, note }) {
  await requireSession(tx, { userId, resource: RESOURCES.run, action: 'write' });
  if (!isId(id)) throw bizErr('E_ARG_INVALID', 'id 必须是会签行 id');

  const st = (await tx.query(
    `SELECT fn_signoff_decide($1,$2,$3,$4) s`,
    [id, userId, !!ok, note ? String(note).trim() : null])).rows[0].s;
  return { id, status: st, _log: { signoff: id, status: st } };
}

/**
 * 封账：会签没签完会被库里拒（E_SIGNOFF_PENDING）；
 * 累计对不上前期时默认也拒（E_SEAL_CHAIN_STALE），要人显式确认（acceptStale）。
 * ★ 为什么"确认"要单独一个参数而不是服务层自己判断：知情同意是一个动作，
 *   不是一次计算。把它变成一个布尔入参，审计日志里才留得下"他确认过"。
 */
export async function seal(tx, { userId, runId, acceptStale }) {
  await requireSession(tx, { userId, resource: RESOURCES.run, action: 'write' });
  if (!isId(runId)) throw bizErr('E_ARG_INVALID', 'run 必须是正整数');
  await tx.query(`SELECT fn_pay_run_seal($1,$2,$3)`,
    [runId, String(userId), !!acceptStale]);
  const r = (await tx.query(
    `SELECT status, sealed_at, sealed_by FROM pay_run WHERE id=$1`, [runId])).rows[0];
  return { run_id: runId, status: r.status, sealed_by: r.sealed_by, _log: { run: runId, sealed: true } };
}
