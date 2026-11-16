// Independent fictional business oracles. No production database or real employee data.
// Run: node --test test/advanced-leave-law.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const fixtureText = readFileSync(new URL('./fixtures/advanced-leave-law.json', import.meta.url), 'utf8');
const fixture = JSON.parse(fixtureText);
const cases = new Map(fixture.cases.map(c => [c.case_id, c]));
const api = await import('../app/leave-calculations.mjs');
const invoke = (name, ...args) => {
  assert.equal(typeof api[name], 'function', `NOT_IMPLEMENTED: required business algorithm ${name}`);
  return api[name](...args);
};
const decimal = value => {
  assert.equal(typeof value, 'string', 'Decimal output must be a string, never binary floating point');
  assert.match(value, /^-?\d+(\.\d+)?$/);
  const [whole, part = ''] = value.split('.');
  return [BigInt(whole + part), 10n ** BigInt(part.length)];
};
const equalDecimal = (actual, expected, message) => {
  const [an, ad] = decimal(actual), [en, ed] = decimal(expected);
  assert.equal(an * ed, en * ad, message);
};
const equalFraction = (actual, expected, message) => {
  assert.ok(actual && typeof actual === 'object', 'Exact fraction required');
  assert.ok(BigInt(actual.denominator) > 0n, 'Positive exact denominator required');
  assert.equal(BigInt(actual.numerator) * BigInt(expected.denominator),
    BigInt(expected.numerator) * BigInt(actual.denominator), message);
};
const scenario = (id, fn) => test(`${id} ${cases.get(id).title}`, () => fn(cases.get(id)));

test('Fictional repository fixture has 18 distinct scenarios and no machine paths', () => {
  assert.equal(fixture.all_facts_people_ids_amounts_are_fictional, true);
  assert.equal(cases.size, 18);
  assert.equal(fixture.case_count, 18);
  assert.doesNotMatch(fixtureText, /\/Users\/|file:\/\/|[A-Za-z]:\\Users\\/);
  for (const c of cases.values()) for (const source of c.source_ids) assert.ok(fixture.sources[source]);
});

scenario('L-H01', ({ input: i, expected: e }) => {
  equalDecimal(invoke('cnAnnualBand', { serviceYears: i.cumulative_qualifying_service_years,
    eligible: i.continuous_work_12_months_eligibility_verified }), e.statutory_full_year_band_days);
  for (const [years, expected] of [['0.99','0'],['1','5'],['9.99','5'],['10','10'],['19.99','10'],['20','15']])
    equalDecimal(invoke('cnAnnualBand', { serviceYears: years }), expected, `Cumulative years ${years}`);
  equalDecimal(invoke('cnAnnualBand', { serviceYears: '11', eligible: false }), '0');
});

scenario('L-H02', ({ input: i, expected: e }) => {
  const result = invoke('cnAnnualProration', { calendarDays: i.qualifying_remaining_calendar_days,
    annualDays: i.full_year_band_days });
  equalFraction(result.fraction, e.unrounded_days_fraction);
  equalDecimal(result.days, e.statutory_grant_days);
});

scenario('L-H03', ({ input: i, expected: e }) => {
  const result = invoke('cnAnnualProration', { calendarDays: i.calendar_days_in_current_year,
    annualDays: i.full_year_band_days, alreadyTaken: i.statutory_days_already_arranged, termination: true });
  equalFraction(result.fraction, e.unrounded_prorated_days_fraction);
  equalDecimal(result.days, e.termination_untaken_payable_days);
  equalDecimal(result.recoverDays, e.recover_already_arranged_days);
});

scenario('L-H04', ({ input: i, expected: e }) => {
  const result = invoke('cnUnusedAnnualPay', { monthlyAverage: i.verified_12_month_average_excluding_overtime,
    days: i.eligible_untaken_days, normalPaid: i.normal_pay_for_same_days_already_paid,
    extraPaid: i.extra_untaken_compensation_already_paid });
  for (const [field, expected] of Object.entries({ dailyWage: e.daily_wage, totalTarget: e.statutory_total_target_for_same_days,
    extraTarget: e.extra_compensation_target, extraRemaining: e.extra_compensation_remaining }))
    equalDecimal(result[field], expected, field);
});

scenario('L-H05', ({ input: i }) => {
  const result = invoke('expiryDecision', { statutory: true, remaining: i.statutory_days_unused });
  assert.equal(result.action, 'legal_review');
  equalDecimal(result.expire, '0');
  const protectedWelfare = invoke('expiryDecision', { statutory: false, remaining: '3', approvedReservations: '2' });
  equalDecimal(protectedWelfare.expire, '1');
  const fullyReserved = invoke('expiryDecision', { statutory: false, remaining: '3', approvedReservations: '3' });
  equalDecimal(fullyReserved.expire, '0');
});

scenario('L-H06', ({ input: i, expected: e }) => {
  const result = invoke('localSickPayDecision', { jurisdiction: i.jurisdiction, locality: i.applicable_locality,
    ruleVersion: i.locality_rule_version, sickLeaveAccepted: i.sick_leave_accepted });
  assert.equal(result.status, e.sick_pay_rule_status);
  assert.equal(result.amount, null);
  assert.equal(result.uncontroversialPayrollCanProceed, true);
});

scenario('L-H07', ({ input: i }) => {
  assert.equal(invoke('hkContinuousContract', { weekHours: i.recognized_hours }).eligible, true);
  // First three weeks cannot borrow later hours through the 468 alternative.
  assert.equal(invoke('hkContinuousContract', { weekHours: ['14','30','30','30'] }).eligible, false);
  assert.equal(invoke('hkContinuousContract', { weekHours: ['30','30','30'] }).eligible, false);
  assert.equal(invoke('hkContinuousContract', { weekHours: ['17','17','17','17'] }).eligible, true);
  assert.equal(invoke('hkContinuousContract', { weekHours: ['18','18','18','13.99'] }).eligible, false);
  assert.equal(invoke('hkContinuousContract', { weekHours: ['18','18','18','18'], priorRule: true }).eligible, true);
  assert.equal(invoke('hkContinuousContract', { weekHours: ['18','18','18','17.99'], priorRule: true }).eligible, false);
});

scenario('L-H08', ({ input: i, expected: e }) => {
  // Call the actual algorithm separately at the legal-employer boundary. Cross-employer
  // grouping must additionally be enforced by the service/DB integration tests.
  for (const [employer, weekHours] of Object.entries(i.employer_weekly_hours))
    assert.equal(invoke('hkContinuousContract', { weekHours }).eligible,
      e.weekly_or_468_met_by_employer[employer], employer);
});

scenario('L-H09', ({ input: i, expected: e }) => {
  const common = i.common_year_case;
  const result = invoke('hkCommonYearProration', { annualDays: common.full_year_entitlement_days,
    calendarDays: common.first_period_calendar_days, yearDays: '365' });
  equalFraction(result.fraction, e.common_year_case.unrounded_days_fraction);
  equalDecimal(result.days, e.common_year_case.first_period_days);
  equalDecimal(invoke('hkAnnualDays', { completedYears: 0 }), '0');
  for (const [years, days] of Object.entries(e.full_year_service_band))
    equalDecimal(invoke('hkAnnualDays', { completedYears: years === '9_or_more' ? 9 : Number(years) }), days);
  equalDecimal(invoke('hkAnnualDays', { completedYears: 30 }), '14');
});

scenario('L-H10', ({ input: i, expected: e }) => {
  const result = invoke('hkAnnualCalendar', { startDate: i.annual_leave_start, endExclusive: i.annual_leave_end_exclusive,
    restDates: i.appointed_rest_day_dates, statutoryHolidayDates: i.statutory_holiday_dates });
  equalDecimal(result.annualDays, e.annual_leave_days_for_unbroken_period);
  assert.deepEqual(result.replacementRestDates, ['2026-06-21']);
  assert.deepEqual(result.replacementHolidayDates, ['2026-06-19']);
});

scenario('L-H11', ({ input: i, expected: e }) => {
  const result = invoke('hkAnnualCashChoice', { entitledDays: i.statutory_entitlement_days,
    requestedDays: i.employee_requested_cash_in_lieu_days });
  assert.equal(result.allowed, false);
  equalDecimal(result.maxCashDays, e.maximum_statutory_choice_days_above_10);
  assert.equal(invoke('hkAnnualCashChoice', { entitledDays: '14', requestedDays: '4' }).allowed, true);
  assert.equal(invoke('hkAnnualCashChoice', { entitledDays: '10', requestedDays: '0.5' }).allowed, false);
});

scenario('L-H12', ({ input: i, expected: e }) => {
  const allocation = invoke('hkSicknessAllocation', { days: '4', category1: i.opening_category1_days,
    category2: i.opening_category2_days });
  equalDecimal(allocation.category1Used, '4');
  equalDecimal(allocation.category2Used, '0');
  equalDecimal(allocation.pendingDays, '0');
  const pay = invoke('hkSicknessPay', { adw: '400', days: '4' });
  equalDecimal(pay.paidSicknessDays, e.qualifying_sickness_allowance_days);
  equalDecimal(pay.dailyTarget, e.daily_sickness_allowance);
  equalDecimal(pay.total, e.total_sickness_allowance_target);
});

scenario('L-H13', ({ input: i, expected: e }) => {
  const args = { days: i.qualified_sickness_days, category1: i.opening_category1_days,
    category2: i.opening_category2_days, category2ProofRequired: true };
  const allocation = invoke('hkSicknessAllocation', { ...args, category2Proof: true });
  equalDecimal(allocation.category1Used, e.complete_evidence_variant.consume_category1_days);
  equalDecimal(allocation.category2Used, e.complete_evidence_variant.consume_category2_days);
  equalDecimal(allocation.pendingDays, '0');
  const missing = invoke('hkSicknessAllocation', { ...args, category2Proof: false });
  assert.equal(missing.status, e.missing_evidence_variant.category2_confirmation_status);
  equalDecimal(missing.category2Used, '0');
  equalDecimal(missing.pendingDays, '2');
  equalDecimal(invoke('hkSicknessAccrual', { completedMonths: 12, previousCompletedMonths: 0 }).grant, '24');
  equalDecimal(invoke('hkSicknessAccrual', { completedMonths: 13, previousCompletedMonths: 12,
    category1: '24', category2: '0' }).grant, '4');
  const full = invoke('hkSicknessAccrual', { completedMonths: 37, previousCompletedMonths: 36, category1: '36', category2: '84' });
  equalDecimal(full.grant, '0');
  // 120 is a current-balance cap, never a lifetime grant cap. Consumption reopens room.
  const replenish = invoke('hkSicknessAccrual', { completedMonths: 37, previousCompletedMonths: 36, category1: '32', category2: '84' });
  equalDecimal(replenish.grant, '4');
  equalDecimal(replenish.category1, '36');
  equalDecimal(replenish.category2, '84');
});

scenario('L-H14', ({ input: i, expected: e }) => {
  const pay = invoke('hkSicknessPay', { adw: i.adw, days: i.illness_calendar_days, paidHolidayDays: '1' });
  equalDecimal(pay.paidSicknessDays, e.sickness_allowance_days);
  equalDecimal(pay.total, e.sickness_allowance_target);
  equalDecimal(invoke('decimalAdd', pay.total, e.statutory_holiday_pay_target), e.total_leave_pay_targets);
  const workInjury = invoke('hkSicknessPay', { adw: i.adw, days: '4', employeesCompensationDays: '4' });
  equalDecimal(workInjury.total, '0');
});

scenario('L-H15', ({ input: i, expected: e }) => {
  const result = invoke('hkADW', { wages: i.gross_wages_before_employee_MPF_deduction, calendarDays: i.calendar_days,
    excludedDays: i.lawfully_disregarded_underpaid_days, excludedWages: i.wages_attributed_to_same_disregarded_days });
  equalFraction(result.fraction, e.adw_exact_fraction);
  equalDecimal(result.display, e.adw_display_only);
  equalDecimal(result.includedWages, e.included_wages);
  equalDecimal(result.includedDays, e.included_days);
  const fourDays = invoke('hkSicknessPay', { adw: result.fraction, days: '4' });
  // Exact 75520/71 is rounded once at the 2dp monetary output. Rounding the
  // displayed daily rate first would incorrectly yield 1063.68 instead.
  equalDecimal(fourDays.total, '1063.66');
  assert.throws(() => invoke('hkADW', { wages: '120000', calendarDays: '365',
    excludedDays: '365', excludedWages: '120000' }));
  assert.throws(() => invoke('hkADW', { wages: '100', calendarDays: '30',
    excludedDays: '1', excludedWages: '101' }));
});

scenario('L-H16', ({ input: i, expected: e }) => {
  // This guard decides CAS eligibility. Preservation of actual rows on rejection
  // additionally belongs to the isolated service/DB integration suite.
  const result = invoke('grantOverwriteDecision', { baselineRevision: i.approved_revision,
    currentRevision: i.current_before_apply.revision });
  assert.equal(result.status, e.apply_result);
  assert.equal(result.allowed, false);
  assert.equal(invoke('grantOverwriteDecision', { baselineRevision: 8, currentRevision: 8 }).allowed, true);
});

scenario('L-H17', ({ input: i, expected: e }) => {
  const first = invoke('leavePayAdoptionDelta', { target: i.source_revision1_target,
    normalCovered: i.normal_wage_already_covering_same_period, alreadyAdopted: '0', revision: 1, currentRevision: 1 });
  equalDecimal(first.additionalTarget, e.after_three_revision1_entries.additional_cash_target);
  const replay = invoke('leavePayAdoptionDelta', { target: i.source_revision1_target,
    normalCovered: i.normal_wage_already_covering_same_period, alreadyAdopted: '200', revision: 1, currentRevision: 1 });
  equalDecimal(replay.delta, '0');
  const revised = invoke('leavePayAdoptionDelta', { target: i.source_revision2_target,
    normalCovered: i.normal_wage_already_covering_same_period, alreadyAdopted: '200', revision: 2, currentRevision: 2 });
  equalDecimal(revised.additionalTarget, e.after_revision2_replacement.additional_cash_target);
  equalDecimal(revised.delta, e.after_revision2_replacement.additional_cash_net_delta_vs_revision1);
  const stale = invoke('leavePayAdoptionDelta', { target: i.source_revision1_target,
    normalCovered: i.normal_wage_already_covering_same_period, alreadyAdopted: '300', revision: 1, currentRevision: 2 });
  assert.equal(stale.stale, true);
  equalDecimal(stale.delta, e.source_revision1_replay_after_revision2_cash_delta);
  assert.throws(() => invoke('leavePayAdoptionDelta', { target: '900', normalCovered: '600',
    alreadyAdopted: '200', revision: 3, currentRevision: 2 }));
});

scenario('L-H18', ({ input: i, expected: e }) => {
  const leaveDates = Object.keys(e.statutory_paternity_pay_by_date);
  const result = invoke('hkPaternityPay', { startDate: i.continuous_employment_start, leaveDates, adw: '400',
    continuousContract: true, otherEligibility: true });
  equalDecimal(result.paidDays, e.statutory_paid_paternity_leave_days);
  equalDecimal(result.total, e.statutory_paternity_pay_total);
  for (const [date, amount] of Object.entries(e.statutory_paternity_pay_by_date)) equalDecimal(result.byDate[date], amount);
  equalDecimal(invoke('hkPaternityPay', { startDate: i.continuous_employment_start, leaveDates,
    adw: '400', continuousContract: false }).total, '0');
  assert.throws(() => invoke('hkPaternityPay', { startDate: i.continuous_employment_start,
    leaveDates: [leaveDates[0], leaveDates[0]], adw: '400' }));
});

test('Additional real algorithms: multi-shift/rest union and cumulative fractional grants', () => {
  const at = t => `2026-11-16T${t}:00+08:00`;
  assert.equal(invoke('multiShiftMinutes', { segments: [
    { start: at('10:00'), end: at('14:00') }, { start: at('17:00'), end: at('21:00') }],
    requestStart: at('13:00'), requestEnd: at('18:00') }), 120);
  assert.equal(invoke('multiShiftMinutes', { segments: [
    { start: at('08:00'), end: at('12:00') }, { start: at('10:00'), end: at('14:00') }],
    requestStart: at('08:00'), requestEnd: at('14:00'), rests: [
      { start: at('11:00'), end: at('12:00') }, { start: at('11:30'), end: at('12:30') }] }), 270);
  assert.equal(invoke('multiShiftMinutes', { segments: [
    { start: at('22:00'), end: '2026-11-17T02:00:00+08:00' },
    { start: '2026-11-17T03:00:00+08:00', end: '2026-11-17T07:00:00+08:00' }],
    requestStart: at('23:00'), requestEnd: '2026-11-17T04:00:00+08:00' }), 240);
  for (const [numerator, granted, target, delta] of [['1','0','0.5','0.5'],['2','0.5','1.5','1'],['3','1.5','2.5','1'],['4','2.5','3','0.5'],['12','3','10','7']]) {
    const result = invoke('cumulativeGrant', { total: '10', numerator, denominator: '12', alreadyGranted: granted,
      scale: 1, rounding: 'floor', step: '0.5' });
    equalDecimal(result.target, target);
    equalDecimal(result.delta, delta);
  }
  const reduction = invoke('cumulativeGrant', { total: '10', numerator: '1', denominator: '2',
    alreadyGranted: '7', scale: 1, rounding: 'floor', step: '0.5' });
  equalDecimal(reduction.target, '5');
  equalDecimal(reduction.delta, '-2');
});
