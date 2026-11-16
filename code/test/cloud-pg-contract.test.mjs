import assert from 'node:assert/strict';
import { createDb, withTx } from '../app/db.mjs';

if (!process.env.DATABASE_URL) throw new Error('本套必须显式连接隔离空PostgreSQL数据库');
const db = await createDb({ url: process.env.DATABASE_URL });
let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); };
try {
  await db.exec(`CREATE FUNCTION app_init_session() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test initialization failure'; END $$`);
  for (let n = 0; n < 4; n++) {
    await assert.rejects(withTx(db, async () => 'must not execute'), /test initialization failure/);
    check(`first initialization failure ${n+1} returns pool connection`, db.raw.idleCount === db.raw.totalCount && db.raw.waitingCount === 0);
  }
  await db.raw.query(`CREATE OR REPLACE FUNCTION app_init_session() RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END $$`);
  await withTx(db, tx => tx.query('CREATE TABLE cloud_transaction_test (id integer PRIMARY KEY)'));
  await db.raw.query(`CREATE OR REPLACE FUNCTION app_init_session() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'second initialization failure'; END $$`);
  await assert.rejects(withTx(db, async () => 'must not execute'), /second initialization failure/);
  check('second session init failure returns pool connection', db.raw.idleCount === db.raw.totalCount && db.raw.waitingCount === 0);
  await db.raw.query(`CREATE OR REPLACE FUNCTION app_init_session() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='app_init_session permission rejected'; END $$`);
  await assert.rejects(withTx(db, async () => 'must not execute'), error => error.code === '42501');
  check('permission failure mentioning function is not swallowed', db.raw.idleCount === db.raw.totalCount);
  await db.raw.query(`CREATE OR REPLACE FUNCTION app_init_session() RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END $$`);
  await assert.rejects(withTx(db, async tx => { await tx.query('INSERT INTO cloud_transaction_test VALUES (1)'); throw new Error('rollback deliberate'); }), /rollback deliberate/);
  check('business failure actually rolls back row', Number((await db.query('SELECT count(*) n FROM cloud_transaction_test')).rows[0].n) === 0);
  await withTx(db, tx => tx.query('INSERT INTO cloud_transaction_test VALUES (2)'));
  check('subsequent request commits normally', Number((await db.query('SELECT count(*) n FROM cloud_transaction_test')).rows[0].n) === 1);
  check('all checked out connections returned after success', db.raw.idleCount === db.raw.totalCount && db.raw.waitingCount === 0);
} finally { await db.close(); }
console.log(`真实PostgreSQL云端连接与事务 ${passed}项通过`);
