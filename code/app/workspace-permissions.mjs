// Navigation follows server-returned resource capabilities. Backend scope and
// object authorization remain authoritative for every request.
const PERSONAL = new Set(['my-payroll','my-training','my-leave']);
const CONFIG = new Set(['groups','grants','foundation-bridge','foundation-import','legacy-ledger','legacy-policy','legacy-exceptions','legacy-health','legacy-mcp']);
const STRUCTURE = new Set(['brands','ledgers','organization','companies','departments','workareas','jobs','grades','positions','legacy-org']);
const PEOPLE = new Set(['people','employments','assignments','legacy-employees']);
const HR = new Set(['legacy-contract','legacy-exit']);
const SALARY = new Set(['customer-payroll','hk-tools','legacy-payroll','legacy-payslip','legacy-salaryitem','legacy-adjust','legacy-paypolicy','legacy-siledger','legacy-declare','legacy-settlement','legacy-severance','legacy-cashout']);
const ATTENDANCE = new Set(['legacy-roster','legacy-attendance','legacy-attx','legacy-att','legacy-close']);
export function canOpenRoute(route,capabilities={}) {
  const resources=capabilities.resources||{},profile=capabilities.profile_code;
  const read=code=>!!resources[code]?.can_read,write=code=>!!resources[code]?.can_write;
  if(route==='home'||route==='legacy-roles')return true;
  if(PERSONAL.has(route))return !!capabilities.has_person&&read(route==='my-payroll'?'payslip':route==='my-leave'?'leave_request':'training_self');
  if(['store_staff','station_staff'].includes(profile)&&!['organization','people','employments','assignments'].includes(route))return false;
  if(profile==='store_manager'&&['customer-performance','legacy-contract','legacy-exit','legacy-severance','legacy-settlement'].includes(route))return false;
  if(profile==='config_admin'&&['foundation-import','foundation-bridge'].includes(route))return false;
  if(CONFIG.has(route))return write('ledger')&&(profile!=='boss');
  if(profile==='config_admin'&&!STRUCTURE.has(route))return false;
  if(STRUCTURE.has(route))return read('ledger')||read('people_read_all')||read('people_self')||read('employee_roster');
  if(PEOPLE.has(route))return read('people_read_all')||read('people_self')||read('employee_roster');
  if(HR.has(route))return read('employment_manage')||(!profile&&read('employee_roster'));
  if(SALARY.has(route)) {
    if(route==='legacy-payslip')return read('payslip')&&read('payroll_slips_read_all');
    if(route==='legacy-settlement')return read('settlement');
    return read('payroll_run')&&read('payroll_slips_read_all');
  }
  if(ATTENDANCE.has(route))return read('attendance_daily');
  if(route==='legacy-punch')return read('punch');
  if(['legacy-leave','legacy-leavereq'].includes(route))return read('leave_request');
  if(route==='legacy-recruit')return read('requisition');
  if(route==='legacy-headcount')return read('headcount');
  if(['customer-performance','legacy-perf'].includes(route))return read('perf_cycle');
  if(route==='legacy-training')return read('training_manage')||(!profile&&read('employee_roster'));
  if(['legacy-dashboard','legacy-report'].includes(route))return read('report');
  if(route==='legacy-approval')return read('approval');
  if(route==='legacy-home')return !profile||['demo','boss','hr_manager'].includes(profile);
  return false;
}
