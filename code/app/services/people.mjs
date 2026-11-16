// ============================================================================
// app/services/people.mjs · 花名册：第一个"能看人"的出口
// ----------------------------------------------------------------------------
// 到 052 为止界面能看考勤、工资条、审批、编制、招聘、绩效 —— 唯独没有"我们有哪些人"。
// person / employment / employee_org_assignment 三张表都在，却没有一个读的出口。
// 这是「表在、门没有」的另一半：前五次是**没有写入路径**，这次是**没有读取路径**，
// 而它的失败形态不是错，是"这个系统看起来没有员工"。
//
// 两条判断照抄既有规矩，一条也不新发明：
//   ① 行闸在库里（fn_emp_roster 里那两个 EXISTS / NOT EXISTS），与考勤、工资条
//      同一套临时表。另开一条"看人"的判据，就会出现"花名册看得到、点进去看不到考勤"。
//   ② 字段掩码 fail-closed（003 的规矩）：身份证没配就是 masked。
//      花名册是最容易"顺手 SELECT *"的地方，而 SELECT * 等于绕过字段权限。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';
import { inStationScope } from './scope.mjs';
import { personaFor } from './persona-guard.mjs';

export const RESOURCES = { roster: 'employee_roster', write: 'employment_manage' };

/** 花名册。as_of 必传：不给"当前在职"这种说法，否则同一个查询跨月会变成另一个答案。 */
export async function roster(tx, { userId, asOf }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ''))) {
    throw bizErr('E_ARG_INVALID', 'as_of 必须是 YYYY-MM-DD（不给默认值：跨月那天会变成另一个答案）');
  }
  await requireSession(tx, { userId, resource: RESOURCES.roster });

  // ★ 字段权限在**循环外**求值一次：它与"哪一行"无关。
  //   写在循环里会让人以为每行权限可能不同，而它不会。
  const actOf = async (f) => (await tx.query('SELECT fn_field_action($1,$2,$3,$4) a',
    [userId, RESOURCES.roster, f, 'list'])).rows[0].a;
  const actId = await actOf('national_id');
  // ★ 手机号也走同一套字段权限：**未配 = 掩码**（fail-closed）。
  //   店长要打电话是真实需求，但那应该由权限表给他 visible，
  //   而不是在代码里"顺手不掩手机" —— 那等于给所有角色开了这个字段。
  const actMobile = await actOf('mobile');

  // ★ 掩码用 fn_apply_mask（同一个函数，不是这里再写一遍 if）：
  //   "visible 才给值、其余给 null" 这条规则只应该存在一处。
  //   掩码返回 null 而不是空串/***：0 会被读成真实金额，*** 会让整列变字符串。
  // ★ 182：门店内再收一层"只看本档口"。收在**外层 WHERE**而不是改 fn_emp_roster ——
  //   161 那个函数 140 行里塞了 5 个 LATERAL（合同/工号/证件），
  //   抄一遍进 182 就是把"一个人只能一行"这套判据复制成两份。
  //   能力位没开时 inStationScope() 与 fn_scope_people **逐字等价**（182 第 ① 支），
  //   所以集团 HR / 店长这条路一个字节都没变。
  const rows = (await tx.query(
    `SELECT r.employee_id, r.employee_no, r.full_name, r.org_id, r.org_name,
            r.hire_date, r.leave_date, r.leaving_soon,
            fn_apply_mask(r.national_id, $2) AS national_id,
            fn_apply_mask(r.mobile, $3) AS mobile,
            -- 161 起：合同与档案补充（合同类字段是实时派生的，见 161 文件头）
            r.birth_date, r.gender,
            r.contract_id, r.contract_no, r.contract_kind,
            r.contract_start, r.contract_end, r.probation_status, r.probation_to,
            r.employment_kind,
            r.emergency_name, r.emergency_phone, r.emergency_relation,
            -- 190：英文名 / 岗位名称（自由文本，不是 position 档案）/ 时薪
            --      hourly_rate 为 null = 月薪人员或未录，**不是 0**
            r.english_name, r.job_title, r.hourly_rate,
            -- 190：法定假日与年假的余额，按 as_of 从既有台账取；
            --      null = 没维护过额度（与"已用完 = 0"必须区分）
            r.stat_holiday_available, r.annual_leave_available,
            -- ★ 190：418/468 连续雇佣判定**未实现**，库里恒为 NULL（未判定）。
            --   不要在服务层拼近似值 —— 口径见 db/190 文件头 ⑤。
            r.continuous_employment
       FROM fn_emp_roster($1::date) r
      WHERE ${inStationScope('r.employee_id', '$4', '$1::date')}`,
    [asOf, actId, actMobile, userId])).rows;

  // 合同到期天数在服务层算一次（页面按它排序/标红，不用各自再算）
  const today = new Date(asOf + 'T00:00:00Z').getTime();
  // ★ 空串 → null（190）：库里允许空串（历史导入），而空串与 null 在页面上长得
  //   不一样（"" 会渲染成空白格、null 会渲染成"—"）。"没录"必须只有一种表示。
  const nn = (v) => (v === '' || v === undefined ? null : v);
  const persona=await personaFor(tx,userId);
  const salaryAll=!persona||!!(await tx.query("SELECT fn_role_can($1,'payroll_slips_read_all','read') ok",[userId])).rows[0].ok;
  return rows.map((r) => ({
    ...r,
    english_name: nn(r.english_name),
    job_title: nn(r.job_title),
    hourly_rate:salaryAll||String(persona?.legacy_person_id)===String(r.employee_id)?r.hourly_rate:null,
    contract_days_left: r.contract_end
      ? Math.round((new Date(r.contract_end).getTime() - today) / 86400000) : null,
    _actions: { national_id: actId, mobile: actMobile },
  }));
}

/**
 * 写人员的证件 / 手机（007 的 person_profile）。
 * ★ 这是"招聘走到入职"链上缺的第二块：入职链能建人，但没人能录证件号，
 *   而合同渲染要求"乙方证件号"非空 —— 于是签不出合同。
 * ★ 已核实的号码在库里唯一（ux_profile_national_id_verified），
 *   所以这里不做"是否重复"的判断，交给库 —— 两个人填错同一个号，
 *   比一个人真的有两个档案更常见，只有"已核实"才需要唯一。
 */
export async function saveProfile(tx, { userId, employeeId, nationalId, mobile, verified }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  }
  if (!(await tx.query('SELECT 1 FROM person WHERE id=$1', [employeeId])).rows.length) {
    throw bizErr('E_PERSON_NOT_FOUND', `人 ${employeeId} 不存在`);
  }
  const vb = verified ? userId : null;
  const put = async (type, value) => {
    const v = String(value || '').trim();
    if (!v) return null;
    // 同类型只留一条"当前"的：多条未核实同类型会让花名册取哪一条变得不确定
    await tx.query(
      `DELETE FROM person_profile
        WHERE person_id=$1 AND profile_type=$2 AND verified_by IS NULL`, [employeeId, type]);
    const row = (await tx.query(
      `INSERT INTO person_profile (person_id, profile_type, profile_value,
                                  verified_by, verified_at)
       VALUES ($1,$2,$3,$4,CASE WHEN $4::bigint IS NULL THEN NULL ELSE now() END)
       RETURNING id`, [employeeId, type, v, vb])).rows[0];
    return Number(row.id);
  };
  const ids = {
    national_id: await put('national_id', nationalId),
    mobile: await put('mobile', mobile),
  };
  return { employee_id: employeeId, saved: Object.entries(ids)
    .filter(([, v]) => v).map(([k]) => k), verified: !!vb,
  _log: { employee: employeeId } };
}

/**
 * 单人详情：任职段 / 归属历史 / 假期额度 / 最近工资条。
 *
 * ★ 权限不再写第二套：**先把他当花名册查一遍**，不在名单里就 404。
 *   另写一个"这个人是否归我管"的判断，就会与花名册漂移 ——
 *   而漂移的形态是"名单里点得进去，点进去看不到"或反过来。
 *
 * ★ 不在名单里返回 **404 而不是 403**：403 说的是"这个人存在，但你没权看"，
 *   它本身就是一条信息。详情页不需要区分"不存在"与"无权"。
 */
export async function detail(tx, { userId, employeeId, asOf }) {
  if (!Number.isInteger(employeeId) || employeeId <= 0) throw bizErr('E_ARG_INVALID', 'id 必须是正整数');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ''))) {
    throw bizErr('E_ARG_INVALID', 'as_of 必须是 YYYY-MM-DD');
  }

  const visible = await roster(tx, { userId, asOf });
  const mine = visible.find((r) => Number(r.employee_id) === employeeId);
  if (!mine) throw bizErr('E_EMPLOYEE_NOT_FOUND', `员工 ${employeeId} 不在你能看的名单里`);

  // 字段权限一次性求值（与哪一行无关）
  const act = async (field) => (await tx.query(
    'SELECT fn_field_action($1,$2,$3,$4) a',
    [userId, RESOURCES.roster, field, 'detail'])).rows[0].a;
  // ★ 字段属于**原资源**：身份证属于花名册（employee_roster），
  //   工资条字段属于工资条（payslip）。拿花名册的资源码去问工资条字段，
  //   结果永远是 masked（fail-closed）—— 看起来像"权限没配好"，实际是问错了对象。
  const actProfile = await act('national_id');
  const actNet = (await tx.query('SELECT fn_field_action($1,$2,$3,$4) a',
    [userId, 'payslip', 'net_amount', 'detail'])).rows[0].a;

  const profile = (await tx.query(
    `SELECT profile_type,
            fn_apply_mask(profile_value,
              CASE WHEN profile_type = 'national_id' THEN $2::varchar ELSE 'visible' END) AS profile_value
       FROM person_profile WHERE person_id = $1 ORDER BY profile_type`, [employeeId, actProfile])).rows;

  const employments = (await tx.query(
    `SELECT id, legal_entity_id, hire_date, leave_date
       FROM employment WHERE person_id = $1 ORDER BY hire_date`, [employeeId])).rows;

  const assignments = (await tx.query(
    `SELECT a.dim_code, a.org_id, o.name AS org_name, a.valid_from, a.valid_to
       FROM employee_org_assignment a
       LEFT JOIN org_unit o ON o.id = a.org_id
      WHERE a.employee_id = $1 ORDER BY a.dim_code, a.valid_from`, [employeeId])).rows;

  const balances = (await tx.query(
    `SELECT b.leave_type_id, t.code, t.name,
            b.granted, b.frozen, b.used, b.expired, b.available
       FROM v_leave_balance b JOIN leave_type t ON t.id = b.leave_type_id
      WHERE b.employee_id = $1 ORDER BY b.leave_type_id`, [employeeId])).rows;

  const persona=await personaFor(tx,userId);
  const salaryAllowed=!persona||String(persona.legacy_person_id)===String(employeeId)||!!(await tx.query("SELECT fn_role_can($1,'payroll_slips_read_all','read') ok",[userId])).rows[0].ok;
  const payslips = salaryAllowed?(await tx.query(
    `SELECT p.id, r.period, p.gross_amount,
            fn_apply_mask(p.net_amount::text, $2) AS net_amount,
            p.si_employee, p.tax_amount
       FROM payslip p JOIN pay_run r ON r.id = p.pay_run_id
      WHERE p.employee_id = $1 ORDER BY r.period DESC LIMIT 5`, [employeeId, actNet])).rows:[];

  return {
    as_of: asOf,
    employee: mine,
    profile, employments, assignments, balances, payslips,
    _actions: { national_id: actProfile, net_amount: actNet, salary_history:salaryAllowed },
  };
}

/**
 * 办离职：结束任职 + 结束归属 + 落离职记录（三件事在库里同一个函数里）。
 * ★ 权限用花名册的门：他不在你能看的名单里，就不该由你来办离职。
 *   另写一个"能不能给这个人办离职"的判断，就会与名单漂移。
 */
export async function terminate(tx, { userId, employeeId, leaveDate, reason }) {
  await requireSession(tx,{userId,resource:RESOURCES.write,action:'write'});
  if (!Number.isInteger(employeeId) || employeeId <= 0) throw bizErr('E_ARG_INVALID', 'id 必须是正整数');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(leaveDate || ''))) {
    throw bizErr('E_ARG_INVALID', 'date 必须是 YYYY-MM-DD');
  }

  // 用「离职日那天他在不在我的名单里」判权限：in 名单 = 归我管
  const visible = await roster(tx, { userId, asOf: leaveDate });
  if (!visible.some((r) => Number(r.employee_id) === employeeId)) {
    throw bizErr('E_EMPLOYEE_NOT_FOUND', `员工 ${employeeId} 不在你能看的名单里`);
  }

  const id = (await tx.query('SELECT fn_emp_terminate($1,$2::date,$3,$4) id',
    [employeeId, leaveDate, reason, String(userId)])).rows[0].id;
  return { termination_id: Number(id), employee_id: employeeId, leave_date: leaveDate };
}
