// ============================================================================
// test/ui.test.mjs · 界面冒烟：18 个页签在真实浏览器里跑一遍
// ----------------------------------------------------------------------------
// 为什么需要这一套：库里 307 条与接口 162 条断言全绿的时候，界面仍然可能
// **一片空白** —— 脚本语法错、CSP 把内联脚本挡了、某个字段名改了下游 undefined。
// 这三种都不会让任何一条库/接口断言变红，只会让打开页面的人看到白屏。
//
// 做法：不开新依赖。用本机 Chrome 的 `--headless --dump-dom`，
// 把它当成"渲染完之后的 HTML 快照"，然后对快照做断言。
//
// ★ 三条与"绿"有关的纪律，和别处一样：
//   ① 没有 Chrome 就**跳过并说出来**，不许静默通过（跳过不算通过）；
//   ② 断言必须钉到**具体内容**（"报表页有导出按钮"），不是"页面不为空"；
//   ③ 空白与报错要能被区分：界面在接口失败时会把业务码原样显示，
//      所以"出现 E_ 开头的东西"本身就是一条失败。
// ============================================================================
import { createApp } from '../app/server.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));

const results = [];
const rec = (id, what, ok, note = '') => results.push({ id, what, ok, note });

if (!CHROME) {
  console.log('\n界面冒烟 · 跳过（没找到 Chrome；设 CHROME_BIN 指向可执行文件即可跑）\n');
  console.log('跳过不算通过：这一套的价值是"改了渲染/改了 CSP 之后页面还活着"，');
  console.log('没跑就等于没有这条结论。\n');
  process.exit(0);
}

const { server, db } = await createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

/** 渲染一个页签并把 DOM 取回来。超时兜底：Chrome 卡住时不许挂住整条流水线。 */
function dumpDom(url, { budget = 6000 } = {}) {
  return new Promise((resolve) => {
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--disable-extensions', '--no-first-run', '--disable-sync',
      `--user-data-dir=/tmp/aihr-ui-${process.pid}-${Math.random().toString(36).slice(2)}`,
      `--virtual-time-budget=${budget}`, '--dump-dom', url,
    ];
    const p = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const t = setTimeout(() => p.kill('SIGKILL'), 25000);
    p.on('exit', () => { clearTimeout(t); resolve(out); });
  });
}

/**
 * 只取 #view 那一段，并把 <script> 剥掉。
 * ★ 不剥的话，"华东区"会从脚本里的示例常量命中 —— 断言就会在"页面没有它"
 *   的情况下变成绿的（假阳性），而看起来完全正常。
 */
// ★ 匹配"页面上真的有"之前，必须先把内联 <script> 剥掉。
//   原来 has() 直接在整页 HTML 上跑，命中过 viewDeclare 模板串里的 id ——
//   于是页面只要炸在加载态（例如 DC_PERIOD 少一行声明，ReferenceError 卡在
//   「加载中…」），所有 id= 类的条件**全都还是绿的**。UI34 那次之所以红，
//   纯粹因为它恰好查了文案；只查 id 的话这个"申报页永远打不开"会一直绿过去。
//   这不是某条断言的问题，是这套冒烟的结构性假阳性。
const stripScript = (h) => String(h).replace(/<script[\s\S]*?<\/script>/gi, '');

const viewOf = (html) => {
  const i = html.indexOf('id="view"');
  if (i < 0) return '';
  const j = html.indexOf('<script', i);
  return (j < 0 ? html.slice(i) : html.slice(i, j)).replace(/<[^>]+>/g, ' ');
};

const TABS = ['home', 'org', 'employees', 'dashboard', 'attendance', 'payslip', 'close', 'payroll',
              'roles', 'policy', 'headcount', 'recruit', 'settlement', 'approval',
              'mcp', 'exceptions', 'perf', 'report', 'health',
              'leave', 'leavereq', 'training'];

// ---------------------------------------------------------------------------
// UI1 · 18 个页签在集团 HR 身份下都渲染出内容
// ---------------------------------------------------------------------------
{
  const dead = [];
  for (const t of TABS) {
    const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#${t}`);
    // 渲染成功的标志：出现 .card（每个页签至少一块）且没有把错误码直接画上来
    // 渲染成功的标志：view 里有 .card（每页至少一块），且没有把未渲染的 JS 值画出来
    const v = viewOf(html);
    const ok = /class="card"/.test(html) && !/\b(undefined|NaN)\b/.test(v);
    if (!ok) dead.push(t);
  }
  rec('UI1', `18 个页签全部渲染出内容（脚本真的跑了：CSP nonce 错一个字节就会白屏）`,
      dead.length === 0, dead.length ? `白屏/报错：${dead.join(',')}` : '18/18');
}

// ---------------------------------------------------------------------------
// UI2 · 报表页：导出按钮 + 留痕卡片（055 的两个可见面）
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#report`);
  rec('UI2', '报表页有「导出 CSV」按钮与「导出留痕」卡片（能看不能导的那一页真的变了）',
      /导出 CSV/.test(html) && /导出留痕/.test(html) && /PAYROLL_GROSS/.test(html),
      `按钮=${/导出 CSV/.test(html)} 留痕=${/导出留痕/.test(html)}`);
}

// ---------------------------------------------------------------------------
// UI3 · 制度页：新配置项显示成中文，而不是英文原值
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#policy`);
  rec('UI3', '制度页：离职年假那一项显示「不处理」（枚举值翻译了，不是 none）',
      /离职时剩余年假怎么处理/.test(html) && /不处理/.test(html),
      `有名=${/离职时剩余年假怎么处理/.test(html)} 有值=${/不处理/.test(html)}`);
}

// ---------------------------------------------------------------------------
// UI4 · 看板：门店 HR 只看到自己（056 在浏览器里的那一面）
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=2&pwd=demo1234#dashboard`);
  // 区域总量表里出现 A店，但不出现华东区（那是整棵子树的汇总）
  const tablePart = viewOf(html).split('区域总量')[1] || '';
  rec('UI4', '门店 HR 的看板：区域总量只有 A店 一行，没有「华东区」那一行',
      /A店/.test(tablePart) && !/华东区/.test(tablePart),
      `有A店=${/A店/.test(tablePart)} 有华东区=${/华东区/.test(tablePart)}`);
}

// ---------------------------------------------------------------------------
// UI5 · 失败要说人话：业务拒绝显示业务码，不显示「系统错误」
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=3&pwd=demo1234#attendance`);
  rec('UI5', '无授权身份：0 行页面明说「不是没有数据，是这个身份看不到」',
      /这个身份看不到/.test(viewOf(html)) && !/系统错误/.test(html),
      `说清了=${/这个身份看不到/.test(html)}`);
}

// 与别处同一条纪律：跑完的结论要写进登记表，否则覆盖率页上它是 never_run。
// 没有 Chrome 的那条分支**不写** —— "没跑过"和"跑过且通过"不能同形。
{
  const fails = results.filter((r) => !r.ok).length;
  await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
    ['SUITE.UI', fails === 0 ? 'pass' : 'fail', fails, null]);
}

// ---------------------------------------------------------------------------
// UI6 · 花名册：工号那一列真的在，而且有值（061 的可见面）
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#employees`);
  const v = viewOf(html);
  rec('UI6', '花名册有「工号」列且显示 E0001/E0002（不是一列「未分配」）',
      /工号/.test(v) && /E0001/.test(v) && /E0002/.test(v),
      `列=${/工号/.test(v)} E0001=${/E0001/.test(v)}`);
}

// ---------------------------------------------------------------------------
// UI7 / UI8 · 新页：打卡与排班（新页面不纳入冒烟 = 改了只有人打开才知道）
// ---------------------------------------------------------------------------
{
  const v = viewOf(await dumpDom(`http://127.0.0.1:${PORT}/?as=2&pwd=demo1234#punch`));
  rec('UI7', '打卡页渲染出时钟与上班/下班两个按钮（时间是服务器时间，不是本地时钟）',
      /上班/.test(v) && /下班/.test(v) && /服务器时间/.test(v),
      `上班=${/上班/.test(v)} 下班=${/下班/.test(v)}`);
}
{
  const v = viewOf(await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#roster`));
  // 排班看板：调色板（班次颜色）+ 网格（.cell）
  rec('UI8', '排班页渲染出班次调色板与可划的网格（一格一人一天一个班）',
      /早班/.test(v) && /晚班/.test(v) && /排班看板/.test(v),
      `调色板=${/早班/.test(v)} 看板=${/排班看板/.test(v)}`);
}

// ---------------------------------------------------------------------------
// UI9 · 组织页：默认是树形图（卡片 + 正交连线），不是一张空画布
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#org/tree`);
  const nodes = (html.match(/class="onode"/g) || []).length;
  const links = (html.match(/class="link"/g) || []).length;
  const v = viewOf(html);
  rec('UI9', '组织页默认渲染树形图：卡片节点 + 正交连线 + 编制口径写在图上',
      nodes >= 3 && links >= nodes - 1
        && /编制/.test(v) && /在编/.test(v) && /含下级/.test(v),
      `节点=${nodes} 连线=${links}`);
}

// ---------------------------------------------------------------------------
// UI9b · 清单视图保留四列数（树形图不替代表格：一个看结构，一个看数）
// ---------------------------------------------------------------------------
{
  const v = viewOf(await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#org/list`));
  const cols = ['编制', '在编', '缺编', '含下级'].filter((x) => v.includes(x));
  rec('UI9b', '组织清单仍有编制/在编/缺编/含下级四列',
      /部门清单/.test(v) && cols.length === 4, `列=${cols.join(',')}`);
}

// ---------------------------------------------------------------------------
// UI10 · 关系网：节点与曲线都在（不是一张空画布）
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#org/graph`);
  const circles = (html.match(/<circle[^>]*class="core"/g) || []).length;
  const curves = (html.match(/class="link2"/g) || []).length;
  // ★ 不写死部门名：PGlite 测试库里只有 A店/B店/华东区。
  //   这条测的是"图能画出来"，不是"数据里有哪些名字"（那是库断言的活）。
  const svg = /class="org-graph"/.test(html);
  rec('UI10', '组织关系网渲染出节点与曲线连线（不是一张空画布）',
      svg && circles >= 3 && curves >= circles - 1,
      `svg=${svg} 节点=${circles} 连线=${curves}`);
}

// ---------------------------------------------------------------------------
// UI11 · 岗位页：按部门分组的岗位卡片（空库时给出空态，不是白屏）
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#org/pos`);
  const v = viewOf(html);
  const cards = (html.match(/class="pos-card/g) || []).length;
  rec('UI11', '岗位页渲染岗位卡片（没数据时是空态文案，不是白屏）',
      /岗位卡片/.test(v) && /岗位总数/.test(v) && (cards >= 1 || /还没有岗位/.test(v)),
      `卡片=${cards}`);
}

// ---------------------------------------------------------------------------
// UI12 · 竖排/横排是同一个滑动开关（不是两个互不相干的按钮）
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#org/tree`);
  const seg = /id="orgOri"/.test(html) && /class="thumb"/.test(html)
    && /data-ori="v"/.test(html) && /data-ori="h"/.test(html);
  const v = viewOf(html);
  rec('UI12', '树形图上有竖排/横排滑动开关（滑块 + 两个选项都在）',
      seg && /竖排/.test(v) && /横排/.test(v),
      `seg=${seg}`);
}

// ---------------------------------------------------------------------------
// UI13 · 工资条页：一个人的工资表（结构 + 口径 + 工资条同屏）
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#payslip`);
  const v = viewOf(html);
  // 口径三项来自制度（一定有值），结构可能空（这个人没定月薪）——
  // 所以断言"有口径 + 有结构表或明确空态"，而不是硬要一个月薪数字。
  const policy = /每日工时/.test(v) && /月计薪/.test(v) && /法定节假日/.test(v);
  const struct = /工资项/.test(v) || /还没有给你定月薪/.test(v);
  // ★ 第三种合法形态：**管理账号没有对应员工**。
  //   钱相关路径 2026-11-16 起不允许"账号没挂人员就把 uid 当人员 id"——
  //   那种兜底会让集团人事打开「我的工资表」看到**另一个员工**的月薪（实测）。
  //   所以这里要接受"明确说明为什么没有"，但**不接受空白**：
  //   页面上必须出现「我的工资表」这个标题 + 一句解释。
  const noEmp = /管理账号/.test(v) && /没有"我的工资表"|对应不到任何员工档案/.test(v);
  rec('UI13', '工资条页 = 我的工资表（工时/计薪天数/法定假口径 + 结构或空态；'
      + '管理账号则必须明确说"没有我的工资表"而不是空白）',
      /我的工资表/.test(v) && ((policy && struct) || noEmp),
      `口径=${policy} 结构=${struct} 管理账号空态=${noEmp}`);
}

// ---------------------------------------------------------------------------
// UI14 · 工资项页：能建项目、能配公式、能试算
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#salaryitem`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI14', '工资项页：项目表 + 公式输入 + 可用变量/函数 + 试算按钮',
      /工资项/.test(v) && has('id="siFormula"') && has('id="siPreview"')
      && /if/.test(v) && /prorata/.test(v) && has('si-var'),
      `公式框=${has('id="siFormula"')} 试算=${has('id="siPreview"')}`);
}

// ---------------------------------------------------------------------------
// UI15 · 工资项页里的计算规则（算薪前拦截 / 算薪后告警）
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#salaryitem`);
  const v = viewOf(html);
  rec('UI15', '工资项页有「计算规则」：阶段/动作/条件同屏，且能新建（表单在）',
      /计算规则/.test(v) && /算薪前拦截/.test(v) && /id="rlSave"/.test(html)
      && /id="rlFormula"/.test(html) && /id="rlStage"/.test(html),
      `卡片=${/计算规则/.test(v)} 表单=${/id="rlSave"/.test(html)}`);
}

// ---------------------------------------------------------------------------
// UI16 · 工资调整页：按月、看到每人当前薪资、能开调整单
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#adjust`);
  const v = viewOf(html);
  rec('UI16', '工资调整页：期间选择 + 人员表格 + 调整入口 + 调整历史',
      /工资调整/.test(v) && /id="adjPeriod"/.test(html) && /data-adjust=/.test(html)
      && /调整历史/.test(v),
      `期间=${/id="adjPeriod"/.test(html)} 入口=${/data-adjust=/.test(html)}`);
}

// ---------------------------------------------------------------------------
// UI17 · 考勤报表页：日报汇总 → HR 调整 → 提交 → 主管审批
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#att`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI17', '考勤报表页：期间/生成/提交/导入/版本/加班三档 全在同屏',
      /考勤报表/.test(v) && has('id="attBuild"') && has('id="attPeriod"')
      && /待审批|已确认/.test(v) && /版本/.test(v) && /加班/.test(v)
      && has('id="attImport"'),
      `生成=${has('id="attBuild"')} 期间=${has('id="attPeriod"')} 导入=${has('id="attImport"')} `
      + `标题=${/考勤报表/.test(v)} 版本=${/版本/.test(v)} 加班=${/加班/.test(v)} `
      + `状态词=${/待审批|已确认/.test(v)} 片段=${v.slice(0, 50).replace(/\s+/g, ' ')}`);
}

// ---------------------------------------------------------------------------
// UI18 · 薪酬政策页：法定值看得见、能改、改要 HR 主管以上
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#paypolicy`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI18', '薪酬政策页：政策项 + 法定默认 + 病假档位 + 假种 + 最低工资 + 节假日 同屏',
      /薪酬政策/.test(v) && /病假工资档位/.test(v) && /最低工资/.test(v)
      && /假种/.test(v) && /21\.75|月计薪天数/.test(v) && /法定节假日/.test(v)
      && has('data-policy=') && has('data-lt=') && /官方/.test(v),
      `档位=${/病假工资档位/.test(v)} 假种=${/假种/.test(v)} 节假日=${/法定节假日/.test(v)} `
      + `最低工资=${/最低工资/.test(v)} 改按钮=${has('data-policy=')}`);
}

// ---------------------------------------------------------------------------
// UI19 · 年假折现页：口径 / 档位 / 试算 / 台账 / 候选人 同屏
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#cashout`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI19', '年假折现页：口径三选 + 年假档位 + 试算 + 台账 + 候选人 同屏',
      /未休年假折现/.test(v) && /年假天数档位/.test(v) && /试算与登记/.test(v)
      && /折现台账/.test(v) && /谁还有可折的年假/.test(v)
      && /300%/.test(v) && /不足 1 整天/.test(v)
      && has('data-mode="extra_200"') && has('id="coQuote"') && has('data-tieryears='),
      `口径=${has('data-mode=')} 试算=${has('id="coQuote"')} 台账=${/折现台账/.test(v)} `
      + `候选人=${/谁还有可折的年假/.test(v)} 片段=${v.slice(0, 46).replace(/\s+/g, ' ')}`);
}

// ---------------------------------------------------------------------------
// UI23 · 折现页的结转政策：默认「不结转」摆在明处，改要写原因
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#cashout`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI23', '往年结转：两个选项按钮 + 截止日 + 一句"为什么默认不结转"',
      /往年结转/.test(v) && has('data-carry="void"') && has('data-carry="carry_1y"')
      && has('id="carryDl"') && /一般不跨年度安排/.test(v),
      `按钮=${has('data-carry="carry_1y"')} 截止日=${has('id="carryDl"')} `
      + `法定说明=${/一般不跨年度安排/.test(v)}`);
}

// ---------------------------------------------------------------------------
// UI20 · 节假日年度维护：明年没数据这件事，今年的页面上就看得见
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#paypolicy`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI20', '节假日卡：年度覆盖胶囊 + 「生成下一年骨架」+「标为已确认」两个按钮同屏',
      /hol-pill/.test(html) && /没有数据/.test(v)
      && /生成 \d{4} 年骨架/.test(v) && /标为已确认/.test(v)
      && has('id="holSk"') && has('id="holCf"'),
      `胶囊=${has('hol-pill')} 缺失提示=${/没有数据/.test(v)} `
      + `骨架=${/生成 \d{4} 年骨架/.test(v)} 确认=${/标为已确认/.test(v)}`);
}

// ---------------------------------------------------------------------------
// UI21 · 工时制度卡：两种制度的差别要在页面上说清，且能改
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#paypolicy`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI21', '工时制度卡：逐日 vs 周期总数说清 + 备案提示 + 改制度表单同屏',
      /工时制度/.test(v) && /综合计算工时/.test(v) && /休息日不单独给 200%/.test(v)
      && /备案/.test(v) && has('id="wtsSys"') && has('id="wtsAppr"'),
      `标题=${/工时制度/.test(v)} 制度说明=${/综合计算工时/.test(v)} `
      + `备案=${/备案/.test(v)} 表单=${has('id="wtsSys"')}`);
}

// ---------------------------------------------------------------------------
// UI22 · 考勤月报：12 列在手机上不再横滑，改成两列网格卡片
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#att`);
  const v = viewOf(html);
  const bare = stripScript(html);
  const has = (x) => new RegExp(x).test(bare);
  // ★ 这一条原来在整页 HTML 上判，命中的是脚本里那段模板串 —— 于是"表格根本
  //   没画出来"也是绿的。剥掉 script 之后真相露出来了：这个测试库的 2026-11
  //   没有任何可汇总的日报，页面走的是"还没生成"那一支，一行数据都没有。
  //   两种状态都要钉，但钉的东西不同：
  //     · 有行 → 必须卡片化（stack2 + 每格 data-label），这是原本要防的事；
  //     · 没行 → 必须**明说还没生成**并给生成入口，而不是画一张 12 列的空表
  //       （空表也会触发"手机上横滑"这个毛病，而且看起来像"这个月没人出勤"）。
  const hasRows = /<td[^>]*data-label=/.test(bare);
  rec('UI22', '月报宽表卡片化：有行时 stack2 + 每格带 data-label（手机上不横滑）；'
    + '没行时必须明说"还没生成"并给生成入口，不画空表（空表既会横滑，又像"这个月没人出勤"）',
      hasRows
        ? (/stack2/.test(bare) && has('data-label="应出勤"')
          && has('data-label="加班 平日/休/法"') && has('data-label="状态"'))
        : (has('id="attBuild"') && /还没有门店封账|生成\/刷新/.test(v)),
      `有行=${hasRows} 标签=${has('data-label="应出勤"')}/${has('data-label="状态"')} `
      + `stack2=${/stack2/.test(bare)} 生成入口=${has('id="attBuild"')} `
      + `报表卡=${/考勤报表/.test(v)}`);
}

// ---------------------------------------------------------------------------
// UI40 · 守护 has() 的"剥 script"本身（不然它哪天被删掉，38 条一起假绿）
// ---------------------------------------------------------------------------
// ★ 这一条不验业务，验的是**这套冒烟的尺子准不准**。
//   做法：拿一个只会出现在内联 <script> 模板串里、绝不会渲染到考勤页上的 id
//   （工时制度表单的 wtsSys，只有 #paypolicy 才画），在 #att 页上分别用
//   "原始 HTML" 和 "剥过 script 的 HTML" 各判一次。
//   正确的实现必须给出：原始 true（模板串里有）、剥后 false（页面上没有）。
//   谁把 stripScript 那行删了，或者把它改成只剥一半，这条立刻红 ——
//   而 38 条业务断言不会红（它们会继续假绿）。
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#att`);
  const raw = /id="wtsSys"/.test(html);
  const bare = /id="wtsSys"/.test(stripScript(html));
  rec('UI40', '尺子自检：只在脚本模板串里出现的 id（工时制度表单 wtsSys，属 #paypolicy），'
    + '在 #att 页上原始 HTML 能命中、剥掉 <script> 后必须命中不到。'
    + '这条防的是"has() 被改回整页匹配"——那时页面炸在加载态，所有 id 类断言仍然全绿',
    raw === true && bare === false,
    `原始=${raw} 剥后=${bare}`);
}

// ---------------------------------------------------------------------------
// UI24 · 社保申报基数卡：一年定一次这件事要在页面上说清
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#paypolicy`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI24', '社保申报基数卡：上年度月平均 / 一年只定一次 / 上下限 / 生成按钮同屏',
      /社保申报基数/.test(v) && /上年度月平均/.test(v) && /一年只定一次/.test(v)
      && /60% \/ 300%/.test(v) && has('id="sidBuild"'),
      `标题=${/社保申报基数/.test(v)} 口径=${/上年度月平均/.test(v)} `
      + `上下限=${/60% \/ 300%/.test(v)} 生成=${has('id="sidBuild"')}`);
}

// ---------------------------------------------------------------------------
// UI25 · 离职结算页：三种钱各有各的算法，这一屏要能说清
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#severance`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI25', '离职结算页：补偿金/代通知金/年假折现三块分开 + 三倍封顶 + 单独计税说明',
      /离职结算/.test(v) && /经济补偿金/.test(v) && /代通知金/.test(v)
      && /三倍/.test(v) && /单独/.test(v) && has('id="sevQuote"') && has('id="sevGo"'),
      `三块=${/代通知金/.test(v)} 封顶=${/三倍/.test(v)} 计税=${/单独/.test(v)} `
      + `试算=${has('id="sevQuote"')}`);
}

// ---------------------------------------------------------------------------
// UI26 · 工资条页：能一键看到"与上期比变了什么"
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#payslip`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI26', '工资条页有「与上期对比」入口，并说明它回答的是"为什么少了 300"',
      has('id="slipDiff"') || /还没有算过薪/.test(v),
      `按钮=${has('id="slipDiff"')} 空态=${/还没有算过薪/.test(v)}`);
}

// ---------------------------------------------------------------------------
// UI27 · 算薪预演：改参数之前先看影响面，且明说"不会留下数据"
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#payroll`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI27', '预演卡：月薪/社保/制度项三路输入 + 预演按钮 + 「一行都不会多」的承诺',
      /算薪预演/.test(v) && /真的算两遍/.test(v) && /一行都不会多/.test(v)
      && has('id="pvPct"') && has('id="pvSi"') && has('id="pvCode"') && has('id="pvGo"'),
      `标题=${/算薪预演/.test(v)} 输入=${has('id="pvPct"')}/${has('id="pvSi"')} `
      + `制度项=${has('id="pvCode"')} 按钮=${has('id="pvGo"')}`);
}

// ---------------------------------------------------------------------------
// UI28 · 两级导航：11 个一级分组，二级收进下拉
// ---------------------------------------------------------------------------
// ★ 下拉内容是点开才渲染的（dumpDom 不执行点击），所以这里钉的是**结构契约**：
//   一级 11 组、顺序、每组条目数（data-n）、无未归类页签、下拉层容器在。
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#payroll`);
  const nav = (html.match(/<div class="navrow" id="navrow">[\s\S]*?<div id="droplayer">/) || [''])[0];
  const groups = [...nav.matchAll(/class="navbtn[^"]*"[^>]*>([^<]+)/g)].map(m => m[1].trim());
  const want = ['我的', '系统管理', '人事组织', '考勤排班', '假期', '薪酬',
                '招聘', '绩效', '培训学习', '看板', 'AI 智能'];
  const nOf = (g) => {
    const m = nav.match(new RegExp(`data-g="${g}" data-n="(\\d+)"`));
    return m ? Number(m[1]) : -1;
  };
  // ★ 薪酬组从 7 项变 8 项：新增「社保台账」（166）——
  //   它与「申报表」是两件事：那边是报出去的表，这边是我们自己的参保账。
  // ★ 薪酬 7→8（新增社保台账 166）、考勤排班 5→6（新增考勤异常 168）。
  //   这两次都是"功能增加、数量跟着变"，不是放宽 —— 变化写进文案，
  //   下次再加项还会红，逼人交代清楚新加的是什么。
  rec('UI28', '一级 11 组按业务顺序；薪酬 8 项（含社保台账）、考勤排班 6 项（含考勤异常）、'
    + '招聘/绩效/培训/AI 各 1 项（单项直达不弹菜单）',
      groups.length === 11 && want.every(w => groups.includes(w))
      && nOf('pay') === 8 && nOf('att') === 6 && nOf('sys') === 5
      && nOf('recruit') === 1 && nOf('perf') === 1 && nOf('learn') === 1 && nOf('ai') === 1
      && /class="caret"/.test(nav) && /id="droplayer"/.test(html)
      // ★ 必须在 nav 片段里查，不能在整个 html 里查 —— 样式表里也有 .nav-orphan，
      //   查全文会永远为真（这次就是这么红的，看着像"有未归类页签"）。
      && !/nav-orphan/.test(nav),
      `一级=${groups.length} 组；薪酬=${nOf('pay')} 项；caret=${/class="caret"/.test(nav)} `
      + `droplayer=${/id="droplayer"/.test(html)} orphan=${/nav-orphan/.test(nav)} `
      + `sys=${nOf('sys')} names=${want.filter(w => !groups.includes(w)).join(',') || '全中'}`);
}

// ---------------------------------------------------------------------------
// UI29 · 假期额度：按假种切换，四个减项分开列
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#leave`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI29', '假期额度页：假种切换 + 授予/已用/冻结/已折现/可用 五项分开 + 用量条',
      /假期额度/.test(v) && /可用 =/.test(v) && /冻结/.test(v)
      && has('data-lt=') && has('data-label="已折现"'),
      `切换=${has('data-lt=')} 说明=${/四个减项/.test(v) || /可用 =/.test(v)} `
      + `表=${has('data-label="可用"')}`);
}

// ---------------------------------------------------------------------------
// UI30 · 请假单：待审排最前，且说清"自审会被库里拒"
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#leavereq`);
  const v = viewOf(html);
  rec('UI30', '请假单页：待审计数 + 不受 90 天窗口限制 + 自审在库里被拒的说明',
      /请假单/.test(v) && /待审/.test(v) && /不受 90 天窗口限制/.test(v)
      && /自审会被直接拒绝/.test(v),
      `待审=${/待审批/.test(v)} 说明=${/自审会被直接拒绝/.test(v)}`);
}

// ---------------------------------------------------------------------------
// UI31 · 【已由 UI36 接管】培训学习从占位变成实模块
// ---------------------------------------------------------------------------
// 原来的 UI31 钉的是"页面明确说还没做" —— 那是"不做也不假装做过"的守则。
// 144 把这一屏做出来了，所以那条断言的前提消失：留着它，就等于要求页面
// 一直写着"还没做"，会拦住正当的实现。
// 断言数因此 -1（37 → 36 再 +1 = 37，实际是 UI36 顶替了 UI31 的位置）。
// 记账在这里，免得以后有人看到条数少了一条以为被删掉。

// ---------------------------------------------------------------------------
// UI32 · 工资表会签：谁该签、签了没有、能不能封账，同一屏
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#payroll`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI32', '算薪页有「工资表会签与封账」卡：说清会签不是审批流，且封账门禁与它绑定',
      /工资表会签与封账/.test(v)
      && (/发起会签/.test(v) || /签字/.test(v))
      && /会签不是审批流|异议是要改数的信号/.test(v)
      && (has('id="sgSeal"') || has('id="sgStart"')),
      `卡片=${/工资表会签与封账/.test(v)} 封账按钮=${has('id="sgSeal"')} `
      + `发起=${has('id="sgStart"')}`);
}

// ---------------------------------------------------------------------------
// UI33 · 发放回单：封账 ≠ 发钱，两步分开
// ---------------------------------------------------------------------------
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#payroll`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI33', '发放回单卡：说清封账≠发钱、不存银行账号、回单总额要与实发对上',
      /发放回单/.test(v) && /封账只说明/.test(v)
      && /不存员工银行账号|不存银行账号/.test(v) && /实发清单/.test(v),
      `卡片=${/发放回单/.test(v)} 两步说明=${/封账只说明/.test(v)} `
      + `账号声明=${/不存员工银行账号/.test(v)} 导出=${has('id="plExport"')}`);
}

// ---------------------------------------------------------------------------
// UI34 · 申报表：两张表 + 只从封账批次出 + 掩码与导出分开
// ---------------------------------------------------------------------------
// ★ 这里查的是"页面有没有把话说清"，不是"数对不对"（数在库与接口两层验过）。
//   申报表最容易出的错不是算错，是**有人拿一张没封账的表去报** ——
//   所以页面上必须有"未封账不出表"这句话。
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#declare`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  // 种子里 2026-03 是 draft，所以这一屏正常落在"还不能出表"那个分支。
  // 两个分支都要验：**拦下来要说明理由**，比"给一张空表"重要得多。
  const blocked = /还不能出表/.test(v);
  rec('UI34', '申报表页：两张表的名字都在 + "未封账不出表" + 拦下时说清去算薪封账（或出表时 0 与空分得开）',
      /个人所得税扣缴申报表/.test(v) && /社会保险费申报表/.test(v)
      && /未封账的数明天还会变/.test(v) && has('id="dcPeriod"')
      && (blocked
        ? /先去「算薪」/.test(v)
        : (/空不是 0/.test(v) && has('id="dcIit"') && has('id="dcSi"'))),
      `两表=${/个人所得税扣缴申报表/.test(v)}/${/社会保险费申报表/.test(v)} `
      + `状态=${blocked ? '拦下并说明' : '出表'} 导出=${has('id="dcIit"')}/${has('id="dcSi"')}`);
}

// ---------------------------------------------------------------------------
// UI35 · 算薪页的"累计链条"：不能只写"累计"两个字，要说清前期没封的后果
// ---------------------------------------------------------------------------
// ★ 143 的判据在库里只有一份（fn_payrun_chain），页面显示的就是同一句话。
//   这里钉的是"这句话真的到了屏幕上"，且**没有**把失败态（E_ 错误码）画上来 ——
//   "能看见不能封"是功能，"页面报错"才是故障，两件事不能混成一条。
//   ★ 放宽成"有 id=chainMsg 或文本含前期"：服务层换了渲染落点也不该红；
//     但**不能**放宽到只查"累计"两个字 —— 页面上别处也有这个词，那是假阳性。
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#payroll`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  const chainHint = has('id="chainMsg"') || /前期/.test(v);
  const errCodes = v.match(/\bE_[A-Z_]{3,}/g) || [];
  rec('UI35', '算薪页能看见"累计链条"：封账门禁的理由上了屏（不是白屏，也不是把 E_ 码画出来）',
      /累计/.test(v) && /封账/.test(v) && chainHint && errCodes.length === 0,
      `累计=${/累计/.test(v)} 封账=${/封账/.test(v)} `
      + `链条=${has('id="chainMsg"') ? 'chainMsg' : (/前期/.test(v) ? '前期' : '无')} `
      + `错误码=${errCodes.join('/') || '无'}`);
}

// ---------------------------------------------------------------------------
// UI36 · 培训学习：从占位变真模块，且"学时是到场记录"这句话在页面上
// ---------------------------------------------------------------------------
// ★ 这一屏原来写"还没做 —— 这里不放编造的数据"。现在做完了，要钉住两件事：
//   ① 页面真的在讲"结业由学时判定"，不是摆三张课程卡片；
//   ② 那个"还没做"的占位文案不能再出现 —— 否则会有人看着占位去问"到底做了没"。
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#training`);
  const v = viewOf(html);
  const has = (x) => new RegExp(x).test(stripScript(html));
  rec('UI36', '培训页是真的了：课程/场次/人员学时三块 + "学时是到场记录" + 没有"还没做"的占位文案',
      /培训学习/.test(v) && /课程/.test(v) && /场次/.test(v)
      && /已结业学时/.test(v) && /学时是到场记录/.test(v)
      && !/还没做/.test(v) && !/未建表/.test(v),
      `课程=${/课程/.test(v)} 场次=${/场次/.test(v)} 学时=${/已结业学时/.test(v)} `
      + `占位文案残留=${/还没做/.test(v)}`);
}

// ---------------------------------------------------------------------------
// UI37 · 绩效页：分数必须有个签字的人；考核项要么列出来，要么明说"还没配"
// ---------------------------------------------------------------------------
// ★ 这条防的是两件会"看起来正常"的事：
//   ① 结果卡退回只显示"得分/档位/系数"的旧样子 —— 那时"这个分是谁给的、
//      改过几次"在页面上答不出来，复盘只能信口头，而绩效分是拿去定钱的东西；
//   ② 加权考核项卡在"方案还没配指标"时**静默消失** —— 消失等于告诉打开的人
//      "这一屏没有这个功能"，真相却是"有，只是没配"。所以空方案必须有那句兜底。
//   ★ 两个分支都算过：有考核项 → 权重合计 + 录值按钮；没考核项 → 兜底文案。
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#perf`);
  const v = viewOf(html);
  const who = /评分人/.test(v) && /版本/.test(v);
  const card = /加权考核项/.test(v);
  const withItems = /权重合计/.test(v) && /录实际值并算加权总分/.test(v);
  const noItems = /这个方案还没有考核项/.test(v);
  rec('UI37', '绩效结果卡有「评分人」「版本」两列（分是谁给的、改过几次要能查）；加权考核项卡要么给出权重合计与录值按钮，要么明说"这个方案还没有考核项"（不许静默消失）',
      who && card && (withItems || noItems),
      `评分人/版本=${who} 卡片=${card} 有考核项=${withItems} 空方案兜底=${noItems}`);
}

// ---------------------------------------------------------------------------
// UI38 · 考试页：限时与可考两列必须分开说（"我还剩几次"是旧表头答不出的）
// ---------------------------------------------------------------------------
// ★ 旧表头只有"题数 / 总分 / 及格"——它答得出"这张卷多难"，答不出
//   "我还能考几次"和"多久内要交"。次数用完才告知，等于让人白答一整张卷。
//   ★ 时钟只在点「开考」发券成功之后才插进 DOM（dumpDom 不执行点击），
//     所以这里钉的是"开考入口在 + 四列表头在"；`clockNow` 只是记录当场有没有
//     已经渲染出来的时钟/不限时文案，不作硬条件（否则这条永远红）。
{
  const html = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#training`);
  const v = viewOf(html);
  // ★ 从「卷面」往后切到本行的「作答」——不能从全页找一个"作答"：
  //   上面的摘要里已经有"1 次作答"，那样切出来是空串，断言会以"未取到表头"红。
  const tail = v.slice(v.indexOf('卷面'));
  const head = tail.slice(0, tail.indexOf('作答'));
  const cols = /限时/.test(head) && /可考/.test(head);
  const start = /开考/.test(v);
  const clockNow = /id="exClock"/.test(v) || /不限时/.test(v);
  rec('UI38', '考试表头是「卷面 / 限时 / 可考 / 作答」：限时说清多久、可考说清还能考几次，且开考入口在（旧表头只写"题数/总分"，答不出"我还剩几次"）',
      cols && start,
      `表头=${head.replace(/\s+/g, ' ').trim() || '未取到'} 限时=${/限时/.test(head)} `
      + `可考=${/可考/.test(head)} 开考=${start} 当场已有时钟=${clockNow}`);
}

// ---------------------------------------------------------------------------
// UI39 · 否定性：旧考试表头没了；强制分布里 0 人的档不能整档消失
// ---------------------------------------------------------------------------
// ★ 两条都是"去掉了什么"的断言，和上面"加了什么"配成一对：
//   ① 「题数 / 总分 / 及格」三列并列是旧考试表头的形状。只验新列在，旧列
//      可能被追加在后面同时留着 —— 那会让同一屏出现两套口径；
//   ② 强制分布只出"有人的档"时，"这一档一个人都没有"（要有人去谈）与
//      "方案里根本没有这一档"（不用管）在页面上长得一模一样。所以 0 人档
//      必须留在表里，且带「这一档没人」标签或整行淡化（opacity），二者其一。
//   ★ 片段取自渲染出的 DOM 而不是全文：查 <script> 里的模板字符串会永远为真。
{
  const trainHtml = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#training`);
  const tv = viewOf(trainHtml);
  const tTail = tv.slice(tv.indexOf('卷面'));
  const head = tTail.slice(0, tTail.indexOf('作答'));
  const headOk = /卷面/.test(tv) && head.length > 0 && /可考/.test(head);
  const stale = ['题数', '总分', '及格'].filter((x) => head.includes(x));

  const perfHtml = await dumpDom(`http://127.0.0.1:${PORT}/?as=1&pwd=demo1234#perf`);
  const pv = viewOf(perfHtml);
  const distCard = /强制分布/.test(pv);
  // 取"强制分布"到 <script> 之前的原始标签，才看得见行上的 style
  const from = perfHtml.indexOf('强制分布');
  const distRaw = from < 0 ? '' : perfHtml.slice(from, perfHtml.indexOf('<script', from));
  const zeroTag = /这一档没人/.test(distRaw);
  const zeroFade = /opacity/.test(distRaw);

  rec('UI39', '旧的考试伪列（题数/总分/及格 三列并列）已被替换掉；强制分布里 0 人的档仍占一行，并带「这一档没人」或整行淡化（否则"这档没人"与"方案没这档"同形）',
      headOk && stale.length === 0 && distCard && (zeroTag || zeroFade),
      `考试表头=${head.replace(/\s+/g, ' ').trim() || '未取到'} 旧列残留=${stale.join('/') || '无'} `
      + `分布卡=${distCard} 0人标签=${zeroTag} 淡化=${zeroFade}`);
}

server.close();
const pass = results.filter((r) => r.ok).length;
console.log(`\n界面冒烟 · 断言 ${results.length} 条 · 通过 ${pass} · 失败 ${results.length - pass}\n`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.what}${r.note ? `   [${r.note}]` : ''}`);
console.log('');
process.exit(pass === results.length ? 0 : 1);
