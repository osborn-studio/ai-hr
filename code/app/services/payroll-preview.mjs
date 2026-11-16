// ============================================================================
// app/services/payroll-preview.mjs · 算薪预演（137）
// ----------------------------------------------------------------------------
// 这一层只做三件事：校验参数、判权限、把库函数的结果整理成界面能直接用的形状。
// **不在这一层算钱** —— 数的对错只由 fn_payroll_calc 一处决定，预演只是把它
// 跑两遍。任何在 JS 里"估一下大概会变多少"的写法，都会在半年后跟真算漂开。
//
// 参数校验写得比较啰嗦，是因为这一页的输入直接决定"看到的影响面"，而错的值
// 有两种坏结果：太宽松 → 存进去一个算薪读不到的值，预演给出 0 变化，人以为
// "这个参数没影响"；太严格 → 人放弃用预演，回到"改了再算"。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { run: 'payroll_run' };

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 数值参数：给区间是为了挡住手滑（比如把 5 写成 500） */
function num(v, { name, min, max, def = 0 }) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw bizErr('E_ARG_INVALID', `${name} 必须是数字`);
  if (n < min || n > max) {
    throw bizErr('E_ARG_INVALID', `${name} 要在 ${min} ~ ${max} 之间（收到 ${n}）`);
  }
  return n;
}

/**
 * 校验并规整覆盖参数。
 * 支持：salary_pct / salary_add / si_base_pct / policy{code: value}
 */
export async function normalizeOverrides(tx, raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {};

  const pct = num(o.salary_pct, { name: 'salary_pct', min: -100, max: 1000 });
  if (pct !== 0) out.salary_pct = pct;

  const add = num(o.salary_add, { name: 'salary_add', min: -1e6, max: 1e6 });
  if (add !== 0) out.salary_add = add;

  const sip = num(o.si_base_pct, { name: 'si_base_pct', min: -100, max: 1000 });
  if (sip !== 0) out.si_base_pct = sip;

  const pol = o.policy && typeof o.policy === 'object' ? o.policy : null;
  if (pol) {
    const codes = Object.keys(pol);
    if (codes.length) {
      // 一次查全部，顺带拿到 value_type —— 类型不对时说清"这一项要的是数字还是开关"
      const defs = (await tx.query(
        `SELECT code, value_type FROM policy_def WHERE code = ANY($1)`, [codes])).rows;
      const byCode = new Map(defs.map(d => [d.code, d.value_type]));
      const bad = codes.filter(c => !byCode.has(c));
      if (bad.length) {
        throw bizErr('E_ARG_INVALID', `这些制度项不存在：${bad.join('、')}`);
      }
      const clean = {};
      for (const c of codes) {
        const t = byCode.get(c);
        const v = pol[c];
        if (t === 'numeric') {
          const n = Number(v);
          if (!Number.isFinite(n)) throw bizErr('E_ARG_INVALID', `${c} 是数字项，收到 ${v}`);
          clean[c] = n;
        } else if (t === 'bool') {
          const s = String(v).toLowerCase();
          if (!['on', 'off', 'true', 'false'].includes(s)) {
            throw bizErr('E_ARG_INVALID', `${c} 是开关项，只能填 on / off（收到 ${v}）`);
          }
          clean[c] = (s === 'on' || s === 'true') ? 'on' : 'off';
        } else {
          clean[c] = String(v);
        }
      }
      out.policy = clean;
    }
  }

  return out;
}

/**
 * 预演。返回库里那份 jsonb，外加一句人话总结。
 * ★ 库里那份里没有"结论"，只有数；结论文案放这里，因为它是给人看的，
 *   而要改文案时不该动数据库函数（那要走一次迁移）。
 */
export async function preview(tx, { userId, period, entityId, overrides }) {
  await requireSession(tx, { userId, resource: RESOURCES.run, action: 'read' });
  if (!PERIOD_RE.test(String(period || ''))) {
    throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM');
  }
  if (!Number.isInteger(entityId) || entityId <= 0) {
    throw bizErr('E_ARG_INVALID', 'entity 必须是正整数（发薪法人 id）');
  }

  const ov = await normalizeOverrides(tx, overrides);
  const r = (await tx.query(
    `SELECT fn_payroll_preview($1,$2,$3::jsonb) p`,
    [period, entityId, JSON.stringify(ov)])).rows[0].p;

  const d = r.delta || {};
  const fmt = (n) => Number(n || 0).toLocaleString('zh-CN',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let summary;
  if ((r.applied || []).length === 0) {
    summary = '没有给任何覆盖参数，下面两个总额是同一份数。';
  } else if (r.no_effect) {
    // ★ 明确说"没影响"，并给出最可能的原因。让人自己盯着一排 0 猜，
    //   他们会以为预演坏了，然后再也不点。
    summary = '这次改动对本期没有任何影响 —— 常见原因：这些人不适用被改的那一项'
      + '（比如全是人天计薪却改了加班倍数），或者改的金额还没到生效日。';
  } else {
    summary = `应发 ${fmt(r.base?.gross)} → ${fmt(r.after?.gross)}（${Number(d.gross) >= 0 ? '+' : ''}${fmt(d.gross)}），`
      + `实发 ${fmt(r.base?.net)} → ${fmt(r.after?.net)}（${Number(d.net) >= 0 ? '+' : ''}${fmt(d.net)}）。`;
  }

  return {
    ...r,
    summary,
    warnings: [
      (r.negative_net || []).length
        ? `有 ${r.negative_net.length} 人实发会变成负数 —— 通常是社保基数或扣款项配错了，先查这些人的明细`
        : null,
      (r.blocked || []).length
        ? `有 ${r.blocked.length} 人的 before 规则会拦住算薪：预演给的是"如果规则放行"的数字，真实算薪会整批不出结果`
        : null,
      r.no_effect ? '这次改动对本期没有影响，别把"没变化"当成"预演没跑"' : null,
    ].filter(Boolean),
  };
}
