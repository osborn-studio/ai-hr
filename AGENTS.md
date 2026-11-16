# AGENTS.md · 接手前先读这一页

这份文件是给**下一个在这个仓库里写代码的人或 AI**（含 codex）看的。
`README.md` 讲的是"这套系统为什么这样设计"，这一页只讲"在这里动手要遵守什么"。


## 2026-11-16 接续基线

当前开发入口为 `/workspace`，产品名为天意人力资源系统（ty-hr）。先读 `docs/53_新版工作台与测试帐套.md`。原业务代码继续保留；001–192 是原迁移，新版从193起增量扩展，已应用迁移不得修改。

测试组织为天意集团，香香鱼米（CN/CNY）、大富烤肉（HK/HKD）各10家门店，总部为独立集团帐套。所有测试记录必须独立虚构，客户原件只用于理解格式，不得自动导入到演示库。地区与币种从配置读取，不能根据品牌名称猜测；两种货币不得直接求和。香港主体不得走原内地算薪。

初始化持久库先运行 `node tools/init-workspace.mjs`，再运行 `node tools/init-test-workspace.mjs --confirm-synthetic`。用 `SEED_SKIP=1` 避免旧小样本。随机凭据只写本地 `TYHR_RUNTIME_DIR/workspace-access.json`，不得提交。测试帐套会为自己新建的虚构组织/主体建立显式旧业务范围；普通映射不自动扩大权限。

`npm test` 包含原业务和新版测试；`npm run test:new` 可单独检查新版，`npm run verify:docs -- --fast --strict` 比对对象数。真实 PostgreSQL 测试需每套隔离空库，不能串用含测试残留的库。下文旧断言条数和迁移编号属于原交接记录，以当前脚本与实跑输出为准。

---

## 一、五分钟把它跑起来

```bash
cd code
npm install          # 只有一个依赖：@electric-sql/pglite（PostgreSQL 编译成 WASM）
npm test             # 原业务和新版完整回归，以各套输出为准
npm run serve        # http://127.0.0.1:8787（内存库，重启即清空）
npm run serve:persist  # 落盘到 ./.data（重启不丢；持久化断言 P1–P4 守这条）
npm run demo           # 跑接口断言 + 起同一套库的服务（自检页才有结论）
npm run backup         # 备份到 ./backups（.tar.gz + .json 清单；空库会被拒）
npm run test:ui        # 界面冒烟（用本机 Chrome --headless --dump-dom；没有 Chrome 则跳过）
npm run verify:docs    # 文档数字与真实库比对（--strict 有差异即 exit 1；--fast 不跑测试）
```

`npm test` 按 package.json 依次运行原业务与新版测试（各自隔离数据）。**内存小的机器上可能被 OOM kill**
（表现为 `Killed: 9` / exit 137，看起来像"测试挂了"实则不是）。分开跑即可：
`npm run test:db`、`npm run test:api`、`npm run test:persist`、`npm run test:backup`、`npm run test:contract`。

不需要 Docker、不需要本机装 PostgreSQL。数据库每次测试都**从空库全量重建**
（从 `db/` 自动派生当前连续迁移顺序执行），没有任何"上次残留的状态"。

页面用 `?as=N#tab` 直达身份与页签：
`/#home`（工作台，默认）、`/#dashboard`（看板）、`/#attendance`、`/#payslip`、`/#close`、`/#payroll`、
`/#roles`、`/#policy`、`/#headcount`、`/#recruit`、`/#settlement`、`/#approval`、`/#mcp`、
`/#exceptions`、`/#perf`、`/#report`、`/#health`。

登录口令见 `server.mjs` 种子：身份 1–4 用 `demo1234`；身份 5 是临时口令 `temp1234`（必须先改密，428）。

探针：`/livez`（免认证，只证进程存活）与 `/readyz`（查库，503 = 不能干活）。

---

## 一之二、这些模块在哪（按「你要改什么」找）

| 你要改的东西 | 文件 | 对应的断言组 |
|---|---|---|
| 行闸 / 四维范围 / 权限求值 | `db/001_core.sql` + `app/services/guard.mjs` | A / M / AG |
| 字段掩码（只掩不报错） | `db/003_field_policy.sql` + `services/payroll.mjs` | C / AV |
| 算薪 / 门禁 / 勾稽 | `db/009` `db/015` + `services/payroll.mjs` | P / S / AA |
| 考勤封账 / 补账 | `db/016` + `services/attendance.mjs` | Q / R |
| 组织版本（时点正确性） | `db/017` | R / X |
| 组织级授权（集团授给组织） | `db/020` | W / X |
| 编制逐级下分 | `db/022` + `services/headcount.mjs` | AC / AD |
| 报表 / 看板 | `db/023` `db/024` `db/056` + `services/report.mjs` | AA / AB / DS / XP |
| 导出（CSV 只有一个写出器） | `app/csv.mjs` + `db/055` | AV / RP / XP |
| 假期额度 / 离职额度结算 | `db/011` `db/057` + `services/leave.mjs` | N / LT |
| 登录限流（按来源） | `db/043` `db/058` | AM / LG |
| 响应头 / CSP nonce | `server.mjs` 的 `SEC_HEADERS` / `htmlHeaders` + `db/059` | NH |
| 界面冒烟 / 渲染别悄悄坏掉 | `code/test/ui.test.mjs` + `db/060` | UI |
| 招聘 / offer 版本 | `db/025` + `services/recruit.mjs` | AD |
| 绩效打分 / 封存 / 待评名单 | `db/026` `db/050` + `services/perf.mjs` | AD / AQ |
| 补账（封账后修正） | `db/051` + `services/attendance.mjs` | AS |
| 入职（offer → 在职） | `db/052` + `services/recruit.mjs` | HI |
| 工号（分配 / 花名册可见） | `db/061` + `services/people.mjs` | NO |
| 员工花名册 / 员工详情 / 离职 | `db/053` `db/054` + `services/people.mjs` | RO / DE / TR |
| 审批引擎（步骤/会签/否决） | `db/032` + `services/approval.mjs` | AI / AR |
| 转签 / 加签 / 代理 / 抄送 | `db/041` `db/045` `db/048` | AK / AN / AO / AP |
| 会话 / 认证 / 改密 | `db/030` `db/035` `db/039` | AH / AT / AW |
| 例外（必须有退出条件） | `db/037` | AJ / AU |
| 开放层（两阶段写 / 只读） | `db/010` `db/047` + `services/mcp.mjs` | J / MS |
| 限流 | `db/043` + `server.mjs` 的 `runWrite` | AM |
| 判据登记与覆盖 | `db/002` + 各 `*_check_group_*.sql` | T / U |
| 备份 / 恢复 | `code/tools/*.mjs` | B |
| 连接归属 / 驱动切换 | `app/db.mjs` | D |
| 探针 | `server.mjs` 的 `/livez` `/readyz` | H |

**加功能前先看表里有没有对应组**：没有组 = 这件事没有判据 = 它以后一定会静默坏掉。

---

## 二、代码放在哪（改错地方会比改错代码更贵）

| 目录 | 职责 | **不要**在这里做的事 |
|---|---|---|
| `code/db/*.sql` | 表、约束、触发器、业务函数。**规矩住在这里** | 不要放"只为了界面好看"的逻辑 |
| `code/app/services/*.mjs` | 身份换算、顺序、事务边界。很薄 | 不要写业务判据（额度/状态机/权限范围） |
| `code/app/server.mjs` | 路由：解析参数 → `runWrite`/`runRead` → JSON | 不要直接 `db.query` 写业务 SQL（读也有例外，但要有理由） |
| `code/app/errors.mjs` | SQLSTATE / 业务码 → HTTP 的**唯一**映射点 | 不要在路由里各写各的 `catch` |
| `code/tools/*.mjs` | 备份 / 恢复（先校验和、再清单、才装载） | 不要在这里加业务逻辑 |
| `code/test/run.mjs` | 数据库断言（含种子） | 不要为了让断言变绿而改断言 |
| `code/test/api.test.mjs` | 接口断言（M/N/O/S/AG/AH/AR/MS/AT/AU/AV/AW/AL/AM/AO/AP/H/X/Y/AE 组） | 同上 |
| `code/test/{persist,backup,db-contract}.test.mjs` | 落盘 / 备份恢复 / 数据访问契约 | 同上 |

一句话：**能由数据库判的，一律放数据库**。服务层可以被绕过（运维脚本、MCP 工具、
以后另一个客户端），数据库不会。权限范围是唯一的例外——它要读 `pg_temp`，只能放服务层。

---

## 三、四条硬规矩（违反任何一条，都会有一次"看起来通过"的事故）

### 1. 写路径只能经 `runWrite`

`runWrite` 替每条写路由做四件事，顺序固定：一个事务 → 业务码映射 → 事务外留痕 → 500 不回显原文。
绕过它，就会缺其中一样，而**缺哪一样都不会让任何断言变红**（除非你加断言）。
`AG13` 是一条源码扫描断言，专门抓这个：它数 `/api` 下的 POST 路由，逐条要求出现 `runWrite(`。

### 2. 新增资源码，必须登记进 `sys_perm_resource`

`app_begin_scope` 的第一个动作是查资源码。未登记 → `E_RESOURCE_UNREGISTERED` →
HTTP 500，看起来像服务故障，实际是少了一行 INSERT。`AG0` 会拿服务层的 `RESOURCES`
与那张表做差集。

### 3. 新增断言组，必须登记进 `sys_check_registry`

`fn_chk_record` 拒绝记录未登记的判据码——这是**故意的**（不许跑没人知道的检查）。
但它的失败形态是"整组结论在覆盖率报告上不存在"，不是红色。见 `029` / `031` 两个迁移的写法。

### 4. 迁移清单不许手写第二份

`server.mjs` 与 `test/run.mjs` 都从 `db/` 目录派生迁移清单（`^\d{3}_.*\.sql$` 排序）。
曾经两边各抄一串文件名，加 `028` 时只改了一处 —— 两套测试用的就不是同一个库，
而没有任何断言会红。**新加迁移只要把文件放进 `db/` 并保证编号连续。**

### 5. 断言条数不许手抄

`npm run verify:docs` 会把 README 顶部那张状态表的每个数字与真实来源比一遍
（迁移/表/函数/触发器/判据组查库，五套断言条数跑一遍取它们自己打的那行）。
它第一次跑就抓到了合计行的 `424/425` 实际是 `426/427` —— 手抄数字的必经之路。
**改完代码先跑一次这个，再改 README。**

本仓作者已经因此错过两次（16→26、44→52）。数字从 `npm test` 的输出里抄。

---

## 四、踩过的坑（同一类错已经犯过 5 次，请当作检查表）

| # | 坑 | 症状 | 怎么防 |
|---|---|---|---|
| 1 | **表有 surrogate PK 但没有生成方式** | `23502 not-null violation on id`，看起来像数据缺失 | 凡是被 INSERT 的表，`id bigint GENERATED BY DEFAULT AS IDENTITY`。已犯 5 次（`sys_check_run`、`payslip`、`pay_run` 等） |
| 2 | **只测"重复"分支，不测"首次"分支** | 第一次真正走到 INSERT 就炸，而测试一直命中"已存在"分支 | 写断言时问一句："这条路径有没有一次是从零开始的？" |
| 3 | **维度 `kind` 有两种，判据落在两张表** | `tmp_scope_org` 查不到 `entity` 维度 → 恒 403 | 按 `sys_perm_dim.kind` 分支，不按维度名硬编码（`services/guard.mjs`） |
| 4 | **视图/函数里用 `current_date` / `now()`** | 同一个查询换一天两个答案，"上个月的报表"永远复现不出来 | 时点类一律带 `as_of` 参数；`AA8` 是一条扫描断言的雏形 |
| 5 | **`x NOT IN (...)` 遇到 NULL 恒为假** | 守卫自己被 NULL 绕过，`ELSE` 静默走默认分支 | 写成 `x IS NULL OR x NOT IN (...)`；已犯一次（`fn_rpt_headcount`） |
| 6 | **触发器的顺序依赖** | 先建触发器后建函数 → 建库失败 | 先函数后触发器；`CREATE TRIGGER` 之前确认函数已存在 |
| 7 | **种子写显式 id 造成序列漂移** | 第一次自增就 `23505`，报主键冲突 | 种子按业务键回查，不写 id（`period` / `employee_id`） |
| 8 | **`search_path=''` 下 `%ROWTYPE` 要带 `public.`** | `type does not exist` | 所有函数都 `SET search_path = ''`，引用一律写全 `public.xxx` |
| 9 | **新业务码没登记进 `BIZ`** | 不报错，落到 400 兜底 —— 「通过了的失败」 | `AE1` 现在要求未登记数 = 0；它一次抓出过 19 个漏登记的码 |
| 10 | **PGlite 数据目录放在工作区内，被沙箱拦截删除** | 运行中随机 500，堆栈里是 `postmaster.pid` unlink | 持久化目录放 `${TMPDIR}` 或 Docker 卷；不要在项目目录里跑持久库 |
| 11 | **单连接驱动上两个事务叠在一起** | 慢事务回滚后数据还在（被别人的 COMMIT 带走）；只在并发下出现 | `withTx` 必须把连接当资源（单连接排队 / 池化取用）；D1、D5、D7 守这条 |
| 12 | **`mode` 只判一半**：`act_kind` 在某个分支里写死 | `mode=all` 变成或签，第一个人点完整单就通过 | 凡「模式」参数，每个插入点都要用上它；跑一遍会签用例（AI2） |
| 13 | **CSV 导出用 `join(',')`** | 三种事故都不报错：无 BOM（Excel 乱码）、值里逗号挤偏列、`=` 开头被 Excel 执行 | 全系统只用 `app/csv.mjs`；数字列与文本列分开处理（XP7） |
| 14 | **`CREATE OR REPLACE VIEW` 在中间插列** | `42P16 cannot change name of view column ...`，读起来像"名字改错了" | 加列一律 `DROP VIEW` 再建（057 的 `v_leave_balance`） |
| 15 | **断言依赖"环境里残留的临时表"** | 单跑绿、连跑红；换执行顺序就翻，而症状像"算错了" | 测权限的断言自己灌（`app_begin_scope`），测分区的断言自己灌全量；或直接断言**性质**不写死行数（DS 组 / AB4） |
| 16 | **异常路径不记账** | 账号被锁后 `authenticate` 直接抛 → 换个账号继续试，来源计数永远不涨（撞库正好这么做） | 任何"失败计数"都要覆盖 catch 分支，除非明确要跳过（LG1 是跑出来的） |
| 17 | **`findIndex` 匹配不到时给 -1** | 后面的循环全落空，断言报"差 7 项"而不是"没找到" | 解析外部文本（CSV/HTML）时先断言找到，或让 `-1` 直接抛（XP2） |
| 18 | **新迁移不会在已有库上自动跑** | `PGLITE_DATA_DIR` 指向老的 `.data` 时，服务照常起，但新列/新函数不存在 → 运行时报"column 不存在" | 迁移目前只在空库上跑（`server.mjs` 里 `fresh` 那一段）。改了 schema 要先换一个数据目录，或自己按序跑迁移 —— 真实部署这一步属于部署脚本 |

---

## 五、加一个功能的标准路径（照这个顺序，别跳）

1. **迁移**：`code/db/0NN_xxx.sql`。表、约束、触发器、`fn_*` 函数都在这一个文件里。
   跨层的判据（比如"未封账不许算薪"）必须在这一层。
2. **服务**：`code/app/services/xxx.mjs`。`export const RESOURCES = {...}`（资源码）、
   参数形状校验（`E_ARG_INVALID`）、`requireOrg` / `prepareRead`、调库函数。**不要开事务**。
3. **路由**：`code/app/server.mjs`。写走 `runWrite`，读走 `runRead`，一行参数解析，不做别的。
4. **业务码**：新 `RAISE EXCEPTION 'E_XXX: 说明'` 的码，加进 `errors.mjs` 的 `BIZ`。
   `AE1` 会扫库里所有 `E_*` 与这张表做差集（要求"未登记数 = 0"）。
5. **断言**：数据库判据进 `test/run.mjs`，接口行为进 `test/api.test.mjs`。
   新组 → 先登记 `sys_check_registry`。
6. **界面**：`code/app/index.html` 加一屏或一个表单。失败要显示**业务码**，不是"系统错误"。

---

## 六、验收口径（别把"绿"说成"对"）

- `224 + 70 全绿` 的含义是：**在 PostgreSQL 18.6（PGlite/WASM）上，这些断言通过**。
  设计基准是 PG 16，换版本要重跑；换成真 PG 也要重跑。
- 断言必须钉到**具体表达式**，不是钉"对象存在"。
  例：不是"约束存在"，而是 `pg_get_constraintdef` 里 grep 到 `round(` 而不是 `abs(`。
- 「预期集合非空 ∧ 全部满足」才算通过。只写"全部满足"的话，集合为空时它是绿的，
  而"没检查"与"检查通过"会变成同一个颜色。

---

## 七、接下来三件值得做的（作者视角，不是需求）

上一轮写在这里的三件已经做完两件半，结论记一下：

1. ~~把内联脚本拆成文件 / 收掉 CSP 的 `unsafe-inline`~~ **做完了，但换了做法**：
   不拆文件，用**每次请求新生成的 nonce**（`059` + `server.mjs` 的 `htmlHeaders`）。
   顺手把接口的 CSP 收到 `script-src 'none'` —— 原来 JSON/CSV 跟着界面一起吃 `'unsafe-inline'`。
   `style-src` 仍留 `'unsafe-inline'`（27 处 style 属性，写明的取舍）。
2. ~~登录失败限速~~ **做完了**（`058`）：按**来源**计数，30 次/15 分钟，阈值是制度项。
   信任边界也定了：只有代理确实覆盖 `X-Forwarded-For` 时才开 `TRUST_PROXY=1`。
   还缺的是**请求体大小上限**（`server.mjs` 目前不读 body，所以暂时无风险；
   一旦加了 POST body 就要先有上限）。
3. **拿真 PostgreSQL 跑一遍**。适配层写好了（`app/db.mjs` 双驱动 + D 组契约），
   但本机没有 PG、也没有包管理器，**一条也没跑过**。换库要重跑全部 486 条断言，
   尤其 `D6`（并发事务要拿到不同连接）—— 它在 PGlite 上是 SKIP，而池化路径的风险全在那一条里。

下一轮我会从这里开始：**真 PG**，然后**界面的自动化测试**（现在只有 25 张实拍 +
5 条响应头断言，改了渲染只有人打开页面才会发现）。

---

## 八、外部约束（不是技术问题，但会决定你写的代码能不能交付）

- **品牌脱敏**：产出中不出现任何真实客户名、品牌名、真实门店/供应商/会员名。
  种子数据全部虚构（A店/B店/C店、甲劳务服务、候选人甲），不要引入真实名字。
- **不越级定性**：这是切片，不是"已上线/已验收/已签约"。文档与界面文案都不许这么写。
