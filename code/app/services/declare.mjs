// ============================================================================
// app/services/declare.mjs · 申报表（141）：个税扣缴申报表 + 社保费申报表
// ----------------------------------------------------------------------------
// 这两张表是"钱离开系统"之后的下一步 —— 报出去就要更正申报，所以这一层的
// 三条规矩都是硬的：
//
//   ① **只从封账批次出**。没有封账就明确拦（把原因说清：去算薪 / 去封账），
//      而不是出一份"看起来对"的表。库里 fn_declare_run 已经这么做了，
//      这里不重复判断 —— 一次判断只能有一处实现。
//
//   ② **金额不与页面分叉**。页面和导出调的是**同一批 SQL 函数**，
//      导出只做"把行变成字节"。另写一句 sum() 就是第二份口径。
//
//   ③ **导出要留痕**。这张表带着完整身份证号与全员工资，比报表更敏感。
//      每一次导出写一条 tax_declare_export（法人/期间/表/人数/行数/摘要），
//      与文件内容同一个事务。
//
// ★ 一件看着不一致、其实是刻意的事：**界面掩码证件号，导出不掩码。**
//   花名册的导出配置成一律掩码（053 的 9002），理由是"文件会被转发"。
//   申报表反过来，因为半掩的号在电子税务局里报不上去 —— 掩了等于交一张废纸。
//   交换条件有三条：只有薪酬写权限的人能导、每次导出留痕、导出的只是
//   "这一家法人这一期"的量。写在这里，免得下一个接手的人以为漏了掩码。
// ============================================================================
import { requireOrg, requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';
import { csv, sha256Hex } from '../csv.mjs';

export const RESOURCES = { read: 'payroll_run', write: 'payroll_run' };
const RES = RESOURCES.read;
const DIM = 'payroll_legal_entity';
const PERIOD = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

/**
 * 证件号掩码：保留前 6 后 4。
 * 18 位的号全掩成 `310101********1234` —— 前 6 位是地区码（HR 核档要看），
 * 后 4 位用来跟人对号；中间出生日期是最该藏的那 8 位。
 */
function maskId(v) {
  const s = String(v || '');
  if (s.length < 10) return s ? '***' : null;
  return s.slice(0, 6) + '*'.repeat(Math.max(s.length - 10, 1)) + s.slice(-4);
}

function assertArgs(entityId, period) {
  if (!Number.isInteger(entityId) || entityId <= 0) {
    throw bizErr('E_ARG_INVALID', 'entity 必须是正整数（发薪法人）');
  }
  // 期间写错时 SQL 会抛 E_DECLARE_PERIOD，但那是在拼完文件名之后；
  // 这一步也顺手挡住 "2026-5" 这种 —— 它会被当成 2026-05 附近去查，查不到也不报。
  if (!PERIOD.test(String(period || ''))) {
    throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM（如 2026-05）');
  }
}

/** 该法人该期两个批次的状态（月度 + 年终奖各一条），给页面说清"为什么出不了表" */
async function runState(tx, entityId, period) {
  const rows = (await tx.query(
    // ★ 时间要在库里按**业务时区**格式化：直接把 timestamptz 传到 JS 再拼字符串，
    //   得到的是 "Sun Nov 15 2026 13:" 这种半截东西（Date 的 toString 不是 ISO），
    //   而申报表是要交给税务的，时间写错比不写更糟。
    `SELECT id, kind, status, calc_version, sealed_by, paid_at,
            to_char(sealed_at AT TIME ZONE public.app_tz(), 'YYYY-MM-DD HH24:MI') AS sealed_at_text
       FROM pay_run
      WHERE legal_entity_id = $1 AND period = $2
      ORDER BY kind, calc_version DESC, id DESC`, [entityId, period])).rows;
  const pick = (k) => rows.find((r) => r.kind === k) || null;
  const monthly = pick('monthly');
  const bonus = pick('bonus');
  let blocked = null;
  if (!monthly) blocked = 'E_DECLARE_NO_RUN';
  else if (!['sealed', 'paid'].includes(monthly.status)) blocked = 'E_DECLARE_NOT_SEALED';
  return { monthly, bonus, blocked };
}

/**
 * 页面：两张表 + 汇总 + 卡在哪。
 * ★ 未封账时**不返回一张空表**，而是返回 blocked —— 空表会被读成"这个月没人"。
 * ★ period 可以不传：不传就取"最近一个已封账的期间"。这一条是为了让页面
 *   一进来就有东西看 —— 让人先去猜"哪个月封过账"，他多半会猜当月，
 *   而当月通常还是 draft，于是第一印象是"这功能没数据"。
 */
export async function board(tx, { userId, entityId, period }) {
  if (!Number.isInteger(entityId) || entityId <= 0) {
    throw bizErr('E_ARG_INVALID', 'entity 必须是正整数（发薪法人）');
  }
  await requireSession(tx, { userId, resource: RES, action: 'read' });
  await requireOrg(tx, { userId, resource: RES, orgId: entityId, dim: DIM, action: 'read' });

  const canWrite = (await tx.query(
    `SELECT fn_role_can($1,$2,'write') o`, [userId, RESOURCES.write])).rows[0].o;

  const periods = (await tx.query(
    `SELECT r.period,
            bool_or(r.status IN ('sealed','paid')) FILTER (WHERE r.kind = 'monthly') AS sealed,
            count(p.id)::int AS slips
       FROM pay_run r
       LEFT JOIN public.payslip p ON p.pay_run_id = r.id
      WHERE r.legal_entity_id = $1
      GROUP BY r.period
      ORDER BY r.period DESC
      LIMIT 24`, [entityId])).rows;
  // ★ 默认期间要落在"有东西可看"的那一期：已封账**且**有工资条。
  //   只按"已封账"挑，会落在一个空批次上（封账本该有工资条，但如果有人绕过
  //   fn_pay_run_seal 直接改状态，或者导入了一半，就会出现"已封账但没人"）——
  //   那时页面会显示一张空表，而真因是"这一期什么都没算过"。
  const sealedFallback = periods.find((x) => x.sealed && x.slips > 0)
    || periods.find((x) => x.sealed)
    || periods[0];

  let p = period ? String(period) : (sealedFallback ? sealedFallback.period : null);
  if (!p) {
    return { period: null, entity: entityId, periods, blocked: 'E_DECLARE_NO_RUN',
             run: null, bonus: null, canWrite, iit: null, si: null, exports: [] };
  }
  assertArgs(entityId, p);

  const st = await runState(tx, entityId, p);
  if (st.blocked) {
    return {
      period: p, entity: entityId, periods, blocked: st.blocked,
      run: st.monthly, bonus: st.bonus, canWrite,
      iit: null, si: null, exports: [],
    };
  }

  const iit = (await tx.query('SELECT * FROM fn_declare_iit($1,$2)', [entityId, p])).rows;
  const si = (await tx.query('SELECT * FROM fn_declare_si($1,$2)', [entityId, p])).rows;
  const sum = (await tx.query('SELECT * FROM fn_declare_si_sum($1,$2)', [entityId, p])).rows;

  const n = (x) => Number(x || 0);
  const num = (arr, k) => arr.reduce((a, x) => a + n(x[k]), 0);

  return {
    period: p, entity: entityId, periods, blocked: null,
    run: st.monthly, bonus: st.bonus, canWrite,

    iit: {
      rows: iit.map((r) => ({ ...r, id_no: maskId(r.id_no) })),
      persons: iit.length,
      sum_income: num(iit, 'income'),
      sum_si: num(iit, 'deduct_special'),
      sum_tax: num(iit, 'tax_now'),
      sum_should: num(iit, 'should_pay'),
      // "有备注"的行数：备注不是装饰，它数出来的就是"这张表还不能原样报"的人
      issues: iit.filter((r) => r.remark).length,
      no_id: iit.filter((r) => !r.id_no).length,
    },

    si: {
      rows: si,
      sum,
      persons: new Set(si.map((r) => r.employee_no + '|' + r.person_name)).size,
      sum_emp: num(si, 'emp_amount'),
      sum_er: num(si, 'er_amount'),
      sum_total: num(si, 'total_amount'),
      issues: si.filter((r) => r.remark).length,
      missing: si.filter((r) => r.base_amount !== null && r.emp_amount === null).length,
    },

    exports: (await tx.query(
      // 时间一律按业务时区格式化：同一页上"封账 13:22、导出 05:22" 会让人
      // 以为导早了 8 小时（前者是业务时区，后者是 ISO/UTC）。
      `SELECT id, kind, period, person_count, row_count, bytes,
              left(content_sha256, 12) AS sha12, total_amount, exported_by,
              to_char(exported_at AT TIME ZONE public.app_tz(), 'YYYY-MM-DD HH24:MI') AS exported_at_text
         FROM tax_declare_export
        WHERE legal_entity_id = $1 AND period = $2
        ORDER BY id DESC LIMIT 10`, [entityId, p])).rows,
  };
}

/** 表头注释：口径说在文件里，因为文件离开系统之后就没人问得着了 */
function headLines(kind, period, entityId, run, extra = []) {
  const title = kind === 'iit'
    ? '个人所得税扣缴申报表（工资薪金所得 · 累计预扣）'
    : '社会保险费申报表（逐人逐险种）';
  const caliber = kind === 'iit'
    ? [
        '# 口径：收入额 = 工资条应发；减除费用 = 5000 × 本年已封账月数；',
        '#       专项扣除 = 工资条社保个人部分；累计已缴 = 本年已封账工资条的税额之和（含本月）',
        '# 本系统不登记"免税收入"与"其他扣除"，一律按 0 申报；',
        '#   有生育津贴、商业健康险等情形的员工，需在电子税务局单独调整',
        '# 年终奖不在本表：它按"全年一次性奖金"单独申报（本表只含工资薪金）',
      ]
    : [
        '# 口径：个人应缴从工资条明细读；单位应缴 = 缴费基数 × 单位费率（工资条不存单位部分）',
        '#       缴费基数优先取申报基数（一年定一次），没有申报则回退月薪标准',
        '# 个人额为 0 表示"该险种个人不缴"（工伤、生育）；为空表示"工资条没有这一行"',
        '#   后者不是 0，是不知道 —— 这样的表还不能直接报，先核工资条结构',
      ];
  return [
    `# ${title}`,
    `# 法人 ${entityId} · 期间 ${period} · 批次 ${run.id}（${run.status}`
      + `${run.sealed_at_text ? `，封账 ${run.sealed_at_text}` : ''}`
      + `${run.sealed_by ? `，封账人 ${run.sealed_by}` : ''}）`,
    ...caliber,
    ...extra,
  ];
}

/** 个税申报表 CSV */
export async function exportIit(tx, { userId, entityId, period }) {
  assertArgs(entityId, period);
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  await requireOrg(tx, { userId, resource: RESOURCES.write, orgId: entityId, dim: DIM, action: 'write' });

  const st = await runState(tx, entityId, period);
  const rows = (await tx.query('SELECT * FROM fn_declare_iit($1,$2)', [entityId, period])).rows;
  if (!rows.length) {
    // 空文件发出去，收到的人只会认为"这个月没人" —— 而真因可能是法人选错了
    throw bizErr('E_DECLARE_EMPTY', '这一期一个人都没有，不出空表（先确认法人选对了）');
  }

  const body = csv({
    columns: [
      { key: 'person_name', label: '姓名' },
      { key: 'id_type', label: '证件类型' },
      { key: 'id_no', label: '证件号码' },
      { key: 'item', label: '所得项目' },
      { key: 'income', label: '收入额', numeric: true },
      { key: 'exempt_income', label: '免税收入', numeric: true },
      { key: 'deduct_std', label: '减除费用', numeric: true },
      { key: 'deduct_special', label: '专项扣除', numeric: true },
      { key: 'deduct_extra', label: '专项附加扣除', numeric: true },
      { key: 'taxable_now', label: '应纳税所得额', numeric: true },
      { key: 'cum_income', label: '累计收入额', numeric: true },
      { key: 'cum_deduct_std', label: '累计减除费用', numeric: true },
      { key: 'cum_deduct_special', label: '累计专项扣除', numeric: true },
      { key: 'cum_deduct_extra', label: '累计专项附加扣除', numeric: true },
      { key: 'cum_taxable', label: '累计应纳税所得额', numeric: true },
      { key: 'cum_tax', label: '累计应纳税额', numeric: true },
      { key: 'cum_paid', label: '累计已缴税额', numeric: true },
      { key: 'tax_now', label: '应扣缴税额', numeric: true },
      { key: 'should_pay', label: '应补(退)税额', numeric: true },
      { key: 'months_counted', label: '本年已申报月数', numeric: true },
      { key: 'filed_months', label: '已申报月份' },
      { key: 'remark', label: '备注' },
    ],
    rows: rows.map((r) => ({ ...r, item: '工资薪金所得' })),
  }).slice(1);

  const extra = st.bonus
    ? [`# 注意：本期另有年终奖批次 ${st.bonus.id}（${st.bonus.status}），`
      + '它不在本表，需按"全年一次性奖金"单独申报']
    : [];
  const text = '\uFEFF' + headLines('iit', period, entityId, st.monthly, extra).join('\r\n')
    + '\r\n' + body;

  const sha = sha256Hex(text);
  const bytes = Buffer.byteLength(text, 'utf8');
  const total = rows.reduce((a, r) => a + Number(r.tax_now || 0), 0);

  await tx.query('SELECT fn_declare_log($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    ['iit', entityId, period, st.monthly.id, rows.length, rows.length, bytes, sha,
      total.toFixed(2), String(userId)]);

  return {
    text, sha, bytes, row_count: rows.length, person_count: rows.length, total,
    filename: `iit_return_entity${entityId}_${period}.csv`,
  };
}

/** 社保申报表 CSV：汇总 + 明细两段（一个文件只能有一个 sheet，两段必须都在里面） */
export async function exportSi(tx, { userId, entityId, period }) {
  assertArgs(entityId, period);
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  await requireOrg(tx, { userId, resource: RESOURCES.write, orgId: entityId, dim: DIM, action: 'write' });

  const st = await runState(tx, entityId, period);
  const rows = (await tx.query('SELECT * FROM fn_declare_si($1,$2)', [entityId, period])).rows;
  if (!rows.length) {
    throw bizErr('E_DECLARE_EMPTY', '这一期没有社保数据，不出空表（先确认法人选对了、si_policy 有险种）');
  }
  const sum = (await tx.query('SELECT * FROM fn_declare_si_sum($1,$2)', [entityId, period])).rows;

  const sumCsv = csv({
    columns: [
      { key: 'item_name', label: '险种' },
      { key: 'person_count', label: '参保人数', numeric: true },
      { key: 'base_sum', label: '缴费基数合计', numeric: true },
      { key: 'emp_sum', label: '个人应缴合计', numeric: true },
      { key: 'er_sum', label: '单位应缴合计', numeric: true },
      { key: 'total_sum', label: '合计', numeric: true },
      { key: 'emp_missing', label: '个人额未登记人数', numeric: true },
    ],
    rows: sum,
  }).slice(1);

  const detCsv = csv({
    columns: [
      { key: 'employee_no', label: '工号' },
      { key: 'person_name', label: '姓名' },
      { key: 'item_name', label: '险种' },
      { key: 'base_amount', label: '缴费基数', numeric: true },
      { key: 'rate_employee', label: '个人费率', numeric: true },
      { key: 'rate_employer', label: '单位费率', numeric: true },
      { key: 'emp_amount', label: '个人应缴', numeric: true },
      { key: 'er_amount', label: '单位应缴', numeric: true },
      { key: 'total_amount', label: '合计', numeric: true },
      { key: 'remark', label: '备注' },
    ],
    rows,
  }).slice(1);

  const missing = sum.reduce((a, r) => a + Number(r.emp_missing || 0), 0);
  const extra = [
    '',
    `# —— 汇总（${sum.length} 个险种）——`,
    '',
    '',
    `# —— 明细（${rows.length} 行${missing ? `，其中 ${missing} 行个人额未登记` : ''}）——`,
  ];
  const text = '\uFEFF' + headLines('si', period, entityId, st.monthly).join('\r\n')
    + '\r\n' + sumCsv + '\r\n' + extra.join('\r\n') + '\r\n' + detCsv;

  const sha = sha256Hex(text);
  const bytes = Buffer.byteLength(text, 'utf8');
  const total = rows.reduce((a, r) => a + Number(r.total_amount || 0), 0);
  const persons = new Set(rows.map((r) => r.person_name + '|' + (r.employee_no || ''))).size;

  await tx.query('SELECT fn_declare_log($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    ['si', entityId, period, st.monthly.id, persons, rows.length, bytes, sha,
      total.toFixed(2), String(userId)]);

  return {
    text, sha, bytes, row_count: rows.length, person_count: persons, total,
    filename: `si_return_entity${entityId}_${period}.csv`,
  };
}

/** 最近导出：跨法人的清单，只给能写的人看（导出这件事本身就是他们的动作） */
export async function recent(tx, { userId }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'read' });
  return (await tx.query(
    `SELECT id, kind, legal_entity_id, period, person_count, row_count, bytes,
            left(content_sha256, 12) AS sha12, total_amount, exported_by,
            to_char(exported_at AT TIME ZONE public.app_tz(), 'YYYY-MM-DD HH24:MI') AS exported_at_text
       FROM tax_declare_export ORDER BY id DESC LIMIT 20`)).rows;
}
