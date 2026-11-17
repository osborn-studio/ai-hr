import test from 'node:test';
import assert from 'node:assert/strict';
import { runPayrollScript, validateScriptOutput } from '../app/services/payroll-script-engine.mjs';

process.env.TYHR_PAYROLL_SCRIPT_SANDBOX = 'quickjs-wasm-v1';
const spec = { hourly_rate: { unit: 'CNY/hour', minimum: '0', maximum: '1000' } };
const run = (code, extra = {}) => runPayrollScript({ code, input: { rate: '28.50', secret: null }, declaredParameters: spec, ...extra });
test('WASM returns decimal text with bounded physical memory and lineage hashes', async () => {
  const r = await run('input => ({parameters:{hourly_rate:{value:input.rate,unit:"CNY/hour"}}})');
  assert.equal(r.output.parameters.hourly_rate.value, '28.50');
  assert.equal(r.physical_memory_bytes, 67108864);
  for (const key of ['code_hash','input_hash','output_hash']) assert.match(r[key], /^[a-f0-9]{64}$/);
});
test('no guest filesystem, network, host imports, timers, clock or randomness', async () => {
  await run('input => { for (const k of ["process","require","fetch","console","Date","WebAssembly","Worker","setTimeout"]) if(typeof globalThis[k]!=="undefined") throw Error(k); if(Math.random!==undefined)throw Error("random"); return {parameters:{hourly_rate:{value:"1",unit:"CNY/hour"}}}; }');
});
test('infinite guest loop is interrupted and does not block the Node event loop', async () => {
  const marker = new Promise(resolve => setTimeout(resolve, 20));
  const attack = run('() => { while(true){} }', { executionMs: 30 });
  await marker;
  await assert.rejects(attack, /execution_timeout|execution_wall_timeout/);
});
test('fixed WASM memory rejects large allocations rather than growing host memory', async () => {
  await assert.rejects(run('() => { const a=[]; while(true) a.push("x".repeat(1024*1024)); }'), /guest_error|engine_failed|execution_timeout/);
  const r = await run('() => ({parameters:{hourly_rate:{value:"2",unit:"CNY/hour"}}})');
  assert.equal(r.physical_memory_bytes, 67108864);
});
test('recursive stack growth is bounded', async () => { await assert.rejects(run('() => { function a(){ return a()+1; } return a(); }'), /guest_error/); });
test('module import has no module loader', async () => { await assert.rejects(run('() => import("node:fs")'), /invalid_output|asynchronous_code_forbidden|guest_error/); });
test('async results and queued jobs are rejected', async () => { await assert.rejects(run('async () => ({parameters:{}})'), /invalid_output|asynchronous_code_forbidden/); });
test('input is recursively frozen and cannot rewrite source values', async () => {
  const r = await run('input => { input.rate="999"; return {parameters:{hourly_rate:{value:input.rate,unit:"CNY/hour"}}}; }');
  assert.equal(r.output.parameters.hourly_rate.value, '28.50');
});
test('bounded serializer resists guest JSON replacement and oversized output', async () => {
  await assert.rejects(run('() => { JSON.stringify=()=>"{}"; return {parameters:{hourly_rate:{value:"1".repeat(40000),unit:"CNY/hour"}}}; }'), /invalid_output|output_limit/);
});
test('output cannot forge wage rows, legal review or undeclared parameters', () => {
  for (const o of [{parameters:{},makeLine:{}},{parameters:{native_verified:{value:'1',unit:'CNY/hour'}}},{parameters:{hourly_rate:{value:28.5,unit:'CNY/hour'}}},{parameters:{hourly_rate:{value:null,unit:'CNY/hour'}}},{parameters:{hourly_rate:{value:'1',unit:'HKD/hour'}}}]) assert.throws(() => validateScriptOutput(o, spec));
});
test('exact decimal bounds reject excess without floating point coercion', () => {
  assert.throws(() => validateScriptOutput({parameters:{hourly_rate:{value:'1000.00000001',unit:'CNY/hour'}}}, spec), /above_bound/);
  assert.equal(validateScriptOutput({parameters:{hourly_rate:{value:'1000.00000000',unit:'CNY/hour'}}}, spec).parameters.hourly_rate.value, '1000.00000000');
});
test('sandbox configuration is explicit and no Node vm fallback exists', async () => {
  delete process.env.TYHR_PAYROLL_SCRIPT_SANDBOX;
  try { await assert.rejects(run('() => ({})'), /isolation_not_configured/); } finally { process.env.TYHR_PAYROLL_SCRIPT_SANDBOX = 'quickjs-wasm-v1'; }
});
