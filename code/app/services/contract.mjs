// ============================================================================
// app/services/contract.mjs · 人事合同：填报 → 校验 → 签署 → 生成标准格式
// ----------------------------------------------------------------------------
// 这一层只做四件事：列、存（含校验）、签（存快照）、渲染。**法定判断全在库里**
// （fn_contract_check / fn_contract_probation_max / fn_contract_render）——
// JS 里再判一遍试用期上限，就有两个地方会漂，而漂的那一次是**签了一份违法合同**。
//
// ★ 三条边界：
//   ① block（违法）→ 直接拒，不落库；warn（有风险）→ 照存，但把话带回去。
//      把预警做成硬拦，人会去 Excel 里签 —— 那样连"有这份合同"都查不到。
//   ② 签署时把渲染结果整段存进 body_snapshot：模板改了不影响已签的那份。
//   ③ 没有"改已签合同"的接口。要变更就签一份新的（prev_id 串链），
//      历史那份留着 —— 与工资条封账、绩效封存同一条规矩。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'employment_manage', write: 'employment_manage' };

const isId = (v) => Number.isInteger(v) && v > 0;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

const KINDS = ['fixed', 'open', 'task', 'parttime', 'intern'];
const HOURS = ['standard', 'comprehensive', 'irregular'];

/**
 * 入职一条链：offer → 人 → 任职 → 工号 → 合同草稿（162）。
 *
 * ★ 这里只做编排，不做判断：入职走 061 的 fn_hire_from_offer，
 *   校验走 160 的 fn_contract_check，编号与默认值在 162 里。
 *   岗位/月薪/入职日**只从 offer 带一次** —— 让 HR 填两遍，两个数必然有一天会不一样，
 *   而不一致时按合同执行（往往就是更低的那个）。
 */
export async function onboardFull(tx, { userId, offerId, personId, hireDate,
  legalEntityId, contract: extra }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(offerId))) throw bizErr('E_ARG_INVALID', 'offer 必须是正整数');
  if (!isId(Number(legalEntityId))) throw bizErr('E_ARG_INVALID', 'entity 必须是正整数（甲方主体）');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(hireDate || ''))) {
    throw bizErr('E_ARG_INVALID', 'hireDate 必须是 YYYY-MM-DD');
  }
  const r = (await tx.query(
    `SELECT * FROM fn_onboard_full($1,$2,$3::date,$4,$5::jsonb,$6)`,
    [Number(offerId), personId ? Number(personId) : null, hireDate,
      Number(legalEntityId), JSON.stringify(extra || {}), String(userId)])).rows[0];
  return {
    person_id: Number(r.person_id),
    employment_id: Number(r.employment_id),
    contract_id: Number(r.contract_id),
    contract_no: r.contract_no,
    // 合同是草稿：入职链不替人签字（见 162 文件头 ②）
    contract_status: 'draft',
    warnings: r.warns ? String(r.warns).split('；').filter(Boolean) : [],
    _log: { offer: Number(offerId), person: Number(r.person_id),
      contract: Number(r.contract_id) },
  };
}

/**
 * 异动清单（163）：调岗/转店/用工类型/工时制度。
 * ★ 与调薪分开列：钱走 salary_adjustment（按月版本），这里只管"他是谁、在哪、干什么"。
 */
export async function changes(tx, { userId, employeeId = null, status = null }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const rows = (await tx.query(
    `SELECT g.*, p.full_name,
            (SELECT c.contract_no FROM employment_contract c WHERE c.id = g.contract_id) AS new_contract_no,
            (SELECT c.status FROM employment_contract c WHERE c.id = g.contract_id) AS new_contract_status
       FROM employee_change g
       LEFT JOIN person p ON p.id = g.employee_id
      WHERE ($1::bigint IS NULL OR g.employee_id = $1)
        AND ($2::text IS NULL OR g.status = $2)
      ORDER BY g.effective_date DESC, g.id DESC LIMIT 200`,
    [employeeId === null ? null : Number(employeeId), status])).rows;
  return {
    rows: rows.map((r) => ({
      ...r, id: Number(r.id), employee_id: Number(r.employee_id),
      old_org_id: r.old_org_id === null ? null : Number(r.old_org_id),
      new_org_id: r.new_org_id === null ? null : Number(r.new_org_id),
      contract_id: r.contract_id === null ? null : Number(r.contract_id),
    })),
    kpi: {
      total: rows.length,
      applied: rows.filter((r) => r.status === 'applied').length,
      // 已生效但变更协议还没签 —— 这是"改了档案、书面还没落"的危险状态
      unsigned: rows.filter((r) => r.status === 'applied'
        && r.new_contract_status !== 'signed').length,
    },
  };
}

/** 开异动单：旧值由库里取（不让人手填，手填就会填错）。 */
export async function changeOpen(tx, { userId, employeeId, kind, effectiveDate, reason, next }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(employeeId))) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数');
  const K = ['position', 'transfer_store', 'employment_type', 'hours_system'];
  if (!K.includes(String(kind))) {
    throw bizErr('E_ARG_INVALID', `异动类型只能是 ${K.join(' / ')}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveDate || ''))) {
    throw bizErr('E_ARG_INVALID', '生效日必须是 YYYY-MM-DD');
  }
  const blocks = (await tx.query(
    `SELECT * FROM fn_change_check($1,$2,$3::date,$4)`,
    [Number(employeeId), String(kind), effectiveDate,
      next && next.org_id ? Number(next.org_id) : null])).rows;
  const bad = blocks.filter((x) => x.level === 'block');
  if (bad.length) throw bizErr('E_CHG_BLOCKED', bad.map((x) => x.message).join('；'));

  const id = Number((await tx.query(
    `SELECT fn_change_open($1,$2,$3::date,$4,$5::jsonb,$6) i`,
    [Number(employeeId), String(kind), effectiveDate, String(reason || '').trim(),
      JSON.stringify(next || {}), String(userId)])).rows[0].i);
  return {
    id, status: 'draft',
    warnings: blocks.filter((x) => x.level === 'warn').map((x) => x.message),
    _log: { change: id, employee: Number(employeeId), kind },
  };
}

/** 异动生效：切归属段 + 生成变更协议（草稿）。协议签署后才截断原合同。 */
export async function changeApply(tx, { userId, id }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(id)) throw bizErr('E_ARG_INVALID', 'id 必须是正整数');
  const r = (await tx.query(`SELECT * FROM fn_change_apply($1,$2)`,
    [id, String(userId)])).rows[0];
  return {
    change_id: Number(r.change_id),
    contract_id: Number(r.contract_id),
    contract_no: r.contract_no,
    effective_from: r.seg_from,
    // 记住：协议是草稿，签了才算变更完成
    contract_status: 'draft',
    _log: { change: id, contract: Number(r.contract_id) },
  };
}

/**
 * 写法人主档（160 建了表，但全仓没有写入路径 —— 于是"招聘走到入职"的人
 * 在系统里签不出一份合同：甲方名称/信用代码/地址全空，渲染直接拒）。
 * ★ 只 upsert 给了的字段：整行覆盖会让"只改地址"把信用代码清空，而清空不报错。
 */
export async function saveEntity(tx, { userId, id, name, creditCode, address,
  legalRep, stampName, bankName, bankAccount }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(id))) throw bizErr('E_ARG_INVALID', 'id 必须是正整数（法人 id）');
  const nm = str(name);
  if (!nm) throw bizErr('E_ARG_INVALID', '法人名称必填（合同甲方不能是空的）');

  // ★ 盖章主体没给就默认用名称 —— 在 JS 里算，不写 COALESCE($6,$2)：
  //   那个写法会让 $2 同时被推断成 varchar(96)（name 列）与"未知类型"，
  //   PG 报 "inconsistent types deduced for parameter $2"，而错误是 500，
  //   看起来像服务故障。
  const stamp = str(stampName) || nm;
  await tx.query(
    `INSERT INTO legal_entity (id, name, credit_code, address, legal_rep,
                               stamp_name, bank_name, bank_account)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       credit_code = COALESCE(EXCLUDED.credit_code, legal_entity.credit_code),
       address     = COALESCE(EXCLUDED.address, legal_entity.address),
       legal_rep   = COALESCE(EXCLUDED.legal_rep, legal_entity.legal_rep),
       stamp_name  = COALESCE(EXCLUDED.stamp_name, legal_entity.stamp_name),
       bank_name   = COALESCE(EXCLUDED.bank_name, legal_entity.bank_name),
       bank_account = COALESCE(EXCLUDED.bank_account, legal_entity.bank_account)`,
    [Number(id), nm, str(creditCode), str(address), str(legalRep),
      stamp, str(bankName), str(bankAccount)]);

  const r = (await tx.query(
    `SELECT id, name, credit_code, address, legal_rep, stamp_name
       FROM legal_entity WHERE id=$1`, [Number(id)])).rows[0];
  return { ...r, id: Number(r.id), _log: { entity: Number(id) } };
}

/** 法人主档清单：合同甲方与工资单表头都读它。 */
export async function entities(tx, { userId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const rows = (await tx.query(
    `SELECT id, name, credit_code, address, legal_rep, stamp_name, is_active
       FROM legal_entity ORDER BY is_active DESC, id`)).rows;
  return {
    rows: rows.map((r) => ({ ...r, id: Number(r.id) })),
    // 还没登记的（名字是"法人 #N（待补全）"）单独数出来：
    // 这些主体签出来的合同，甲方一栏是无效的
    incomplete: rows.filter((r) => /（待补全）$/.test(String(r.name))
      || !r.credit_code || !r.address).length,
  };
}

/** 合同清单（默认按起始日倒序）。employee 给了就只看这个人。 */
export async function list(tx, { userId, employeeId = null, status = null }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });  // ★ 行闸（170）：这四个读接口原来 requireSession 之后就直查全表，
  //   于是 A 店 HR 打开页面看到的是全集团的人（权限矩阵 PM8 抓到）。
  //   人员范围一律以「花名册口径」为准：先按 employee_roster 重建 scope，
  //   再用 fn_scope_people() 过滤 —— 那是行闸的唯一表达式，不要手抄 EXISTS。
  await tx.query('SELECT app_begin_scope($1,$2,$3)',
    [userId, 'employee_roster', null]);

  if (employeeId !== null && !isId(Number(employeeId))) {
    throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  }
  const rows = (await tx.query(
    `SELECT c.id, c.employee_id, c.legal_entity_id, c.contract_no, c.kind,
            c.start_date, c.end_date, c.probation_from, c.probation_to,
            c.job_title, c.workplace, c.hours_system,
            c.wage_amount, c.wage_unit, c.pay_day,
            c.status, c.sign_date, c.signed_by, c.prev_id,
            c.terminate_at,
            pe.full_name,
            (SELECT n.no FROM employee_no n
              WHERE n.assigned_person_id = c.employee_id AND n.retired_at IS NULL
              ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            (SELECT l.name FROM legal_entity l WHERE l.id = c.legal_entity_id) AS entity_name,
            -- 距到期天数：负数是已经过期。页面按这个排序/标红，不用前端算
            (c.end_date - CURRENT_DATE) AS days_left
       FROM employment_contract c
       LEFT JOIN person pe ON pe.id = c.employee_id
      WHERE ($1::bigint IS NULL OR c.employee_id = $1)
        AND c.employee_id IN (SELECT employee_id FROM fn_scope_people())
        AND ($2::text IS NULL OR c.status = $2)
      ORDER BY c.start_date DESC, c.id DESC
      LIMIT 500`, [employeeId === null ? null : Number(employeeId), status])).rows;

  const live = rows.filter((r) => r.status === 'signed');
  return {
    rows: rows.map((r) => ({
      ...r,
      id: Number(r.id), employee_id: Number(r.employee_id),
      legal_entity_id: Number(r.legal_entity_id),
      wage_amount: num(r.wage_amount),
      days_left: r.days_left === null ? null : Number(r.days_left),
      prev_id: r.prev_id === null ? null : Number(r.prev_id),
    })),
    kpi: {
      total: rows.length,
      signed: live.length,
      // 90 天内到期：这是"该准备续签了"的实际窗口，不是随便挑的数
      expiring: live.filter((r) => r.days_left !== null
        && Number(r.days_left) >= 0 && Number(r.days_left) <= 90).length,
      expired: live.filter((r) => r.days_left !== null && Number(r.days_left) < 0).length,
      draft: rows.filter((r) => r.status === 'draft').length,
    },
  };
}

/** 单份（含正文快照；draft 没有快照，返回 null）。 */
export async function get(tx, { userId, id }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(id)) throw bizErr('E_ARG_INVALID', 'id 必须是正整数');
  const r = (await tx.query(
    `SELECT c.*, pe.full_name,
            -- ★ 日期在库里就转成文本：JS 里 String(new Date()) 会得到
            --   "Sun Nov 15 2026 …"，打印在合同上就是一行洋文（这个坑踩过）。
            to_char(c.sign_date, 'YYYY-MM-DD') AS sign_date_text,
            to_char(c.start_date, 'YYYY-MM-DD') AS start_text,
            to_char(c.end_date, 'YYYY-MM-DD') AS end_text,
            (SELECT l.name FROM legal_entity l WHERE l.id = c.legal_entity_id) AS entity_name,
            (SELECT t.name FROM contract_template t WHERE t.id = c.template_id) AS template_name
       FROM employment_contract c
       LEFT JOIN person pe ON pe.id = c.employee_id
      WHERE c.id = $1`, [id])).rows[0];
  if (!r) throw bizErr('E_CT_NOT_FOUND', `合同 ${id} 不存在`);
  return r;
}

/**
 * 存一份合同（新建或改 draft）。
 * block 直接抛；warn 照存并随结果带回去。
 */
export async function save(tx, { userId, data }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  const d = data || {};
  if (!isId(Number(d.employeeId))) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数');
  if (!isId(Number(d.legalEntityId))) throw bizErr('E_ARG_INVALID', 'entity 必须是正整数（甲方主体）');
  const kind = String(d.kind || '').trim();
  if (!KINDS.includes(kind)) {
    throw bizErr('E_ARG_INVALID', `合同类型只能是 ${KINDS.join(' / ')}`);
  }
  const hours = String(d.hoursSystem || 'standard').trim();
  if (!HOURS.includes(hours)) {
    throw bizErr('E_ARG_INVALID', `工时制度只能是 ${HOURS.join(' / ')}`);
  }

  // ---- 库里判：block 抛、warn 收集 ----
  const checks = (await tx.query(
    `SELECT * FROM fn_contract_check($1,$2,$3,$4::date,$5::date,$6::date,$7::date,$8)`,
    [Number(d.employeeId), Number(d.legalEntityId), kind,
      d.startDate || null, d.endDate || null,
      d.probationFrom || null, d.probationTo || null,
      d.id ? Number(d.id) : null])).rows;

  const blocks = checks.filter((c) => c.level === 'block');
  if (blocks.length) {
    // 拼成一句能直接给用户看的话：违法条款不该以 500 或"约束冲突"的形式出现
    throw bizErr('E_CT_BLOCKED', blocks.map((b) => b.message).join('；'));
  }
  const warns = checks.filter((c) => c.level === 'warn').map((c) => ({
    code: c.code, message: c.message,
  }));

  // ---- 编号：给了就用，没给就按 主体-年月-序号 生成 ----
  let no = str(d.contractNo);
  if (!no) {
    const seq = Number((await tx.query(
      `SELECT count(*)::int n FROM employment_contract
        WHERE legal_entity_id = $1 AND start_date >= date_trunc('year', $2::date)`,
      [Number(d.legalEntityId), d.startDate])).rows[0].n) + 1;
    no = `HT${String(d.legalEntityId).padStart(2, '0')}-`
      + `${String(d.startDate).slice(0, 4)}-${String(seq).padStart(4, '0')}`;
  }

  const cols = {
    employee_id: Number(d.employeeId),
    legal_entity_id: Number(d.legalEntityId),
    contract_no: no,
    kind,
    start_date: d.startDate,
    end_date: d.endDate || null,
    probation_from: d.probationFrom || null,
    probation_to: d.probationTo || null,
    job_title: String(d.jobTitle || '').trim(),
    workplace: String(d.workplace || '').trim(),
    employee_address: String(d.employeeAddress || '').trim(),
    hours_system: hours,
    wage_amount: num(d.wageAmount),
    wage_unit: String(d.wageUnit || 'month').trim(),
    pay_day: Number(d.payDay || 15),
    template_id: d.templateId ? Number(d.templateId) : null,
    status: 'draft',
  };
  if (!cols.job_title) throw bizErr('E_ARG_INVALID', '岗位必填（合同第十七条的必备条款）');
  if (!cols.workplace) throw bizErr('E_ARG_INVALID', '工作地点必填');
  if (!cols.employee_address) {
    throw bizErr('E_ARG_INVALID', '乙方送达地址必填（送达地址条款没有地址，等于没有这一条）');
  }
  if (!cols.wage_amount || cols.wage_amount <= 0) throw bizErr('E_ARG_INVALID', '约定工资必须大于 0');
  if (!cols.template_id) {
    // 没指定就按类型取一份启用中的模板 —— 让"忘了选模板"不至于变成"生成不出来"
    const t = (await tx.query(
      `SELECT id FROM contract_template WHERE kind = $1 AND is_active
        ORDER BY version DESC, id LIMIT 1`, [kind])).rows[0];
    if (!t) throw bizErr('E_CT_NO_TEMPLATE', `没有适用于「${kind}」的启用中模板`);
    cols.template_id = Number(t.id);
  }

  let id;
  if (d.id) {
    // 只允许改 draft：已签的合同要变更就签新的（见文件头 ③）
    const cur = (await tx.query(
      `SELECT status FROM employment_contract WHERE id = $1`, [Number(d.id)])).rows[0];
    if (!cur) throw bizErr('E_CT_NOT_FOUND', `合同 ${d.id} 不存在`);
    if (cur.status !== 'draft') {
      throw bizErr('E_CT_SIGNED', `合同 ${d.id} 已经是「${cur.status}」，不能改 —— 要变更就签一份新的`);
    }
    id = Number(d.id);
    await tx.query(
      `UPDATE employment_contract SET
         employee_id=$2, legal_entity_id=$3, contract_no=$4, kind=$5,
         start_date=$6, end_date=$7, probation_from=$8, probation_to=$9,
         job_title=$10, workplace=$11, employee_address=$12, hours_system=$13,
         wage_amount=$14, wage_unit=$15, pay_day=$16, template_id=$17,
         updated_at=now()
       WHERE id=$1`,
      [id, cols.employee_id, cols.legal_entity_id, cols.contract_no, cols.kind,
        cols.start_date, cols.end_date, cols.probation_from, cols.probation_to,
        cols.job_title, cols.workplace, cols.employee_address, cols.hours_system,
        cols.wage_amount, cols.wage_unit, cols.pay_day, cols.template_id]);
  } else {
    id = Number((await tx.query(
      `INSERT INTO employment_contract
         (employee_id, legal_entity_id, contract_no, kind, start_date, end_date,
          probation_from, probation_to, job_title, workplace, employee_address,
          hours_system, wage_amount, wage_unit, pay_day, template_id, status,
          prev_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'draft',$17)
       RETURNING id`,
      [cols.employee_id, cols.legal_entity_id, cols.contract_no, cols.kind,
        cols.start_date, cols.end_date, cols.probation_from, cols.probation_to,
        cols.job_title, cols.workplace, cols.employee_address, cols.hours_system,
        cols.wage_amount, cols.wage_unit, cols.pay_day, cols.template_id,
        d.prevId ? Number(d.prevId) : null])).rows[0].id);
  }

  return { id, contract_no: cols.contract_no, status: 'draft', warnings: warns,
    _log: { contract: id, no: cols.contract_no } };
}

/** 预览渲染（不落库）：填报时能立刻看到"生成出来长什么样"。 */
export async function render(tx, { userId, id }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(id)) throw bizErr('E_ARG_INVALID', 'id 必须是正整数');
  const body = (await tx.query(`SELECT fn_contract_render($1) t`, [id])).rows[0].t;
  return { id, body };
}

/**
 * 签署：把渲染结果存成快照，状态转 signed。
 * ★ 快照必须在 UPDATE 之前算：fn_contract_render 读的是当前行，
 *   而 ck_ec_snapshot 要求"非 draft 必须有快照"——顺序反了就直接约束冲突。
 */
export async function sign(tx, { userId, id, signedBy }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(id)) throw bizErr('E_ARG_INVALID', 'id 必须是正整数');
  const cur = (await tx.query(
    `SELECT status FROM employment_contract WHERE id=$1`, [id])).rows[0];
  if (!cur) throw bizErr('E_CT_NOT_FOUND', `合同 ${id} 不存在`);
  if (cur.status !== 'draft') {
    throw bizErr('E_CT_SIGNED', `合同 ${id} 已经是「${cur.status}」，不能重复签署`);
  }
  const body = (await tx.query(`SELECT fn_contract_render($1) t`, [id])).rows[0].t;
  const r = (await tx.query(
    `UPDATE employment_contract
        SET status='signed', sign_date=COALESCE(sign_date, CURRENT_DATE),
            signed_by=$2, body_snapshot=$3, updated_at=now()
      WHERE id=$1
      RETURNING id, sign_date, signed_by, length(body_snapshot) AS len`,
    [id, String(signedBy || userId), body])).rows[0];
  return { id: Number(r.id), status: 'signed', sign_date: r.sign_date,
    signed_by: r.signed_by, body_length: Number(r.len),
    _log: { contract: id, action: 'sign' } };
}

/** 续签：以上一份为基准复制一份 draft（不自动签，条款要人再看一遍）。 */
export async function renew(tx, { userId, id, startDate, endDate, kind }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(id)) throw bizErr('E_ARG_INVALID', 'id 必须是正整数');
  const prev = (await tx.query(
    `SELECT * FROM employment_contract WHERE id=$1`, [id])).rows[0];
  if (!prev) throw bizErr('E_CT_NOT_FOUND', `合同 ${id} 不存在`);
  if (prev.status !== 'signed') {
    throw bizErr('E_ARG_INVALID', '只能以**已签署**的合同为基准续签');
  }
  const k = kind || prev.kind;
  const s = startDate || null;
  const e = endDate || null;
  if (!s) throw bizErr('E_ARG_INVALID', '续签要给新的起始日');
  return save(tx, { userId, data: {
    employeeId: prev.employee_id, legalEntityId: prev.legal_entity_id,
    kind: k, startDate: s, endDate: e,
    // ★ 续签**不带试用期**：同一单位只能约定一次（fn_contract_check 会拦，
    //   这里直接不传，省得填表的人以为该填）
    jobTitle: prev.job_title, workplace: prev.workplace,
    employeeAddress: prev.employee_address, hoursSystem: prev.hours_system,
    wageAmount: prev.wage_amount, wageUnit: prev.wage_unit, payDay: prev.pay_day,
    templateId: prev.template_id, prevId: Number(prev.id),
  } });
}

/**
 * 在职但没有生效合同的人（双倍工资风险的起算点）。
 * ★ 挂在"人"上而不是"合同"上：这件事的特征就是"系统里一切正常"——
 *   人在上班、工资在发，直到离职那天有人提出来。
 */
export async function unsigned(tx, { userId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const rows = (await tx.query(
    `SELECT e.person_id, p.full_name,
            e.hire_date,
            (CURRENT_DATE - e.hire_date) AS days_since_hire,
            (SELECT n.no FROM employee_no n
              WHERE n.assigned_person_id = p.id AND n.retired_at IS NULL
              ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            (SELECT c.id FROM employment_contract c
              WHERE c.employee_id = p.id AND c.status = 'signed'
              ORDER BY c.start_date DESC LIMIT 1) AS last_contract_id
       FROM employment e
       JOIN person p ON p.id = e.person_id
      WHERE daterange(e.hire_date, e.leave_date, '[]') @> CURRENT_DATE
        AND NOT EXISTS (SELECT 1 FROM employment_contract c
                         WHERE c.employee_id = p.id AND c.status = 'signed'
                           AND daterange(c.start_date, c.end_date, '[]') @> CURRENT_DATE)
      ORDER BY e.hire_date`)).rows;

  return {
    rows: rows.map((r) => ({
      ...r,
      person_id: Number(r.person_id),
      days_since_hire: Number(r.days_since_hire),
      // 满 30 天仍未签书面：这是法定"应当订立书面劳动合同"的一个月
      overdue: Number(r.days_since_hire) > 30,
    })),
    // 只数"已超期"的：刚入职 3 天没签是正常流程，不该出现在待办里制造噪音
    overdue: rows.filter((r) => Number(r.days_since_hire) > 30).length,
  };
}

// ---------------------------------------------------------------------------
// 打印页（服务端渲染）：合同是要盖章签字的凭证，存下来就得能打印
// ---------------------------------------------------------------------------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const KIND_CN = { fixed: '固定期限', open: '无固定期限', task: '以完成一定工作任务为期限',
  parttime: '非全日制', intern: '实习' };

/**
 * @param {object} c         employment_contract 行（get 的返回）
 * @param {string} bodyText  正文（已签用 body_snapshot，未签用 fn_contract_render）
 */
export function html(c, bodyText) {
  // 正文按空行分段；段内换行保留（合同条款是一条一段，不是一坨）
  const paras = String(bodyText || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(c.contract_no)} 劳动合同</title>
<style>
  :root { --ink:#111; --line:#bbb; }
  * { box-sizing:border-box; }
  body { margin:0; background:#f4f5f7; color:var(--ink);
         font:14px/1.85 "Songti SC","SimSun",-apple-system,"PingFang SC",serif; }
  .bar { position:sticky; top:0; z-index:9; display:flex; gap:12px; align-items:center;
         padding:10px 16px; background:#fff; border-bottom:1px solid var(--line);
         font-family:-apple-system,"PingFang SC",sans-serif; font-size:13px; }
  .bar b { font-size:14px; }
  .bar .sub { color:#666; font-size:12px; }
  .bar button { margin-left:auto; padding:6px 14px; border:1px solid var(--line);
                border-radius:6px; background:#fff; cursor:pointer; font-size:13px; }
  .page { max-width:820px; margin:16px auto; background:#fff; padding:32px 44px 28px;
          border:1px solid var(--line); }
  h1 { text-align:center; font-size:20px; letter-spacing:6px; margin:0 0 4px; }
  .meta { text-align:center; color:#666; font-size:12px; margin-bottom:18px; }
  .doc p { margin:0 0 10px; text-align:justify; white-space:pre-wrap; }
  .doc p.lead { text-indent:2em; }
  .sign { margin-top:26px; padding-top:14px; border-top:1px solid var(--line); }
  .sign pre { margin:0; font:inherit; white-space:pre-wrap; }
  .foot { margin-top:18px; color:#999; font-size:11px; display:flex; }
  .foot .r { margin-left:auto; }
  .stampbox { position:relative; }
  @page { size:A4; margin:18mm 16mm; }
  @media print {
    body { background:#fff; }
    .bar { display:none; }
    .page { border:none; margin:0; padding:0; max-width:none; }
  }
</style></head>
<body>
  <div class="bar">
    <b>${esc(c.contract_no)}</b>
    <span class="sub">${esc(KIND_CN[c.kind] || c.kind)} ·
      ${esc(c.full_name || '')} · ${esc(c.status)}</span>
    <button onclick="window.print()">打印 / 存 PDF</button>
  </div>
  <div class="page">
    <h1>劳动合同</h1>
    <div class="meta">合同编号：${esc(c.contract_no)}
      ${c.sign_date_text ? ` · 签订日期：${esc(c.sign_date_text)}` : ' · 未签署'}</div>
    <div class="doc">${paras.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
    <div class="foot">
      <span>${esc(c.status === 'signed' ? '已签署' : '草稿：未签署')}
        ${c.signed_by ? ` · 甲方签署人 ${esc(c.signed_by)}` : ''}</span>
      <span class="r">${esc(c.contract_no)}</span>
    </div>
  </div>
</body></html>`;
}
