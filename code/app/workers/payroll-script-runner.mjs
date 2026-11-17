import { parentPort, workerData } from 'node:worker_threads';
import { newVariant, newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import releaseSync from '@jitl/quickjs-wasmfile-release-sync';

// This worker hosts only the WASM engine. No host functions are given to guest code.
const PHYSICAL_BYTES = 64 * 1024 * 1024;
const ALLOCATOR_BYTES = 16 * 1024 * 1024;
const STACK_BYTES = 256 * 1024;
const OUTPUT_BYTES = 32 * 1024;
let runtime, context;
const handles = [];
try {
  const memory = new WebAssembly.Memory({ initial: PHYSICAL_BYTES / 65536, maximum: PHYSICAL_BYTES / 65536 });
  const engine = await newQuickJSWASMModuleFromVariant(newVariant(releaseSync, { wasmMemory: memory }));
  runtime = engine.newRuntime();
  runtime.setMemoryLimit(ALLOCATOR_BYTES);
  runtime.setMaxStackSize(STACK_BYTES);
  runtime.removeModuleLoader();
  const deadline = performance.now() + workerData.execution_ms;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    if (performance.now() > deadline) { interrupted = true; return true; }
    return false;
  });
  context = runtime.newContext();
  function evaluate(code) {
    const result = context.evalCode(code, 'payroll-rule.js', { type: 'global' });
    if (result.error) { result.error.dispose(); throw new Error(interrupted ? 'execution_timeout' : 'guest_error'); }
    handles.push(result.value);
    return result.value;
  }
  // Capture serialization intrinsics before the guest can replace globals.
  const serializer = evaluate(`(() => {
    const stringify = JSON.stringify;
    return value => {
      if (value === null || typeof value !== 'object' || typeof value.then === 'function') throw Error('invalid_output');
      const result = stringify(value);
      if (typeof result !== 'string' || result.length > ${OUTPUT_BYTES}) throw Error('output_limit');
      return result;
    };
  })()`);
  const input = evaluate(`(() => {
    const value = ${JSON.stringify(workerData.input)};
    const freeze = value => { if (value && typeof value === 'object') { for (const key of Object.keys(value)) freeze(value[key]); Object.freeze(value); } return value; };
    return freeze(value);
  })()`);
  evaluate(`(() => {
    for (const key of ['Date','console','fetch','XMLHttpRequest','WebSocket','Worker','SharedArrayBuffer','Atomics','process','require','setTimeout','setInterval','queueMicrotask','performance']) {
      Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false });
    }
    Object.defineProperty(Math, 'random', { value: undefined, writable: false, configurable: false });
  })()`);
  const fn = evaluate(`(${workerData.code}\n)`);
  if (context.typeof(fn) !== 'function') throw new Error('function_required');
  const result = context.callFunction(fn, context.undefined, input);
  if (result.error) { result.error.dispose(); throw new Error(interrupted ? 'execution_timeout' : 'guest_error'); }
  handles.push(result.value);
  const serialized = context.callFunction(serializer, context.undefined, result.value);
  if (serialized.error) { serialized.error.dispose(); throw new Error(interrupted ? 'execution_timeout' : 'invalid_output'); }
  handles.push(serialized.value);
  const text = context.getString(serialized.value);
  if (Buffer.byteLength(text) > OUTPUT_BYTES) throw new Error('output_limit');
  if (runtime.hasPendingJob()) throw new Error('asynchronous_code_forbidden');
  let cannotGrow = false;
  try { memory.grow(1); } catch { cannotGrow = true; }
  if (!cannotGrow || memory.buffer.byteLength !== PHYSICAL_BYTES) throw new Error('physical_memory_limit_unavailable');
  parentPort.postMessage({ ok: true, output: JSON.parse(text), engine: 'quickjs-emscripten-0.32.0-release-sync', physical_memory_bytes: memory.buffer.byteLength });
} catch (error) {
  const known = new Set(['execution_timeout','guest_error','invalid_output','function_required','output_limit','asynchronous_code_forbidden','physical_memory_limit_unavailable']);
  parentPort.postMessage({ ok: false, error: known.has(error?.message) ? error.message : 'engine_failed' });
} finally {
  for (const handle of handles.reverse()) { try { handle.dispose(); } catch {} }
  try { context?.dispose(); } catch {}
  try { runtime?.dispose(); } catch {}
}
