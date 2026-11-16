// Synthetic fixtures only. Real customer payroll never belongs in this repository.
import assert from 'node:assert/strict';
import {
  readFileSync
} from 'node:fs';
import {
  PGlite
} from '@electric-sql/pglite';
import {
  btree_gist
} from '@electric-sql/pglite/contrib/btree_gist';
import * as svc from '../app/services/customer-payroll.mjs';
import {
  parseFormula,
  evaluateFormula,
  money,
  totals
} from '../app/services/customer-payroll-engine.mjs';
import {
  parseFiveTable,
  parseCsv
} from '../app/services/customer-payroll-import.mjs';
import {
  makeZip
} from '../app/zip.mjs';
import * as perf from '../app/services/customer-performance.mjs';

let checks = 0;
const ok = (value, message) => {
  assert.ok(value, message);
  checks++;
};
const eq = (a, b, message) => {
  assert.deepEqual(a, b, message);
  checks++;
};
const reject = async (fn, match) => {
  await assert.rejects(fn, match);
  checks++;
};
let db;
if (process.env.DATABASE_URL) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, v => Number(v));
  pg.types.setTypeParser(1082, v => new Date(`${v}T00:00:00Z`));
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL
  });
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  db = {
    query: (sql, args) => client.query(sql, args),
    exec: sql => client.query(sql),
    close: () => client.end()
  };
  console.log('customer-payroll driver: PostgreSQL');
} else {
  db = await PGlite.create({
    extensions: {
      btree_gist
    }
  });
  console.log('customer-payroll driver: PGlite');
}
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => (await q(sql, args))[0];
const ins = async (table, data) => Number((await one(
  `INSERT INTO ${table}(${Object.keys(data).join(',')}) VALUES(${Object.keys(data).map((_,i)=>'$'+(i+1)).join(',')}) RETURNING id`,
  Object.values(data))).id);
const loadMigration = async name => db.exec(readFileSync(new URL('../db/' + name, import.meta.url), 'utf8'));
try {
  await loadMigration('193_tyhr_foundation.sql');
  await loadMigration('194_tyhr_foundation_governance.sql');
  await loadMigration('196_tyhr_customer_payroll.sql');
  await loadMigration('197_tyhr_customer_performance.sql');
  await loadMigration('199_tyhr_payroll_input_review.sql');
  await loadMigration('200_tyhr_payroll_formula_guard.sql');
  await db.exec('CREATE TABLE sys_check_registry(check_code text PRIMARY KEY,name text,domain text,kind text,guard_object text,guard_schema text,guard_table text,guard_kind text,runner text,assertion_sql text)');
  await loadMigration('201_tyhr_region_currency.sql');
  await loadMigration('202_tyhr_region_payroll_guard.sql');
  await db.exec(
    `CREATE TABLE test_caps(account_id bigint,resource text,action text); CREATE FUNCTION fn_role_can(uid bigint,res text,act text) RETURNS boolean LANGUAGE sql AS $$ SELECT uid=1000 OR EXISTS(SELECT 1 FROM test_caps WHERE account_id=uid AND resource=res AND action=act) $$;`
    );
  const g = await ins('ty_group', {
      code: 'TEST',
      name: '合成测试集团'
    }),
    g2 = await ins('ty_group', {
      code: 'OTHER',
      name: '合成另一集团'
    });
  const l = await ins('ty_ledger', {
      group_id: g,
      code: 'TEST',
      name: '合成帐套',
      scope_mode: 'group'
    }),
    l2 = await ins('ty_ledger', {
      group_id: g2,
      code: 'OTHER',
      name: '合成另一帐套',
      scope_mode: 'group'
    });
  const secondLedger=await ins('ty_ledger',{group_id:g,code:'SECOND',name:'合成第二帐套',scope_mode:'group'});
  const c1 = await ins('ty_company', {
      group_id: g,
      ledger_id: l,
      code: 'A',
      name: '测试甲门店'
    }),
    c2 = await ins('ty_company', {
      group_id: g,
      ledger_id: secondLedger,
      code: 'B',
      name: '测试乙门店'
    }),
    c3 = await ins('ty_company', {
      group_id: g2,
      ledger_id: l2,
      code: 'OTHER',
      name: '测试另一门店'
    });
  const p1 = Number((await one('SELECT fn_ty_create_person($1,$2,$3) id', [g, 'TEST001',
      '测试甲<svg/onload=alert(1)>'
    ])).id),
    p2 = Number((await one('SELECT fn_ty_create_person($1,$2,$3) id', [g, 'TEST002', '测试乙'])).id);
  const e1 = await ins('ty_employment', {
      group_id: g,
      person_id: p1,
      company_id: c1,
      hire_date: '2026-01-01'
    }),
    e2 = await ins('ty_employment', {
      group_id: g,
      person_id: p2,
      company_id: c2,
      hire_date: '2026-01-01'
    });
  await q(
    "INSERT INTO test_caps VALUES (2000,'payroll_run','read'),(2000,'payroll_run','write'),(2000,'payroll_slips_read_all','read'),(3000,'payroll_run','read')"
    );
  for (const account of [2000, 3000, 4000]) await ins('ty_access_grant', {
    account_id: account,
    group_id: g,
    company_id: c1,
    can_read: true,
    can_write: true,
    valid_from: '2026-01-01'
  });
  eq(money(evaluateFormula(parseFormula('ROUND(0.1+0.2,2)'), {})), '0.30', 'exact decimal arithmetic');
  eq(money(evaluateFormula(parseFormula('ROUND(-1.005,2)'), {})), '-1.01', 'negative half away from zero');
  eq(money(evaluateFormula(parseFormula('IF(employment_type="PT",rate*hours,missing)'), {
    employment_type: 'PT',
    rate: '75',
    hours: '7.25'
  })), '543.75', 'conditional short circuit');
  eq(money(evaluateFormula(parseFormula('ROUND(10000/31*17,2)'), {})), '5483.87', 'no premature rounding');
  await reject(async () => parseFormula('process.exit(1)'), /不支持/);
  await reject(async () => parseFormula('x.constructor'), /不支持/);
  await reject(async () => evaluateFormula(parseFormula('missing+1'), {}), /缺少输入/);
  await reject(async () => evaluateFormula(parseFormula('1/0'), {}), /除数/);
  eq(totals([{
    kind: 'earning',
    amount: '1000'
  }, {
    kind: 'earning',
    amount: '-20'
  }, {
    kind: 'deduction',
    amount: '30'
  }, {
    kind: 'employee_contribution',
    amount: '47.50'
  }, {
    kind: 'employer_contribution',
    amount: '50'
  }]).net_pay, '902.50', 'negative earning and contribution separated');
  const spec = (key, p, c, e, amount) => ({
    source_key: key,
    source_person_name: '合成人员',
    source_company_name: '测试门店',
    person_id: p,
    company_id: c,
    employment_id: e,
    inputs: {
      employment_type: 'FT',
      salary_rate: amount,
      period_days: '30',
      employed_days: '30'
    },
    items: [{
      code: 'base_pay',
      name: '基本工资',
      kind: 'earning',
      amount
    }],
    source_totals: {
      net_pay: amount
    }
  });
  const created = await svc.createBatch(db, {
      userId: 1000,
      input: {
        group_id: g,
        period: '2026-10',
        currency:'HKD',region_code:'HK',
        rows: [spec('A', p1, c1, e1, '1000'), spec('B', p2, c2, e2, '2000')]
      }
    }),
    bid = created.batch.id;
  eq((await svc.report(db, {
    userId: 1000,
    batchId: bid
  })).summary.net_pay, '3000.00', 'group total');
  const ledgerReport=await svc.report(db,{userId:1000,batchId:bid,ledgerId:l});
  eq(ledgerReport.summary.net_pay,'1000.00','selected ledger has its own total');
  ok(!ledgerReport.scope_complete&&ledgerReport.rows.length===1,'selected ledger cannot expose other authorized ledger');
  await reject(()=>svc.confirmBatch(db,{userId:1000,batchId:bid,ledgerId:l}),/缺少薪酬权限/);
  const restricted = await svc.report(db, {
    userId: 2000,
    batchId: bid
  });
  eq(restricted.rows.length, 1, 'company-scoped rows');
  eq(restricted.summary.net_pay, '1000.00', 'company total never includes hidden amount');
  ok(!restricted.scope_complete, 'report marked partial');
  await reject(() => svc.report(db, {
    userId: 3000,
    batchId: bid
  }), /缺少薪酬权限/);
  await reject(() => svc.report(db, {
    userId: 4000,
    batchId: bid
  }), /缺少薪酬权限/);
  await reject(() => svc.confirmBatch(db, {
    userId: 2000,
    batchId: bid
  }), /缺少薪酬权限/);
  const rid = restricted.rows[0].id;
  await reject(() => svc.mapRow(db, {
    userId: 2000,
    rowId: rid,
    input: {
      company_id: c2,
      person_id: p2,
      employment_id: e2,
      match_reason: '伪造'
    }
  }), /缺少薪酬权限/);
  await reject(() => svc.mapRow(db, {
    userId: 1000,
    rowId: rid,
    input: {
      company_id: c3,
      person_id: p1,
      employment_id: e1,
      match_reason: '跨集团'
    }
  }), /缺少薪酬权限/);
  const v = await svc.validateBatch(db, {
    userId: 1000,
    batchId: bid
  });
  ok(v.ok, 'snapshot reconciliation');
  await reject(() => svc.createBatch(db, {
    userId: 1000,
    input: {
      group_id: g,
      period: '2026-10',
      currency:'HKD',region_code:'HK',
      rows: [spec('A', p1, c1, e1, '1000'), spec('B', p2, c2, e2, '2000')]
    }
  }), /已有该来源/);
  const html = await svc.printHtml(db, {
    userId: 1000,
    batchId: bid
  });
  ok(html.includes('&lt;svg/onload=alert(1)&gt;') && !html.includes('<svg/onload='), 'print escapes person');
  const out = await svc.exportCsv(db, {
    userId: 2000,
    batchId: bid
  });
  ok(out.includes('1000') && !out.includes('2000'), 'CSV respects intersection');
  await svc.confirmBatch(db, {
    userId: 1000,
    batchId: bid
  });
  eq((await one('SELECT status FROM ty_payroll_batch WHERE id=$1', [bid])).status, 'confirmed',
    'confirmed state');
  await reject(() => q("UPDATE ty_payroll_row SET result_data='{}' WHERE id=$1", [rid]), /已确认/);
  await reject(() => q(
      "UPDATE ty_payroll_batch SET status='draft',confirmed_by=NULL,confirmed_at=NULL WHERE id=$1", [bid]),
    /已确认/);
  await reject(() => q('DELETE FROM ty_payroll_audit WHERE batch_id=$1', [bid]), /只可追加/);
  const duplicateMonth = (await svc.createBatch(db, {
    userId: 1000,
    input: {
      group_id: g,
      period: '2026-10',
      currency:'HKD',region_code:'HK',
      rows: [spec('DIFFERENT_FILE', p1, c1, e1, '1000')]
    }
  })).batch;
  const dm = await svc.validateBatch(db, {
    userId: 1000,
    batchId: duplicateMonth.id
  });
  ok(!dm.ok && dm.checks[0].issues.some(i => i.code === 'ALREADY_CONFIRMED'),
    'store copy cannot confirm already confirmed person');
  await reject(() => svc.confirmBatch(db, {
    userId: 1000,
    batchId: duplicateMonth.id
  }), /仍有/);
  await q("UPDATE ty_payroll_row SET validation='{\"ok\":true}' WHERE batch_id=$1", [duplicateMonth.id]);
  await reject(() => q(
    "UPDATE ty_payroll_batch SET status='confirmed',confirmed_by=1000,confirmed_at=now() WHERE id=$1", [
      duplicateMonth.id
    ]), /已有已确认工资/);
  const badBatch = await svc.createBatch(db, {
    userId: 1000,
    input: {
      group_id: g,
      period: '2026-10',
      currency:'HKD',region_code:'HK',
      rows: [{
        ...spec('BAD', p1, c1, e1, '1000'),
        source_totals: {
          net_pay: '999.99'
        }
      }]
    }
  });
  ok(!(await svc.validateBatch(db, {
    userId: 1000,
    batchId: badBatch.batch.id
  })).ok, 'cent difference blocks');
  await reject(() => svc.confirmBatch(db, {
    userId: 1000,
    batchId: badBatch.batch.id
  }), /仍有/);
  const rules = [{
    code: 'base_pay',
    name: '基本工资',
    kind: 'earning',
    expression: 'ROUND(IF(employment_type="FT",salary_rate/period_days*employed_days,salary_rate*worked_hours),2)'
  }];
  const draft = await svc.saveRuleSet(db, {
    userId: 1000,
    input: {
      group_id: g,
      name: '测试草稿',
      currency:'HKD',region_code:'HK',
      region: 'HK',
      rules
    }
  });
  const newB = await svc.createBatch(db, {
      userId: 1000,
      input: {
        group_id: g,
        period: '2026-11',
        currency:'HKD',region_code:'HK',
        kind: 'calculated',
        rows: [{
          ...spec('NEW', p1, c1, e1, '1000'),
          items: [],
          source_totals: {},
          data_kind: 'inputs'
        }]
      }
    }),
    nbid = newB.batch.id;
  const calc = await svc.calculateBatch(db, {
    userId: 1000,
    batchId: nbid,
    input: {
      ruleset_id: draft.ruleset.id
    }
  });
  ok(calc.ok, 'draft can trial');
  await reject(() => svc.confirmBatch(db, {
    userId: 1000,
    batchId: nbid
  }), /尚未批准/);
  const approved = await svc.saveRuleSet(db, {
    userId: 1000,
    input: {
      group_id: g,
      name: '测试已批准',
      currency:'HKD',region_code:'HK',
      region: 'HK',
      status: 'approved',
      approval_ack: true,
      policy_notes: '仅合成回归：FT按日历天数，在职天数已确认',
      rules
    }
  });
  await svc.calculateBatch(db, {
    userId: 1000,
    batchId: nbid,
    input: {
      ruleset_id: approved.ruleset.id
    }
  });
  ok((await svc.validateBatch(db, {
    userId: 1000,
    batchId: nbid
  })).ok, 'new month has independent calculation');
  await svc.confirmBatch(db, {
    userId: 1000,
    batchId: nbid
  });
  eq((await svc.report(db, {
    userId: 1000,
    batchId: nbid
  })).summary.net_pay, '1000.00', 'confirmed new month amount');
  await reject(() => q("UPDATE ty_payroll_ruleset SET name='tamper' WHERE id=$1", [approved.ruleset.id]),
    /不能修改/);
  await reject(() => svc.saveRuleSet(db, {
    userId: 2000,
    input: {
      group_id: g,
      name: '非法',
      currency:'HKD',region_code:'HK',
      region: 'HK',
      rules
    }
  }), /缺少薪酬权限/);
  const missingB = await svc.createBatch(db, {
    userId: 1000,
    input: {
      group_id: g,
      period: '2026-11',
      currency:'HKD',region_code:'HK',
      kind: 'calculated',
      rows: [{
        ...spec('MISSING', p1, c1, e1, '1000'),
        inputs: {
          employment_type: 'PT',
          salary_rate: '50'
        },
        items: [],
        source_totals: {}
      }]
    }
  });
  ok(!(await svc.calculateBatch(db, {
    userId: 1000,
    batchId: missingB.batch.id,
    input: {
      ruleset_id: approved.ruleset.id
    }
  })).ok, 'missing attendance input blocks trial');
  await reject(() => svc.confirmBatch(db, {
    userId: 1000,
    batchId: missingB.batch.id
  }), /仍有/);
  const sourceBefore = (await one('SELECT source_data FROM ty_payroll_row WHERE batch_id=$1', [badBatch.batch
    .id
  ])).source_data;
  await svc.calculateBatch(db, {
    userId: 1000,
    batchId: badBatch.batch.id,
    input: {
      ruleset_id: approved.ruleset.id
    }
  });
  eq((await one('SELECT source_data FROM ty_payroll_row WHERE batch_id=$1', [badBatch.batch.id])).source_data,
    sourceBefore, 'trial leaves imported evidence unchanged');
  await reject(() => q("UPDATE ty_payroll_row SET source_data='{}' WHERE batch_id=$1", [badBatch.batch.id]),
    /来源数据不可改写/);
  const duplicate = await svc.createBatch(db, {
    userId: 1000,
    input: {
      group_id: g,
      period: '2026-10',
      currency:'HKD',region_code:'HK',
      rows: [spec('D1', p1, c1, e1, '10'), spec('D2', p1, c1, e1, '10')]
    }
  });
  ok(!(await svc.validateBatch(db, {
    userId: 1000,
    batchId: duplicate.batch.id
  })).ok, 'duplicate same-company person blocked');
  const csvRows = parseCsv(
    'source_key,source_person_name,company_id,person_id,employment_id,input.employment_type,input.salary_rate,input.worked_hours\r\nC1,"合成,姓名",1,2,3,PT,50,10\r\n'
    );
  eq(csvRows[0].source_person_name, '合成,姓名', 'quoted CSV');
  eq(csvRows[0].inputs.worked_hours, '10', 'input CSV');
  const preview = await svc.importPreview(db, {
    userId: 1000,
    input: {
      group_id: g,
      period: '2026-11',
      currency:'HKD',region_code:'HK',
      format: 'rows',
      rows: [{
        ...spec('PREVIEW', p1, c1, e1, '5'),
        items: []
      }]
    }
  });
  eq(preview.rows[0].employment_id, e1, 'preview retains explicit matching');
  const cells =
    '<row r="2"><c r="B2" t="inlineStr"><is><t>中文姓名</t></is></c><c r="BJ2" t="inlineStr"><is><t>雇主MPF</t></is></c></row><row r="3"><c r="B3" t="inlineStr"><is><t>合成姓名</t></is></c><c r="H3" t="inlineStr"><is><t>合成门店</t></is></c><c r="AI3"><f>1+2</f><v>3</v></c><c r="BJ3"><v>0</v></c><c r="BK3"><v>0</v></c><c r="BM3"><v>3</v></c></row>';
  const fixture = makeZip([{
    name: 'xl/workbook.xml',
    data: '<workbook><sheets><sheet name="10月薪酬" r:id="r1"/></sheets></workbook>'
  }, {
    name: 'xl/_rels/workbook.xml.rels',
    data: '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'
  }, {
    name: 'xl/worksheets/sheet1.xml',
    data: '<worksheet><sheetData>' + cells + '</sheetData></worksheet>'
  }]);
  const parsed = parseFiveTable(fixture, {
    period: '2026-10'
  });
  eq(parsed.rows[0].items[0].amount, '3.00', 'cached Excel amount imported');
  ok(!JSON.stringify(parsed).includes('1+2'), 'raw formulas not persisted');
  await reject(async () => parseFiveTable(Buffer.from('not zip')), /工作簿/);
  ok(svc.inputTemplate().csv.startsWith('\uFEFFsource_key'), 'downloadable input template');
  ok(svc.ruleCatalog().draft.rules.every(r => parseFormula(r.expression)),
    'all source draft formulas compile');
  // Real performance service -> authorized confirmed candidate -> payroll input.
  const grade = await ins('ty_grade', {
    group_id: g,
    code: 'PAYTEST',
    name: '合成绩效职级',
    level: 1
  });
  const cycle = (await perf.createCycle(db, {
    userId: 1000,
    input: {
      group_id: g,
      code: 'PAYTEST',
      name: '合成绩效',
      start_date: '2026-10',
      end_date: '2026-11',
      payout_period: '2026-12',
      currency_code:'HKD',region_code:'HK',
      company_ids: [c1]
    }
  })).cycle;
  await perf.saveScheme(db, {
    userId: 1000,
    cycleId: cycle.id,
    input: {
      rules: {
        confirmed: true,
        aggregation: 'floor_average_months',
        payout_assignment: 'last_month_employment',
        score_base: 1,
        score_floor: 0,
        metrics: [{
          code: 'quality',
          unit: 'ratio',
          method: 'direct_deduction'
        }],
        rating_bands: [{
          min_score: 0,
          grade: 'A',
          factor: 1
        }],
        grade_bases: {
          [grade]: 900
        }
      }
    }
  });
  await perf.saveInputs(db, {
    userId: 1000,
    cycleId: cycle.id,
    input: {
      company_metrics: [{
        company_id: c1,
        period: '2026-10',
        metrics: {
          quality: {
            value: 0,
            unit: 'ratio',
            status: 'verified'
          }
        },
        source_saved_score: 1
      }],
      person_months: [{
        person_id: p1,
        company_id: c1,
        employment_id: e1,
        period: '2026-10',
        grade_id: grade,
        eligibility_status: 'verified',
        source_saved_amount: 900
      }]
    }
  });
  const calcPerf = await perf.calculate(db, {
    userId: 1000,
    cycleId: cycle.id
  });
  await perf.confirm(db, {
    userId: 1000,
    cycleId: cycle.id,
    input: {
      result_version: calcPerf.cycle.result_version,
      reason: '仅合成测试确认'
    }
  });
  const perfBatch = (await svc.createBatch(db, {
    userId: 1000,
    input: {
      group_id: g,
      period: '2026-12',
      currency:'HKD',region_code:'HK',
      kind: 'calculated',
      rows: [{
        ...spec('PERF', p1, c1, e1, '1000'),
        items: [],
        source_totals: {}
      }]
    }
  })).batch;
  const applied = await svc.applyPerformanceCandidates(db, {
    userId: 1000,
    batchId: perfBatch.id,
    input: {
      cycle_id: cycle.id
    }
  });
  eq(applied.applied.length, 1, 'confirmed performance posted once');
  eq(applied.applied[0].amount, '900.00', 'performance source amount');
  const repeated = await svc.applyPerformanceCandidates(db, {
    userId: 1000,
    batchId: perfBatch.id,
    input: {
      cycle_id: cycle.id
    }
  });
  eq(repeated.applied.length, 0, 'repeat posting adds no amount');
  eq(repeated.already_applied.length, 1, 'repeat posting records idempotency');
  await reject(() => svc.applyPerformanceCandidates(db, {
    userId: 2000,
    batchId: perfBatch.id,
    input: {
      cycle_id: cycle.id
    }
  }), /绩效/);
  await reject(() => svc.createBatch(db, {
    userId: 1000,
    input: {
      group_id: g,
      period: '2026-11',
      currency:'HKD',region_code:'HK',
      rows: [{
        ...spec('FORGED', p1, c1, e1, '1000'),
        provenance: {
          type: 'performance',
          cycle_id: cycle.id,
          source_key: 'forged'
        }
      }]
    }
  }), /客户端provenance/);
  await reject(() => svc.createBatch(db, {
    userId: 1000,
    input: {
      group_id: g,
      period: '2026-11',
      currency:'HKD',region_code:'HK',
      rows: [{
        ...spec('FORGED2', p1, c1, e1, '1000'),
        inputs: {
          performance_bonus: '900'
        }
      }]
    }
  }), /不可手填/);
  const perfRules = (await svc.saveRuleSet(db, {
    userId: 1000,
    input: {
      group_id: g,
      name: '合成绩效入薪',
      currency:'HKD',region_code:'HK',
      region: 'HK',
      status: 'approved',
      approval_ack: true,
      policy_notes: '合成夹具：基本工资加已确认绩效',
      rules: [...rules, {
        code: 'performance',
        name: '绩效奖金',
        kind: 'earning',
        expression: 'performance_bonus'
      }]
    }
  })).ruleset;
  for(const [name,ruleRows] of [
    ['double',[{code:'base',name:'错误基本工资',kind:'earning',expression:'salary_rate+performance_bonus'},{code:'bonus',name:'奖金重复',kind:'earning',expression:'performance_bonus'}]],
    ['reference',[...rules,{code:'reference_bonus',name:'仅参考',kind:'reference',expression:'performance_bonus'}]],
    ['indirect',[...rules,{code:'bonus_ref',name:'参考桥',kind:'reference',expression:'performance_bonus'},{code:'first',name:'奖金',kind:'earning',expression:'bonus_ref'},{code:'second',name:'重复桥',kind:'earning',expression:'first'}]],
    ['wrong_amount',[...rules,{code:'bonus',name:'奖金错误倍数',kind:'earning',expression:'performance_bonus*2'}]],
  ]){
    const trial=(await svc.saveRuleSet(db,{userId:1000,input:{group_id:g,name,currency:'HKD',region_code:'HK',region:'HK',rules:ruleRows}})).ruleset;
    const response=await svc.calculateBatch(db,{userId:1000,batchId:perfBatch.id,input:{ruleset_id:trial.id}});
    ok(!response.ok,`performance protection: ${name}`);
  }
  await svc.calculateBatch(db, {
    userId: 1000,
    batchId: perfBatch.id,
    input: {
      ruleset_id: perfRules.id
    }
  });
  eq((await svc.report(db, {
    userId: 1000,
    batchId: perfBatch.id
  })).summary.net_pay, '1900.00', 'system salary plus confirmed bonus');
  await svc.confirmBatch(db, {
    userId: 1000,
    batchId: perfBatch.id
  });
  await reject(() => svc.applyPerformanceCandidates(db, {
    userId: 1000,
    batchId: perfBatch.id,
    input: {
      cycle_id: cycle.id
    }
  }), /已确认/);
  await reject(() => q('DELETE FROM ty_payroll_performance_input WHERE batch_id=$1', [perfBatch.id]), /不可改写/);
  // A cached allowance/input is a proposal until an authorized operator reviews
  // it. Updating it preserves source evidence and invalidates the prior trial.
  const fixed=(await svc.saveRuleSet(db,{userId:1000,input:{group_id:g,name:'虚构固定月薪',currency:'HKD',region_code:'HK',region:'CUSTOM',status:'approved',approval_ack:true,policy_notes:'测试帐套自行启用的完全虚构方案',rules:[{code:'base_pay',name:'月薪',kind:'earning',expression:'base_salary'}]}})).ruleset;
  const reviewBatch=(await svc.createBatch(db,{userId:1000,input:{group_id:g,period:'2027-01',currency:'HKD',region_code:'HK',kind:'calculated',rows:[{...spec('REVIEW',p1,c1,e1,'1000'),items:[],source_totals:{},inputs:{base_salary:'1000',unused_input:'123'},input_review:{base_salary:{status:'unverified',origin:'source_input'},unused_input:{status:'unverified',origin:'source_input'}}}]}})).batch;
  const reviewId=(await svc.report(db,{userId:1000,batchId:reviewBatch.id})).rows[0].id;
  ok(!(await svc.calculateBatch(db,{userId:1000,batchId:reviewBatch.id,input:{ruleset_id:fixed.id}})).ok,'unreviewed used input blocks');
  const rawBefore=(await one('SELECT source_data FROM ty_payroll_row WHERE id=$1',[reviewId])).source_data;
  await svc.editRowInputs(db,{userId:1000,rowId:reviewId,input:{inputs:{},reviewed_keys:['base_salary'],reason:'虚构来源金额已核验'}});
  ok((await svc.calculateBatch(db,{userId:1000,batchId:reviewBatch.id,input:{ruleset_id:fixed.id}})).ok,'unused unreviewed field does not block');
  const edited=await svc.editRowInputs(db,{userId:1000,rowId:reviewId,input:{inputs:{base_salary:'1200'},reason:'虚构新月工资调为1200'}});
  eq(edited.effective_inputs.base_salary,'1200','row override immediately visible');
  eq((await one('SELECT result_data FROM ty_payroll_row WHERE id=$1',[reviewId])).result_data,null,'input edit invalidates old calculation');
  eq((await one('SELECT source_data FROM ty_payroll_row WHERE id=$1',[reviewId])).source_data,rawBefore,'editing inputs preserves source');
  await reject(()=>svc.editRowInputs(db,{userId:1000,rowId:reviewId,input:{inputs:{performance_bonus:'900'},reason:'伪造绩效'}}),/不可编辑/);
  await svc.calculateBatch(db,{userId:1000,batchId:reviewBatch.id,input:{ruleset_id:fixed.id}});
  await svc.confirmBatch(db,{userId:1000,batchId:reviewBatch.id});
  eq((await svc.report(db,{userId:1000,batchId:reviewBatch.id})).summary.net_pay,'1200.00','reviewed new amount confirmed');
  await reject(()=>svc.editRowInputs(db,{userId:1000,rowId:reviewId,input:{inputs:{base_salary:'1300'},reason:'冻结后误改'}}),/已确认/);
  const mismatch=(await svc.createBatch(db,{userId:1000,input:{group_id:g,period:'2027-02',currency:'HKD',region_code:'HK',rows:[{...spec('DB-BYPASS',p1,c1,e1,'1000'),source_totals:{net_pay:'999.99'}}]}})).batch;
  await q("UPDATE ty_payroll_row SET validation='{\"ok\":true}' WHERE batch_id=$1",[mismatch.id]);
  await reject(()=>q("UPDATE ty_payroll_batch SET status='confirmed',confirmed_by=1000,confirmed_at=now() WHERE id=$1",[mismatch.id]),/来源保存总额不一致/);
  eq(Number((await one('SELECT count(*) n FROM ty_payroll_posted_person WHERE batch_id=$1',[mismatch.id])).n),0,'failed financial guard rolls back posting key');
  const staleBatch=(await svc.createBatch(db,{userId:1000,input:{group_id:g,period:'2027-03',currency:'HKD',region_code:'HK',kind:'calculated',rows:[{...spec('STALE',p1,c1,e1,'1000'),items:[],source_totals:{},inputs:{base_salary:'1000'}}]}})).batch;
  await svc.calculateBatch(db,{userId:1000,batchId:staleBatch.id,input:{ruleset_id:fixed.id}});
  const oldResult=(await one('SELECT result_data FROM ty_payroll_row WHERE batch_id=$1',[staleBatch.id])).result_data;
  await q("UPDATE ty_payroll_row SET input_overrides='{\"base_salary\":\"2000\"}',input_review='{\"base_salary\":{\"status\":\"verified\",\"reason\":\"虚构输入复核\"}}' WHERE batch_id=$1",[staleBatch.id]);
  eq((await one('SELECT result_data FROM ty_payroll_row WHERE batch_id=$1',[staleBatch.id])).result_data,null,'direct SQL input edit clears result');
  await q("UPDATE ty_payroll_row SET result_data=$2::jsonb,validation='{\"ok\":true}' WHERE batch_id=$1",[staleBatch.id,JSON.stringify(oldResult)]);
  await reject(()=>q("UPDATE ty_payroll_batch SET status='confirmed',confirmed_by=1000,confirmed_at=now() WHERE id=$1",[staleBatch.id]),/输入快照已经过期|已批准公式的数据库重算/);
  await svc.calculateBatch(db,{userId:1000,batchId:staleBatch.id,input:{ruleset_id:fixed.id}});
  await q("UPDATE ty_payroll_row SET result_data=jsonb_set(result_data,'{totals,net_pay}','\"9999.00\"'),validation='{\"ok\":true}' WHERE batch_id=$1",[staleBatch.id]);
  await reject(()=>q("UPDATE ty_payroll_batch SET status='confirmed',confirmed_by=1000,confirmed_at=now() WHERE id=$1",[staleBatch.id]),/结果总额与项目合计不一致/);
  const otherRow=(await svc.createBatch(db,{userId:1000,input:{group_id:g,period:'2027-04',currency:'HKD',region_code:'HK',kind:'calculated',rows:[{...spec('OTHER-INPUT',p2,c2,e2,'1000'),items:[],source_totals:{},inputs:{base_salary:'1000'}}]}})).batch;
  const otherRowId=(await svc.report(db,{userId:1000,batchId:otherRow.id})).rows[0].id;
  await reject(()=>svc.editRowInputs(db,{userId:2000,rowId:otherRowId,input:{inputs:{base_salary:'999'},reason:'跨公司伪造'}}),/授权范围/);
  await reject(()=>svc.editRowInputs(db,{userId:3000,rowId:otherRowId,input:{inputs:{base_salary:'999'},reason:'只读伪造'}}),/缺少薪酬权限/);
  ok(parsed.rows[0].inputs.input_housing==='0.00'&&parsed.rows[0].input_review.input_housing.status==='unverified','cached allowance proposed for review');
  ok(svc.inputSchema().fields.some(f=>f.key==='employee_mpf_eligible'&&f.type==='boolean'),'editable schema preserves explicit eligibility');
  eq(svc.syntheticInputRows().length,177,'synthetic demo has requested row count');
  ok(svc.syntheticInputRows().every(r=>r.source_person_name.startsWith('示范员工')&&r.provenance.type==='synthetic'),'demo factory contains only artificial inputs');
  ok(svc.ruleCatalog().options.length>=4&&svc.ruleCatalog().options.every(p=>p.rules.every(r=>parseFormula(r.expression))),'multiple self-selectable algorithms compile');
  // Check each supported operator against independent expected values and the
  // JS preview. Half-cent cases require fractions rather than rounded division.
  for(const [expression,context,expected]of [
    ['0.1+0.2',{},'0.30'],['9.25-10.5',{},'-1.25'],['1.2*3.4',{},'4.08'],['10/4',{},'2.50'],
    ['MIN(-2.5,-2.6)',{},'-2.60'],['MAX(-2.5,-2.6)',{},'-2.50'],['MIN(1.23)',{},'1.23'],['MAX(1.23)',{},'1.23'],
    ['IF(flag,amount,missing)',{flag:true,amount:'1.005'},'1.01'],
    ['IF(false,1/0,3)',{},'3.00'],['1=rate',{rate:'01'},true],['"FT"!="PT"',{},true],
    ['-1/3 < 0',{},true],['2<=2',{},true],['3>2',{},true],['3>=3',{},true],
    ['AND(flag,missing)',{flag:false},false],['OR(flag,missing)',{flag:true},true],
    ['ROUND(1.005)',{},'1.01'],['ROUND(-1.005,2)',{},'-1.01'],['ROUND(1.5,0)',{},'2.00'],
    ['ROUND(1/3*1.515,2)',{},'0.51'],['ROUND(1/3*3.015,2)',{},'1.01'],
    ['ROUND(10000/31*17,2)',{},'5483.87'],['1e-30*1e30',{},'1.00'],
    ['true="true"',{},false],['ROUND(1.234567895,8)',{},'1.23'],
  ]){
    const ast=parseFormula(expression),used=new Set();const js=evaluateFormula(ast,context,{onRead:k=>used.add(k)});
    const dbResult=(await one('SELECT fn_ty_payroll_eval($1::jsonb,$2::jsonb) result',[JSON.stringify(ast),JSON.stringify(context)])).result;
    if(typeof expected==='boolean'){eq(js,expected,expression+' JS boolean');eq(dbResult.v,expected,expression+' DB boolean');}
    else{eq(money(js),expected,expression+' JS amount');eq(String((await one('SELECT fn_ty_payroll_money($1::jsonb) amount',[JSON.stringify(dbResult.v)])).amount),expected,expression+' DB exact amount');}
    eq([...new Set(dbResult.used)].sort(),[...used].sort(),expression+' actual read dependencies');
  }
  for(const [expression,context]of [['1/0',{}],['missing+1',{}],['ROUND(1,2.001)',{}],['ROUND(1,9)',{}],['AND(1,true)',{}],['IF(1,2,3)',{}],['1e-31+1',{}]]){
    const ast=parseFormula(expression);await reject(async()=>evaluateFormula(ast,context),/除数|缺少|ROUND|真假|精度/);
    await reject(()=>q('SELECT fn_ty_payroll_eval($1::jsonb,$2::jsonb)',[JSON.stringify(ast),JSON.stringify(context)]),/薪酬|ROUND|真假/);
  }
  await reject(()=>q('SELECT fn_ty_payroll_eval($1::jsonb,$2::jsonb)',[JSON.stringify({op:'eval',args:['1']}),'{}']),/不支持/);
  await reject(()=>q('SELECT fn_ty_payroll_eval($1::jsonb,$2::jsonb)',[JSON.stringify({var:true}),'{}']),/变量名/);
  await svc.calculateBatch(db,{userId:1000,batchId:staleBatch.id,input:{ruleset_id:fixed.id}});
  const correct=(await one('SELECT result_data FROM ty_payroll_row WHERE batch_id=$1',[staleBatch.id])).result_data;
  const forged=structuredClone(correct);forged.items[0].amount='7777.00';for(const key of ['income_total','payable_gross','net_pay','employer_cost'])forged.totals[key]='7777.00';forged.used_inputs=[];forged.input_snapshot={};
  await q("UPDATE ty_payroll_row SET result_data=$2::jsonb,validation='{\"ok\":true}' WHERE batch_id=$1",[staleBatch.id,JSON.stringify(forged)]);
  await reject(()=>q("UPDATE ty_payroll_batch SET status='confirmed',confirmed_by=1000,confirmed_at=now() WHERE id=$1",[staleBatch.id]),/已批准公式的数据库重算/);
  const hiddenDependency={...correct,used_inputs:[]};
  await q("UPDATE ty_payroll_row SET result_data=$2::jsonb,validation='{\"ok\":true}' WHERE batch_id=$1",[staleBatch.id,JSON.stringify(hiddenDependency)]);
  await reject(()=>q("UPDATE ty_payroll_batch SET status='confirmed',confirmed_by=1000,confirmed_at=now() WHERE id=$1",[staleBatch.id]),/实际输入依赖/);
  const fractionalCycle=(await perf.createCycle(db,{userId:1000,input:{group_id:g,code:'FRACTIONAL',name:'虚构分以下奖金',start_date:'2027-05',end_date:'2027-06',payout_period:'2027-06',currency_code:'HKD',region_code:'HK',company_ids:[c1]}})).cycle;
  await perf.saveScheme(db,{userId:1000,cycleId:fractionalCycle.id,input:{rules:{confirmed:true,aggregation:'average_score_last_grade',payout_assignment:'last_month_employment',alternative_eligibility:'last_month',alternative_rounding:'none',score_base:1,score_floor:0,metrics:[{code:'quality',unit:'ratio',method:'direct_deduction'}],rating_bands:[{min_score:0,grade:'A',factor:1}],grade_bases:{[grade]:900.005}}}});
  await perf.saveInputs(db,{userId:1000,cycleId:fractionalCycle.id,input:{company_metrics:[{company_id:c1,period:'2027-05',metrics:{quality:{value:0,unit:'ratio',status:'verified'}},source_saved_score:1}],person_months:[{person_id:p1,company_id:c1,employment_id:e1,period:'2027-05',grade_id:grade,eligibility_status:'verified'}]}});
  const fractionalCalc=await perf.calculate(db,{userId:1000,cycleId:fractionalCycle.id});
  await perf.confirm(db,{userId:1000,cycleId:fractionalCycle.id,input:{result_version:fractionalCalc.cycle.result_version,reason:'虚构未舍入奖金用于边界回归'}});
  const fractionalBatch=(await svc.createBatch(db,{userId:1000,input:{group_id:g,period:'2027-06',currency:'HKD',region_code:'HK',kind:'calculated',rows:[{...spec('FRACTIONAL',p1,c1,e1,'1000'),items:[],source_totals:{}}]}})).batch;
  const fractionBlocked=await svc.applyPerformanceCandidates(db,{userId:1000,batchId:fractionalBatch.id,input:{cycle_id:fractionalCycle.id}});
  ok(fractionBlocked.applied.length===0&&fractionBlocked.blocked[0].reason.includes('分以下'),'fractional source never silently rounded');
  const fractionApplied=await svc.applyPerformanceCandidates(db,{userId:1000,batchId:fractionalBatch.id,input:{cycle_id:fractionalCycle.id,rounding:'round_2'}});
  eq(fractionApplied.applied[0].amount,'900.01','explicit source rounding is half away from zero');
  ok(fractionApplied.applied[0].rounding==='round_2'&&Number(fractionApplied.applied[0].amount_exact)===900.005,'original precision and explicit rounding retained');
  eq((await svc.applyPerformanceCandidates(db,{userId:1000,batchId:fractionalBatch.id,input:{cycle_id:fractionalCycle.id}})).already_applied.length,1,'rounded source posting remains idempotent');
  await svc.calculateBatch(db,{userId:1000,batchId:fractionalBatch.id,input:{ruleset_id:perfRules.id}});
  await svc.confirmBatch(db,{userId:1000,batchId:fractionalBatch.id});
  eq((await svc.report(db,{userId:1000,batchId:fractionalBatch.id})).summary.net_pay,'1900.01','DB verifies exact source and explicitly rounded payroll');
  for(const statement of ['TRUNCATE ty_payroll_audit','TRUNCATE ty_payroll_posted_person','TRUNCATE ty_payroll_performance_input','TRUNCATE ty_payroll_row CASCADE','TRUNCATE ty_payroll_batch CASCADE','TRUNCATE ty_payroll_ruleset CASCADE','TRUNCATE ty_perf_result'])await reject(()=>q(statement),/禁止TRUNCATE/);
  // Currency does not imply a country. Known company declarations, explicit
  // business context and jurisdiction-tagged modules are checked independently.
  const rg=await ins('ty_group',{code:'REGION',name:'完全虚构地区测试集团'});
  const hb=await ins('ty_brand',{group_id:rg,code:'HK',name:'虚构香港品牌',region_code:'HK',currency_code:'HKD'}),cb=await ins('ty_brand',{group_id:rg,code:'CN',name:'虚构内地品牌',region_code:'CN',currency_code:'CNY'});
  const hl=await ins('ty_ledger',{group_id:rg,brand_id:hb,code:'HK',name:'虚构香港帐套',scope_mode:'brand'}),cl=await ins('ty_ledger',{group_id:rg,brand_id:cb,code:'CN',name:'虚构内地帐套',scope_mode:'brand'});
  const hc=await ins('ty_company',{group_id:rg,ledger_id:hl,brand_id:hb,code:'HK',name:'虚构香港公司'}),cc=await ins('ty_company',{group_id:rg,ledger_id:cl,brand_id:cb,code:'CN',name:'虚构内地公司'});
  const rp=Number((await one('SELECT fn_ty_create_person($1,NULL,$2) id',[rg,'虚构跨地区人员'])).id),he=await ins('ty_employment',{group_id:rg,company_id:hc,person_id:rp,hire_date:'2026-01-01'}),ce=await ins('ty_employment',{group_id:rg,company_id:cc,person_id:rp,hire_date:'2026-01-01'});
  await reject(()=>svc.createBatch(db,{userId:1000,input:{group_id:rg,period:'2027-01',currency:'CNY',region_code:'HK',rows:[spec('WRONG-CURRENCY',rp,hc,he,'1000')]}}),/币种/);
  await reject(()=>svc.createBatch(db,{userId:1000,input:{group_id:rg,period:'2027-01',currency:'HKD',region_code:'CN',rows:[spec('WRONG-REGION',rp,hc,he,'1000')]}}),/地区/);
  await reject(()=>svc.createBatch(db,{userId:1000,input:{group_id:rg,period:'2027-01',currency:'HKD',region_code:'HK',rows:[spec('MIX-HK',rp,hc,he,'1000'),spec('MIX-CN',rp,cc,ce,'1000')]}}),/地区|币种/);
  const rawBatch=await ins('ty_payroll_batch',{group_id:rg,period:'2027-01',currency:'CNY',region_code:'CN',label:'虚构直接SQL预检',kind:'source_snapshot',created_by:1000});
  await reject(()=>ins('ty_payroll_row',{batch_id:rawBatch,group_id:rg,source_key:'RAW-HK',source_data:JSON.stringify(spec('RAW-HK',rp,hc,he,'1000')),person_id:rp,company_id:hc,employment_id:he}),/币种/);
  await reject(()=>q("UPDATE ty_payroll_batch SET region_code='HK' WHERE id=$1",[rawBatch]),/地区和币种不能直接改写/);
  await reject(()=>perf.createCycle(db,{userId:1000,input:{group_id:rg,code:'WRONG',name:'虚构错误币种',start_date:'2027-01',end_date:'2027-02',payout_period:'2027-02',currency_code:'CNY',region_code:'HK',company_ids:[hc]}}),/币种/);
  await reject(()=>perf.createCycle(db,{userId:1000,input:{group_id:rg,code:'MIXED',name:'虚构混合地区',start_date:'2027-01',end_date:'2027-02',payout_period:'2027-02',currency_code:'HKD',region_code:'HK',company_ids:[hc,cc]}}),/地区|币种/);
  const rawCycle=await ins('ty_perf_cycle',{group_id:rg,code:'RAW',name:'虚构直接周期',start_date:'2027-01-01',end_date:'2027-02-01',payout_period:'2027-02-01',currency_code:'CNY',region_code:'CN',created_by:1000});
  await reject(()=>q('INSERT INTO ty_perf_cycle_company(cycle_id,company_id) VALUES($1,$2)',[rawCycle,hc]),/币种/);
  await reject(()=>q("UPDATE ty_perf_cycle SET region_code='HK' WHERE id=$1",[rawCycle]),/地区和币种不能直接改写/);
  const hkModule=[{code:'contribution',name:'虚构供款模块',kind:'employee_contribution',expression:'mpf_amount',jurisdiction_module:'HK_MPF'}];
  await reject(()=>svc.saveRuleSet(db,{userId:1000,input:{group_id:rg,name:'错误HK模块到CN',currency:'CNY',region:'CN',rules:hkModule}}),/地区专属/);
  await reject(()=>svc.saveRuleSet(db,{userId:1000,input:{group_id:rg,name:'错误HK模块到CUSTOM',currency:'HKD',region:'CUSTOM',rules:hkModule}}),/地区专属/);
  await reject(()=>q('SELECT fn_ty_assert_rule_jurisdiction($1::jsonb,$2,$3)',[JSON.stringify(hkModule),'HK','CN']),/地区/);
  await reject(()=>q('SELECT fn_ty_assert_rule_jurisdiction($1::jsonb,$2,$3)',[JSON.stringify([{...hkModule[0],jurisdiction_module:'CN_IIT'}]),'HK','HK']),/地区专属/);
  const cnBase=(await svc.saveRuleSet(db,{userId:1000,input:{group_id:rg,name:'虚构通用基础工资',currency:'CNY',region:'CUSTOM',status:'approved',approval_ack:true,policy_notes:'仅虚构通用工资算式，名称不判断地区',rules:[{code:'generic',name:'含MPF和税字样仍为通用示例',kind:'earning',expression:'base_salary',jurisdiction_module:'BASE'}]}})).ruleset;
  const cnBatch=(await svc.createBatch(db,{userId:1000,input:{group_id:rg,period:'2027-01',currency:'CNY',kind:'calculated',rows:[{...spec('CN-BASE',rp,cc,ce,'1000'),items:[],source_totals:{},inputs:{base_salary:'1000'}}]}})).batch;
  eq(cnBatch.region_code,'CN','configured company declaration supplies known country, not currency');
  await svc.calculateBatch(db,{userId:1000,batchId:cnBatch.id,input:{ruleset_id:cnBase.id}});await svc.confirmBatch(db,{userId:1000,batchId:cnBatch.id});
  eq((await svc.report(db,{userId:1000,batchId:cnBatch.id})).summary.net_pay,'1000.00','CUSTOM base works for explicitly configured CN company');
  await reject(()=>q("UPDATE ty_brand SET region_code='HK',currency_code='HKD' WHERE id=$1",[cb]),/确认金额/);
  const plainLedger=await ins('ty_ledger',{group_id:rg,code:'PLAIN',name:'虚构无品牌帐套',scope_mode:'group',region_code:'CN',currency_code:'CNY'});
  const plainCompany=await ins('ty_company',{group_id:rg,ledger_id:plainLedger,code:'PLAIN',name:'虚构无品牌公司'}),plainEmployment=await ins('ty_employment',{group_id:rg,company_id:plainCompany,person_id:rp,hire_date:'2026-01-01'});
  const plainBatch=(await svc.createBatch(db,{userId:1000,input:{group_id:rg,period:'2027-01',currency:'CNY',region_code:'CN',rows:[spec('PLAIN',rp,plainCompany,plainEmployment,'1000')]}})).batch;
  await svc.confirmBatch(db,{userId:1000,batchId:plainBatch.id});
  await reject(()=>q("UPDATE ty_ledger SET region_code='HK',currency_code='HKD' WHERE id=$1",[plainLedger]),/确认金额/);
  const lateBrand=await ins('ty_brand',{group_id:g,code:'LATE-HK',name:'虚构后补品牌',region_code:'HK',currency_code:'HKD'});
  await reject(()=>q('UPDATE ty_company SET brand_id=$1 WHERE id=$2',[lateBrand,c1]),/确认金额/);
  await reject(()=>q('TRUNCATE ty_financial_locale_lock'),/禁止TRUNCATE/);
  const unknown=(await svc.createBatch(db,{userId:1000,input:{group_id:g,period:'2027-08',currency:'HKD',rows:[spec('COUNTRY-UNKNOWN',p1,c1,e1,'1000')]}})).batch;
  eq(unknown.region_code,null,'unknown company country remains null even for HKD');
  ok(!(await svc.validateBatch(db,{userId:1000,batchId:unknown.id})).ok,'unknown snapshot cannot confirm before country declaration');
  await svc.setBatchLocale(db,{userId:1000,batchId:unknown.id,input:{region_code:'HK'}});
  await svc.confirmBatch(db,{userId:1000,batchId:unknown.id});
  const unknownCycle=(await perf.createCycle(db,{userId:1000,input:{group_id:g,code:'UNKNOWN-COUNTRY',name:'虚构未知地区草稿',start_date:'2027-01',end_date:'2027-02',payout_period:'2027-02',currency_code:'HKD',company_ids:[c1]}})).cycle;
  eq(unknownCycle.region_code,null,'unknown performance country stays null in draft');
  await perf.setCycleLocale(db,{userId:1000,cycleId:unknownCycle.id,input:{region_code:'HK'}});
  await reject(()=>perf.setCycleLocale(db,{userId:1000,cycleId:unknownCycle.id,input:{region_code:'CN'}}),/地区已明确/);
  console.log(`customer-payroll: ${checks} assertions passed`);
} finally {
  await db.close();
}
