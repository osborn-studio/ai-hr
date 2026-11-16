// ============================================================================
// tools/seed-chain.mjs · 「香香鱼米」餐饮连锁演示帐套
//                       60 家门店 / 两条品牌线 / 6 个城市 / 374 人
// ----------------------------------------------------------------------------
// 用法（空库上跑）：
//   PGLITE_DATA_DIR=./data node tools/seed-chain.mjs
//   DATABASE_URL=postgres://... node tools/seed-chain.mjs
//
// 这个库里只有**一份帐套**：香香鱼米（餐饮连锁演示帐套）。
// 用户那边另有一个「町萌网络」帐套是**真实业务**（已同步钉钉），
// 那份不归本脚本管 —— 本脚本一个字节都不会写它。
//
// ---------------------------------------------------------------------------
// 前置依赖（缺一个就灌不对，顺序见下一节）
// ---------------------------------------------------------------------------
// ① 迁移必须已经跑完。本脚本用到的、由迁移提供的东西：
//    · 126/127  假种 ANNUAL / PERSONAL / SICK（额度用 fn_leave_type_id 取，
//               **不能写死 leave_type_id 的数字** —— 它不是稳定的 identity）
//    · 142      si_policy.item 的险种键归一（pension / medical / unemployment /
//               injury / maternity）。写 `unemploy` 会被触发器归一成
//               `unemployment`，但**工资条那一行只认规范键**，所以本脚本直接用规范键。
//    · 172      station / store_station / station_position 三张档口表，
//               以及预置的 24 条档口词表（含 brand_line：cantonese / tempura …）。
//               ★ 这三张表**不在**时（172 被 revert 的库），本脚本会跳过
//                 "⑨ 档口编制"整段并打一行日志，其余数据照灌 —— 建帐不该因为
//                 某个模块没上线就跑不完。见 hasStation 那段。
//    · 022      编制 headcount_budget；064 帐套/账号；083 岗位词典。
//
// ---------------------------------------------------------------------------
// 灌库顺序（顺序错了会造出"算不出薪"的库，每一步都别跳）
// ---------------------------------------------------------------------------
// ★ 先决：**一个全新的空库**（独立的 PGLITE_DATA_DIR / database）。
//   香香鱼米不能和「町萌网络」共库 —— 068 只做到档案级多帐套，
//   业务表还没有 ledger_id（债 SUITE.MT），混在一起会把两边业务数据搅在一块。
//   本脚本的 CLI 见到"库里已经有表"会直接 exit 2，就是拦这件事。
//
//   ① 跑迁移          首启 app/server.mjs 会建表（或走 test/run.mjs 的迁移段）
//   ② 本脚本           PGLITE_DATA_DIR=... node tools/seed-chain.mjs
//                      建帐套 + 组织 + 岗位 + 人 + 编制 + 档口 + 考勤明细 + 账号
//   ③ 业务流水样例     SEED_SKIP=1 PGLITE_DATA_DIR=... node tools/seed-demo-flow.mjs
//                      （另一个脚本：审批/请假/报销这类"跑过的单据"）
//   ④ 逐店封账         POST /api/attendance/close（每店每月一次）
//                      ★ 不封账就跑算薪 → 409「本期有考勤但未封账的门店」，
//                        而且报错只说"未封账"，不说"所以工资是空的"
//   ⑤ 算薪             POST /api/payroll/run?period=2026-06&entity=1
//
//   ★ ④ 必须在 ⑤ 之前，这是 172/117 之后最容易踩的一步：算薪只吃**已封账**的
//     考勤期。本脚本故意灌"未封账"的考勤明细（真实系统上线第一天就是这个状态），
//     这样"封账"这件事在演示里也点得动。
//
// ★ 社保政策为什么要在本脚本里补（walk 走查实测出来的阻断项）：
//   si_policy 与 tax_param 的种子原来只写在 app/server.mjs 的**内置种子**里，
//   而那段种子的条件是"空库首启 且 没有 SEED_SKIP"。用 SEED_SKIP=1 + 本脚本建库时
//   它不跑，于是 si_policy 一条都没有 → 算薪必然 422 E_SI_POLICY_MISSING
//   （"上海 养老保险 在 2026-03-31 之前没有生效的政策"），工资 6 个页面全空。
//   所以本脚本自己补一份（见"①b 社保政策与个税参数"）。
//
// ---------------------------------------------------------------------------
// 这份数据不是"随便造点行"：它要能回答六个问题，否则演示时会被问住——
// ---------------------------------------------------------------------------
//   ① 60 家店、6 个城市、两条品牌线：人数 / 编制 / 工时 / 工资，能不能按门店、
//      按城市、按品牌三种口径各自加起来还对得上；
//   ② 一家商场主力店（店长 + 副店长 + 8 个档口）与一家天妇罗专门店
//      （店长 + 2 个档口，没有炒锅、没有烧腊）在组织架构图上必须长得**不一样**
//      —— 否则"餐饮连锁"只是换了个店名，档口岗位是摆着好看的；
//   ③ 有 5 家店编制未满（计划 8 人、实到 5 人）：组织架构图要能显出"缺岗 3 人"，
//      点开还要说得出**缺哪个档口**（172 的档口编制这三张表，本脚本已接上）；
//      而不是每家店都刚好满编 —— 满编的演示数据一看就是造的；
//   ④ 一个店长登录，看到的是**只有自己那家店**；店员连"查花名册"都不该有
//      （fail-closed，只有自己的工资条/请假/考勤）；
//   ⑤ 老板点"算薪"要被拦下，而且拦它的理由得站得住：**176 之后老板是
//      「全局只读」**（所有资源可读、零可写），所以拦他的是**权限** ——
//      403 E_RESOURCE_FORBIDDEN。
//      ★ 别指望 409（考勤未封账）那个理由：073 曾把老板改成"业务全权"，
//        那时拦他的是业务闸 —— 换一期没封账，他就真的算下去了，
//        而"看起来被拦住了"是最难查的形态（断言只要判 `!== 200` 就会记成绿）。
//        176 把写权限收回后，理由才是对的：**算薪归薪酬专员，老板只能看**。
//        演示讲稿里若还写着"点一下看看被拦"，说明词要换成这句；
//   ⑥ 5 名外包不占编制但出现在门店工时里；8 名兼职按小时计薪（pay_basis='hour'），
//      与 366 名月薪制的人混在同一张工资表里不出错 —— 连锁餐饮就是这两种人在一起。
//
// ---------------------------------------------------------------------------
// 规模说明（重要）
// ---------------------------------------------------------------------------
// 真实客户是 **60 家门店**，本脚本按 60 家造：PGlite 灌数据这部分约 5 秒，
// 真正的耗时是那一百多个迁移文件（约 25 秒），所以没必要缩。
// 若哪天演示机扛不住，把下面 CITIES 里的门店删到 24–30 家即可，
// 但**城市与品牌两个维度必须保留** —— 那才是"连锁"的两个维度。
//
// ---------------------------------------------------------------------------
// 命名与品牌脱敏
// ---------------------------------------------------------------------------
// 「香香鱼米」是用户指定的演示品牌词，可以用；其余一律虚构：
//   · 集团     香香鱼米餐饮集团（帐套代码 XYYM-001）
//   · 主食线   香香鱼米     —— 盖饭 / 鱼米主食，商场主力店与社区店
//   · 专门店线 白露天妇罗   —— 小而精，只做炸物，没有炒锅/烧腊（自造，非真实品牌）
// 商场名一律自造（云栖广场 / 星屿天地 / 拾光里…），**一个真实商场名都不许出现**；
// 城市用真名（深圳上海广州珠海金华义乌）是必要的：客户就是这几个城市，
// 换成"甲市乙市"演示时没人看得懂；品牌与商场才是需要脱敏的部分。
// 要改品牌名只改 BRANDS 一处即可，其余（门店名、日志、断言）全从它派生。
//
// ---------------------------------------------------------------------------
// 已知取舍与风险（读代码时抬头看这几条，别踩）
// ---------------------------------------------------------------------------
//   ① **只能在空库上跑一次**。CLI 会检查"库里还没有表"；而 seedChain() 作为函数
//      被调用两次会造出重复的编制版本（station_position 是只增不改，
//      trg_sp_append_only 会拒 UPDATE，但不会拒"再追加一版"）。
//   ② **登录只能按 id**（`POST /login?user=<id>`，参数名叫 user，收的是数字 id；
//      传 login 名会 400 E_ARG_INVALID）。id 由**创建顺序**决定，所以：
//      · 本脚本第一个建账号时是固定的：admin=1 demo=2 boss=3 hr=4 payroll=5 hrops=6，
//        店长 7–66，店员样例 67/68（建帐输出里"账号基准"那行就是答案）；
//      · 内置种子先跑过（fresh 且未 SEED_SKIP）、或别的脚本先建账号，就会整体后移。
//      验收脚本要按 id 逐个登，所以别把 id 写死在文档里 —— 读那一行。
//   ③ **人名生成上限 1600**（40 姓 × 40 名）：超过会抛"人名重复"。
//      现在 379 人，够用；真要造千人规模得加字库，而不是关掉那条断言。
//   ④ **兼职时薪的还原依赖制度项**：月薪标准 = 时薪 × 174，而 174 = 21.75 × 8
//      来自 policy PAY_DAYS_PER_MONTH / PAY_WORK_HOURS_DAY。客户改这两个数，
//      兼职的实际时薪就跟着漂 —— 这是 117 的既定口径，不是本脚本的选择。
//   ⑤ **授权生效日被抹平到 AUTH_FROM**（2026-01-01）：为了让历史 as_of 查得到人，
//      代价是"授权是什么时候给的"这段历史在演示库里看不出来。
//   ⑥ **门店路由手机号没有 verified_by**：手机号落在店长的 person_profile 上，
//      未核实 → 唯一索引不生效（007 的部分索引），行闸按字段掩码默认屏蔽。
//      演示里想看到号码，得给角色配字段权限，不是改种子。
//   ⑦ **si_policy 的城市写死 '上海'**（算薪里的 CASE 就是字面量），
//      与门店所在城市无关；跨省发薪要连那些 CASE 一起改。
//   ⑧ **兼职的工时不能给太少**：社保/公积金基数按"月薪标准"算（143:456-458），
//      小时工的月薪标准 = 时薪 × 174（4350–5220）。基数 = clamp(月薪标准, 下限, 上限)
//      （012 的 fn_si_base）——所以社保基准被 5975 的下限抬上去（4350 < 5975），
//      公积金基准则就是月薪标准本身（4350 > 2690 的下限）。个人扣缴约
//      5975×10.5% + 4350×7% = 627.38 + 304.50 = 931.88；
//      若只排两天班（8 小时、应发 200），实发会是**负 731.88 元**。
//      本脚本因此给兼职排整月晚市（88 小时），并在灌数据时**自检**一遍。
//      要改的是排班，不是把社保关掉 —— 关掉会掩盖"按申报口径缴"这条真实规则。
//      （⑪b 有一段自检：按核算薪同源的工时与扣缴算一遍，一旦为负直接抛错，
//        不静默产出负工资条。）
//   ⑨ **引用算薪行号前先看清哪一份是活的**：`fn_payroll_calc` 被逐版重写过
//      （015/087/090/094/098/099/103/105/112/117/120/128/129/133/143 各有一份），
//      只有 `143_iit_chain.sql` 那份生效。同一句 RAISE 在十几处都有，改前面的
//      版本**不生效也不报错** —— 比没有注释更难查。本脚本里的行号一律指 143。
//   ⑩ **"兼职只缴工伤"这件事系统做不到**：非全日制用工按法规只强制工伤险，但
//      `si_policy` 没有"按人豁免"这一维（143 的游标只看城市与险种）。所以演示库里的
//      兼职是按月薪标准**全额**缴社保 + 公积金，扣缴约占应发 37–42%（88 小时时）。
//      ★ 这个占比有下限，不是配置能压下去的：月薪标准 ≥ 5975（时薪 ≥ 34.34）时，
//        社保与公积金基数都等于月薪标准，占比恒为 17.5% × 174/88 ≈ **34.6%**；
//        时薪越低，5975 的社保下限吃得越重，占比越高（25 元档 42.4%）。
//        演示时别解释成"基数按月薪标准"这种半截话，说这句更挡得住追问：
//        "工时只有一半时扣缴会接近四成 —— 不是多扣，是没有因为他是兼职就漏缴。"
//      这是**能力缺口**，不是数据可以绕过的 —— 要真支持得加"参保方案"这一层，
//      别在种子里造一个例外（那样报表与申报表会各算一套）。
//   ⑪ **档口编制原来"当期精确匹配"，181 之后改成沿用了**（这条注释曾写过反的）
//      `station_position` 这里仍只写**两期**（演示业务月 2026-06 + 跑脚本当天所在月），
//      但 181 的 `fn_station_quota_effective` 会让**没有配置的月份沿用 ≤ 当期的最近一期**，
//      并返回 `status`（set / carried / unset / moved）与 `carried_from` 让页面写明"沿用 2026-06"。
//      所以切到 07/08/09/10/12 月不再是"档口编 0"，而是"沿用 2026-06 的定编"——
//      ★ **这是有意的**：沿用必须能被看出来，否则"忘了配"和"这期不需要人"在页面上长得一样。
//      ★ 沿用在**读时**发生，不回填数据行：回填会把"哪一期真配过"永久抹掉，
//        而 append-only 的表一旦回填就说不清来源。
//      ★ 旧注释里那句"`fn_hc_quota` 有回退"是错的：`022:4-11` 的 `fn_hc_quota` 是
//        `WHERE org_id = … AND period = p_period`，**精确匹配、没有回退**（`fn_hc_quota_asof`
//        才是按日期取的那种，但它是另一个函数）。所以"门店编"至今仍是当期的，
//        切到没有 budget 行的月份会显示"未定编"——那是真未定，不是 bug，但**门店编要不要也沿用**是另一个待定口径。
//   ⑫ **店员的范围是"本店"，不是"本人"**：系统目前没有 person 类权限维度
//      （`sys_perm_dim` 只有 cost_org/attendance_org/payroll_legal_entity/si_entity），
//      `tmp_scope_emp` 有人写没人读，行闸 `fn_scope_people` 只看 cost_org。
//      所以店员样例账号看到的是**本店 11 人**（金额字段靠掩码挡：net/si 掩，
//      gross 目前明文 —— 那是 `app/services/payroll.mjs` 里硬编码的字段白名单）。
//      要真"只看自己"，得加 person 维度 + 行闸 UNION tmp_scope_emp + 掩码加 gross，
//      属功能级改动；★ 注：180 之后"只看自己"已由**能力位**做出来了
//      （payroll_slips_read_all：有它看全员，没有只看自己那行），本条只剩
//      "行级范围"的历史说明，别照它去改数据。
//   ⑬ **"招城市经理"没有叶子节点可挂**（登记为债，不假装能做）：025:172-175 要求
//      招聘需求只能挂**叶子组织**。本脚本把机动放在**额度层**而不是建"城市本部"节点
//      （原因见 ② 那段注释：本部也是 dept，会把 Σ门店 算成 67/396/22），
//      于是城市永远是非叶子 → 想在系统里"招一个城市经理"，目前没有合法的挂载点。
//      真要做，正确方向是给 org_unit 加 `is_store` 之类的属性标记 + 一张"虚拟岗位节点"，
//      而不是在 dept 里混进非门店。
//   ⑭ **"可招"只是个数字，看不到机动编准备给谁**：集团可招 2 / 城市各 1 落在额度层，
//      页面上说不出"这 2 个编是给营运督导还是给财务"。演示时照实说"这是机动额度，
//      配到哪个岗要在建编时定" —— 别解释成"已经有 2 个岗位等着招"。
//
// ---------------------------------------------------------------------------
// 为什么门店人员按"档"而不是按"人头"造
// ---------------------------------------------------------------------------
// 餐饮门店的编制从来不是"这家店 8 个人"，而是"这家店要几口锅、几个砧板、
// 几个打荷"。所以人数是**档口岗位的合计**，不是先定人数再配岗位：
//   大店（商场主力店） 店长 1 + 副店长 1 + 档口 6–8
//   中店              店长 1 + 副店长 1 + 档口 3–5
//   小店 / 专门店      店长 1 + 档口 2–3（不设副店长：一个人管得过来）
// 一个店长带不带副店长，是"这家店多大"的直接体现，也是组织架构图上
// 唯一能一眼看出门店规模的东西。
// ============================================================================
import { createDb } from '../app/db.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../app/services/auth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..', 'db');

// ---- 帐套与品牌（脱敏锚点：改名字只改这里）----------------------------------
// ★ 这个库里只有一份帐套：香香鱼米（演示）。用户那边的「町萌网络」是真实业务
//   帐套（已同步钉钉），本脚本不碰它 —— 也**不能**放在同一个库里：
//   068 只做到了"档案级多帐套"（sys_ledger / org_unit / sys_account 有 ledger_id），
//   **业务表（考勤、工资条、审批、结算）还没有 ledger_id**（068 登记为债 SUITE.MT）。
//   两套帐放在一个库里，5 号店的考勤会被算进另一家的报表 —— 所以香香鱼米必须
//   独占一个库（一个 PGLITE_DATA_DIR / 一个 database）。
const GROUP = '香香鱼米餐饮集团';
const LEDGER_CODE = 'XYYM-001';
const LEDGER_NAME = '香香鱼米 演示帐套';
const EMP_NO_PREFIX = 'XX';            // 工号前缀：XX1001 起，永不复用
const BRANDS = {
  rice:    { key: 'rice',    name: '香香鱼米',   line: '主食盖饭线' },      // 主力
  tempura: { key: 'tempura', name: '白露天妇罗', line: '天妇罗专门店线' },  // 只做炸物
};

// ---- 时间锚点 ---------------------------------------------------------------
// 演示业务月定在 2026-06：帐套启用期间、编制期间、考勤明细都对齐这个月，
// 否则演示时会遇到"帐套 6 月启用、考勤在 3 月"这种一眼假的错位。
const LEDGER_START = '2026-06';
const PERIOD = '2026-06';
const PERIOD_END = '2026-06-30';       // 期间末（算薪口径一律按期末取值）
const HIRE_BASE = '2026-01';           // 开城日所在月：全员 1 月入职（见下方说明）
// 授权生效日：演示帐套是把一家**已经在跑**的公司搬进来，所以权限从开业前就算数。
// 见 mkAccount 里的说明 —— 用 CURRENT_DATE 会让任何历史 as_of 查到 0 人。
const AUTH_FROM = '2026-01-01';
const ATT_DAYS = ['2026-06-01', '2026-06-02'];              // 全职：两天明细（够看板/报表用）
// 兼职：**整月晚市**（6-01…6-22，每天 4 小时 = 88 小时）。
// ★ 为什么不像全职那样只给两天：算薪的社保基数用的是**月薪标准**（143:456-458，
//   按申报口径，不看本月实际工时），而兼职的月薪标准 = 时薪 × 174。工时只给两天
//   （8 小时 ≈ 200 元应发）时，光个人扣缴就 900 多 —— 会算出**负数实发**。
//   那不是 bug，是"按申报口径缴社保"的必然结果；而兼职的真实形态本来就是
//   "天天晚市来四个小时"，按整月排既真实、又不会在演示时给出一个负工资条。
// ★ 为什么是 4 小时而不是 4.5：非全日制用工的参考口径是"平均每日不超过 4 小时、
//   每周累计不超过 24 小时"（《劳动合同法》第 68 条）。88 小时/月 ≈ 20.3 小时/周
//   （按 4.33 周），日、周两条线都在里面 —— 演示时对方 HR 问起来，这个数是站得住的。
//   4.5 小时/日虽然周累计也只有 22.9 小时，但**日**上限已经越线，不值得为半小时留个把柄。
const ATT_DAYS_PART = Array.from({ length: 22 }, (_, i) =>
  `2026-06-${String(i + 1).padStart(2, '0')}`);
// 外包的工时（supplier_timesheet）只要三天：外包按天对账，不是按月考勤
const OUT_DAYS = ['2026-06-01', '2026-06-02', '2026-06-03'];

// 全员入职日必须早于任何要演示的 as_of（默认演示 2026-03-31 的在册人数）。
// 但又不能全公司同一天入职 —— 那一眼就是造的。所以摊在 1 月的 20 天里。
const hireDayOf = (i) => `${HIRE_BASE}-${String(5 + (i % 20)).padStart(2, '0')}`;

// ---- 岗位档案（集团统一岗位词典，code 全局唯一）-----------------------------
// ★ 为什么不 per-store：position.code 是全局唯一键，按门店建就会把同一份词典
//   复制 60 遍（S01_WOK、S02_WOK…），改一次岗位名称要改 60 行。
//   门店归属由 person_position（谁在岗）+ employee_org_assignment（人在哪家店）
//   两处表达，岗位本身是集团资产 —— 这也是客户 HR 的实际做法。
const POSITIONS = [
  { code: 'STORE_MGR',    name: '店长',           level: 1, desc: '门店第一责任人：排班、考勤确认、请假审批' },
  { code: 'STORE_DEPUTY', name: '副店长',         level: 1, desc: '大店/中店设，代店长顶班；小店不设' },
  { code: 'WOK',          name: '炒锅（炉头）',   level: 2, desc: '主食线核心档口：出餐速度决定翻台' },
  { code: 'CUTTING',      name: '砧板',           level: 2, desc: '切配：按单配菜、控损耗' },
  { code: 'ASSIST',       name: '打荷',           level: 2, desc: '递盘、装盘、传菜到窗口' },
  { code: 'WASH_VEG',     name: '水台',           level: 2, desc: '宰杀、清洗、初加工' },
  { code: 'STEAM',        name: '上什（蒸锅）',   level: 2, desc: '蒸柜、炖盅' },
  { code: 'DIM_SUM',      name: '点心（白案）',   level: 2, desc: '面点、白案；只有大店配' },
  { code: 'ROAST',        name: '烧腊',           level: 2, desc: '烧腊档：技术岗，工资带一档' },
  { code: 'FRONT',        name: '前厅服务',       level: 2, desc: '点单、上餐、巡台' },
  { code: 'CASHIER',      name: '收银',           level: 2, desc: '收银与日结对账' },
  { code: 'DISH',         name: '洗碗保洁',       level: 2, desc: '洗消与闭店清洁；门店最低一档' },
  { code: 'TEMPURA_FRY',  name: '炸物台',         level: 2, desc: '专门店线：裹粉、控油温、出餐' },
  { code: 'TEMPURA_CHEF', name: '天妇罗师傅',     level: 2, desc: '专门店线：炸场主厨，替代炒锅' },
];

// ---- 岗位 → 档口（172 的 station 词表）-------------------------------------
// 172 把"这家店有哪些档口、每个档口编几个什么岗"单独建了三张表
// （station / store_station / station_position）。岗位是集团词表，档口是
// 门店里的一口锅、一个台位 —— 两者是多对一的：炉灶档就一个，站的是炒锅。
// 店长/副店长不进档口：门店编 − Σ档口编 = 店长副店长的编，这是 172 的既定口径。
const POSITION_STATION = {
  WOK: 'WOK', CUTTING: 'CUT', ASSIST: 'GARNISH', WASH_VEG: 'SEA',
  STEAM: 'STEAM', DIM_SUM: 'DIMSUM', ROAST: 'ROAST',
  FRONT: 'FLOOR', CASHIER: 'CASHIER', DISH: 'STEWARD',
  TEMPURA_CHEF: 'TEMPURA', TEMPURA_FRY: 'FRY',
};
// 缺岗按这个顺序往档口上摊（先缺最挡出餐的岗：打荷没人，炉头就出不了菜）
const SHORTAGE_ORDER = ['ASSIST', 'FRONT', 'CASHIER', 'CUTTING', 'WASH_VEG',
  'TEMPURA_FRY', 'STEAM', 'DISH', 'WOK', 'TEMPURA_CHEF', 'ROAST', 'DIM_SUM'];

// 品牌的档口线（172 词表里的 brand_line）：主食线按粤式/港式快餐的分工，
// 专门店线只有炸物台与天妇罗台 —— 这一条也是"专门店没有炒锅"在 172 侧的落点。
const BRAND_LINE = { rice: 'cantonese', tempura: 'tempura' };

// ---- 薪资档（元/月）--------------------------------------------------------
// 档位与客户的薪资带宽一致：店长 9000–13000、副店长 7000–9000、
// 炒锅/砧板 6500–8500、打荷/水台 5000–6500、前厅 4500–6000。
// 客户没给的三档由这条逻辑推出来（注释写明，不装作是客户给的）：
//   · 上什/点心/烧腊/天妇罗师傅 走"技术档" 6200–9000：手上功夫定价，高于打荷；
//   · 收银比前厅高 300 左右：要担现金差错；
//   · 洗碗保洁 4200–5000：门店最低一档，现实就是这个数。
const BANDS = {
  STORE_MGR:    { small: [9000, 9800], mid: [9500, 11000], big: [11000, 13000] },
  STORE_DEPUTY: { small: null,         mid: [7000, 8200],  big: [8200, 9000] },
  WOK:          { '*': [6500, 8500] },
  CUTTING:      { '*': [6500, 8200] },
  STEAM:        { '*': [6200, 8000] },
  DIM_SUM:      { '*': [6000, 7800] },
  ROAST:        { '*': [6800, 8500] },
  TEMPURA_CHEF: { '*': [7000, 9000] },
  TEMPURA_FRY:  { '*': [5200, 6800] },
  ASSIST:       { '*': [5000, 6500] },
  WASH_VEG:     { '*': [5000, 6500] },
  CASHIER:      { '*': [4800, 6200] },
  FRONT:        { '*': [4500, 6000] },
  DISH:         { '*': [4200, 5000] },
};

// ---- 门店：城市 → 门店（商圈 · 商场 · 品牌 · 规模 · 缺岗人数）----------------
// 商场名全部虚构。同一个商场名在不同城市出现是**故意的**：连锁商场（云栖广场、
// 星屿天地…）在多个城市开店，是连锁餐饮最常见的开店结构。
// 同一城市里两个品牌开在同一个商场也是真的：主力店带客流，专门店吃溢出。
// 缺岗（第 5 个元素）只有 5 家店有 —— 见文件头第 ③ 条。
const CITIES = [
  { name: '深圳', stores: [   // 22：主战场
    ['南山', '云栖广场', 'rice', 'big'],
    ['福田', '星屿天地', 'rice', 'big'],
    ['宝安', '拾光里',   'rice', 'big'],
    ['龙华', '澜山广场', 'rice', 'big'],
    ['罗湖', '白鹭湾天地', 'rice', 'big'],
    ['南山', '青泊中心', 'rice', 'mid', 3],      // ← 缺岗：计划 +3
    ['福田', '柚见里',   'rice', 'mid'],
    ['宝安', '木白坊',   'rice', 'mid'],
    ['龙岗', '苔原广场', 'rice', 'mid'],
    ['龙华', '石径里',   'rice', 'mid'],
    ['光明', '青庐天地', 'rice', 'mid', 3],      // ← 缺岗：计划 +3
    ['坪山', '飞鸟天地', 'rice', 'mid'],
    ['盐田', '禾风里',   'rice', 'mid'],
    ['前海', '望舒天地', 'rice', 'mid'],
    ['南山', '长庚广场', 'rice', 'mid'],
    ['福田', '鹿鸣天地', 'rice', 'mid'],
    ['宝安', '松间里',   'rice', 'mid'],
    ['罗湖', '竹外广场', 'rice', 'small'],
    ['龙岗', '澹然里',   'rice', 'small'],
    ['南山', '云栖广场', 'tempura', 'small'],
    ['福田', '星屿天地', 'tempura', 'small'],
    ['宝安', '拾光里',   'tempura', 'small'],
  ] },
  { name: '上海', stores: [   // 18
    ['静安', '澄明广场', 'rice', 'big'],
    ['徐汇', '谷雨里',   'rice', 'big'],
    ['浦东', '惊蛰天地', 'rice', 'big'],
    ['长宁', '半夏广场', 'rice', 'big'],
    ['静安', '白露里',   'rice', 'mid'],
    ['徐汇', '霜降天地', 'rice', 'mid'],
    ['浦东', '长夏广场', 'rice', 'mid', 3],      // ← 缺岗：计划 +3
    ['黄浦', '小满里',   'rice', 'mid'],
    ['杨浦', '芒种天地', 'rice', 'mid'],
    ['闵行', '处暑广场', 'rice', 'mid'],
    ['普陀', '立秋里',   'rice', 'mid'],
    ['虹口', '寒露天地', 'rice', 'mid'],
    ['浦东', '冬至广场', 'rice', 'mid'],
    ['徐汇', '江晚中心', 'rice', 'mid'],
    ['静安', '溪云里',   'rice', 'mid'],
    ['静安', '澄明广场', 'tempura', 'small'],
    ['徐汇', '谷雨里',   'tempura', 'small'],
    ['浦东', '惊蛰天地', 'tempura', 'small'],
  ] },
  { name: '广州', stores: [   // 8
    ['天河', '疏影广场', 'rice', 'big'],
    ['越秀', '泮池天地', 'rice', 'big'],
    ['天河', '云栖广场', 'rice', 'mid'],
    ['海珠', '星屿天地', 'rice', 'mid', 3],      // ← 缺岗：计划 +3
    ['番禺', '拾光里',   'rice', 'mid'],
    ['白云', '青泊中心', 'rice', 'mid'],
    ['荔湾', '松间里',   'rice', 'small'],
    ['天河', '疏影广场', 'tempura', 'small'],
  ] },
  { name: '珠海', stores: [   // 5
    ['香洲', '澜山广场', 'rice', 'big'],
    ['香洲', '禾风里',   'rice', 'mid'],
    ['金湾', '望舒天地', 'rice', 'mid'],
    ['斗门', '竹外广场', 'rice', 'small'],
    ['香洲', '澜山广场', 'tempura', 'small'],
  ] },
  { name: '金华', stores: [   // 4
    ['婺城', '长庚广场', 'rice', 'mid'],
    ['金东', '鹿鸣天地', 'rice', 'mid'],
    ['婺城', '澹然里',   'rice', 'small'],
    ['婺城', '长庚广场', 'tempura', 'small'],
  ] },
  { name: '义乌', stores: [   // 3
    ['稠城', '苔原广场', 'rice', 'mid'],
    ['北苑', '飞鸟天地', 'rice', 'mid'],
    ['稠城', '苔原广场', 'tempura', 'small', 2],  // ← 缺岗：小门店计划 +2
  ] },
];

// ---- 档口编制：按品牌 × 规模给出的"这家店有哪些岗"-------------------------
// 大店给 4 套（6–8 个档口），中店 3 套（3–5），小店/专门店 2–3。
// 这些差异不是凑数：一家 600 平的商场店才养得起点心白案与洗碗专岗，
// 一家 40 平的社区档口就是"一口锅 + 一个前厅"。
const STAFFING = {
  rice: {
    big: [
      ['WOK', 'CUTTING', 'ASSIST', 'WASH_VEG', 'STEAM', 'FRONT', 'CASHIER', 'DISH'],      // 8
      ['WOK', 'CUTTING', 'ASSIST', 'WASH_VEG', 'ROAST', 'FRONT', 'CASHIER'],              // 7
      ['WOK', 'CUTTING', 'ASSIST', 'STEAM', 'DIM_SUM', 'FRONT', 'CASHIER', 'DISH'],       // 8
      ['WOK', 'CUTTING', 'ASSIST', 'STEAM', 'FRONT', 'CASHIER'],                          // 6
    ],
    mid: [
      ['WOK', 'CUTTING', 'ASSIST', 'FRONT', 'CASHIER'],   // 5
      ['WOK', 'CUTTING', 'WASH_VEG', 'FRONT'],            // 4
      ['WOK', 'CUTTING', 'FRONT'],                        // 3
    ],
    small: [
      ['WOK', 'ASSIST', 'FRONT'],                         // 3
      ['WOK', 'FRONT'],                                   // 2
    ],
  },
  // 专门店线只做炸物：**没有炒锅、没有烧腊、没有砧板水台**。
  // 这不是省略，是这条线的产品结构决定的 —— 一台炸炉 + 一个前厅就开门。
  tempura: {
    small: [
      ['TEMPURA_CHEF', 'TEMPURA_FRY', 'FRONT'],           // 3
      ['TEMPURA_CHEF', 'FRONT'],                          // 2
      ['TEMPURA_CHEF', 'TEMPURA_FRY', 'CASHIER'],         // 3
    ],
  },
};
// 副店长只在"这家店大到一个人管不住"的时候设
const HAS_DEPUTY = { big: true, mid: true, small: false };

// ---- 人名（虚构，组合生成，保证不重名）-------------------------------------
const SURNAMES = ['陈', '周', '吴', '何', '刘', '许', '孙', '郑', '黄', '冯',
  '徐', '朱', '马', '胡', '林', '高', '罗', '沈', '谢', '韩',
  '梁', '唐', '曾', '彭', '蒋', '蔡', '潘', '田', '董', '袁',
  '于', '余', '叶', '程', '苏', '魏', '吕', '丁', '任', '姚'];
const GIVEN = ['立', '敏', '桐', '静', '洋', '安', '浩', '悦', '磊', '雨',
  '晨', '琳', '超', '越', '峰', '洁', '宇', '晴', '楠', '雪',
  '嘉', '宏', '晓', '文', '家', '海', '燕', '鹏', '伟', '婷',
  '强', '丽', '军', '芳', '健', '颖', '斌', '萍', '涛', '霞'];

// ---- 外包（虚构供应商）-----------------------------------------------------
const SUPPLIER = '恒瑞人力（虚构）';
// 5 名外包：不占编制，但要在门店工时里出现（客户真实做法：洗碗与闭店清洁外包）
const OUTSOURCED_PLAN = 5;
// 兼职：8 家商场主力店各 1 名，晚市高峰 4 小时/日（非全日制口径），按小时计薪
const PART_TIME_PLAN = 8;

// ---- 小工具 ----------------------------------------------------------------
/** 固定种子的伪随机：每次跑出来的薪资一样，截图与回归才对得上。 */
function mulberry32(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260601);

/** 在薪资带宽里取一个"像真的"数：落到 50 元格点上（真实薪资表就是整数百）。 */
function pickAmount(band) {
  const [lo, hi] = band;
  const raw = lo + rnd() * (hi - lo);
  return Math.min(hi, Math.max(lo, Math.round(raw / 50) * 50));
}

/** 取某个岗位在某档门店的薪资带宽（没分档的岗位走 '*' 通用档）。 */
function bandOf(code, tier) {
  const bands = BANDS[code];
  if (!bands) throw new Error(`岗位 ${code} 没有薪资档（新增档口岗位时要同时给带宽）`);
  const band = bands[tier] ?? bands['*'];
  if (!band) throw new Error(`岗位 ${code} 在「${tier}」档没有薪资带宽`);
  return band;
}

/** 门店全名：品牌（商圈 + 商场 + 店），与客户的门店命名规则一致。 */
const storeNameOf = (brand, area, mall) => `${BRANDS[brand].name}（${area}${mall}店）`;

/** 门店专属手机号（虚拟 199 号段）：客户用它做考勤打卡的门店路由。 */
const storePhoneOf = (idx) => `199${String(80000000 + idx * 137)}`;

/**
 * 门店规模的"期望值"。★ 缩规模（比如演示机扛不住降到 24–30 家）时，
 * **必须同时改这里**，否则 buildStores() 会直接抛错 —— 那是故意的：
 * 一个"门店数悄悄变成 47 家"的演示库，比一次明确的失败难查得多。
 * 改的顺序：先删 CITIES 里的门店，再让期望值与实际一致（或临时把 checks 关掉）。
 */
const EXPECT = {
  total: 60,
  brand: { rice: 50, tempura: 10 },
  city: { 深圳: 22, 上海: 18, 广州: 8, 珠海: 5, 金华: 4, 义乌: 3 },
};

/**
 * 把 CITIES 展开成一维门店表，并自检分布。自检是给"改这张表的人"的护栏：
 * 门店数、品牌线、城市分布一旦被改错，演示现场才发现就晚了。
 */
function buildStores() {
  const stores = [];
  CITIES.forEach((city) => {
    city.stores.forEach(([area, mall, brand, tier, short]) => {
      stores.push({
        idx: stores.length + 1,
        city: city.name,
        area,
        mall,
        brand,
        tier,
        short: short || 0,
        name: storeNameOf(brand, area, mall),
      });
    });
  });

  const dup = new Set();
  for (const s of stores) {
    if (dup.has(s.name)) throw new Error(`门店名重复：${s.name}（门店名要能唯一指认一家店）`);
    dup.add(s.name);
  }
  if (stores.length !== EXPECT.total) {
    throw new Error(`门店数应为 ${EXPECT.total}（见 EXPECT），实际 ${stores.length}`);
  }
  const byBrand = (k) => stores.filter((s) => s.brand === k).length;
  for (const [k, n] of Object.entries(EXPECT.brand)) {
    if (byBrand(k) !== n) {
      throw new Error(`品牌 ${k} 的门店数应为 ${n}（见 EXPECT），实际 ${byBrand(k)}`);
    }
  }
  for (const [city, n] of Object.entries(EXPECT.city)) {
    const got = stores.filter((s) => s.city === city).length;
    if (got !== n) throw new Error(`城市 ${city} 门店数应为 ${n}（见 EXPECT），实际 ${got}`);
  }
  return stores;
}

/**
 * 在给定 db 上建整个连锁演示帐套。返回一份清单，便于断言与打印。
 * @param {object} db createDb() 返回的连接（需已跑完迁移）
 * @param {{log?: (msg: string) => void}} opts
 */
export async function seedChain(db, { log = () => {} } = {}) {
  const out = {
    ledger: null,
    orgs: {},
    persons: [],
    accounts: [],
    outsourced: [],
    shortageStores: [],
    stats: {},
  };
  const stores = buildStores();

  // ---- ① 开帐套 -------------------------------------------------------------
  const lid = (await db.query(
    `SELECT fn_ledger_open($1,$2,$3,'acct_admin') id`,
    [LEDGER_CODE, LEDGER_NAME, LEDGER_START])).rows[0].id;
  out.ledger = Number(lid);

  // ---- ①b 社保政策与个税参数（算薪的输入；缺一条就一次薪都算不出来）--------
  // ★ 为什么在这里补：这两样原来只写在 app/server.mjs 的**内置种子**里，
  //   而内置种子的条件是"空库首启 且 没有 SEED_SKIP"。用 SEED_SKIP=1 + 本脚本
  //   建库时它不跑 → si_policy 一条都没有 → 算薪 422 E_SI_POLICY_MISSING
  //   （"上海 养老保险 在 2026-03-31 之前没有生效的政策"），工资 6 个页面全空。
  //   这不是演示数据的缺口，是**算薪的必需输入**，所以建帐脚本必须自己带上。
  //
  // ★ 城市固定 '上海'：算薪里 `fn_si_base_eff(p_employee,'上海',…)` 与那段 CASE
  //   把城市写成了字面量 '上海'，所以补别的城市的政策对算薪不起作用。
  //
  // ★★ 引用行号前先看清"哪一份是活的"（走查踩过一次，会害人）：
  //   算薪函数 `fn_payroll_calc` 被**逐版重写**过 —— 015/087/090/094/098/099/103/
  //   105/112/117/120/128/129/133/143 里各有一份同名函数，只有**最后一份**
  //   （`143_iit_chain.sql`）是真的。同一句 `RAISE E_SI_POLICY_MISSING` 在十几处
  //   都有，改前面的版本**完全不生效且不报错**。以下行号一律指 143：
  //     · 社保游标（只取 rate_employee > 0）       143:445-451
  //     · 基数 = fn_si_base_eff(人, 城市, 险种, 月薪标准, 期末)   143:456-458
  //     · 险种 → 工资条行的 CASE                    143:459-465
  //     · 养老缺失即 422 的闸                       143:473-474
  //     · 小时工的应发 = 时薪 × 实际工时            143:345
  //
  // ★ 险种键必须用**规范键**（142 的 fn_si_item_canon + 触发器会归一）：
  //   失业是 `unemployment`（不是 `unemploy` —— 142 就是为这个 bug 打的补丁）。
  //
  // ★ 算薪的游标只取 `rate_employee > 0` 的政策（143:449），而工资条行只由
  //   pension / medical / unemployment / housing_fund 四种映射出来（143:459-465）。
  //   两件事拼在一起有两条硬结论：
  //     · **pension 的个人费率必须 > 0**，否则 `v_si_lines` 里没有 SI_PENSION，
  //       算薪会直接 422 —— 哪怕政策行存在（143:473-474 的闸判的就是这一行在不在）。
  //     · **工伤 / 生育的个人费率填 0**：填 0 就被游标过滤掉，既不扣钱也不出行，
  //       这才是干净的；若给成非 0，钱会进 v_si（实发变少）而工资条上没有那一行
  //       —— 正是 142 记录的"员工以为自己被多扣了"。单位费率照样要填，
  //       申报表 133/141 是按险种列的，缺一行就是少申报一个险种。
  //
  // ★ 费率来源：养老 8%/16% 与社保基数上下限 5975/31014 取自 server.mjs 的内置种子
  //   （那条是唯一的既有口径，照抄不改）；其余按上海现行常规口径补，
  //   并注明 **待客户 HR 按当地人社/公积金中心公布核对**：
  //     医疗 个人 2% / 单位 8.5%，生育 个人 0 / 单位 1%
  //       —— 上海 2019 起生育保险并入职工医保（单位合计 9.5%），这里拆成两行
  //          只是为了让工资条与申报表能**分栏**显示，合计仍是 9.5%，不重复扣；
  //     失业 个人 0.5% / 单位 0.5%；工伤 个人 0 / 单位 0.26%（行业中间档）；
  //     公积金 个人 7% / 单位 7%（★ 基数与社保不同，见 HF_BASE）。
  //
  // ★ id 不用手写：142 给 si_policy.id 补了 GENERATED BY DEFAULT AS IDENTITY，
  //   显式写 id 反而可能撞上序列（142 里专门 setval 过）。
  //
  // ★ 公积金要不要演：工资条专门有 SI_HOUSING_FUND 一行（143:463），不种这条政策
  //   那一行永远不出现（不是 0，是"没有"）。餐饮连锁里正式员工缴、兼职不缴是
  //   常见做法，而本系统按"人有政策就算"算，做不到按人开关 —— 所以做成一个
  //   **显式开关**：要演五险一金就留着，客户明确不缴就置 false（工资条那一行消失、
  //   实发金额变大），别让它变成"代码里有、数据里没有"的静默缺口。
  const INCLUDE_HOUSING_FUND = true;
  const SI_BASE = { floor: 5975, ceiling: 31014 };    // 社保基数（养老/医疗/失业/工伤/生育共用）
  const HF_BASE = { floor: 2690, ceiling: 36921 };    // 公积金基数：与社保不同，别复用上面那组
  const SI_POLICIES = [
    // item,          个人费率, 单位费率, 基数
    ['pension',      0.08,  0.16,   SI_BASE],
    ['medical',      0.02,  0.085,  SI_BASE],
    ['unemployment', 0.005, 0.005,  SI_BASE],
    ['injury',       0,     0.0026, SI_BASE],
    ['maternity',    0,     0.01,   SI_BASE],
  ];
  if (INCLUDE_HOUSING_FUND) {
    SI_POLICIES.push(['housing_fund', 0.07, 0.07, HF_BASE]);
  }
  for (const [item, empRate, erRate, base] of SI_POLICIES) {
    await db.query(
      `INSERT INTO si_policy(city, item, effective_from, base_floor, base_ceiling,
                             rate_employee, rate_employer)
       VALUES ('上海',$1,$2::date,$3,$4,$5,$6)
       ON CONFLICT (city, item, effective_from) DO NOTHING`,
      [item, AUTH_FROM, base.floor, base.ceiling, empRate, erRate]);
  }
  // 个税减除费用：★ 015 的迁移里本来就 `INSERT INTO tax_param(year,threshold)
  //   VALUES (2026,5000)`，所以这条其实是**幂等兜底**（走查报告说"没种"，
  //   实测是迁移带去的那一条 —— 留着它是因为真跑不通时先怀疑数据最省事，
  //   而 ON CONFLICT DO NOTHING 保证它永远不会覆盖客户改过的值）。
  await db.query(`INSERT INTO tax_param(year, threshold) VALUES (2026, 5000)
                  ON CONFLICT (year) DO NOTHING`);

  // ---- ② 组织：集团 → 城市（region）→ 门店（dept）---------------------------
  // ★ 三条结论写在前面，免得后来人"顺手"改成品牌树：
  //   ① 组织树是**管理线**（谁向谁汇报、考勤归谁审），品牌是**经营线**
  //      （这家店卖什么）。两条线在一家门店上交叉，但不能合并成一棵树：
  //      一家店只属于一个城市，却同时属于集团和某个品牌。
  //   ② 门店用 kind='dept'（064 起 'store' 已统一成 dept），城市用 'region'。
  //   ③ 品牌不进组织树，只体现在门店名与岗位结构上（专门店线没有炒锅档）。
  const root = Number((await db.query(
    `SELECT fn_org_add(NULL,$1,'group') id`, [GROUP])).rows[0].id);
  out.orgs[GROUP] = root;

  for (const city of CITIES) {
    const rid = Number((await db.query(
      `SELECT fn_org_add($1,$2,'region') id`, [root, city.name])).rows[0].id);
    out.orgs[city.name] = rid;
    for (const st of stores.filter((s) => s.city === city.name)) {
      const sid = Number((await db.query(
        `SELECT fn_org_add($1,$2,'dept') id`, [rid, st.name])).rows[0].id);
      out.orgs[st.name] = sid;
      st.orgId = sid;
    }
    // ★ 这里**不建"城市本部"节点**（曾建过 6 城市本部 + 1 集团本部，已撤）。
    //   原因：064 把 store 并进了 dept，本部同为 dept，于是任何"按 kind='dept'
    //   汇总"的地方都会把它们算进门店 —— 实测 67 个 dept / Σquota 396 / Σgap 22，
    //   而正确值是 60 / 388 / 14；走查只能靠"名字里是否含'本部'"排除，改名即失效。
    //   所以机动改放**额度层**（见 ⑧），组织树保持纯「集团 → 城市 → 门店」。
    //   代价两条，写在文件头「已知取舍与风险」⑬⑭：
    //     · 没有可挂"招城市经理"需求的叶子节点（025 只允许挂叶子）→ 登记为债；
    //     · "可招"只是个数字，看不到这笔编准备给哪个职能。
  }

  // 集团根也是"成本组织"上的一个可授予节点：给所有账号的范围都用 node_subtree
  await db.query(`SELECT fn_ledger_activate('acct_admin')`);

  // ---- ③ 账号：6 个集团岗位 ------------------------------------------------
  // ★ 演示帐套里几百个账号共用两个口令，逐个 scrypt 会让灌数据多花十几秒；
  //   同一口令复用同一个摘要不影响登录（盐已经写在摘要里）。
  const hashCache = new Map();
  const hash = (pwd) => {
    if (!hashCache.has(pwd)) hashCache.set(pwd, hashPassword(pwd));
    return hashCache.get(pwd);
  };

  const mkAccount = async (login, display, role, org, pwd, personId = null) => {
    const uid = Number((await db.query(
      `SELECT fn_account_create($1,$2,$3,$4,$5,'seed') id`,
      [login, display, role, org, personId])).rows[0].id);
    await db.query(`INSERT INTO sys_user_credential(user_id, pwd_hash) VALUES ($1,$2)`,
      [uid, hash(pwd)]);
    // ★ 授权生效日回填到 AUTH_FROM。
    //   fn_account_create 用 DEFAULT CURRENT_DATE 写授权，而**行闸**是按
    //   "查询时点"算有效权限的（077：fn_scope_rules(user, as_of)）。
    //   于是演示里查 as_of=2026-03-31 的在册人数会返回 0 行 —— 不是数据错，
    //   是"那天这个账号还没被授权"；但客户看到的是"系统里一个人都没有"。
    //   演示帐套是把一家已经跑了半年的公司搬进来，所以授权从 AUTH_FROM 起就算数。
    await db.query(`UPDATE sys_user_role SET effective_from = $2::date WHERE user_id = $1`,
      [uid, AUTH_FROM]);
    out.accounts.push({ id: uid, login, display, role });
    return uid;
  };

  const HQ = [
    ['admin',   '系统管理员',     'admin',        null, 'admin1234'],
    ['demo',    '帐套管理员',     'acct_admin',   null, 'demo1234'],
    ['boss',    '总经理',         'boss',         null, 'demo1234'],
    ['hr',      '集团人事负责人', 'group_hr',     null, 'demo1234'],
    ['payroll', '薪酬考勤专员',   'payroll_spec', null, 'demo1234'],
    ['hrops',   '人事专员',       'hr_ops',       null, 'demo1234'],
  ];
  for (const [login, display, role, org, pwd] of HQ) {
    await mkAccount(login, display, role, org, pwd);
  }

  // ---- ④ 岗位词典（集团统一，14 个业务岗位）--------------------------------
  const posId = new Map();
  for (const p of POSITIONS) {
    const id = Number((await db.query(
      `SELECT fn_position_upsert($1,$2,NULL,$3,false,$4) id`,
      [p.code, p.name, p.level, p.desc])).rows[0].id);
    posId.set(p.code, id);
  }

  // ---- ⑤ 员工：按档口编制逐店生成 ------------------------------------------
  let nameSeq = 0;
  const names = new Set();
  const nextName = () => {
    const i = nameSeq++;
    const sur = SURNAMES[i % SURNAMES.length];
    const g1 = GIVEN[Math.floor(i / SURNAMES.length) % GIVEN.length];
    const g2 = GIVEN[(i * 7 + Math.floor(i / SURNAMES.length)) % GIVEN.length];
    const name = i % 4 === 3 ? `${sur}${g1}${g2}` : `${sur}${g1}`;
    if (names.has(name)) throw new Error(`人名重复：${name}（重名会让"这是同一个人吗"变成演示事故）`);
    names.add(name);
    return name;
  };

  let noSeq = 1000;   // 员工编号：XX1001 起，跨门店连续，永不重复
  let empSeq = 0;     // 只用来摊开入职日

  /**
   * 建一个人：person → employment → 门店归属（成本/考勤两个维度）→ 薪资 →
   * 工号 → 假期额度 → 岗位任职。
   * ★ 成本组织与考勤组织都挂门店：这家店即成本中心，也是考勤班组。
   *   客户真实场景里两者可能不同（比如区域共享的后厨支援），这里先取最常见的一种。
   */
  const mkEmployee = async ({
    name, storeOrgId, posCode, tier, monthly, payBasis = null, hireDate, extra = {},
  }) => {
    const pid = Number((await db.query(`SELECT fn_person_create($1) id`, [name])).rows[0].id);
    const emp = Number((await db.query(
      `INSERT INTO employment(person_id, legal_entity_id, hire_date, pay_basis)
       VALUES ($1, 1, $2::date, $3) RETURNING id`, [pid, hireDate, payBasis])).rows[0].id);
    for (const dim of ['cost_org', 'attendance_org']) {
      await db.query(
        `INSERT INTO employee_org_assignment(employee_id, dim_code, org_id, valid_from)
         VALUES ($1,$2,$3,$4::date)`, [pid, dim, storeOrgId, hireDate]);
    }
    await db.query(
      `INSERT INTO salary_standard(employment_id, monthly_amount, effective_from)
       VALUES ($1,$2,$3::date)`, [emp, monthly, hireDate]);

    // 工号按入职顺序发：客户的工号就是流水号，不编码门店（换店不改工号）
    noSeq += 1;
    await db.query(`SELECT fn_assign_employee_no($1,$2)`, [pid, `${EMP_NO_PREFIX}${noSeq}`]);

    // 假别额度按 code 取 id（★ 原来写死 1/2 —— 那是年假/病假，与注释说的"事假"不符；
    //   假种 id 不是稳定的 identity，写死数字会在重灌库之后指向另一个假别）
    await db.query(
      `INSERT INTO leave_grant(employee_id, leave_type_id, qty, valid_from)
       VALUES ($1, public.fn_leave_type_id('ANNUAL'),   40, $2::date),
              ($1, public.fn_leave_type_id('PERSONAL'), 16, $2::date),
              ($1, public.fn_leave_type_id('SICK'),     24, $2::date)`, [pid, hireDate]);

    if (posCode) {
      await db.query(`SELECT fn_position_assign($1,$2,$3::date,'seed')`,
        [pid, posId.get(posCode), hireDate]);
    }
    out.persons.push({
      id: pid, name, posCode, monthly, payBasis, hireDate, ...extra,
    });
    return pid;
  };

  const bigStores = stores.filter((s) => s.tier === 'big');

  for (const st of stores) {
    const variants = STAFFING[st.brand][st.tier];
    if (!variants) throw new Error(`没有这个品牌/规模组合的档口编制：${st.brand}/${st.tier}`);
    const staffCodes = variants[(st.idx - 1) % variants.length];
    const hireMgr = hireDayOf(empSeq++);

    // 店长：门店第一责任人，也是这家店的考勤路由手机号持有人
    const mgrPid = await mkEmployee({
      name: nextName(), storeOrgId: st.orgId, posCode: 'STORE_MGR', tier: st.tier,
      monthly: pickAmount(bandOf('STORE_MGR', st.tier)), hireDate: hireMgr,
      extra: { store: st.name, city: st.city, brand: st.brand, isManager: true },
    });
    // 门店路由号落在店长的 person_profile(mobile) 上：表里没有"门店电话"这一列，
    // 而客户的门店号就是挂在店长名下的那个号（打卡机按它认门店）。
    await db.query(
      `INSERT INTO person_profile(person_id, profile_type, profile_value)
       VALUES ($1,'mobile',$2)`, [mgrPid, storePhoneOf(st.idx)]);

    let count = 1;

    if (HAS_DEPUTY[st.tier]) {
      count += 1;
      await mkEmployee({
        name: nextName(), storeOrgId: st.orgId, posCode: 'STORE_DEPUTY', tier: st.tier,
        monthly: pickAmount(bandOf('STORE_DEPUTY', st.tier)), hireDate: hireDayOf(empSeq++),
        extra: { store: st.name, city: st.city, brand: st.brand },
      });
    }
    for (const code of staffCodes) {
      count += 1;
      await mkEmployee({
        name: nextName(), storeOrgId: st.orgId, posCode: code, tier: st.tier,
        monthly: pickAmount(bandOf(code, st.tier)), hireDate: hireDayOf(empSeq++),
        extra: { store: st.name, city: st.city, brand: st.brand },
      });
    }
    st.headcount = count;
  }

  // ---- ⑥ 8 名兼职：晚市高峰，按小时计薪 ------------------------------------
  // ★ 兼职是"编制内的人"还是"编制外的人"，客户自己也没定死；这里按客户的
  //   实际口径：兼职在门店出勤、占工时、算工资，**占编也算到岗**
  //   —— 他的合同在我方，不占编就会出现"招进来不占编"的口子（172 的既定口径，
  //   要排除得改 policy HC_STATION_PARTTIME，不是改这份数据）。
  //   所以门店编 = 正式 + 兼职 + 缺岗设计，档口编只算档口岗（店长/副店长不进档口）。
  for (let i = 0; i < PART_TIME_PLAN; i += 1) {
    const st = bigStores[i % bigStores.length];
    const rate = 25 + Math.floor(rnd() * 6);              // 25–30 元/小时
    // salary_standard 只有月薪口径，所以反算：时薪 × 21.75 天 × 8 小时 = 月薪标准。
    // 算薪时 fn_pay_basis='hour' 会用 月薪 ÷ 174 还原成时薪，两边同一个数。
    const monthly = Math.round(rate * 174);
    const posCode = i % 3 === 2 ? 'DISH' : 'FRONT';
    await mkEmployee({
      name: nextName(), storeOrgId: st.orgId, posCode, tier: st.tier,
      monthly, payBasis: 'hour', hireDate: hireDayOf(empSeq++),
      extra: { store: st.name, city: st.city, brand: st.brand, partTime: true, rate },
    });
    st.headcount += 1;
  }

  // ---- ⑦ 5 名外包人员（不占编制，出现在门店工时里）------------------------
  // ★ 为什么不建成 person + employment(法人=供应商)：019 的判断是"外包人员不是员工"，
  //   建成员工会让所有"按 person"的口径（在职人数、社保、工资条）多出 5 个人。
  //   所以走 outsourced_worker，工时走 supplier_timesheet，两边不混。
  const supId = Number((await db.query(
    `INSERT INTO supplier(code, name) VALUES ('SUP-HR',$1) RETURNING id`, [SUPPLIER])).rows[0].id);
  for (let i = 0; i < OUTSOURCED_PLAN; i += 1) {
    const st = bigStores[i % bigStores.length];
    const name = nextName();
    const wid = Number((await db.query(
      `INSERT INTO outsourced_worker(supplier_id, full_name, worker_code, valid_from)
       VALUES ($1,$2,$3,$4::date) RETURNING id`,
      [supId, name, `HR-${String(i + 1).padStart(3, '0')}`, ATT_DAYS[0]])).rows[0].id);
    await db.query(
      `INSERT INTO outsourced_assignment(worker_id, store_id, valid_from)
       VALUES ($1,$2,$3::date)`, [wid, st.orgId, ATT_DAYS[0]]);
    for (const d of OUT_DAYS) {   // 3 天 × 8 小时：外包按天结算
      await db.query(
        `INSERT INTO supplier_timesheet(worker_id, work_date, hours, submitted_by)
         VALUES ($1,$2::date,8,'jia_fang')`, [wid, d]);
    }
    out.outsourced.push({ id: wid, name, store: st.name, city: st.city });
  }

  // ---- ⑦b 法人主档（160）------------------------------------------------------
  // ★ 为什么必须在这里写，而不是等 160 的回填：
  //   160 的回填是在**迁移时**跑的，那会儿还没有任何 employment / pay_run；
  //   种子是在迁移之后灌的，于是 legal_entity 一直是空的 ——
  //   后果不是报错，而是**发薪界面上的"法人"下拉是空的**（而算薪明明能跑）。
  //   名字是虚构的演示主体，别拿它当真实公司。
  await db.query(
    `INSERT INTO legal_entity(id, name, credit_code, address, legal_rep, stamp_name, bank_name, bank_account)
     VALUES (1, '香香鱼米餐饮管理（深圳）有限公司', '91440300MA5DEMO01X',
             '深圳市南山区示例路 1 号', '示例法人', '香香鱼米餐饮管理（深圳）有限公司',
             '示例银行深圳分行', '0000 0000 0000 0001')
     ON CONFLICT (id) DO NOTHING`);

  // ---- ⑧ 编制：集团 → 城市 → 门店，逐级下达 --------------------------------
  // ★ 口径（022 的规则）：**下分是分配，不是复制**。
  //   门店额度 = 实到人数 + 缺岗设计（缺岗的 5 家店在这里显出缺口，其余满编）；
  //   城市额度 = 它下辖门店额度**之和** + 1（城市机动）；
  //   集团额度 = 各城市额度**之和** + 2（集团机动）= 396。
  //   ★ 这里是"同一笔钱往下分"，不是每层各有一份预算 —— 门店那层加起来仍是 388，
  //     396 只多出机动那 8，不会翻倍。方案 C 之前是"集团 = Σ城市"（406），
  //     机动藏在更上面一层，导致城市/集团两边都得靠"多写一点"来凑，收不干净。
  //
  // ★ gap 的展示口径（2026-11 已定，**下面这段是历史，别再按它推理**）：
  //   早期 server 侧 org/tree 的 gap 是「额度 − **直属**在编」，而集团/城市不直挂人，
  //   于是那两行会显示成额度本身（396 / 149），看着像"全公司没人"。
  //   **现在已改成「含下级」（subtree）**：实测集团 396 − 374 = **22**、深圳 149 − 142 = **7**。
  //   所以别再从"org/tree 用直属"这个前提出发 —— 那个前提过期了。
  //
  // ★★ 三个"缺口"数会同时出现，别混（v5 实测，走查独立复核过）：
  //     quota − 子树在编  = 22   ← 俗称的 gap（= 门店缺 14 + 机动 8）
  //     门店缺口          = 14   ← 真正在招人的缺口（5 家店 3/3/3/3/2）
  //     机动合计          =  8   ← 城市 1×6 + 集团 2，是"还没下分的编"，不是缺口
  //   城市层同理：gap = 该城门店缺 + 1（深圳 7 / 上海 4 / 广州 4 / 珠海 1 / 金华 1 / 义乌 3）。
  //   ★ 22 = 14 + 8 这条恒等式建议直接当验收判据：它同时证明"缺口没被吃掉、机动也还在"。
  //   ⚠️ 别把 8 当成 gap 写进断言（我曾写错过一次，被走查用上式推翻）。
  //
  // ★ 期间要写两个：演示业务月（2026-06）与"跑脚本当天所在月"。
  //   组织架构页按 app_today() 的月份取编制（server 侧 fn_hc_quota 的口径），
  //   只写 2026-06 的话，演示当天打开组织页会看到所有门店 gap 为空 ——
  //   那不是"没缺岗"，是"这个月没定编"，两者在页面上长得一样，很容易被误解。
  const curPeriod = (await db.query(
    `SELECT to_char(app_today(),'YYYY-MM') p`)).rows[0].p;
  const periods = [...new Set([PERIOD, curPeriod])];

  for (const st of stores) {
    const plan = st.headcount + st.short;
    if (st.short > 0) {
      out.shortageStores.push({
        store: st.name, city: st.city, brand: st.brand,
        plan, actual: st.headcount, gap: st.short,
      });
    }
    for (const period of periods) {
      await db.query(
        `INSERT INTO headcount_budget(org_id, period, version, quota, set_by, reason)
         VALUES ($1,$2,1,$3,'acct_admin',$4)`,
        [st.orgId, period, plan,
          st.short > 0 ? '建帐：编制未满（招人中）' : '建帐：按档口编制核定的额度']);
    }
  }

  // 城市额度 = Σ下辖门店 + **机动**；集团额度 = Σ城市 + 机动。
  //
  // ★★ 为什么机动只能"多给"，不能"从 388 里留"（这条算式是跟走查/team-lead 一起
  //   算清的，写在这里免得下次再绕一遍）：
  //     集团额度 = Σ城市额度 = Σ门店额度 + Σ城市机动 + 集团机动
  //   而 Σ门店 = 388 是**钉死**的（门店编一个不多一个不少，门店缺仍 14）。
  //   388 已全额下分到门店，集团/城市手里本来就是 0 —— 所以"留机动"在数学上
  //   只能等于"比 388 多出来的部分"；想从 388 里留，就得让 Σ门店 < 388，与钉死条件互斥。
  //   口径上也如此：机动编是**预留编制**，不是把已批的岗位编制抽回来。
  //
  // ★ 本脚本取**最小机动**：城市各 1（6）+ 集团 2 → 总额 **396 = 388 + 6 + 2**。
  //   可招：集团 2、城市各 1、门店 0/3/2；而 Σ门店仍 388、门店缺仍 14。
  //   要更宽裕只改下面两个常量（各 2、集团 4 → 总额 404），其余算式自动跟随。
  const RESERVE_CITY = 1;     // 每个城市的机动（不下分到门店）
  const RESERVE_GROUP = 2;    // 集团机动
  let groupQuota = 0;
  let reserveTotal = 0;
  const cityQuotas = [];
  for (const city of CITIES) {
    const storesQuota = stores
      .filter((s) => s.city === city.name)
      .reduce((a, s) => a + s.headcount + s.short, 0);
    const cityQuota = storesQuota + RESERVE_CITY;
    cityQuotas.push({ city: city.name, quota: cityQuota, stores: storesQuota, reserve: RESERVE_CITY });
    groupQuota += cityQuota;
    reserveTotal += RESERVE_CITY;
    for (const period of periods) {
      await db.query(
        `INSERT INTO headcount_budget(org_id, period, version, quota, set_by, reason)
         VALUES ($1,$2,1,$3,'group_hr','建帐：城市额度＝下辖门店额度＋机动（未下分）')`,
        [out.orgs[city.name], period, cityQuota]);
    }
  }
  groupQuota += RESERVE_GROUP;
  reserveTotal += RESERVE_GROUP;
  for (const period of periods) {
    await db.query(
      `INSERT INTO headcount_budget(org_id, period, version, quota, set_by, reason)
       VALUES ($1,$2,1,$3,'group_hr','建帐：集团额度＝各城市额度＋集团机动')`,
      [root, period, groupQuota]);
  }
  const storesQuotaTotal = stores.reduce((a, s) => a + s.headcount + s.short, 0);
  log(`编制逐级下达：集团 ${groupQuota} = 门店 ${storesQuotaTotal} + 机动 ${reserveTotal}（城市：`
    + cityQuotas.map((c) => `${c.city} ${c.quota}（店 ${c.stores}/机动 ${c.reserve}）`).join(' · ')
    + '）');

  // ---- ⑨ 档口编制（172）：门店 → 档口 → 岗位 → 编几个 ----------------------
  // ★ 为什么这一步不能省：门店编只说明"这家店 8 个编"，而组织图上要回答的
  //   是"缺哪几个岗"。缺岗若只落在门店一层，演示时点开门店就只能看到
  //   "8 编 / 5 人"，客户下一句必然是"缺哪个岗？"——答不上来就等于没做。
  //
  // ★ 只开这家店**真有岗位**的档口，不用 fn_store_station_preset 全量铺：
  //   preset 会把品牌线所有档口一起打开（含烧腊档、点心档），于是一家 40 平
  //   的社区店里挂着一排"未定编"的档口 —— 那不是信息，是噪声。
  //   客户的门店就是这么配的：小店只有一个炉灶档、一个前厅档。
  //
  // ★ 缺岗怎么摊到档口上：按 SHORTAGE_ORDER 逐个岗位 +1，直到把缺口摊完。
  //   优先打在"最挡出餐"的岗（打荷、前厅、收银）——这是店长的真实排班思路：
  //   先补能立刻顶上出餐的岗，洗碗可以自己刷。
  //
  // ★ 兼容：172 若被 revert（station 表不存在），这一段整体跳过并在日志里说明，
  //   其余数据仍是完整的 —— 建帐脚本不该因为"某个模块没上线"就跑不完。
  const hasStation = Boolean((await db.query(
    `SELECT to_regclass('public.station') t`)).rows[0].t);
  let stationSlots = 0;   // Σ档口编（岗次）：给 ⑫ 的汇总行用，走查对账当基准
  if (hasStation) {
    const stationIdByCode = new Map((await db.query(
      `SELECT id, code FROM station WHERE is_active`)).rows.map((r) => [r.code, Number(r.id)]));
    const stationPosId = new Map((await db.query(
      `SELECT id, code FROM position WHERE is_active`)).rows.map((r) => [r.code, Number(r.id)]));

    // 每店每岗的在岗人数（人次；一人一岗，所以就是人头）
    const holdersByStore = new Map();
    for (const p of out.persons) {
      if (!POSITION_STATION[p.posCode]) continue;   // 店长/副店长不进档口
      if (!holdersByStore.has(p.store)) holdersByStore.set(p.store, new Map());
      const m = holdersByStore.get(p.store);
      m.set(p.posCode, (m.get(p.posCode) || 0) + 1);
    }

    let slotTotal = 0;
    for (const st of stores) {
      const holders = holdersByStore.get(st.name) || new Map();
      const codes = [...holders.keys()];
      // 计划岗次 = 在岗 + 摊到这一岗的缺岗
      const planSlots = new Map(codes.map((c) => [c, holders.get(c)]));
      let left = st.short;
      for (const code of SHORTAGE_ORDER) {
        if (left <= 0) break;
        if (!planSlots.has(code)) continue;
        planSlots.set(code, planSlots.get(code) + 1);
        left -= 1;
      }
      if (left > 0) throw new Error(`门店 ${st.name} 的缺岗 ${st.short} 人摊不完（档口不够分的）`);

      for (const code of codes) {
        const stationCode = POSITION_STATION[code];
        const stationId = stationIdByCode.get(stationCode);
        const positionId = stationPosId.get(code);
        if (!stationId) throw new Error(`岗位 ${code} 对应的档口 ${stationCode} 不在 172 词表里`);
        if (!positionId) throw new Error(`岗位 ${code} 没有 position 档案`);
        const ssId = Number((await db.query(
          `SELECT fn_store_station_enable($1,$2,$3::date) id`,
          [st.orgId, stationId, AUTH_FROM])).rows[0].id);
        const slots = planSlots.get(code);
        for (const period of periods) {
          await db.query(`SELECT fn_sp_set($1,$2,$3,$4,'acct_admin',$5)`,
            [ssId, positionId, period, slots,
              st.short > 0 ? '建帐：按排班需求定编（含缺岗）' : '建帐：按档口核定编制']);
        }
        slotTotal += slots;
      }
    }
    log(`档口编制（172）：${slotTotal} 个岗次已定编（门店编合计 `
      + `${stores.reduce((a, s) => a + s.headcount + s.short, 0)}，`
      + `差额是店长/副店长的编，不进档口）`);
    stationSlots = slotTotal;
  } else {
    log('跳过档口编制（172）：库里还没有 station 表');
  }

  // ---- ⑩ 账号：60 个店长 + 2 个店员样例 ------------------------------------
  // ★ 不给 374 名员工人人开号：演示里没人会一个个试，但"店员只能看到自己"
  //   这条必须能演，所以留 2 个店员样例号（大店的打荷、专门店的前厅）。
  //   店长账号按门店发：数据范围 = 这家店的整棵子树，所以他只看得到自己那家店。
  for (const st of stores) {
    const mgr = out.persons.find((p) => p.store === st.name && p.isManager);
    if (!mgr) throw new Error(`门店 ${st.name} 没有店长（每店必须有第一责任人）`);
    await mkAccount(`s${String(st.idx).padStart(2, '0')}m`, mgr.name, 'store_mgr',
      st.orgId, 'demo1234', mgr.id);
  }
  const samples = [
    out.persons.find((p) => p.posCode === 'ASSIST'),
    out.persons.find((p) => p.posCode === 'FRONT' && p.brand === 'tempura'),
  ].filter(Boolean);
  const staffAccounts = [];
  for (const s of samples) {
    const st = stores.find((x) => x.name === s.store);
    const login = `s${String(st.idx).padStart(2, '0')}s`;
    const uid = await mkAccount(login, s.name, 'store_staff', st.orgId, 'demo1234', s.id);
    staffAccounts.push({ uid, login, store: s.store, pos: s.posCode });
  }
  // ★ 账号清单：验收要按 `user=<id>` 逐个登，没有清单只能猜 id。
  //   id 由**创建顺序**决定（内置种子先跑过就会整体后移），所以每次建帐都把
  //   "谁是多少号"打出来，别让人事后反推。
  const idOf = (loginName) => out.accounts.find((a) => a.login === loginName)?.id ?? '?';
  const mgrAccs = out.accounts.filter((a) => a.role === 'store_mgr');
  log(`账号清单：集团 6 个（admin#${idOf('admin')} admin · demo#${idOf('demo')} acct_admin · `
    + `boss#${idOf('boss')} boss · hr#${idOf('hr')} group_hr · payroll#${idOf('payroll')} payroll_spec · `
    + `hrops#${idOf('hrops')} hr_ops）`);
  log(`          店长 ${mgrAccs.length} 个（${mgrAccs[0]?.login}#${mgrAccs[0]?.id} … `
    + `${mgrAccs[mgrAccs.length - 1]?.login}#${mgrAccs[mgrAccs.length - 1]?.id}，范围=本店）；`
    + `店员样例 ${staffAccounts.length} 个（${staffAccounts.map((a) => `${a.login}#${a.uid} ${a.store} ${a.pos}`).join(' / ')}）`);
  log(`账号基准：accounts=${out.accounts.length} hq=6 store_mgr=${mgrAccs.length} `
    + `store_staff=${staffAccounts.length} `
    + `mgr_ids=${mgrAccs[0]?.id}-${mgrAccs[mgrAccs.length - 1]?.id} `
    + `staff_ids=${staffAccounts.map((a) => a.uid).join(',')}`);

  // ---- ⑪ 考勤明细（让看板/报表/工资有数）-----------------------------------
  // ★ 餐饮的班不是 9 点到 5 点：两头班 10:00–22:00 挂在店里 12 小时，
  //   中间落场 2 小时（off_duty）、值班餐 1 小时（break_on_duty），实际工作 8 小时。
  //   五列物理量必须自洽：span 12 = on_duty 10 + off_duty 2；
  //   in_attendance 9 = on_duty 10 - break 1；work 8 = in_attendance 9 - break 1。
  // ★ 全职只给两天明细（看板/报表够用）；兼职给整月 22 个晚市班 —— 原因见
  //   ATT_DAYS_PART 上面那段：社保基数按月薪标准算，工时给少了会算出负数实发。
  //   兼职按 'hourly' 口径 work = in_attendance（值班餐已含在在岗工时里）。
  const storeOf = new Map(stores.map((s) => [s.name, s]));
  for (const p of out.persons) {
    const st = storeOf.get(p.store);
    if (p.partTime) {
      for (const d of ATT_DAYS_PART) {
        await db.query(
          `INSERT INTO attendance_daily_store(employee_id, store_id, work_date,
             shift_start_at, shift_end_at, span_hours, on_duty_hours, off_duty_hours,
             break_on_duty_hours, in_attendance_hours, work_hours, snap_on_duty_break_basis)
           VALUES ($1,$2,$3::date, $3::date + time '18:00', $3::date + time '22:00',
                   4, 4, 0, 0, 4, 4, 'hourly')`, [p.id, st.orgId, d]);
      }
    } else {
      for (const d of ATT_DAYS) {
        await db.query(
          `INSERT INTO attendance_daily_store(employee_id, store_id, work_date,
             shift_start_at, shift_end_at, span_hours, on_duty_hours, off_duty_hours,
             break_on_duty_hours, in_attendance_hours, work_hours, snap_on_duty_break_basis)
           VALUES ($1,$2,$3::date, $3::date + time '10:00', $3::date + time '22:00',
                   12, 10, 2, 1, 9, 8, 'allowance')`, [p.id, st.orgId, d]);
      }
    }
  }

  // ---- ⑪b 兼职"实发会不会变负"自检 -----------------------------------------
  // ★ 为什么建帐时就要算这一遍：小时工的实发 = 工时 × 时薪 − 个人扣缴，而个人扣缴
  //   是按**月薪标准**算的（社保、公积金基数都有下限，时薪再低也照缴），工时给少了
  //   就会算出负数实发，而**系统不会报错** —— 它只是个数字。演示时弹出几张负工资条，
  //   客户第一反应就是"你们算错了"。所以这里一旦为负就**直接失败**，不静默通过。
  //
  // ★ 三个输入全部取自"算薪看的那几个源"，本脚本不另造口径：
  //   · 工时   fn_att_person_period(person, 期间).work_hours  ← 143:344 算薪用它
  //            （★ 不用"排班天数 × 单班时长"这种常量：排班改了、考勤灌少了、有人请假，
  //              常量都看不出来，而算薪看的是考勤。走查提的就是这个口子。）
  //   · 时薪   月薪标准 ÷ (PAY_DAYS_PER_MONTH × PAY_WORK_HOURS_DAY)  ← 143:338-340
  //            （这两行是那段代码的**镜像**；制度项取的是库里的值，不写死 174，
  //              客户改制度项时自检与算薪一起变。那段改了这里要跟着改。）
  //   · 扣缴   fn_si_base_eff(person,'上海',险种,月薪标准,期末) × 个人费率
  //            （险种取最新版次且 rate_employee > 0，与 143:445-451 的游标同构；
  //              少写 rate_employee > 0 会把 0 费率的工伤/生育也算一遍 —— 结果是 0，
  //              不出错，但会掩盖"这两条本来就不该进 v_si"的事实。）
  // ★ 依赖的函数取不到（133/143 之前的老库）就跳过并说明，不猜。
  const fnReg = (await db.query(
    `SELECT to_regprocedure('public.fn_si_base_eff(bigint,varchar,varchar,numeric,date)') si,
            to_regprocedure('public.fn_att_person_period(bigint,varchar)') att`)).rows[0];
  if (fnReg.si && fnReg.att) {
    const pol = (await db.query(
      `SELECT COALESCE((SELECT value_num FROM fn_policy_effective('PAY_DAYS_PER_MONTH',NULL,$1::date)),21.75) d,
              COALESCE((SELECT value_num FROM fn_policy_effective('PAY_WORK_HOURS_DAY',NULL,$1::date)),8) h`,
      [PERIOD_END])).rows[0];
    const partTimers = out.persons.filter((p) => p.partTime);
    let worst = null;
    for (const p of partTimers) {
      const hours = Number((await db.query(
        `SELECT work_hours FROM fn_att_person_period($1,$2)`, [p.id, PERIOD])).rows[0]?.work_hours || 0);
      const hourly = Math.round((p.monthly / (Number(pol.d) * Number(pol.h))) * 10000) / 10000;
      const gross = Math.round(hourly * hours * 100) / 100;
      const ded = Number((await db.query(
        `SELECT COALESCE(sum(round(public.fn_si_base_eff($1,'上海',s.item,$2,$3::date)
                                  * s.rate_employee, 2)), 0) d
           FROM (SELECT DISTINCT ON (item) item, rate_employee
                   FROM si_policy
                  WHERE city = '上海' AND rate_employee > 0 AND effective_from <= $3::date
                  ORDER BY item, effective_from DESC) s`,
        [p.id, p.monthly, PERIOD_END])).rows[0].d);
      // ★ 本比较**故意忽略个税**：这几个数（应发 ≤ 2640）显然在起征点以下，
      //   `max(应发 − 扣缴 − 5000, 0) = 0`。边界是"应发 − 扣缴 > 5000"——
      //   有人把时薪调到几十块、或把工时排满月时，个税就进来了，这条自检会漏。
      //   真要覆盖那种情形，得把 fn_iit/**个税链**也接进来；现在不做，但说清边界。
      if (gross < ded) {
        throw new Error(`兼职 ${p.name}（${p.store}）算出来是负数实发：`
          + `应发 ${gross}（${hours} 小时 × ${hourly} 元/时）< 个人扣缴 ${ded}。`
          + '要么加考勤工时，要么把他的计薪基础改回月薪制 —— 不要靠关社保来解决');
      }
      // ★ 扣缴为 0 是**信号不是错误**（team-lead 定的口径）：si_policy 一条没生效时
      //   它就是 0，自检会"轻松通过"。这里不中断建帐（有些客户确实只缴工伤，
      //   扣缴天然接近 0），但必须把话说出来 —— 否则工资条上一个险种都没有，
      //   而算薪要等到跑那一刻才 422。
      if (ded <= 0 && p.monthly > 0) {
        log(`[警告] 兼职 ${p.name}（${p.store}）个人扣缴算出 0 —— `
          + '多半是 si_policy 没灌进去或城市/生效日写错，算薪会直接 422');
      }
      const margin = Math.round((gross - ded) * 100) / 100;
      if (!worst || margin < worst.margin) worst = { name: p.name, hours, hourly, gross, ded, margin };
    }
    // ★ 没有小时工时 worst 仍是 null：这里若直接读 worst.name 会以
    //   "Cannot read properties of null" 崩掉，而真正的原因（本帐套没有兼职）
    //   根本不在报错里。少一个人、换个客户就可能没有兼职，所以要显式分支。
    if (!worst) {
      log('兼职实发自检：本帐套没有小时工（pay_basis=hour），跳过');
    } else {
      log(`兼职实发自检：${partTimers.length} 人，最紧的一位 ${worst.name}：`
        + `${worst.hours} 小时 × ${worst.hourly} 元 = 应发 ${worst.gross}，`
        + `个人扣缴 ${worst.ded}，实发 ${worst.margin}`
        + `（扣缴占应发 ${Math.round((worst.ded / worst.gross) * 100)}% —— `
        + '工时只有一半时扣缴会接近四成：不是多扣，是没有因为他是兼职就漏缴）');
    }
  } else {
    log('跳过兼职实发自检：库里还没有 fn_si_base_eff / fn_att_person_period（133/143 之前的老库）');
  }

  // ---- ⑫ 汇总 --------------------------------------------------------------
  const partTime = out.persons.filter((p) => p.partTime).length;
  out.stats = {
    stores: stores.length,
    cities: CITIES.length,
    riceStores: stores.filter((s) => s.brand === 'rice').length,
    tempuraStores: stores.filter((s) => s.brand === 'tempura').length,
    employees: out.persons.length,
    partTime,
    outsourced: out.outsourced.length,
    accounts: out.accounts.length,
    quotaTotal: stores.reduce((a, s) => a + s.headcount + s.short, 0),
    shortageStores: out.shortageStores.length,
    shortageGap: out.shortageStores.reduce((a, x) => a + x.gap, 0),
    stationSlots,
    cityQuotas,          // 城市额度明细（门店/本部/机动三段），给对账用
    groupQuota,          // 集团额度 = 门店 + 本部 + 机动
    reserveTotal,        // 机动（未下分）合计
  };

  log(`帐套「${LEDGER_NAME}」(${LEDGER_CODE}) · ${out.stats.stores} 家门店`
    + `（${BRANDS.rice.name} ${out.stats.riceStores} · ${BRANDS.rice.line} / `
    + `${BRANDS.tempura.name} ${out.stats.tempuraStores} · ${BRANDS.tempura.line}）`
    + ` · ${out.stats.cities} 个城市 · ${out.stats.employees} 名员工（含 ${partTime} 名兼职）`
    + ` · ${out.stats.outsourced} 名外包 · ${out.stats.accounts} 个账号`);
  log(`编制合计 ${out.stats.quotaTotal} · 缺岗设计：${out.stats.shortageStores} 家店共 ${out.stats.shortageGap} 个空编`
    + `（${out.shortageStores.map((s) => `${s.store} +${s.gap}`).join('、')}）`);
  // ★ 机器可读的一行：验收（/api/org/tree、/api/org/stations）要拿这些数当基准，
  //   靠人从上面几句中文里抠数字迟早抠错。格式固定为 key=value，空格分隔。
  // ★ quotaTotal 是**门店**编合计（对账基准，别混成集团总额）；
  //   groupQuota 才是集团额度 = 门店 + 本部 + 机动。两个都要有：
  //   走查的断言拿 quotaTotal 对门店，拿 groupQuota 对看板/报表。
  log('对账基准：'
    + `stores=${out.stats.stores} employees=${out.stats.employees} `
    + `partTime=${out.stats.partTime} outsourced=${out.stats.outsourced} `
    + `accounts=${out.stats.accounts} quotaTotal=${out.stats.quotaTotal} `
    + `stationSlots=${out.stats.stationSlots} shortageStores=${out.stats.shortageStores} `
    + `shortageGap=${out.stats.shortageGap} groupQuota=${out.stats.groupQuota} `
    + `reserve=${out.stats.reserveTotal}`);
  log(`店长账号 s01m…s${String(out.stats.stores).padStart(2, '0')}m（口令 demo1234）；`
    + `集团账号 admin / demo / boss / hr / payroll / hrops`);
  return out;
}

// ---- CLI -------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await createDb({
    dataDir: process.env.PGLITE_DATA_DIR || undefined,
    url: process.env.DATABASE_URL || undefined,
  });
  await db.exec('CREATE EXTENSION IF NOT EXISTS btree_gist');
  const fresh = Number((await db.query(
    `SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n) === 0;
  if (!fresh) {
    console.error('这个库里已经有表了。建帐要在空库上做 —— 香香鱼米必须独占一个库：');
    console.error('  068 只做了"档案级多帐套"，业务表（考勤/工资条/审批）还没有 ledger_id，');
    console.error('  两个帐套混在一个库里，5 号店的考勤会被算进另一家的报表（债 SUITE.MT）。');
    console.error('换一个 PGLITE_DATA_DIR，或新建一个 database 再跑。');
    process.exit(2);
  }
  for (const m of readdirSync(DB_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort()) {
    await db.exec(readFileSync(join(DB_DIR, m), 'utf8'));
  }
  await db.initSession();
  await seedChain(db, { log: console.log });
  console.log('');
  console.log('下一步（顺序别跳，④ 不封账 ⑤ 就算不出薪）：');
  console.log('  ① 起服务     SEED_SKIP=1 PGLITE_DATA_DIR=... node app/server.mjs');
  console.log('  ② 业务流水   SEED_SKIP=1 PGLITE_DATA_DIR=... node tools/seed-demo-flow.mjs');
  console.log('  ③ 登录       POST /login?user=<id>&pwd=demo1234 —— 只认 id（传 login 名会 400）；'
    + 'id 见上面"账号基准"那行');
  console.log('  ④ 逐店封账   POST /api/attendance/close（每家店每月一次）');
  console.log('  ⑤ 算薪       POST /api/payroll/run?period=2026-06&entity=1');
  process.exit(0);
}
