// ============================================================================
// tools/sync-dingtalk.mjs · 把钉钉的「组织架构 / 人员 / 考勤原始流水」同步进一个帐套
// ----------------------------------------------------------------------------
//   DATABASE_URL=postgres://postgres@127.0.0.1:5433/aihr_demo \
//   node tools/sync-dingtalk.mjs --ledger YH --name "香香鱼米" --period 2026-11
//
// 组织这一层**按钉钉的部门树原样建**（076：部门可嵌套）：
//   集团根 ← 钉钉根部门；其余每个部门建成 kind='dept' 的组织，父子取自 parentId。
//   于是"人事行政部 / 实施部 / 财务部"都是真实部门，而"XX门店"只是部门名的一种 ——
//   连锁餐饮与集团总部用的是同一套结构，不需要两套。
//
// 四条口径（写在代码里，因为它们决定了同步出什么）：
//   ① 只接三个域：组织、人员、考勤原始流水。不接"考勤结果"（口径不同）。
//   ② 全部单向：钉钉 → 本系统。
//   ③ 对不上不动：同级重名按父范围查重，不跨父合并；已映射的人只刷新快照。
//   ④ 归属是区间的：换部门关旧行开新行，不删历史（014 的区间不重叠约束守着）。
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, withTx } from '../app/db.mjs';
import { hashPassword } from '../app/services/auth.mjs';
import * as ding from '../app/services/dingtalk.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..', 'db');
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };

const ledgerCode = arg('--ledger', 'DM');
const ledgerName = arg('--name', '香香鱼米');
const period = arg('--period', new Date().toISOString().slice(0, 7));
const punchDays = Number(arg('--punch-days', '7'));
const pwd = arg('--pwd', '1234');
const profile = arg('--profile') || undefined;
// ★ 增量模式：只拉打卡（组织与人员不动）。"我刚打了个卡，能不能看见"要能 10 秒内跑完。
const onlyPunch = process.argv.includes('--only-punch');

const url = process.env.DATABASE_URL;
if (!url) { console.error('必须给 DATABASE_URL（目标帐套的库）'); process.exit(2); }

const db = await createDb({ url });
await db.exec('CREATE EXTENSION IF NOT EXISTS btree_gist');
{
  const n = Number((await db.query(
    `SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n);
  if (n === 0) {
    for (const f of readdirSync(DB_DIR).filter((x) => /^\d{3}_.*\.sql$/.test(x)).sort()) {
      await db.exec(readFileSync(join(DB_DIR, f), 'utf8'));
    }
    console.log('· 空库：已跑完全部迁移');
  }
}
await db.initSession();

// ★ "今天"必须取**业务时区**（库里的 app_today），不能用 toISOString()：
//   北京时间 11-15 早上 6 点，UTC 还是 11-14 —— 于是"拉今天的打卡"实际拉的是昨天，
//   而人刚打完卡却一条都看不到。这个错只有真人打卡时才暴露（脚本本身不报错）。
const today = (await db.query('SELECT app_today() d')).rows[0].d
  .toISOString().slice(0, 10);
const say = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// ① 帐套
// ---------------------------------------------------------------------------
const ledgerId = onlyPunch ? 1 : await withTx(db, async (tx) => {
  const ex = (await tx.query(`SELECT id FROM sys_ledger WHERE code=$1`, [ledgerCode])).rows[0];
  if (ex) return Number(ex.id);
  const id = (await tx.query(`SELECT fn_ledger_open($1,$2,$3,'sync') id`,
    [ledgerCode, ledgerName, period])).rows[0].id;
  await tx.query(`SELECT fn_ledger_activate('sync')`);
  return Number(id);
});
if (!onlyPunch) say(`① 帐套 ${ledgerCode} #${ledgerId}（启用期间 ${period}）`);

// ---------------------------------------------------------------------------
// ② 组织：按钉钉部门树原样建
// ---------------------------------------------------------------------------
if (!onlyPunch) {
  const depts = await ding.listDepartments({ profile });
  const orgRun = Number((await db.query(`SELECT fn_ext_sync_begin('dingtalk','org','sync') id`)).rows[0].id);

  const localOf = new Map();
  for (const r of (await db.query(
    `SELECT ext_id, org_id FROM ext_org_map WHERE system_code='dingtalk'`)).rows) {
    localOf.set(String(r.ext_id), Number(r.org_id));
  }

  const rootRow = (await db.query(
    `SELECT id FROM org_unit WHERE parent_id IS NULL ORDER BY id LIMIT 1`)).rows[0];
  const rootId = rootRow ? Number(rootRow.id)
    : Number((await db.query(`SELECT fn_org_add(NULL,$1,'group',NULL) id`, [ledgerName])).rows[0].id);

  let created = 0, reused = 0, orgFail = 0;
  // 按深度升序建：父一定先于子（listDepartments 已排序）
  for (const d of depts) {
    const isRoot = d.parentExt === null || d.parentExt === undefined;
    const name = isRoot ? ledgerName : d.name;
    if (isRoot) {
      localOf.set(String(d.extId), rootId);
      await db.query(`SELECT fn_ext_org_map_put('dingtalk',$1,$2,NULL,$3)`, [d.extId, name, rootId]);
      reused += 1;
      continue;
    }
    try {
      const parentOrg = localOf.get(String(d.parentExt));
      if (!parentOrg) throw new Error(`上级部门 ${d.parentExt} 还没建（顺序错？）`);

      let orgId = localOf.get(String(d.extId));
      if (orgId) { reused += 1; }
      else {
        // 同级重名按**父范围**查重：钉钉允许不同上级有同名部门，
        // "重名就复用"会把两拨人并到一个部门里。
        const exist = (await db.query(
          `SELECT id FROM org_unit WHERE parent_id=$1 AND name=$2 LIMIT 1`,
          [parentOrg, name])).rows[0];
        if (exist) { orgId = Number(exist.id); reused += 1; }
        else {
          orgId = Number((await db.query(`SELECT fn_org_add($1,$2,'dept',NULL) id`,
            [parentOrg, name])).rows[0].id);
          created += 1;
        }
      }
      localOf.set(String(d.extId), orgId);
      await db.query(`SELECT fn_ext_org_map_put('dingtalk',$1,$2,$3,$4)`,
        [d.extId, name, d.parentExt, orgId]);
    } catch (e) {
      orgFail += 1;
      console.log(`   ! 部门「${d.name}」未建：${String(e.message).split('\n')[0].slice(0, 80)}`);
    }
  }
  if (created + reused + orgFail !== depts.length) {
    console.log(`   [核对] 部门 ${depts.length} · 新建 ${created} · 复用 ${reused} · 失败 ${orgFail}`);
  }
  await db.query(`SELECT fn_ext_sync_end($1,$2,$3,$4,$5,NULL,$6)`,
    [orgRun, created + reused + orgFail, created, reused, orgFail,
     `钉钉 ${depts.length} 个部门 → 本地部门树（可嵌套）`]);
  say(`② 组织：${depts.length} 个部门 → 新建 ${created} · 复用 ${reused} · 失败 ${orgFail}`);
}

// ---------------------------------------------------------------------------
// ③ 人员（+账号）：归属到**他自己的部门**
// ---------------------------------------------------------------------------
let pOk = 0, pSkip = 0, pFail = 0;
const failures = [];
if (!onlyPunch) {
  const people = await ding.listAllPeople({ profile });
  const pplRun = Number((await db.query(`SELECT fn_ext_sync_begin('dingtalk','person','sync') id`)).rows[0].id);
  const orgOfDept = new Map((await db.query(
    `SELECT ext_id, org_id FROM ext_org_map WHERE system_code='dingtalk'`))
    .rows.map((r) => [String(r.ext_id), Number(r.org_id)]));
  const rootOrgId = Number((await db.query(
    `SELECT id FROM org_unit WHERE parent_id IS NULL ORDER BY id LIMIT 1`)).rows[0].id);

  for (const p of people) {
    try {
      // ★ 计数必须在**事务外**加：事务回滚时，回调里的 `pOk += 1` 不会跟着撤销，
      //   于是批次表出现"31 人 = 新建 32"，被 ck_esr_sum 拒掉。
      //   这个坑在 run.mjs 里踩过一次（那边是"计数随回滚消失"），这里是它的镜像。
      const outcome = await withTx(db, async (tx) => {
        const orgId = orgOfDept.get(String(p.deptId)) || rootOrgId;
        const mapped = (await tx.query(
          `SELECT person_id, account_id FROM ext_person_map
            WHERE system_code='dingtalk' AND ext_user_id=$1`, [p.extUserId])).rows[0];

        let pid;
        let isNew = false;
        if (mapped) { pid = Number(mapped.person_id); }
        else {
          isNew = true;
          pid = Number((await tx.query(`SELECT fn_person_create($1) id`, [p.name])).rows[0].id);
          await tx.query(`INSERT INTO employment(person_id, legal_entity_id, hire_date)
                          VALUES ($1, 1, $2::date)`, [pid, today]);
          const no = (await tx.query(`SELECT fn_next_employee_no() no`)).rows[0].no;
          await tx.query(`SELECT fn_assign_employee_no($1,$2)`, [pid, no]);
        }

        // 归属：换部门 = 关旧行 + 开新行（区间表，不删历史）
        for (const dim of ['cost_org', 'attendance_org']) {
          const cur = (await tx.query(
            `SELECT org_id FROM employee_org_assignment
              WHERE employee_id=$1 AND dim_code=$2 AND valid_to IS NULL
              ORDER BY valid_from DESC LIMIT 1`, [pid, dim])).rows[0];
          if (cur && Number(cur.org_id) === orgId) continue;
          if (cur) {
            // ★ 如果这条归属是**今天才建的**（同一轮同步里先挂了根，后来又找到部门），
            //   把它关成"昨天结束"会得到 valid_to < valid_from，被 ck_eoa_span 拒。
            //   这种行没有任何历史价值（一天都没生效过），直接删。
            const started = (await tx.query(
              `SELECT valid_from FROM employee_org_assignment
                WHERE employee_id=$1 AND dim_code=$2 AND valid_to IS NULL`, [pid, dim])).rows[0];
            const startedToday = started
              && started.valid_from instanceof Date
              && started.valid_from.toISOString().slice(0, 10) >= today;
            if (startedToday) {
              await tx.query(
                `DELETE FROM employee_org_assignment
                  WHERE employee_id=$1 AND dim_code=$2 AND valid_to IS NULL`, [pid, dim]);
            } else {
              await tx.query(
                `UPDATE employee_org_assignment SET valid_to = $3::date - 1
                  WHERE employee_id=$1 AND dim_code=$2 AND valid_to IS NULL`, [pid, dim, today]);
            }
          }
          await tx.query(
            `INSERT INTO employee_org_assignment(employee_id, dim_code, org_id, valid_from)
             VALUES ($1,$2,$3,$4::date)`, [pid, dim, orgId, today]);
        }

        const login = `dm${String(p.extUserId).slice(-6)}`;
        let accountId = mapped?.account_id ? Number(mapped.account_id) : null;
        if (!accountId) {
          const acc = (await tx.query(`SELECT id FROM sys_account WHERE login=$1`, [login])).rows[0];
          if (acc) accountId = Number(acc.id);
          else {
            accountId = Number((await tx.query(
              `SELECT fn_account_create($1,$2,'store_staff',$3,$4,'sync') id`,
              [login, p.name, orgId, pid])).rows[0].id);
            await tx.query(`INSERT INTO sys_user_credential(user_id, pwd_hash)
                            VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING`,
              [accountId, hashPassword(pwd)]);
          }
        }
        await tx.query(`SELECT fn_ext_person_map_put('dingtalk',$1,$2,$3,$4,$5)`,
          [p.extUserId, pid, p.name, p.deptName, accountId]);
        return isNew ? 'new' : 'exist';
      });
      if (outcome === 'new') pOk += 1; else pSkip += 1;
    } catch (e) {
      pFail += 1;
      failures.push(`${p.name}: ${String(e.message).split('\n')[0].slice(0, 90)}`);
    }
  }
  await db.query(`SELECT fn_ext_sync_end($1,$2,$3,$4,$5,NULL,$6)`,
    [pplRun, people.length, pOk, pSkip, pFail,
     failures.length ? failures.slice(0, 5).join(' | ') : null]);
  say(`③ 人员 ${people.length} 人：新建 ${pOk} · 已存在 ${pSkip} · 失败 ${pFail}`);
  if (failures.length) say('   失败样例：', failures.slice(0, 3));
}

// ---------------------------------------------------------------------------
// ④ 考勤原始流水
// ---------------------------------------------------------------------------
const from = new Date(Date.now() - punchDays * 86400e3).toISOString().slice(0, 10);
const runPunch = Number((await db.query(`SELECT fn_ext_sync_begin('dingtalk','punch','sync') id`)).rows[0].id);
const userIds = (await db.query(`SELECT ext_user_id FROM ext_person_map WHERE system_code='dingtalk'`))
  .rows.map((r) => r.ext_user_id);
const personOf = new Map((await db.query(
  `SELECT m.ext_user_id, m.person_id, a.org_id
     FROM ext_person_map m
     LEFT JOIN LATERAL (SELECT org_id FROM employee_org_assignment
                         WHERE employee_id = m.person_id AND dim_code = 'attendance_org'
                           AND valid_to IS NULL ORDER BY valid_from DESC LIMIT 1) a ON true
    WHERE m.system_code='dingtalk'`)).rows.map((r) => [r.ext_user_id, r]));

let rows = 0, newRows = 0, callFails = 0;
const batches = await ding.listPunches(userIds, from, today, { profile });
for (const b of batches) {
  if (b.error) { callFails += 1; continue; }
  const who = personOf.get(b.userId);
  if (!who) { rows += b.records.length; continue; }
  for (const rec of b.records) {
    const row = ding.toPunchRow(rec);
    rows += 1;
    if (!row) continue;
    const before = Number((await db.query(`SELECT count(*)::int n FROM punch`)).rows[0].n);
    await db.query(`SELECT fn_punch_ingest($1,$2::timestamptz,$3,'dingtalk',$4,$5,$6)`,
      [Number(who.person_id), row.at, row.kind, row.extId, who.org_id ?? null, row.device]);
    const after = Number((await db.query(`SELECT count(*)::int n FROM punch`)).rows[0].n);
    if (after > before) newRows += 1;
  }
}
await db.query(`SELECT fn_ext_sync_end($1,$2,$3,$4,$5,$6,$7)`,
  [runPunch, rows, newRows, rows - newRows, callFails, today,
   `${from} → ${today}；${userIds.length} 人；接口失败 ${callFails} 人`]);
say(`④ 打卡原始流水 ${from} → ${today}：读到 ${rows} 条，新进 ${newRows}，重复 ${rows - newRows}`
  + (callFails ? `，${callFails} 人接口失败` : ''));

// ---------------------------------------------------------------------------
// ⑤ 汇总
// ---------------------------------------------------------------------------
say('\n⑤ 同步健康度');
for (const h of (await db.query(`SELECT * FROM v_ext_sync_health WHERE system_code='dingtalk'`)).rows) {
  say(`   ${String(h.domain).padEnd(7)} 总量 ${String(h.total_rows).padStart(4)} · `
    + `成功 ${String(h.ok_rows).padStart(4)} · 跳过 ${String(h.skip_rows).padStart(3)} · `
    + `失败 ${String(h.fail_rows).padStart(2)} · ${h.minutes_ago} 分钟前`);
}
const counts = (await db.query(
  `SELECT (SELECT count(*)::int FROM person) p, (SELECT count(*)::int FROM sys_account) a,
          (SELECT count(*)::int FROM org_unit WHERE kind='dept') o,
          (SELECT count(*)::int FROM punch) pu`)).rows[0];
say(`\n库内现状：部门 ${counts.o} · 人员 ${counts.p} · 账号 ${counts.a} · 打卡 ${counts.pu}`);
say(`登录：账号 dmXXXXXX（或 admin），初始口令 ${pwd}`);

await db.close();
process.exit(pFail ? 1 : 0);
