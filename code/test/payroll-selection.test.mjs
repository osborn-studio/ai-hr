import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createApp } from '../app/server.mjs';
import { withTx } from '../app/db.mjs';
import { runPayroll, listRuns } from '../app/services/payroll.mjs';

// Execute the actual browser selector against competing batches. No duplicate
// selection implementation in this test: a period-only regression must fail.
const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const source = html.match(/function selectMonthlyRun\(runs, period, entity\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(source);
const select = runInNewContext(`(${source})`);
const competing = [
  { id: 1, period: '2026-11', legal_entity_id: 11, kind: 'monthly' },
  { id: 2, period: '2026-11', legal_entity_id: 22, kind: 'bonus' },
  { id: 3, period: '2026-11', legal_entity_id: 22, kind: 'monthly' },
];
assert.equal(select(competing, '2026-11', '22')?.id, 3);
assert.equal(select(competing, '2026-12', 22), undefined);
assert.equal(select(competing, '2026-11', 33), undefined);

const { db, server } = await createApp();
try {
  // An empty synthetic legal entity keeps calculation inputs minimal. Its
  // bonus batch is inserted first to reproduce the former backend mistake.
  const result = await withTx(db, async tx => {
    await tx.query(`UPDATE sys_data_scope_rule SET value_ids=array_append(value_ids,9988)
      WHERE dimension='payroll_legal_entity' AND data_scope_id IN
      (SELECT data_scope_id FROM sys_user_role WHERE user_id=1)`);
    const bonus = (await tx.query(`INSERT INTO pay_run(period,legal_entity_id,kind)
      VALUES('2028-01',9988,'bonus') RETURNING id`)).rows[0];
    const monthly = (await tx.query(`INSERT INTO pay_run(period,legal_entity_id,kind)
      VALUES('2028-01',9988,'monthly') RETURNING id`)).rows[0];
    await tx.exec('SAVEPOINT selection_calc');
    await assert.rejects(
      runPayroll(tx, { userId: 1, period: '2028-01', entityId: 9988 }),
      e => e.message.includes(`E_PAYROLL_NO_ELIGIBLE: 批次 ${monthly.id} `)
        && !e.message.includes(`批次 ${bonus.id} `),
      'Empty monthly calculation must name the monthly batch, never the earlier bonus batch',
    );
    await tx.exec('ROLLBACK TO SAVEPOINT selection_calc');
    const runs = await listRuns(tx);
    assert.equal(runs.find(r => Number(r.id) === Number(monthly.id))?.kind, 'monthly');
    assert.equal(runs.find(r => Number(r.id) === Number(bonus.id))?.kind, 'bonus');
    return { run_id: monthly.id };
  });
  console.log(`薪酬批次选择 · 7/7 通过（前端法人/期间/类型，后端月薪与年终奖分离；run=${result.run_id}）`);
} finally {
  server.close();
  await db.close();
}
