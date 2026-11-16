// ============================================================================
// tools/seed-positions.mjs · 按部门建岗位并授岗（客户可改，脚本只是初始化）
// ----------------------------------------------------------------------------
//   DATABASE_URL=postgres://.../aihr_demo node tools/seed-positions.mjs
//
// 岗位是**人为设计**的：这里给的是"香香鱼米"的一份初稿（对照钉钉的部门），
// 客户在界面上改就行 —— 脚本只是把"上线第一天"要做的事一次做完。
//
// 一人可多岗：下面 HOLDERS 里同一个人可以出现在多个岗位下（示例员工就是
// 销售主管 + 销售）。这不是数据错，是他的真实状态。
//
// 连锁餐饮的岗位初稿（参考通用连锁餐饮，不是某一家客户）：
//   店长 / 副店长 / 值班经理 / 收银 / 服务员 / 厨工 / 库管 / 配送 / 人事专员 / 薪酬专员
// 用 --profile retaurant 时按部门名匹配（没有对应部门就跳过，不硬造组织）。
// ============================================================================
import { createDb, withTx } from '../app/db.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('必须给 DATABASE_URL'); process.exit(2); }
const profile = (process.argv.includes('--restaurant')) ? 'restaurant' : 'dingmeng';

// 岗位：code / 名称 / 归属部门名（按名字匹配，找不到就建在集团根下）/ 级别 / 是否外包
const DM = [
  ['SALES_MGR',    '销售主管',   '销售部',     1, false],
  ['SALES',        '销售',       '销售部',     2, false],
  ['FIN_MGR',      '财务主管',   '财务部',     1, false],
  ['FIN',          '财务',       '财务部',     2, false],
  ['TECH_MGR',     '技术主管',   'TA开发部',   1, false],
  ['TECH',         '技术',       'TA开发部',   2, false],
  ['IMPL_DIR',     '实施总监',   '实施部',     1, false],
  ['IMPL_CONSULT', '实施顾问',   '实施部',     2, false],
  ['OUTSOURCE',    '外包人员',   '外部人员',   2, true],
];

const RESTAURANT = [
  ['STORE_MGR',  '店长',      '门店', 1, false],
  ['STORE_DEP',  '副店长',    '门店', 1, false],
  ['SHIFT_LEAD', '值班经理',  '门店', 1, false],
  ['CASHIER',    '收银员',    '门店', 2, false],
  ['SERVER',     '服务员',    '门店', 2, false],
  ['KITCHEN',    '厨工',      '门店', 2, false],
  ['STOCKER',    '库管',      '门店', 2, false],
  ['DELIVERY',   '配送员',    '门店', 2, false],
  ['HR_SPEC',    '人事专员',  null,   2, false],
  ['PAY_SPEC',   '薪酬专员',  null,   2, false],
];

// 授岗：姓名 → 岗位 code 列表（一人可多岗）
// 演示帐套：用户明确「示例员工 是销售主管，同时也是销售」；其余按部门推断
const HOLDERS_DM = {
  '示例员工': ['SALES_MGR', 'SALES'],
  '杨继勇': ['IMPL_DIR'],
  '陈斌':   ['IMPL_CONSULT'],
  '周杰':   ['IMPL_CONSULT'],
  '闫妍':   ['FIN'],
};

const PLAN = profile === 'restaurant' ? RESTAURANT : DM;

const db = await createDb({ url });
await db.initSession();
const today = (await db.query('SELECT app_today() d')).rows[0].d.toISOString().slice(0, 10);
const rootId = (await db.query(
  `SELECT id FROM org_unit WHERE parent_id IS NULL ORDER BY id LIMIT 1`)).rows[0]?.id;

const orgIdOf = async (name) => {
  if (!name) return rootId;
  const r = (await db.query(
    `SELECT id FROM org_unit WHERE name = $1 AND is_active ORDER BY id LIMIT 1`, [name])).rows[0];
  return r ? Number(r.id) : rootId;
};

let made = 0;
for (const [code, name, orgName, level, outsourced] of PLAN) {
  const org = await orgIdOf(orgName);
  await withTx(db, async (tx) => {
    await tx.query(`SELECT fn_position_upsert($1,$2,$3,$4,$5,$6)`,
      [code, name, org, level, outsourced, orgName ? `归属：${orgName}` : null]);
  });
  made += 1;
  console.log(`✓ 岗位 ${name.padEnd(6)} ${code.padEnd(13)} → ${orgName || '（集团）'}`);
}

if (profile === 'dingmeng') {
  let assigned = 0;
  for (const [who, codes] of Object.entries(HOLDERS_DM)) {
    const p = (await db.query(
      `SELECT id FROM person WHERE full_name = $1 ORDER BY id LIMIT 1`, [who])).rows[0];
    if (!p) { console.log(`· ${who}：库里没这个（钉钉没同步到？）`); continue; }
    for (const code of codes) {
      const pos = (await db.query(`SELECT id FROM position WHERE code = $1`, [code])).rows[0];
      if (!pos) continue;
      await db.query(`SELECT fn_position_assign($1,$2,$3::date,'seed')`,
        [p.id, pos.id, today]);
      assigned += 1;
    }
    console.log(`  ↳ ${who} → ${codes.join(' + ')}`);
  }
  console.log(`\n授岗 ${assigned} 条（一人可多岗）`);
}

// 汇总：每个岗位几个人
const rows = (await db.query(`SELECT * FROM fn_position_list(NULL, $1::date)`, [today])).rows;
console.log('\n岗位 | 部门 | 在岗');
for (const r of rows) {
  console.log(`  ${String(r.name).padEnd(6)} ${String(r.org_name || '—').padEnd(10)} ${r.holders}  ${r.holder_names || ''}`);
}
console.log(`\n岗位 ${made} 个；一人多岗：${rows.filter(r => r.holders > 1).length} 个岗位有多人`);
await db.close();
process.exit(0);
