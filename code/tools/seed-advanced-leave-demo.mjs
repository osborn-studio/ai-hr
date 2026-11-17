// Opt-in synthetic overlay for an existing TY-TEST workspace. Never initializes
// identities, credentials, external receipts, attendance punches or migrations.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { createDb, withTx } from '../app/db.mjs';
import { accessFor } from '../app/services/foundation.mjs';
import * as leave from '../app/services/advanced-leave.mjs';
import { hkAnnualDays, leavePayAdoptionDelta } from '../app/leave-calculations.mjs';

export const VERSION = 'TY-ADV-LEAVE-DEMO-202610-V1';
const CN_HOLIDAYS_2026 = ['2026-01-01','2026-02-16','2026-02-17','2026-02-18','2026-02-19',
  '2026-04-05','2026-05-01','2026-05-02','2026-06-19','2026-09-25','2026-10-01','2026-10-02','2026-10-03'];
const q = async (t, s, a = []) => (await t.query(s, a)).rows;
const one = async (t, s, a = []) => (await q(t, s, a))[0];
const iso = v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const same = (a, b) => String(a) === String(b);
const fail = message => { throw new Error(message); };
const nextDay = day => new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
const months = (from, to) => {
  const [y, m, d] = from.split('-').map(Number), [yy, mm, dd] = to.split('-').map(Number);
  return Math.max(0, (yy - y) * 12 + mm - m - (dd < d ? 1 : 0));
};
const roleRecord = a => ({ account_id: a.id, login: a.login, profile_code: a.profile_code, display_name: a.display_name });

async function actorsFor(t, groupId) {
  const rows = await q(t, `SELECT a.id,a.login,a.display_name,p.profile_code FROM sys_account a
    LEFT JOIN ty_test_account_profile p ON p.account_id=a.id
    WHERE a.status='active' AND (p.group_id=$1 OR a.login='tyhr_admin')
    AND (p.profile_code IN('demo','config_admin','group_hr_director','hr_manager') OR a.login='tyhr_admin')`, [groupId]);
  const candidates = [];
  for (const a of rows) {
    const scope = await accessFor(t, a.id);
    if (!scope.shared(groupId, true)) continue;
    const permissions = {};
    for (const kind of ['config','manage','approve','payroll']) permissions[kind] = !!(await one(t,
      'SELECT fn_role_can($1,$2,\'write\') ok', [a.id, 'advanced_leave_' + kind])).ok;
    candidates.push({ ...a, permissions });
  }
  const priority = a => a.profile_code === 'group_hr_director' ? 0 : a.profile_code === 'demo' ? 1 : 2;
  const business = candidates.filter(a => a.profile_code !== 'config_admin').sort((a, b) => priority(a) - priority(b));
  const manager = business.find(a => a.permissions.manage && a.permissions.payroll);
  const reviewer = business.find(a => !same(a.id, manager?.id) && a.permissions.approve && a.permissions.payroll);
  const creator = candidates.find(a => a.profile_code === 'config_admin' && a.permissions.config)
    || candidates.find(a => a.permissions.config);
  const publisher = candidates.find(a => a.permissions.config && !same(a.id, creator?.id));
  if (!manager || !reviewer || !creator || !publisher)
    fail('缺少两名真实有权的全集团假期业务/复核人员或配置发布人员；请先运行既定角色授权迁移，工具不会自行扩权');
  return { manager, reviewer, creator, publisher };
}

async function counts(t, gid) {
  return (await one(t, `SELECT
    (SELECT count(*) FROM ty_leave_relationship WHERE group_id=$1)::int relationships,
    (SELECT count(*) FROM ty_leave_scheme WHERE group_id=$1)::int schemes,
    (SELECT count(*) FROM ty_leave_account a JOIN ty_leave_relationship r ON r.id=a.relationship_id WHERE r.group_id=$1)::int accounts,
    (SELECT count(*) FROM ty_leave_lot l JOIN ty_leave_account a ON a.id=l.account_id JOIN ty_leave_relationship r ON r.id=a.relationship_id WHERE r.group_id=$1)::int lots,
    (SELECT count(*) FROM ty_leave_request x JOIN ty_leave_account a ON a.id=x.account_id JOIN ty_leave_relationship r ON r.id=a.relationship_id WHERE r.group_id=$1)::int requests`, [gid]));
}

// Explicit, additive correction for the first released synthetic fixture only.
// Never resets an approval, edits a published rule, deletes a request or touches
// customer data. A user-processed old request is held for manual review instead.
async function repairLegacyCalendar(t, index, actors) {
  const oldScene = index.scenes.find(s => s.key === 'CN-PENDING');
  const localDate = oldScene?.data.starts_at && new Date(Date.parse(oldScene.data.starts_at) + 8 * 3600000).toISOString().slice(0, 10);
  if (!CN_HOLIDAYS_2026.includes(localDate)) return null;
  const old = await one(t, 'SELECT * FROM ty_leave_request WHERE id=$1 FOR UPDATE', [oldScene.data.request_id]);
  if (!old || old.status !== 'pending') fail('旧节日日历案例已由用户处理；保留其审批，须人工核对，不自动重置');
  const day = await one(t, `SELECT d.work_date::text work_date,
    min(s.start_at)::text starts,max(s.end_at)::text ends FROM ty_roster_day d
    JOIN ty_roster_period p ON p.id=d.period_id JOIN ty_roster_segment s ON s.day_id=d.id
    WHERE d.employment_id=$1 AND p.period='2026-10-01' AND p.status IN('published','closed')
    AND d.work_date>='2026-10-08' AND NOT s.overtime AND s.leave_kind IS NULL
    AND NOT EXISTS(SELECT 1 FROM ty_leave_request x JOIN ty_leave_account a ON a.id=x.account_id
      WHERE a.relationship_id=$2 AND x.status IN('pending','approved','taken')
      AND tstzrange(x.starts_at,x.ends_at,'[)')&&tstzrange(s.start_at AT TIME ZONE 'Asia/Shanghai',s.end_at AT TIME ZONE 'Asia/Shanghai','[)'))
    GROUP BY d.id ORDER BY d.work_date LIMIT 1`, [oldScene.employment_id, oldScene.relationship_id]);
  if (!day) fail('没有可用的既有合法工作日供错误演示单更正；未改原申请');
  await leave.cancelRequest(t, { userId: actors.manager.id, id: old.id,
    reason: '全部；修正初版演示选择法定节日本日，真实取消释放原占用，保留历史' });
  const stamp = value => String(value).slice(0,19).replace(' ', 'T') + '+08:00';
  const replacement = (await leave.submitRequest(t, { userId: actors.manager.id, input: {
    account_id: old.account_id, scheme_id: old.scheme_id, employment_id: old.employment_id,
    request_key: `${VERSION}:REQUEST:CN-PENDING:CALENDAR-CORRECTION-1`,
    starts_at: stamp(day.starts), ends_at: stamp(day.ends), evidence_ref: '全部；原错例有据取消后的新待核单，无真实附件' } })).request;
  const fixed = structuredClone(index);
  const row = fixed.scenes.find(s => s.key === 'CN-PENDING');
  row.operator = roleRecord(actors.manager);
  row.data = { ...row.data, request_id: replacement.id, starts_at: stamp(day.starts), ends_at: stamp(day.ends) };
  fixed.calendar_corrections = [...(fixed.calendar_corrections || []), { old_request_id: old.id,
    new_request_id: replacement.id, old_status: 'cancelled', reason: 'CN法定节日本日不扣法定年假；仅更正本工具初版单据' }];
  fixed.counts_after = await counts(t, index.group_id);
  fixed.created_counts = Object.fromEntries(Object.keys(fixed.counts_after).map(k => [k, fixed.counts_after[k] - fixed.counts_before[k]]));
  await t.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data)VALUES($1,'calendar_correction','advanced_leave_demo',$2,$3::jsonb)",
    [actors.manager.id,index.group_id,JSON.stringify(fixed)]);
  return { ...fixed, replayed: false, corrected_legacy_calendar: true };
}

export async function seedAdvancedLeaveDemo(db, { confirmSynthetic = false } = {}) {
  if (confirmSynthetic !== true) fail('必须明确 --confirm-synthetic；本工具仅用于TY-TEST帐套');
  return withTx(db, async t => {
    if (!(await one(t, "SELECT to_regclass('public.ty_leave_scheme') IS NOT NULL ok")).ok)
      fail('请先受控应用高级假期迁移；本工具不自动前滚数据库');
    const group = await one(t, "SELECT * FROM ty_group WHERE code='TY-TEST' FOR UPDATE");
    if (!group) fail('缺少既有TY-TEST工作区，未新建任何人员或账号');
    const proof = await one(t, "SELECT after_data FROM ty_audit WHERE action='seed' AND entity_kind='test_workspace' AND entity_id=$1 ORDER BY id DESC LIMIT 1", [group.id]);
    const size = await one(t, `SELECT (SELECT count(*) FROM ty_person WHERE group_id=$1)::int people,
      (SELECT count(*) FROM ty_test_account_profile WHERE group_id=$1)::int accounts`, [group.id]);
    if (!proof?.after_data?.synthetic || !proof.after_data.complete || size.people !== 62 || size.accounts !== 77)
      fail('前置条件不足：须为带完整标记的62名既有人员/77个既有账号；不补造身份或重置密码');
    const actors = await actorsFor(t, group.id);
    const previous = await one(t, "SELECT after_data FROM ty_audit WHERE action IN('seed','calendar_correction') AND entity_kind='advanced_leave_demo' AND entity_id=$1 AND after_data->>'version'=$2 ORDER BY id DESC LIMIT 1", [group.id, VERSION]);
    if (previous?.after_data?.complete) return (await repairLegacyCalendar(t, previous.after_data, actors))
      || { ...previous.after_data, replayed: true, existing_business_state_preserved: true };
    const before = await counts(t, group.id), scenes = [], warnings = [], schemes = new Map(), peopleIndex = [];
    const personRows = await q(t, `SELECT DISTINCT ON(p.id) p.id person_id,p.person_number,p.full_name,
      e.id employment_id,e.hire_date,e.leave_date,e.company_id,c.code company_code,c.name company_name,
      loc.region_code,loc.currency_code,pf.account_id,pf.profile_code,acc.login employee_login
      FROM ty_person p JOIN ty_employment e ON e.person_id=p.id JOIN ty_company c ON c.id=e.company_id
      CROSS JOIN LATERAL fn_ty_company_locale(c.id) loc
      JOIN ty_test_account_profile pf ON pf.person_id=p.id AND pf.group_id=p.group_id
      JOIN sys_account acc ON acc.id=pf.account_id AND acc.status='active'
      WHERE p.group_id=$1 AND p.status='active' AND e.status='active' AND e.hire_date<='2026-10-01'
      AND (e.leave_date IS NULL OR e.leave_date>='2026-12-31')
      AND pf.profile_code IN('store_staff','station_staff','store_manager')
      ORDER BY p.id,e.hire_date DESC,e.id`, [group.id]);
    if (personRows.some(p => !['CN','HK'].includes(p.region_code))) fail('人员公司地区未配置，不按品牌名称猜测');
    const cn = personRows.filter(p => p.region_code === 'CN'), hk = personRows.filter(p => p.region_code === 'HK');
    if (cn.length < 9 || hk.length < 4) fail('缺少足够既有直营人员支撑两地独立演示；未新增员工补数');
    const calendarRows = await q(t, `SELECT d.employment_id,d.work_date::text calendar_day,d.day_kind FROM ty_roster_day d
      JOIN ty_roster_period p ON p.id=d.period_id WHERE p.group_id=$1 AND p.period='2026-10-01'
      AND p.status IN('published','closed') ORDER BY d.work_date`, [group.id]);
    const personnelCalendars = Object.fromEntries(cn.map(p => [String(p.employment_id), {
      calendar_status: 'verified', calendar_version: 'SYNTHETIC-PUBLISHED-ROSTER-202610-CN-LEGAL-2026',
      calendar_valid_from: '2026-10-01', calendar_valid_to: '2026-11-01', holiday_dates: CN_HOLIDAYS_2026,
      rest_dates: calendarRows.filter(d => same(d.employment_id,p.employment_id) && d.day_kind==='rest').map(d=>d.calendar_day),
      synthetic_only: true
    }]));
    const marker = '人事假期资料复核';
    const call = (fn, args, actor = actors.manager) => fn(t, { ...args, userId: actor.id });

    const scheme = async (p, code, name, { statutory = false, unit = 'day', basis = 'calendar', draft = false, extra = {} } = {}) => {
      const key = `${p.company_id}:${code}`;
      if (schemes.has(key)) return schemes.get(key);
      const existing = await one(t, 'SELECT * FROM ty_leave_scheme WHERE group_id=$1 AND company_id=$2 AND code=$3 ORDER BY version DESC LIMIT 1', [group.id, p.company_id, code]);
      if (existing && existing.rules.demo_namespace !== VERSION)
        fail(`公司${p.company_code}假种${code}已有其他规则；未覆盖，须先核对既有配置`);
      const rules = { demo_namespace: VERSION, synthetic_only: true, disclaimer: marker, quantity_basis: basis,
        step: unit === 'minute' ? '1' : '0.5', calendar_version: 'DEMO-ONLY-2026-POLICY', rest_dates: [],
        holiday_dates: p.region_code === 'CN' ? CN_HOLIDAYS_2026 : [],
        ...(p.region_code==='CN' && code==='annual' ? {
          calendar_status:'verified',calendar_valid_from:'2026-10-01',calendar_valid_to:'2026-11-01',
          calendar_version:'SYNTHETIC-PUBLISHED-ROSTER-202610-CN-LEGAL-2026',
          personnel_calendars:Object.fromEntries(cn.filter(x=>same(x.company_id,p.company_id))
            .map(x=>[String(x.employment_id),personnelCalendars[String(x.employment_id)]]))
        } : {}),
        expiry_action: statutory ? 'legal_review' : 'expire', legal_rule_ref: statutory ? `${p.region_code}-REVIEWED-DEMO-20261117` : null,
        legal_review_ref: statutory ? 'SYNTHETIC-DEMO-REVIEW-NOT-CUSTOMER-LEGAL-ADVICE' : null,
        proration_denominator: 365, proration_rounding: 'floor', ...extra };
      let s = existing || (await call(leave.createScheme, { operationId: `${VERSION}:SCHEME:${key}`, input: {
        group_id: group.id, company_id: p.company_id, code, name, jurisdiction: p.region_code, unit, statutory,
        valid_from: '2026-01-01', rules } }, actors.creator)).scheme;
      if (!draft && s.status === 'draft') s = (await call(leave.publishScheme, { id: s.id }, actors.publisher)).scheme;
      schemes.set(key, s); return s;
    };
    const relationship = async p => {
      const mapped = await one(t, `SELECT r.* FROM ty_leave_relationship_employment x JOIN ty_leave_relationship r ON r.id=x.relationship_id WHERE x.employment_id=$1`, [p.employment_id]);
      if (mapped) {
        if (!same(mapped.group_id, group.id) || !same(mapped.person_id, p.person_id) || mapped.jurisdiction !== p.region_code)
          fail('既有真实关系映射不一致；未改写历史身份');
        return mapped;
      }
      const completedMonths = months(iso(p.hire_date), '2026-10-01');
      return (await call(leave.verifyRelationship, { input: { group_id: group.id, person_id: p.person_id,
        employment_ids: [p.employment_id], source_key: `${VERSION}:REL:${p.person_number}:${p.company_code}:${iso(p.hire_date)}`,
        legal_employer_key: `SYNTHETIC-STORE-EMPLOYER:${p.company_code}`, jurisdiction: p.region_code,
        valid_from: iso(p.hire_date), valid_to: p.leave_date ? nextDay(iso(p.leave_date)) : null,
        evidence_ref: marker + '；实际公司关系取现有入离职段；示范资格核定', qualifications: {
          synthetic_only: true, continuous_work_12_months: p.region_code === 'CN',
          service_years: p.region_code === 'CN' ? '3' : undefined,
          cumulative_service_note: p.region_code === 'CN' ? '既往工龄3年，不取客户花名册' : null,
          continuous_contract_verified: p.region_code === 'HK',
          continuous_contract_note: p.region_code === 'HK' ? '仅本演示的同雇主周时数核定，不以FT/PT标签推断客户资格' : null,
          completed_continuous_years: p.region_code === 'HK' ? Math.floor(completedMonths / 12) : undefined,
          completed_months_at_baseline: completedMonths, birth_event_verified: false, childcare_event_verified: false,
          medical_evidence_verified: false, cn_sick_locality_verified: false
        } } })).relationship;
    };
    const grant = async (p, r, s, total, suffix, { expires = '2026-12-31' } = {}) => {
      const existing = await one(t, `SELECT a.id account_id,l.* FROM ty_leave_account a JOIN ty_leave_lot l ON l.account_id=a.id
        WHERE a.relationship_id=$1 AND a.code=$2 AND l.entitlement_year=2026 ORDER BY l.id LIMIT 1`, [r.id, s.code]);
      if (existing) {
        warnings.push(`${p.person_number}/${s.code}复用既有2026权益，未重复发全年`);
        return { account_id: existing.account_id, lot: existing, reused: true };
      }
      return call(leave.grantCumulative, { input: { relationship_id: r.id, scheme_id: s.id, code: s.code,
        stable_key: `${VERSION}:${p.person_number}:${p.company_code}:${suffix}`, entitlement_year: 2026,
        valid_from: '2026-10-01', expires_on: expires, total, numerator: '1', denominator: '1',
        event_key: `${VERSION}:GRANT:${p.person_number}:${p.company_code}:${suffix}`,
        evidence_ref: marker + '；权益基线，未重置旧账本' } });
    };
    for (const p of personRows) {
      p.relationship = await relationship(p);
      p.annualScheme = await scheme(p, 'annual', p.region_code === 'CN' ? '内地法定年假·累计工龄' : '香港法定年假·周年取得',
        { statutory: true, basis: p.region_code === 'CN' ? 'roster' : 'calendar' });
      if (!p.annualScheme.statutory) fail('年假方案须明确法定属性');
      const total = p.region_code === 'CN' ? '5' : hkAnnualDays({ completedYears: p.relationship.qualifications.completed_continuous_years ?? 0 });
      p.annual = await grant(p, p.relationship, p.annualScheme, total, 'ANNUAL', { expires: p.region_code === 'HK' ? null : '2026-12-31' });
      if (p.region_code === 'HK') {
        p.extraAnnualScheme = await scheme(p, 'demo-contract-annual-advance', '合同额外预借年假·7日', {
          extra: { contractual_only: true, not_statutory_vested: true, source_note: '额外福利层，不伪称已满周年，不自动形成员工债务' } });
        p.extraAnnual = await grant(p, p.relationship, p.extraAnnualScheme, '7', 'CONTRACT-ANNUAL');
        p.sickScheme = await scheme(p, 'sick', '香港累积疾病日·基线', { statutory: true,
          extra: { category1_cap: '36', category2_cap: '84', combined_cap: '120', category2_days: '0',
            evidence_status: 'not_a_medical_certificate', pay_rate_ref: 'HK-ADW-4/5',
            required_qualification_facts: ['continuous_contract_verified'] } });
        const completed = months(iso(p.hire_date), '2026-10-01');
        const days = String(Math.min(completed, 12) * 2 + Math.max(0, completed - 12) * 4);
        p.sick = await grant(p, p.relationship, p.sickScheme, days, 'SICK-CATEGORY1');
      }
      peopleIndex.push({ person_number: p.person_number, full_name: p.full_name, region: p.region_code,
        company_code: p.company_code, company_name: p.company_name, employee_login: p.employee_login,
        relationship_id: p.relationship.id, employment_id: p.employment_id, annual_account_id: p.annual.account_id,
        annual_scheme_id: p.annualScheme.id, annual_scheme_name: p.annualScheme.name,
        statutory_annual_days: total, extra_annual_account_id: p.extraAnnual?.account_id || null,
        sick_account_id: p.sick?.account_id || null, synthetic_only: true });
    }
    const scene = (key, p, ids, expected, operator = actors.manager, limitations = []) => {
      const row = { key, person_number: p.person_number, full_name: p.full_name, employee_login: p.employee_login,
        company_name: p.company_name, relationship_id: p.relationship.id, employment_id: p.employment_id,
        operator: roleRecord(operator), reviewer: roleRecord(actors.reviewer), data: ids,
        expected_initial_state: expected, entry: '#attendance/leave', route: 'attendance/leave',
        employee_entry: '#my/leave', limitations, all_fictional: true };
      scenes.push(row); return row;
    };
    const request = async (key, p, s, g, starts, ends, state) => {
      const selfCan = !!(await one(t, "SELECT fn_role_can($1,'advanced_leave_self','write') ok", [p.account_id])).ok;
      const operator = selfCan ? { id: p.account_id, login: p.employee_login, display_name: p.full_name, profile_code: p.profile_code } : actors.manager;
      const r = (await call(leave.submitRequest, { self: selfCan, input: { account_id: g.account_id, scheme_id: s.id,
        employment_id: p.employment_id, request_key: `${VERSION}:REQUEST:${key}`, starts_at: starts, ends_at: ends,
        evidence_ref: marker + '；仅示范申请事由，不代表材料已获核' } }, operator)).request;
      if (['approved','taken','rejected'].includes(state)) await call(leave.decideRequest,
        { id: r.id, approve: state !== 'rejected', reason: marker + '；双人审批演练' }, actors.reviewer);
      if (state === 'taken') await call(leave.settleRequest, { id: r.id, evidenceRef: marker + '；实际休假核定' });
      if (state === 'cancelled') await call(leave.cancelRequest, { id: r.id, self: selfCan, reason: marker + '；申请人取消演练' }, operator);
      return scene(key, p, { request_id: r.id, account_id: g.account_id, scheme_id: s.id, lot_id: g.lot.id, starts_at: starts, ends_at: ends }, state, operator,
        ['假期域真实状态；既有10月考勤/工资未自动改写，后续采用仍须明确复核']);
    };
    const rosterDays = await q(t, `SELECT d.person_id,d.employment_id,d.work_date::text work_date,
      jsonb_agg(jsonb_build_object('start',to_char(s.start_at,'YYYY-MM-DD"T"HH24:MI:SS')||'+08:00',
      'end',to_char(s.end_at,'YYYY-MM-DD"T"HH24:MI:SS')||'+08:00','leave_kind',s.leave_kind) ORDER BY s.start_at) segments
      FROM ty_roster_day d JOIN ty_roster_period p ON p.id=d.period_id JOIN ty_roster_segment s ON s.day_id=d.id
      WHERE p.group_id=$1 AND p.period='2026-10-01' AND p.status IN('published','closed') AND NOT s.overtime
      GROUP BY d.id ORDER BY d.work_date,d.id`, [group.id]);
    const candidate = (people, kind) => {
      for (const p of people) {
        const d = rosterDays.find(d => same(d.employment_id, p.employment_id)
          && !CN_HOLIDAYS_2026.includes(d.work_date)
          && (kind === 'taken' ? d.segments.some(s => s.leave_kind === 'annual_leave') : d.segments.every(s => !s.leave_kind)));
        if (d) return { p, d };
      }
      return null;
    };
    // Actual CN annual leave follows the published multi-shift roster, not a global eight-hour day.
    // The CN annual schemes below are configured as roster-based at creation.
    const taken = candidate(cn, 'taken');
    if (!taken) fail('10月既有排班缺少可核对年假标记；未将已打卡工作日伪装成实际已休');
    await request('CN-TAKEN', taken.p, taken.p.annualScheme, taken.p.annual,
      taken.d.segments[0].start, taken.d.segments.at(-1).end, 'taken');
    const pending = candidate(cn.filter(p => !same(p.person_id, taken.p.person_id)), 'work');
    if (!pending) fail('缺少已发布排班供待批案例使用');
    await request('CN-PENDING', pending.p, pending.p.annualScheme, pending.p.annual,
      pending.d.segments[0].start, pending.d.segments.at(-1).end, 'pending');
    const cancelled = candidate(cn.filter(p => !same(p.person_id, taken.p.person_id) && !same(p.person_id, pending.p.person_id)), 'work');
    if (cancelled) await request('CN-CANCELLED', cancelled.p, cancelled.p.annualScheme, cancelled.p.annual,
      cancelled.d.segments[0].start, cancelled.d.segments.at(-1).end, 'cancelled');
    await request('HK-FUTURE-APPROVED', hk[0], hk[0].extraAnnualScheme, hk[0].extraAnnual,
      '2026-11-23T00:00:00+08:00', '2026-11-24T00:00:00+08:00', 'approved');
    await request('HK-REJECTED', hk[1], hk[1].extraAnnualScheme, hk[1].extraAnnual,
      '2026-11-26T00:00:00+08:00', '2026-11-27T00:00:00+08:00', 'rejected');
    await request('HK-SICK-PENDING', hk[2], hk[2].sickScheme, hk[2].sick,
      '2026-11-02T00:00:00+08:00', '2026-11-06T00:00:00+08:00', 'pending');

    const multi = rosterDays.find(d => same(cn[8].employment_id, d.employment_id)
      && d.segments.length >= 2 && d.segments.every(s => !s.leave_kind)
      && Date.parse(d.segments[1].start) - Date.parse(d.segments[0].end) >= 1800000);
    if (!multi) fail('缺少既有一天多班场景，未伪造排班或原始打卡');
    const mp = cn.find(p => same(p.employment_id, multi.employment_id));
    const ms = await scheme(mp, 'demo-welfare-minutes', '企业福利分钟额度·多班请假', { unit: 'minute', basis: 'roster',
      extra: { source_note: '企业福利240分钟；不是已付加班再次兑换调休' } });
    const mg = await grant(mp, mp.relationship, ms, '240', 'WELFARE-MINUTES');
    const stamp = n => new Date(n).toISOString();
    await request('CN-MULTISHIFT-MINUTES', mp, ms, mg,
      stamp(Date.parse(multi.segments[0].end) - 1800000), stamp(Date.parse(multi.segments[1].start) + 1800000), 'pending');

    for (const [i, approved] of [[5, false], [6, true]]) {
      const p = cn[i], adjustment = (await call(leave.previewAdjustment, { operationId: `${VERSION}:ADJUST:${p.person_number}`, input: {
        lot_id: p.annual.lot.id, mode: 'delta', value: approved ? '1' : '0.5',
        evidence_ref: marker + '；企业额外福利增额，不减少法定义务', reason: '人工有据增额演练' } })).adjustment;
      if (approved) await call(leave.applyAdjustment, { id: adjustment.id }, actors.reviewer);
      scene(approved ? 'ADJUST-APPROVED' : 'ADJUST-PENDING', p,
        { account_id: p.annual.account_id, adjustment_id: adjustment.id, lot_id: p.annual.lot.id }, approved ? 'applied_once' : 'awaiting_second_person_review');
    }
    const payPerson = cn[7], parent = `${VERSION}:PAY:${payPerson.person_number}`;
    const initial = { account_id: payPerson.annual.account_id, parent_key: parent, currency: 'CNY', revision: 1,
      target: '800', normal_covered: '600', source_ref: marker + '；核准假薪解释版本1，非外部凭证' };
    const first = await call(leave.createPayrollCandidate, { input: initial });
    await call(leave.createPayrollCandidate, { input: { ...initial, revision: 2, target: '900',
      source_ref: marker + '；核准假薪解释版本2，待工资复核采用' } });
    const delta = leavePayAdoptionDelta({ target: '900', normalCovered: '600', alreadyAdopted: '200', revision: 2, currentRevision: 2 });
    scene('PAYROLL-CANDIDATE-NET-DELTA', payPerson, { account_id: payPerson.annual.account_id,
      obligation_id: first.obligation.id, parent_key: parent, source_revisions: [1, 2], preview_delta: delta.delta },
      'v1追加200、v2追加300；若v1已采用则本次净差100。本示例仅两版候选，未采用/未付', actors.manager,
      ['没有捏造工资批次、银行成功或政府回执；源版本留痕不改既有10月工资']);

    const templates = [
      [cn[0], 'demo-cn-sick-locality-pending', '内地病假·属地与工资规则待核', { locality: null, sick_pay_rate: null }],
      [cn[1], 'demo-cn-maternity-pending', '内地产假·事件及地方附加待核', { national_base_calendar_days: '98', local_additional_days: null, birth_event_verified: false }],
      [cn[2], 'demo-cn-childcare-pending', '育儿假·地区与子女资格待核', { annual_days: null, locality: null, childcare_event_verified: false }],
      [cn[3], 'demo-cn-lactation-pending', '哺乳周期·资格及发生计划待核', { daily_minutes: '60', event_verified: false, occurrences_generated: false }],
      [hk[3], 'demo-hk-maternity-pending', '香港产假·休假与给薪资格待核', { base_weeks: '14', paid_weeks40_verified: false, ADW_verified: false }],
      [cn[4], 'demo-toil-allocation-pending', '调休与预支·原加班补偿去向待核', { source_overtime_fact: null, cash_compensation_already_adopted: null, advance_enabled: false }]
    ];
    for (const [p, code, name, extra] of templates) {
      const s = await scheme(p, code, name, { draft: true, extra: { ...extra,
        status_reason: '全部；未核资格/地区规则或未实现办理，不发布、不发放、不产生工资', enabled: false } });
      scene('TEMPLATE-' + code, p, { scheme_id: s.id }, 'draft_not_enabled', actors.creator,
        ['人员只是待核界面示例，不推断该人员性别、生育、疾病或子女情况；没有真实附件']);
    }
    const after = await counts(t, group.id);
    const index = { version: VERSION, seed_revision: 2, complete: true, synthetic: true, group_id: group.id,
      base_period: '2026-10', observation_date: '2026-11-17', all_facts_fictional: true,
      changed_passwords: 0, created_people: 0, created_accounts: 0, external_receipts: 0,
      existing_person_count: size.people, existing_account_count: size.accounts,
      roles: Object.fromEntries(Object.entries(actors).map(([k, a]) => [k, roleRecord(a)])),
      people: peopleIndex, scenes, warnings, counts_before: before, counts_after: after,
      created_counts: Object.fromEntries(Object.keys(after).map(k => [k, after[k] - before[k]])),
      limitations: ['仅使用现有人员，不重排原始班表或改已确认工资',
        '香港2026入职员工法定周年年假未取得时显示0；合同额外福利独立',
        '母婴/育儿/属地病假/调休预支以未启用草稿明确展示，未知不变0或全国默认',
        '延期、结转、现金转换及完整工资采用应待正式生命周期接口核验后继续补充'] };
    await t.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data)VALUES($1,'seed','advanced_leave_demo',$2,$3::jsonb)",
      [actors.manager.id, group.id, JSON.stringify(index)]);
    return { ...index, replayed: false };
  });
}

async function main() {
  if (!process.argv.includes('--confirm-synthetic')) fail('必须显式 --confirm-synthetic');
  const arg = process.argv.indexOf('--out');
  if (arg >= 0 && (!process.argv[arg + 1] || process.argv[arg + 1].startsWith('--'))) fail('--out后须提供明确的场景索引文件名');
  if (process.env.CONTROL_URL) fail('本工具仅用于单部署数据库逻辑帐套，拒绝CONTROL_URL');
  if (process.env.DATABASE_URL && process.env.PGLITE_DATA_DIR) fail('DATABASE_URL与PGLITE_DATA_DIR请只选一个明确持久目标');
  if (!process.env.DATABASE_URL && !process.env.PGLITE_DATA_DIR) fail('必须明确持久DATABASE_URL或PGLITE_DATA_DIR；拒绝默认内存演示');
  const db = await createDb({ url: process.env.DATABASE_URL || undefined, dataDir: process.env.PGLITE_DATA_DIR || undefined });
  try {
    const result = await seedAdvancedLeaveDemo(db, { confirmSynthetic: true });
    const file = resolve(arg >= 0 ? process.argv[arg + 1] : resolve(process.env.TYHR_RUNTIME_DIR || '../.runtime', 'advanced-leave-demo-scenes.json'));
    await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 });
    await writeFile(file + '.tmp', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    await chmod(file + '.tmp', 0o600); await rename(file + '.tmp', file); await chmod(file, 0o600);
    console.log(JSON.stringify({ version: VERSION, replayed: result.replayed, existing_people: result.existing_person_count,
      existing_accounts: result.existing_account_count, created: result.created_counts, scenes: result.scenes.length,
      passwords_changed: 0, external_receipts: 0, scene_index: file }));
  } finally { await db.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch(e => { console.error(String(e.message).replace(/postgres(?:ql)?:\/\/\S+/gi, '[已隐藏数据库连接]')); process.exitCode = 1; });
