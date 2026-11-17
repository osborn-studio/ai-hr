import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

export const SCRIPT_ENGINE = Object.freeze({ name: 'quickjs-emscripten', version: '0.32.0', variant: 'release-sync', physical_memory_bytes: 67108864, allocator_bytes: 16777216, stack_bytes: 262144, output_bytes: 32768 });
const sha = value => createHash('sha256').update(value).digest('hex');
let active = 0;
function plain(value, depth = 0) {
  if (depth > 12) throw new Error('input_depth_exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('non_finite_input'); return; }
  if (typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value))) throw new Error('plain_json_required');
  const keys = Object.keys(value);
  if (keys.length > 256) throw new Error('input_keys_exceeded');
  for (const key of keys) { if (['__proto__','constructor','prototype'].includes(key)) throw new Error('unsafe_key'); plain(value[key], depth + 1); }
}
export function validateScriptOutput(output, declaredParameters) {
  plain(output);
  if (!output || Array.isArray(output) || Object.keys(output).some(key => key !== 'parameters') || !output.parameters || Array.isArray(output.parameters)) throw new Error('parameters_only');
  const keys = Object.keys(output.parameters);
  if (!keys.length || keys.length > 32) throw new Error('parameter_count');
  for (const key of keys) {
    const p = output.parameters[key];
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || !Object.hasOwn(declaredParameters, key) || !p || Array.isArray(p) || Object.keys(p).some(k => !['value','unit'].includes(k))) throw new Error('undeclared_parameter');
    if (typeof p.value !== 'string' || !/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/.test(p.value)) throw new Error('decimal_text_required');
    if (p.unit !== declaredParameters[key].unit) throw new Error('parameter_unit_mismatch');
    const spec = declaredParameters[key];
    // Bounds are exact scaled integer comparisons, not IEEE754 amounts.
    const rational = str => { const [whole, fraction = ''] = str.replace(/^-/, '').split('.'); return (str[0] === '-' ? -1n : 1n) * BigInt(whole + fraction.padEnd(8, '0')); };
    if (spec.minimum != null && rational(p.value) < rational(spec.minimum)) throw new Error('parameter_below_bound');
    if (spec.maximum != null && rational(p.value) > rational(spec.maximum)) throw new Error('parameter_above_bound');
  }
  return output;
}
export async function runPayrollScript({ code, input, declaredParameters, executionMs = 200, wallMs = 2000 }) {
  if (process.env.TYHR_PAYROLL_SCRIPT_SANDBOX !== 'quickjs-wasm-v1') throw new Error('script_isolation_not_configured');
  if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > 65536) throw new Error('code_limit');
  plain(input);
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 131072) throw new Error('input_limit');
  if (active >= 2) throw new Error('script_capacity_busy');
  const deadline = Math.min(500, Math.max(25, Number(executionMs) || 200));
  const wall = Math.min(3000, Math.max(100, Number(wallMs) || 2000));
  active++;
  try {
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../workers/payroll-script-runner.mjs', import.meta.url), {
        workerData: { code, input, execution_ms: deadline },
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
        env: {}, stdout: true, stderr: true,
      });
      let finished = false;
      const finish = async (error, value) => { if (finished) return; finished = true; clearTimeout(timer); await worker.terminate(); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { void finish(new Error('execution_wall_timeout')); }, wall);
      worker.on('message', value => { void finish(null, value); });
      worker.on('error', () => { void finish(new Error('engine_failed')); });
      worker.on('exit', () => { if (!finished) void finish(new Error('engine_failed')); });
    });
    if (!result.ok) throw new Error(result.error);
    const output = validateScriptOutput(result.output, declaredParameters);
    return { output, engine: SCRIPT_ENGINE, code_hash: sha(code), input_hash: sha(serialized), output_hash: sha(JSON.stringify(output)), physical_memory_bytes: result.physical_memory_bytes };
  } finally { active--; }
}
