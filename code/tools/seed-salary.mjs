// ============================================================================
// tools/seed-salary.mjs · 给一个人定月薪 + 拆工资结构
// ----------------------------------------------------------------------------
// 用法：
//   DATABASE_URL=postgres://... node tools/seed-salary.mjs \
//     --login dm318588 --monthly 13000 --from 2026-11-01 \
//     --items '[{"item_code":"BASE","amount":9000},{"item_code":"POST_ALLOW","amount":3000},
//               {"item_code":"MEAL","amount":600},{"item_code":"COMM","amount":400}]'
//
// 为什么要有这个脚本，而不是在库里手敲两条 INSERT：
//   ① 月薪标准与结构是**一次动作的两半**，分开写很容易只写一半 ——
//      只写 standard 的话工资能算出来但工资条上只有一行"基本工资 13000"，
//      看起来"也对"，直到有人问"我的岗位津贴呢"；
//   ② 结构合计必须等于月薪（fn_salary_structure_set 会拒），
//      脚本里先算一遍再写，错在命令行就能看见，不用等界面报错；
//   ③ 幂等：重复跑不会堆出两条月薪标准（同生效日覆盖，不同生效日视为调薪）。
// ============================================================================
import { createDb } from '../app/db.mjs';

const arg = (k, d = null) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const url = process.env.DATABASE_URL;
if (!url) { console.error('必须给 DATABASE_URL'); process.exit(2); }

const login = arg('login');
const monthly = Number(arg('monthly'));
const from = arg('from') || new Date().toISOString().slice(0, 8) + '01';
const itemsRaw = arg('items');

if (!login || !Number.isFinite(monthly) || monthly <= 0) {
  console.error('用法：--login <账号> --monthly <月薪> [--from YYYY-MM-DD] [--items json]');
  process.exit(2);
}

const db = await createDb({ url });

const who = (await db.query(
  `SELECT p.id AS person_id, p.full_name, e.id AS employment_id, e.hire_date
     FROM sys_account a
     JOIN person p ON p.id = a.person_id
     JOIN employment e ON e.person_id = p.id AND e.leave_date IS NULL
    WHERE a.login = $1
    ORDER BY e.hire_date DESC LIMIT 1`, [login])).rows[0];

if (!who) { console.error(`找不到账号 ${login} 的在职任职记录`); process.exit(1); }

// ① 月薪标准：同生效日覆盖，不同生效日视为调薪（历史保留）
const dup = (await db.query(
  `SELECT id FROM salary_standard WHERE employment_id = $1 AND effective_from = $2::date`,
  [who.employment_id, from])).rows[0];
if (dup) {
  await db.query(`UPDATE salary_standard SET monthly_amount = $2 WHERE id = $1`, [dup.id, monthly]);
} else {
  await db.query(
    `INSERT INTO salary_standard(employment_id, monthly_amount, effective_from)
     VALUES ($1,$2,$3::date)`, [who.employment_id, monthly, from]);
}

// ② 结构：没给就按 基本/岗位/餐补/通讯 的常见比例拆；总和必须等于月薪
let items = [];
if (itemsRaw) {
  items = JSON.parse(itemsRaw);
} else {
  const post = Math.min(3000, Math.round(monthly * 0.23));
  const meal = 600;
  const comm = 400;
  const base = monthly - post - meal - comm;
  items = [
    { item_code: 'BASE', amount: base },
    { item_code: 'POST_ALLOW', amount: post },
    { item_code: 'MEAL', amount: meal },
    { item_code: 'COMM', amount: comm },
  ];
}
const sum = items.reduce((a, x) => a + Number(x.amount || 0), 0);
if (Math.abs(sum - monthly) > 0.005) {
  console.error(`结构合计 ${sum} 与月薪 ${monthly} 不一致 —— 拆分只解释总额，不改总额`);
  process.exit(1);
}

const total = (await db.query(
  `SELECT fn_salary_structure_set($1,$2::date,$3::jsonb,'seed-salary') t`,
  [who.employment_id, from, JSON.stringify(items)])).rows[0].t;

const rows = (await db.query(
  `SELECT item_code, name, amount FROM fn_salary_structure_of($1,$2::date)`,
  [who.employment_id, from])).rows;

console.log(`\n${who.full_name}（${login}）· 生效 ${from}`);
console.log(`月薪标准 ${monthly}`);
for (const r of rows) console.log(`  ${r.name.padEnd(8)} ${Number(r.amount).toFixed(2).padStart(10)}`);
console.log(`  ${'合计'.padEnd(8)} ${Number(total).toFixed(2).padStart(10)}\n`);
await db.close();
