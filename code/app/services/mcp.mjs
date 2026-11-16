// ============================================================================
// app/services/mcp.mjs · 开放层：AI 不能直接改数据，只能"预览 → 执行"
// ----------------------------------------------------------------------------
// 这一层存在的理由只有一条，而它几乎总被做成一句建议：
//
//   「建议 AI 先调用 dryRun 看一下影响面，再执行。」
//
// 建议会被跳过。模型会、脚本会、人赶时间时更会。所以这里的规矩是：
// **没有 plan 的写操作，数据库直接拒**（`fn_mcp_execute` ①）。这一层做的不是
// "再检查一遍"，而是**替调用方把 plan 造出来并绑死参数**：
//
//   plan(args)  →  sys_mcp_plan 里一行：工具名 + 参数摘要 + 影响面 + ttl
//   execute     →  摘要必须一致（改一个参数就 E_MCP_ARGS_CHANGED）
//                  只能用一次（E_MCP_PLAN_USED）
//                  过期作废（E_MCP_PLAN_EXPIRED）
//                  影响面超阈值 → 转人工（E_MCP_OVER_THRESHOLD，拒绝而不是提示）
//
// ★ 摘要用**规范化 JSON**（键排序）算。不做规范化的话，`{a:1,b:2}` 与
//   `{b:2,a:1}` 会得到两个摘要，于是"参数没变"这件事判不出来 —— 而它正是
//   防止"预览 10 条、执行 1000 条"的唯一依据。
//
// ★ 只读那半边（047）：开放层是同一份数据的**第二个门**。所以只读工具
//   **不自己写 SQL**，一律复用同一个服务函数 —— 掩码与行闸只有一份实现。
//   自己再写一条 SELECT，就是把"列表页掩了、MCP 没掩"这条路留出来。
//   只读也落审计（shift_run=false）：泄露是通过读发生的。
// ============================================================================
import crypto from 'node:crypto';
import { bizErr } from '../errors.mjs';
import * as attendance from './attendance.mjs';
import * as payroll from './payroll.mjs';
import * as leave from './leave.mjs';
import * as headcount from './headcount.mjs';

/** 键排序后的规范化 JSON —— 摘要必须与键序无关 */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

/** sha256 摘要，落成 bytea（库里 args_digest 是 bytea，不是 text）
 *  ★ 必须传 Uint8Array（Buffer），不能传 '\\x...' 字符串：
 *    PGlite 的 bytea 序列化器只接受二进制，传字符串会在参数绑定处报
 *    "Invalid input for bytea type" —— 而这个错发生在**发送前**，
 *    看起来像服务故障，实际是类型不匹配。 */
function digestOf(args) {
  return crypto.createHash('sha256').update(canon(args), 'utf8').digest();
}

/**
 * 工具目录。
 * ★ 只登记**真的接上了**的工具。放一个没有实现的工具进目录，
 *   AI 会调用它、拿到"成功"、而数据没有变化 —— 那比报错坏得多。
 *
 * 每个工具三种字段之一：
 *   write: true  → preview + exec（两阶段写）
 *   write: false → run（只读，仍审计）
 *   optional     → 可缺省的参数（只读工具常见）
 */
export const TOOLS = {
  // -------------------------------------------------------------------------
  // 只读：不建 plan，但落审计、且必须过同一道门（行闸 + 掩码）
  // -------------------------------------------------------------------------
  attendance_query: {
    write: false,
    title: '查考勤人日（只返回调用者有权看的门店）',
    args: [],
    run: async (tx, a, actorId) => attendance.listDaily(tx, { userId: actorId }),
  },

  leave_balance: {
    write: false,
    // ★ 只查**调用者本人**。查别人的额度需要一条"代理他人"的授权模型，
    //   而那套模型现在不存在 —— 假装它存在（收 employee_id 却不校验）比不收更坏。
    title: '查我自己的假期额度（含可用/冻结/已用/过期四态）',
    args: [],
    run: async (tx, a, actorId) => leave.getBalance(tx, { userId: actorId }),
  },

  payslip_summary: {
    write: false,
    title: '查某批次的工资条（受字段掩码约束，与页面同一份实现）',
    args: ['run_id'],
    // ★ 这一行就是"掩码只有一份"的证据：不重写掩码，直接调 listSlips。
    run: async (tx, a, actorId) => payroll.listSlips(tx, { userId: actorId, runId: a.run_id }),
  },

  headcount_query: {
    write: false,
    title: '查某期间的编制（额度/已下分/可招/占编 同屏）',
    args: ['period'],
    run: async (tx, a, actorId) => {
      const v = await headcount.view(tx, { userId: actorId, period: a.period });
      return v.rows;
    },
  },

  // -------------------------------------------------------------------------
  // 写入：两条，证明"多一个写工具"的门槛是**再写一遍预览**
  // -------------------------------------------------------------------------
  leave_apply: {
    write: true,
    title: '代员工提交请假申请',
    args: ['employee_id', 'leave_type_id', 'qty', 'date_from', 'date_to'],
    // 预览：这一批会动到几张单、影响谁。写之前能看见的，才叫预览。
    preview: async (tx, a) => {
      const bal = (await tx.query(
        `SELECT available FROM v_leave_balance WHERE employee_id=$1 AND leave_type_id=$2`,
        [a.employee_id, a.leave_type_id])).rows[0];
      return {
        affected_count: 1,
        diff: [{
          employee_id: a.employee_id, leave_type_id: a.leave_type_id, qty: a.qty,
          available_before: bal?.available ?? null,
          available_after: bal ? Number(bal.available) - Number(a.qty) : null,
          date_from: a.date_from, date_to: a.date_to,
        }],
      };
    },
    exec: async (tx, a, actor) => {
      const r = await tx.query('SELECT fn_leave_apply($1,$2,$3,$4::date,$5::date) id',
        [a.employee_id, a.leave_type_id, a.qty, a.date_from, a.date_to]);
      return { request_id: Number(r.rows[0].id), actor };
    },
  },

  headcount_set: {
    write: true,
    title: '调整某组织的编制额度（追加一个版本）',
    args: ['org_id', 'period', 'quota', 'reason'],
    // 预览必须回答三个问题：改前多少、改后多少、**会不会超编或超上级额度**。
    // 只回"影响 1 行"的预览是橡皮图章。
    preview: async (tx, a) => {
      const cur = (await tx.query(
        `SELECT fn_hc_quota($1,$2) quota, fn_hc_allocated($1,$2) allocated,
                fn_hc_used($1,$2) used, fn_hc_available($1,$2) available`,
        [a.org_id, a.period])).rows[0];
      const org = (await tx.query(
        'SELECT parent_id, name FROM org_unit WHERE id=$1', [a.org_id])).rows[0];
      const parent = org?.parent_id ? (await tx.query(
        `SELECT fn_hc_available($1,$2) available, fn_hc_quota($1,$2) quota`,
        [org.parent_id, a.period])).rows[0] : null;

      const delta = Number(a.quota) - Number(cur.quota ?? 0);
      return {
        // 影响面 = 1 个组织。但真正要看见的是下面三个判断。
        affected_count: 1,
        diff: [{
          org_id: a.org_id, org_name: org?.name ?? null, period: a.period,
          quota_before: cur.quota, quota_after: a.quota, delta,
          allocated: cur.allocated, used: cur.used,
          // 改完会不会出现"下分超过额度"
          over_allocated_after: Number(a.quota) < Number(cur.allocated ?? 0),
          // 增量会不会超出上级可下分的余量
          parent_available: parent?.available ?? null,
          parent_available_after: parent ? Number(parent.available) - delta : null,
          parent_short: parent ? Number(parent.available) - delta < 0 : false,
        }],
      };
    },
    exec: async (tx, a, actor, actorId) => {
      const r = await headcount.setBudget(tx, {
        userId: actorId, orgId: a.org_id, period: a.period,
        quota: a.quota, reason: a.reason,
      });
      return { ...r, actor };
    },
  },

  // -------------------------------------------------------------------------
  // 工资项与公式：给 AI 用的四个口子
  // -------------------------------------------------------------------------
  // ★ 为什么 AI 需要"试算"这个只读工具：模型写公式一定会写错几次，
  //   而"改完直接算薪"是最坏的验证方式（钱已经发了）。
  //   试算让它自己闭环：写 → 试 → 改，人只在最后确认一次。
  salary_items: {
    write: false,
    title: '列出工资项（含公式、类型、排序）与可用函数/变量',
    args: [],
    run: async (tx) => ({
      items: (await tx.query(
        `SELECT code, name, item_kind, formula, sort_order, is_active
           FROM salary_item ORDER BY sort_order, code`)).rows,
      funcs: (await tx.query(`SELECT * FROM fn_formula_funcs()`)).rows,
      builtin_vars: ['MONTHLY', 'COMMISSION', 'PRESENT_DAYS', 'WORK_DAYS',
                     'LEAVE_DAYS', 'SI_BASE', 'TAX_THRESHOLD'],
      script_syntax: '多行：`名字 = 表达式` 累积中间变量，`return 表达式` 给结果；每行仍是白名单表达式，无循环无 IO',
    }),
  },

  salary_formula_preview: {
    write: false,
    title: '试算一个公式/脚本（可给多组变量，一次看多档结果）',
    args: ['formula', 'samples'],
    // samples: [{ "MONTHLY": 13000, "POST_ALLOW": 3000 }, ...]
    run: async (tx, a) => {
      const allow = {};
      for (const r of (await tx.query(`SELECT code FROM salary_item`)).rows) allow[r.code] = true;
      const err = (await tx.query(`SELECT fn_formula_script_try($1,$2::jsonb) e`,
        [a.formula, JSON.stringify(allow)])).rows[0].e;
      if (err) return { ok: false, error: String(err).split('\n')[0], samples: [] };
      const out = [];
      for (const vars of (Array.isArray(a.samples) && a.samples.length ? a.samples : [{}])) {
        try {
          const v = (await tx.query(`SELECT fn_formula_script_eval($1,$2::jsonb) v`,
            [a.formula, JSON.stringify(vars)])).rows[0].v;
          out.push({ vars, value: Number(v) });
        } catch (e) {
          out.push({ vars, error: String(e.message).split('\n')[0] });
        }
      }
      return { ok: true, samples: out };
    },
  },

  salary_item_plan: {
    write: true,
    title: '新建/修改一个工资项（预览会给出：改前改后、试算结果、谁在用它）',
    args: ['code', 'name', 'formula', 'kind', 'sort_order'],
    preview: async (tx, a) => {
      const code = String(a.code || '').toUpperCase();
      const before = (await tx.query(
        `SELECT code, name, item_kind, formula, sort_order, is_active
           FROM salary_item WHERE code = $1`, [code])).rows[0] || null;
      const allow = {};
      for (const r of (await tx.query(`SELECT code FROM salary_item`)).rows) allow[r.code] = true;
      allow[code] = true;
      const formula = String(a.formula || '').trim();
      const err = formula
        ? (await tx.query(`SELECT fn_formula_script_try($1,$2::jsonb) e`,
            [formula, JSON.stringify(allow)])).rows[0].e
        : null;
      // 试算：用一份"看起来正常"的样例，让人和 AI 都能看到这个公式大概出多少
      let sample = null;
      if (formula && !err) {
        const vars = { MONTHLY: 13000, POST_ALLOW: 3000, MEAL: 600, COMM: 400,
                       COMMISSION: 2000, PRESENT_DAYS: 21, WORK_DAYS: 21.75 };
        const v = (await tx.query(`SELECT fn_formula_script_eval($1,$2::jsonb) v`,
          [formula, JSON.stringify(vars)])).rows[0].v;
        sample = { vars, value: Number(v) };
      }
      // 谁在用它：已经写进工资条的项目不能被悄悄改语义（历史解释不了）
      const used = Number((await tx.query(
        `SELECT count(*)::int n FROM payslip_item WHERE item_code = $1`, [code])).rows[0].n);
      return {
        affected_count: 1,
        diff: [{
          code,
          before: before ? { name: before.name, item_kind: before.item_kind,
                             formula: before.formula, sort_order: before.sort_order } : null,
          after: { name: a.name, formula: formula || null,
                   kind: formula ? 'formula' : (a.kind || 'fixed'),
                   sort_order: Number(a.sort_order ?? 100) },
          formula_error: err ? String(err).split('\n')[0] : null,
          sample,
          used_in_payslips: used,
          warns: [
            err ? '公式没通过校验，exec 会拒绝' : null,
            used > 0 ? `这个项目已经出现在 ${used} 条工资条明细里，改语义会让历史对不上（建议新建一项）` : null,
          ].filter(Boolean),
        }],
      };
    },
    exec: async (tx, a, actor) => {
      const code = String(a.code || '').toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{1,23}$/.test(code)) throw bizErr('E_ITEM_CODE', '代码不规范');
      const formula = String(a.formula || '').trim();
      const allow = {};
      for (const r of (await tx.query(`SELECT code FROM salary_item`)).rows) allow[r.code] = true;
      allow[code] = true;
      if (formula) {
        const err = (await tx.query(`SELECT fn_formula_script_try($1,$2::jsonb) e`,
          [formula, JSON.stringify(allow)])).rows[0].e;
        if (err) throw bizErr('E_FORMULA', String(err).split('\n')[0]);
      }
      const kind = formula ? 'formula' : (['fixed','variable','statistic'].includes(a.kind) ? a.kind : 'fixed');
      await tx.query(
        `INSERT INTO salary_item(code,name,item_kind,formula,sort_order,is_active,note)
         VALUES ($1,$2,$3,$4,$5,true,$6)
         ON CONFLICT (code) DO UPDATE
           SET name=EXCLUDED.name, item_kind=EXCLUDED.item_kind, formula=EXCLUDED.formula,
               sort_order=EXCLUDED.sort_order, note=EXCLUDED.note`,
        [code, a.name, kind, formula || null, Number(a.sort_order ?? 100), `由 ${actor} 通过开放层修改`]);
      return { code, item_kind: kind };
    },
  },

  salary_rules: {
    write: false,
    title: '列出计算规则（算薪前拦截 / 算薪后告警）与最近的命中记录',
    args: [],
    run: async (tx) => ({
      rules: (await tx.query(
        `SELECT code, name, stage, formula, action, message, is_active, sort_order
           FROM salary_rule ORDER BY sort_order, code`)).rows,
      recent_hits: (await tx.query(
        `SELECT rule_code, stage, action, message, person_id, hit_at
           FROM salary_rule_hit ORDER BY id DESC LIMIT 20`)).rows,
    }),
  },

  // -------------------------------------------------------------------------
  // 未休年假折现（129）：给 AI 的口子
  // -------------------------------------------------------------------------
  // ★ 为什么"试算"要做成工具而不仅是界面按钮：AI 要能回答
  //   "他年底还有几天、折下来多少钱"，而它一旦只能调"登记"就等于
  //   用真单据去问价 —— 台账上会多出一堆作废单。
  annual_leave_balance: {
    write: false,
    title: '谁还有可折的未休年假（按累计工龄算出来的天数）与本年度已折现台账',
    args: [],
    run: async (tx) => {
      const mode = (await tx.query(
        `SELECT value_text m FROM fn_policy_effective('LEAVE_ANNUAL_CASHOUT', NULL, app_today())`
      )).rows[0]?.m || 'off';
      return {
        mode,
        mode_means: mode === 'off' ? '不折现（默认）'
          : mode === 'total_300' ? '一次性 300%（工资不再另发）'
            : '额外补 200%（300% 含已照发工资）',
        candidates: (await tx.query(
          `SELECT e.person_id, p.name, p.employee_no,
                  fn_cumulative_years(e.person_id, app_today()) AS cum_years,
                  fn_annual_leave_days(e.person_id, app_today()) AS entitled_days,
                  fn_annual_leave_unused(e.person_id, app_today()) AS unused_days
             FROM employment e JOIN person p ON p.id = e.person_id
            WHERE e.leave_date IS NULL
              AND fn_annual_leave_unused(e.person_id, app_today()) > 0
            ORDER BY unused_days DESC, p.employee_no LIMIT 200`)).rows,
        cashouts: (await tx.query(
          `SELECT c.id, c.employee_id, p.name, c.leave_year, c.days, c.amount,
                  c.rate, c.settle_period, c.status, c.reason
             FROM leave_cashout c JOIN person p ON p.id = c.employee_id
            ORDER BY c.id DESC LIMIT 100`)).rows,
        tiers: (await tx.query(
          `SELECT years_from, days FROM annual_leave_tier ORDER BY years_from`)).rows,
      };
    },
  },

  annual_leave_quote: {
    write: false,
    title: '试算某人某天的未休年假折现金额（不落账）',
    args: ['employee_id', 'date'],
    run: async (tx, a) => {
      const q = (await tx.query(`SELECT * FROM fn_annual_leave_quote($1,$2)`,
        [a.employee_id, a.date])).rows[0];
      return {
        employee_id: a.employee_id, on: a.date,
        days: Number(q.days), monthly_wage: Number(q.monthly_wage),
        daily_wage: Number(q.daily_wage), rate: Number(q.rate),
        amount: Number(q.amount), mode: q.mode,
        note: q.mode === 'off' ? '制度是 off，试算金额恒为 0；改配置后才会有数'
          : '天数已按"不足 1 整天不支付"向下取整',
      };
    },
  },

  annual_leave_cashout: {
    write: true,
    title: '登记一张未休年假折现单（预览给出天数/金额/落到哪个月）',
    args: ['employee_id', 'date', 'period', 'reason'],
    preview: async (tx, a) => {
      const q = (await tx.query(`SELECT * FROM fn_annual_leave_quote($1,$2)`,
        [a.employee_id, a.date])).rows[0];
      const exists = (await tx.query(
        `SELECT id, status FROM leave_cashout
          WHERE employee_id=$1 AND leave_year=EXTRACT(year FROM $2::date)::int
            AND status <> 'void'`, [a.employee_id, a.date])).rows[0] || null;
      const payRun = (await tx.query(
        `SELECT id, status FROM pay_run WHERE period=$1 AND kind='monthly'`,
        [a.period])).rows[0] || null;
      return {
        affected_count: 1,
        diff: [{
          employee_id: a.employee_id, on: a.date, period: a.period,
          mode: q.mode, days: Number(q.days), rate: Number(q.rate),
          amount: Number(q.amount), monthly_wage: Number(q.monthly_wage),
        }],
        warns: [
          q.mode === 'off' ? '当前制度是 off，执行会被拒（E_ALC_OFF）' : null,
          Number(q.days) === 0 ? '折算后不足 1 天，没有可折的部分' : null,
          exists ? `该员工本年已有折现单 #${exists.id}（${exists.status}），执行会被拒（E_ALC_EXISTS）` : null,
          payRun ? `该月工资批次已存在（${payRun.status}）：封账后这笔钱就进不去，要先重开` : null,
        ].filter(Boolean),
      };
    },
    exec: async (tx, a, actor) => {
      const id = Number((await tx.query(
        `SELECT fn_annual_leave_cashout($1,$2,$3,$4,$5) i`,
        [a.employee_id, a.date, a.period, a.reason, String(actor)])).rows[0].i);
      const r = (await tx.query(`SELECT days, amount, settle_period FROM leave_cashout WHERE id=$1`,
        [id])).rows[0];
      return { id, days: Number(r.days), amount: Number(r.amount), settle_period: r.settle_period };
    },
  },

  annual_leave_cashout_void: {
    write: true,
    title: '作废一张年假折现单（钱还没进工资条才能作废）',
    args: ['cashout_id', 'reason'],
    preview: async (tx, a) => {
      const c = (await tx.query(`SELECT * FROM leave_cashout WHERE id=$1`, [a.cashout_id])).rows[0];
      if (!c) return { affected_count: 0, diff: [], warns: ['没有这张单'] };
      return {
        affected_count: 1,
        diff: [{ id: c.id, before: c.status, after: 'void', days: Number(c.days), amount: Number(c.amount) }],
        warns: c.status === 'paid'
          ? [`这张单已经进了 ${c.settle_period} 的工资条，作废会被拒（E_ALC_PAID）；要改只能在那个月红冲`]
          : [],
      };
    },
    exec: async (tx, a, actor) => {
      await tx.query(`SELECT fn_annual_leave_cashout_void($1,$2,$3)`,
        [a.cashout_id, a.reason, String(actor)]);
      return { id: a.cashout_id, status: 'void' };
    },
  },
};

export const listTools = () => Object.entries(TOOLS).map(([name, t]) => ({
  name, title: t.title, write: !!t.write, args: t.args || [],
}));

function needTool(name) {
  const t = TOOLS[name];
  if (!t) throw bizErr('E_MCP_UNKNOWN_TOOL', `工具 ${name} 不在目录里（目录里没有的，AI 不能调）`);
  return t;
}

const REQ = {
  employee_id: 'int', leave_type_id: 'int', qty: 'num',
  date_from: 'date', date_to: 'date',
  org_id: 'int', quota: 'int', period: 'month', reason: 'text', run_id: 'int',
  // 工资项与公式（AI 用）：这些参数既不是日期也不是数字，
  // 不写类型就会掉进"默认 date"，报出"formula 必须是 YYYY-MM-DD"这种莫名其妙的错。
  formula: 'str', samples: 'json', code: 'str', name: 'str',
  kind: 'str', sort_order: 'int',
  // 年假折现（129）
  cashout_id: 'int',
};

/**
 * 参数形状校验：AI 传错类型时，要在**预览**就失败，而不是执行到一半。
 * ★ `reason` 也要校验，而且校验的是"够不够说明问题"——库里 fn_hc_set 有 4 字下限，
 *   这里先拦一次，是为了让 AI 拿到"原因太短"而不是一个 422 的约束报错。
 */
function normalize(tool, args) {
  const out = {};
  for (const k of tool.args) {
    const v = args?.[k];
    const kind = REQ[k];
    if (v === undefined || v === null || v === '') throw bizErr('E_ARG_INVALID', `缺少参数 ${k}`);
    if (kind === 'int') {
      if (!Number.isInteger(Number(v))) throw bizErr('E_ARG_INVALID', `${k} 必须是整数`);
      out[k] = Number(v);
    } else if (kind === 'num') {
      if (!Number.isFinite(Number(v))) throw bizErr('E_ARG_INVALID', `${k} 必须是数字`);
      out[k] = Number(v);
    } else if (kind === 'month') {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v))) throw bizErr('E_ARG_INVALID', `${k} 必须是 YYYY-MM`);
      out[k] = String(v);
    } else if (kind === 'str') {
      out[k] = String(v);
    } else if (kind === 'json') {
      try { out[k] = typeof v === 'string' ? JSON.parse(v) : v; }
      catch { throw bizErr('E_ARG_INVALID', `${k} 必须是 JSON`); }
    } else if (kind === 'text') {
      if (String(v).trim().length < 4) throw bizErr('E_ARG_INVALID', `${k} 至少 4 个字（改数据必须说明原因）`);
      out[k] = String(v).trim();
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw bizErr('E_ARG_INVALID', `${k} 必须是 YYYY-MM-DD`);
      out[k] = String(v);
    }
  }
  return out;
}

// ===========================================================================
// 只读：不建 plan，但审计 + 同一道门
// ===========================================================================
/**
 * ★ 只读为什么也要走"服务函数"而不是直接 SELECT：
 *   ① 掩码只有一份实现（工资条的净值/社保按字段权限掩掉）；
 *   ② 行闸只有一份实现（四维临时表），AI 看到的行数 = 这个人自己看到的行数；
 *   ③ 拒绝理由一致（不是"AI 读到 0 行"而是 E_OUT_OF_SCOPE）。
 */
export async function read(tx, { toolName, args, actor, actorId }) {
  const tool = needTool(toolName);
  if (tool.write) {
    throw bizErr('E_MCP_TOOL_MISMATCH',
      `工具 ${toolName} 是写工具：必须先 plan 预览，再 execute（不能直接读/执行）`);
  }
  const a = normalize(tool, args);
  const rows = await tool.run(tx, a, actorId);

  // 读也留痕。affected = 这次返回了多少行 —— 它比"调用了"更有用：
  // 一个只该看到 2 行的账号读到 200 行，这个数字会说话。
  await tx.query('SELECT fn_mcp_audit_read($1,$2,$3)',
    [toolName, String(actor), Array.isArray(rows) ? rows.length : 1]);

  return { tool: toolName, count: Array.isArray(rows) ? rows.length : 1, rows };
}

// ===========================================================================
// 写入：两阶段
// ===========================================================================
/** 预览：写 plan。affected_count 与 diff 一起落库，执行时比对的是摘要不是 diff */
export async function plan(tx, { toolName, args, actor }) {
  const tool = needTool(toolName);
  if (!tool.write) throw bizErr('E_MCP_TOOL_MISMATCH', `工具 ${toolName} 是只读工具，不需要 plan`);

  const a = normalize(tool, args);
  const p = await tool.preview(tx, a);

  const r = (await tx.query(
    `INSERT INTO sys_mcp_plan(tool_name, args_digest, diff_json, affected_count, plan_ttl_seconds)
     VALUES ($1, $2::bytea, $3::jsonb, $4, 300)
     RETURNING plan_id`,
    [toolName, digestOf(a), JSON.stringify({ args: a, diff: p.diff }), p.affected_count])).rows[0];

  return {
    plan_id: r.plan_id,
    tool: toolName,
    args: a,
    affected_count: p.affected_count,
    diff: p.diff,
    ttl_seconds: 300,
    // 提示而不是保证：真正的保证在 fn_mcp_execute 里
    note: '一个 plan 只能执行一次，5 分钟内有效；参数有任何变化都必须重新预览',
  };
}

/** 执行：五条门禁在库里（010），这里只负责把参数重新规范化后交给它 */
export async function execute(tx, { planId, toolName, args, actor, actorId }) {
  const tool = needTool(toolName);
  if (!tool.write) throw bizErr('E_MCP_TOOL_MISMATCH', `工具 ${toolName} 是只读工具，不要 plan`);

  const a = normalize(tool, args);
  const dg = digestOf(a);

  // ★ 先过门禁（无 plan / 工具不符 / 摘要不符 / 过期 / 已用 / 超阈值），
  //   再动业务数据。反过来的话，被拒的那次已经把单据建出来了。
  await tx.query('SELECT fn_mcp_execute($1,$2,$3::bytea,$4)', [planId, toolName, dg, actor]);

  const out = await tool.exec(tx, a, actor, actorId);
  return { ...out, plan_id: planId, tool: toolName };
}

/** 最近的使用记录（只读工具也要能被看见，否则"谁调过什么"没人答得出） */
export async function recentAudit(tx, { limit = 20 }) {
  return (await tx.query(
    `SELECT called_at, tool_name, actor, shift_run, affected
       FROM sys_mcp_audit ORDER BY called_at DESC LIMIT $1`, [limit])).rows;
}

/** 按调用者统计用量：读多写少正常，"一个人读了 500 行"要看一眼 */
export async function usage(tx) {
  return (await tx.query('SELECT * FROM v_mcp_usage ORDER BY reads DESC')).rows;
}
