// ============================================================================
// app/services/payslip-pack.mjs · 按门店批量打包工资单（171）
// ----------------------------------------------------------------------------
// 单份打印（payslip-print）解决的是"一个门店出一份单"，而 HR 月底的真实动作是
// **一次出全套**：十家店点十次、再手工把十个窗口另存成十个文件、再自己打包，
// 中间任何一步点错，就是把这家店的薪资发给了那家店的店长。
//
// 所以这个入口只做三件事：
//   ① 把该期间**所有有工资条的门店**各生成一份 HTML（不许多、不許空）；
//   ② 文件名带期间与门店名，且门店名里的 / \ : * ? " < > | 全部清掉
//      —— 文件名里有斜杠，解压时会被当成子目录，而"少了几个文件"不会报错；
//   ③ 打成一个 zip 直接下载（`Content-Disposition: attachment`）。
//
// ★ 三条设计取舍（写在这里，因为下一个人最容易在这里"优化"）：
//
//   ① **服务端打包，不引依赖。** 见 app/zip.mjs：zip 的写侧只有三段结构，
//      zlib 已经给了 deflate。多引一个 archiver 就多一条供应链，
//      而这个仓库的依赖只有 PGlite 与 pg（xlsx.mjs 开头那段自述同一条理由）。
//
//   ② **数据一律走 payslip-print.sheet()，一个字都不另写。**
//      这里是打包最容易做错的地方，也是 71ce396 被抓出四处越权的同一个形态：
//      新入口为了"顺手只取需要的列"自己写一条 SELECT，于是行闸（fn_scope_people）
//      与字段掩码（fn_field_action）**换了个入口就失效**。
//      本文件因此**没有一条业务 SQL**：批次列表只是个目录，人与钱全部由 sheet()
//      给出，权限口径只有那一处。
//      场景传 `export`（页面是 `list`）—— 导出的文件会被转发，所以只能更严，
//      不能更松（003 的 scene 维就是为这件事存在的）。
//
//   ③ **空门店不出文件。** 门店是"有人在那里领工资"才出现在这张单上，
//      没有工资条的门店生成一份 0 人 0 元的空单只有一个后果：
//      店长收到一张写着"0 人"的纸，然后打电话问财务"我店里的人是不是漏发了"。
//      判据是"这个店有没有工资条"，不是"组织树里有没有这个店"。
//
// ★ 一个批次一个法人，"这家店的人分属两个法人"是有可能的（连锁常见）：
//   那时这一家店会有两份单（两个甲方主体不能印在同一张纸上），
//   文件名会带上主体名以示区别 —— 只有在**该期间有多个批次**时才加前缀，
//   单法人时不加（财务要的是"一眼看出是哪个店"，不是最长文件名）。
// ============================================================================
import { html, sheet } from './payslip-print.mjs';
import { makeZip } from '../zip.mjs';
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'payroll_run' };

// 期间只有一个形状：YYYY-MM。宽容解析（"2026-3"、"2026/03"）的代价是
// 这一期"看起来有数据"而实际查的是另一期，而工资单印错期间要重开。
const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

// 文件名里的非法字符：Windows 的九宫格 + 控制字符。
// ★ 斜杠单独要紧：zip 里 `/` 是路径分隔符，留着它就等于在包里建子目录，
//   解压后"文件数少了一个"，而且不报错。
const ILLEGAL_IN_NAME = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
// Windows 的保留设备名：CON.html 在 Windows 上是创不出来的
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 把任意字符串清成一个可用的文件名片段。
 * @param {string} raw 门店名 / 主体名
 * @param {string} fallback 清完是空的时候用什么（"未归店"这类）
 * @returns {string}
 */
export function safeFilePart(raw, fallback = '未命名') {
  let s = String(raw ?? '').replace(ILLEGAL_IN_NAME, '_');
  // 空白折成一个空格：门店名里带换行（粘贴进来的）会把文件名拆成两行
  s = s.replace(/\s+/g, ' ').trim();
  // 首尾的点与空格在 Windows 上会被静默吃掉，于是"文件名对不上"
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  // 太长的名字在部分文件系统上会被截断，截断后可能又撞车 —— 这里先截短
  return [...s].slice(0, 60).join('');
}

/** 一张单的文件名：`2026-11_A店.html`，多法人时 `2026-11_示例餐饮_A店.html` */
function fileNameOf({ period, entity, orgName, multi }) {
  const bits = [period];
  if (multi) bits.push(safeFilePart(entity, '未知主体'));
  bits.push(safeFilePart(orgName, '未归店'));
  return `${bits.join('_')}.html`;
}

/**
 * 打包：该期间所有有工资条的门店，各一份工资单 HTML，打成 zip。
 *
 * @param {object} tx 事务
 * @param {object} p
 * @param {number} p.userId 会话用户
 * @param {string} p.period 期间（YYYY-MM）
 * @param {1|2} [p.perPage] 每页几人（与单份打印的 per 同义）
 * @returns {Promise<{period: string, per: number, zip: Buffer, files: Array,
 *   stores: number, people: number, runs: number, skipped_runs: Array}>}
 */
export async function pack(tx, { userId, period, perPage = 1 }) {
  // 岗位层先判（064）：不许碰 payroll_run 的账号，连"有哪些批次"都不该知道。
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });

  const p = String(period ?? '').trim();
  if (!PERIOD_RE.test(p)) {
    throw bizErr('E_PACK_PERIOD',
      `期间必须写成 YYYY-MM（例如 2026-11），收到的是 "${p}"`);
  }
  const per = Number(perPage) === 2 ? 2 : 1;

  // 目录：该期间有哪些批次。**这只是一份目录**（日期 + 主体 + id），
  // 不含任何人的信息，所以可以由这里查；人与钱一律走 sheet()。
  const runs = (await tx.query(
    `SELECT r.id, r.period, r.legal_entity_id,
            COALESCE(l.stamp_name, l.name) AS entity_name
       FROM pay_run r
       LEFT JOIN legal_entity l ON l.id = r.legal_entity_id
      WHERE r.period = $1
      ORDER BY r.legal_entity_id, r.id`, [p])).rows;

  // ★ 三个参数/状态错各有名字，不要笼统 500：
  //   期间写错 → 422（改对就能过）；这一期压根没算过薪 → 409（要去算薪）；
  //   算过但我的范围里一个门店都没有 → 409（是权限/门店归属的事，不是参数错）。
  if (runs.length === 0) {
    throw bizErr('E_PACK_NO_RUN', `${p} 还没有发薪批次，先算薪再打包`);
  }

  const multi = runs.length > 1;
  const files = [];
  const skipped = [];
  const used = new Set();
  let people = 0;

  for (const r of runs) {
    let d;
    try {
      // ★ 场景 export：这是**下载出去的文件**，会被转发到微信群里。
      //   与单份打印（list）共用同一个 sheet()，两处不可能给出两个答案。
      d = await sheet(tx, {
        userId, runId: Number(r.id), orgId: null, scene: 'export',
      });
    } catch (e) {
      // 权限面全在 sheet() 里（岗位 → 法人 → 行闸 → 掩码），这里**不重判一遍**：
      // 越出我的法人范围 = 这一批不归我，跳过它继续打其余的；
      // 其它错误照抛（吞掉会变成"包里莫名少了几个店"）。
      if (/E_OUT_OF_SCOPE/.test(String(e?.message || ''))) {
        skipped.push({ run_id: Number(r.id), legal_entity_id: Number(r.legal_entity_id) });
        continue;
      }
      throw e;
    }

    for (const g of d.groups) {
      // ★ 空门店不出文件（见文件头 ③）：这里再挡一次，是因为
      //   "有人在这个组里"必须是**有工资条的人**，不能是组织树上挂着的组。
      if (!g.people.length) continue;
      let name = fileNameOf({
        period: p, entity: d.run.entity_stamp || d.run.entity_name || r.entity_name,
        orgName: g.org_name, multi,
      });
      // 撞名（两家店同名、或清洗后恰好一样）不许覆盖：加序号，并把"撞过"
      // 这件事留在结果里 —— 静默覆盖的后果是少一家店，而少一家店不报错。
      if (used.has(name)) {
        const base = name.replace(/\.html$/, '');
        let n = 2;
        while (used.has(`${base}(${n}).html`)) n++;
        name = `${base}(${n}).html`;
      }
      used.add(name);
      // ★★ 一份文件只放**这一家店**的单。
      //   html() 拿到的是 sheet() 的整个结果，里面是这一批次的**所有**门店 ——
      //   直接把 d 递进去，A店 那份文件里就印着 B店 的人（同一个包、同一批权限，
      //   但"发到店"这件事的前提就是每家店只看到自己的那张纸）。
      //   这一段第一版就写错了，是 PK1 数"签收栏份数 = 人数"时抓出来的：
      //   两份文件里各有两张单。
      const doc = {
        ...d,
        groups: [g],
        totals: { people: g.people.length, stores: 1, gross: g.gross, net: g.net },
      };
      files.push({
        name,
        org_id: g.org_id,
        org_name: g.org_name,
        legal_entity_id: d.run.legal_entity_id,
        run_id: d.run.id,
        people: g.people.length,
        html: html(doc, { perPage: per, company: d.run.entity_name }),
      });
      people += g.people.length;
    }
  }

  if (files.length === 0) {
    // 两种可能：这一期真的没有工资条（去算薪），或我的范围里一个人都没有
    // （去配权限）。错误语必须说清是哪种，否则下一个人会去改错的地方。
    throw bizErr('E_PACK_EMPTY',
      `${p} 在你的数据范围内没有任何有工资条的门店（${skipped.length} 个批次因超出法人范围被跳过）`);
  }

  const zip = makeZip(files.map((f) => ({
    name: f.name, data: Buffer.from(f.html, 'utf8'),
  })));

  return {
    period: p,
    per,
    zip,
    // files 只回元信息（不回 HTML）：它是给人核对"包里到底有哪几张"的，
    // 也是断言的抓手 —— 文件数必须等于门店数，空门店不产生空文件。
    files: files.map(({ html: _html, ...rest }) => rest),
    stores: files.length,
    people,
    runs: runs.length,
    skipped_runs: skipped,
  };
}
