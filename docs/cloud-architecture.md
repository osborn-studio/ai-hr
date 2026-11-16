# 天意HR云端架构审查 V1

日期：2026-11-17。状态：只读审查及迁移建议，未改应用、迁移、账号或数据库，未运行应用及回归测试，未发布云端。

## 1. 本轮已接受的架构决策

当前正式开发基线为 **React 构建产物 + 一个 Node HTTP 服务进程 + 一个部署数据库**。Node 同源提供网页静态资源和业务 REST；集团、品牌公司、门店及业务帐套为数据库中的逻辑范围，同一集团永久人员身份贯通。不同客户的隔离不因逻辑帐套合并而放松。

生产必须显式配置 PostgreSQL 或满足本报告原子性要求的真实 Broker；PGlite 仅保留为隔离测试或明确标识的本地演示。正式启动不得因缺少数据库配置而悄悄退回内存库。React 开发服务器不是生产所需的第二个常驻进程；生产运行构建后的静态文件。

保留旧迁移与已存在的事务规则，逐域建立新应用服务替换旧入口。不是把全部旧 SQL 或全部前端重新手抄，也不是把 `query(sql)` 改成无状态 HTTP 后宣称完成迁移。领域数据口采用 `executeCommand / queryView`；Broker 以真实、可配置、可验证的契约接入，未核验的平台能力不标记为已接通。

主任务负责人已接受以上方向；用户要求的先补假期设计、清理并同步 GitHub，再进入正式代码开发的顺序继续有效。

## 2. 阅读范围与可信边界

已读开发根 `AGENTS.md`、`code/package.json`、`app/db.mjs`、`app/registry.mjs`、`tools/migrate-checked.mjs`、`compose.yaml`、`Dockerfile`、根及 code 的忽略规则；定向读 `server.mjs` 的初始化、迁移、写读封装、静态路由、会话及建库入口；读 `workspace.html` 及 `workspace.mjs` 的状态、导航、请求、主路由和旧页嵌入；定向读或检索 foundation/guard/persona/session/auth、公式引擎、导入、钉钉适配及 PDF 代码。

这不是对 210 个 SQL 文件、77 个服务或全部功能的重新逐行验收；没有访问业务数据库，没有读取真实客户表格或任何明文口令文件。仓库状态只做只读查询；不根据旧说明中的测试条数宣称当前全部测试通过。

文件盘点来源为当前目录扫描：

| 项目 | 当前实际文件事实 | 含义 |
|---|---|---|
| SQL 迁移 | 001–210，共210个，编号连续 | 迁移历史应保留；文件存在不等于生产数据库已应用 |
| app 直属文件 | 26个 | 包含前端、服务器、数据库及通用导入导出工具 |
| app/services | 77个文件 | 混合旧业务服务、新ty域服务、虚构演示初始化服务 |
| app/server.mjs | 6,183行 | 同时承载启动、种子、路由、事务、静态网页和部署相关路径 |
| app/index.html | 10,573行 | 原业务大页，约597KB，非React |
| app/workspace.mjs | 404行，约57KB | 原生ESM，较多长行及HTML字符串，不是React组件 |
| test 直属文件 | 36个 | 是复用候选验证资产，不等于本轮已实跑 |
| tools 直属文件 | 24个 | 必须区分部署、初始化、备份与本机辅助职责 |

## 3. 现状到底是什么

### 3.1 前端与HTTP

`package.json` 的运行依赖只有 PGlite，`pg` 为可选依赖；没有 React、ReactDOM、Vite 或前端构建脚本。现有前端由 `workspace.html` 加载原生ESM，并通过 `innerHTML`、事件监听和 hash 路由渲染。新版工作空间仍将大量旧业务放进同源 `iframe`，通过 `postMessage` 传入会话及组织上下文。菜单既有“组织全景”又有“组织机构图”，还有“兼容员工档案”“兼容排班工具”等旧结构；这与V16已经统一的菜单和用户措辞不一致。

Node 使用 `node:http.createServer`，同一进程提供 `/workspace`、旧 `/` 页面及 `/api`。生产端口读取 `PORT`，主机读取 `HOST`，默认回环；容器显式设 `0.0.0.0`。已有 `/livez`、`/readyz`、响应安全头、CSP nonce、有限请求体、写限流、业务错误映射、数据库会话与吊销。**源码顶部“内存Map、无限流”等旧切片注释已经落后于实现**，不能沿用它来否定当前已有安全能力，也不能据此认为整套已达生产验收。

### 3.2 数据库与事务

`createDb({url,dataDir})` 中：有 `url` 使用 node-postgres Pool；无 `url` 使用进程内 PGlite；PGlite 不传目录则为内存库。`npm run serve` 默认会建内存库，`serve:persist` 走 `./.data`。正式部署需取消这种隐式内存兜底。

`withTx` 的 PostgreSQL 实现取同一个 client 运行 `BEGIN/COMMIT/ROLLBACK`；PGlite 通过互斥队列避免单连接并发事务串扰。旧行权限依赖 `app_init_session()` 创建的 `pg_temp.tmp_scope_*` 临时表，`app_begin_scope()` 将当前权限灌入，再执行数据查询。因此**事务、授权和同一物理连接属于同一契约**。

数据库建表、约束、触发器、业务函数已大量进入210个迁移。Node服务不是独立于PostgreSQL语义的通用CRUD层。即使某个云数据库宣称“PostgreSQL兼容”，还须核验 PL/pgSQL、`btree_gist`、排他约束、临时表、事务锁、JSONB、数值及日期语义；“有SQL查询”不是全部兼容的证据。

### 3.3 启动、迁移与帐套

空库启动会顺序执行迁移并登记文件SHA256；存量库启动只警告待迁移，不自动追平。`migrate-checked.mjs` 要求可信账本、核对全部已应用文件哈希、指定连续迁移并加事务锁，是可保留的增量迁移基础。启动遇到缺迁移但继续提供业务的旧行为，应在新生产模式改成 readiness 未就绪或显式拒绝相关业务，不应只靠日志提示。

`CONTROL_URL` 触发的是**旧物理多库帐套**：控制库登记 `db_name`，token前缀选库，按库开连接池；开帐请求还会 `spawn tools/new-ledger.mjs` 执行 `CREATE DATABASE`。这不是新ty域的集团—品牌—门店逻辑帐套，也不支持在一个网站只有一个托管数据库的条件下照搬。新正式入口不应默认启用这条路径；旧库已有历史可保留和明确迁移，不能直接删除。

## 4. 可复用、要适配、应替换的边界

| 部分 | 精确代码位置 | 处理建议 |
|---|---|---|
| 数据库连接/事务归属 | `code/app/db.mjs:50`、`:216`附近 | 保留pg事务基础和隔离测试驱动；生产显式配置，补失败释放及能力检查 |
| 迁移账本/核验 | `code/app/server.mjs:128`起、`code/tools/migrate-checked.mjs` | 保留文件顺序和哈希，部署步骤独立于业务请求；不修改已应用迁移 |
| 业务错误与下载工具 | `code/app/errors.mjs`、`csv.mjs`、`download.mjs`、`xlsx-write.mjs`、`zip.mjs` | 复用单一写出、转义、防公式注入、下载命名；继续共享授权后取数 |
| 公式计算 | `code/app/services/customer-payroll-engine.mjs:30`、`:82`、`:106`、`:210`、`:295` | 无eval的AST及BigInt有理数运算是优先复用候选；仍需按V8扩展作用域/引用/依赖/调试，不宣称已满足全部高级规则 |
| 会话及口令摘要 | `code/app/services/session.mjs`、`auth.mjs` | 可复用生成、摘要、吊销及数据库记录；实际身份和权限仍由后端判定 |
| 旧权限边界 | `code/app/services/guard.mjs:29`、`:66`，`db/001_core.sql:36`、`:193` | PostgreSQL旧域先保留；新域统一服务端上下文。不能移到前端菜单，不能拆成多次无会话REST |
| 新集团身份与关系 | `code/app/services/foundation.mjs:28`、`:105`、`:154`、`:206`；`db/193_tyhr_foundation.sql`起 | 复用永久人员、组织、雇佣任职概念和现有守卫，按V9统一全貌/事件/历史授权 |
| 旧新域桥接 | `code/app/services/foundation-bridge.mjs`、`db/210_tyhr_legacy_service_guard.sql` | 作为迁移期明确映射保留；普通映射不能自动扩大业务权限，最后按域撤下桥接 |
| 现有导入解析 | `code/app/xlsx.mjs:90`、`services/customer-payroll-import.mjs:18`、`foundation-import*.mjs` | 复用已有限制及格式理解；统一暂存/校验/预演/提交/幂等/审计，不把客户模板当唯一模型 |
| 排班/假期/绩效/考试 | `services/advanced-time.mjs`、`leave*.mjs`、`roster-*.mjs`、`perf*.mjs`、`exam*.mjs`、`training.mjs`与对应SQL | 先建立V7–V16对象动作对照，按真实语义复用；本轮未逐项重验，不直接搬旧页面或把旧功能名当完成 |
| 前端纯函数 | `code/app/scope-tree.mjs`、`organization-view.mjs:9–10` | 层级/时点辅助函数可抽为无DOM模块；只是展示或测试辅助，不能代替后端数据权限 |
| 当前前端视觉和交互 | `workspace.css`、各 `*-ui.mjs` | 可参照样式、表格和已经可用的交互，再改成React组件；旧shell/iframe不作为正式统一体验 |
| 钉钉适配 | `code/app/services/dingtalk.mjs:23`起 | CLI输出转中间结构可参考；依赖本机已授权dws，不能当客户云端应用OAuth实现 |
| PDF | `code/app/pdf.mjs:39`、`:63`、`:99` | 本机Chrome路径+子进程不可作为云端默认前提；打印HTML/取数复用，服务端PDF适配独立能力，缺能力明确回退浏览器打印 |
| 虚构演示种子 | `services/test-workspace.mjs`、`test-accounts.mjs`及相应init工具 | 保留显式确认、可重跑及不重置口令的约束；正式启动与演示初始化分离 |

这里列的是可复用候选，不是每个候选已通过全部新设计验收。已有单元/SQL/API测试应跟随对象行为迁移，旧UI源码扫描类测试不能替代新React交互验收。

## 5. REST/Broker必须解决的契约

### 5.1 领域数据口，而非裸SQL代理

以下是天意拟定的内部接口名称，**不是钉钉或千问的公开API**：

```ts
queryView({ view, principal, tenantContext, filters, page, sort, asOf })
executeCommand({ command, principal, tenantContext, commandId,
                 expectedVersion, payload, effectiveAt })
getCommandResult({ tenantContext, commandId })
```

`principal` 必须来自Node已经验证的会话或受信任服务身份，不能由请求体指定他人账号；客户/集团上下文必须与会话授权求交集。前端只能调用白名单业务命令和授权投影，不能选择表名、SQL、权限临时表或任意HTTP目标。

PostgreSQL实现可在一次 `withTx` 内调用既有服务和SQL规则，先形成可运行纵切。Broker实现必须将同一命令需要的授权核验、状态比较、约束、幂等占位、业务写入、额度/采用/义务账和outbox作为一次可证明的原子提交；也可由一个受控远程领域命令服务承接。如果Broker只有单表CRUD，没有事务/RPC/并发比较能力，不能伪造客户端补偿来声称等价。

### 5.2 适配能力准入表

| 能力 | PostgreSQL本地实现 | Broker/云端必须提交的真实证据 |
|---|---|---|
| 身份与隔离 | 服务端会话+授权事务 | 认证方式、租户边界、凭据归属，不能把管理员数据库密钥发前端 |
| 原子命令 | 同一pg client事务 | 多写事务/原子批次/RPC的真实入口、参数、错误及回滚语义 |
| 并发 | 唯一约束、锁、版本比较 | compare-and-set或等效串行保证；两个请求不能均消费同一额度 |
| 幂等与未知结果 | 稳定命令键+结果账 | 重试相同键返回原结果；超时先查结果，不盲目再次发款或扣结 |
| 数据类型 | NUMERIC、日期、时区、JSONB等 | 金额与ID以无损格式收发；日期不是任意时间戳截取；空值不能误变0 |
| 权限 | 旧同连接作用域+新领域守卫 | 同一授权规则覆盖PC、手机、API、导入、导出及异步任务 |
| 状态与外发 | 业务状态+outbox | 原子持久化事件；投递重试不能再次发生业务或资金事实 |
| 读投影 | 按授权筛选分页 | 服务端过滤、字段掩码、稳定排序/分页和数据量限制 |
| 制度/迁移 | 可信哈希账本 | schema版本、兼容矩阵、回滚/恢复方案，不猜测已应用历史 |
| 启动及运行 | `PORT/HOST`、readiness | Node版本、进程/端口、超时、内存、可写目录、休眠唤醒及外网访问范围 |
| 文件 | 本地临时文件或受控存储 | 持久附件/下载有效期/授权/签名；临时磁盘不能充当唯一资料库 |

每个适配器应显式报告 `configured / contract_verified / sandbox_verified / live_authorized` 等阶段，不能因环境变量存在就显示“已接通”。当前Broker阶段为 `pending_contract`，未提供具体endpoint、未申请授权、未做实连。

### 5.3 只开放REST时的两种合法路径

1. 平台提供足够的事务或领域RPC：实现Broker适配，通过同一组命令契约测试后逐域切换。
2. 平台数据库接口不足，但允许访问受控后端：在经确认的基础设施部署同一Node领域服务及PostgreSQL，前端通过受保护REST访问。这个方案依赖额外后端基础设施，**不能称为仅复制进平台托管环境就完整运行**。

若两者都不具备，仍可交付前端演示，但不能把工资扣结、假期额度、审批生效等业务写入降成多次不原子的CRUD来满足“能打开页面”。

## 6. 一个部署数据库和逻辑帐套

正式基线使用一个数据库连接配置，不用 `CONTROL_URL` 再为每家店建物理库。客户/集团信任边界、集团、品牌公司、门店经营公司、部门、档口、岗位和业务帐套分别有稳定ID。永久人员身份不以门店库、姓名或登录名作为主键。

同一集团的跨品牌入离转调记录在同一身份下关联；权限仍可只授权某品牌/门店的当前或历史片段。业务帐套用于制度、核算及办理范围，不等同独立法人；CN/HK算薪能力按公司/门店明确启用，单启用/双启用与币种/付款主体分开配置。

迁移期要保留旧外键和桥接，不在一次页面重构中顺便搬移未知客户数据库。新建全虚构开发库可从可信迁移初始化；旧存量库须先核账本、版本和映射，再按独立方案迁移。不开启普通HR的建库能力。

## 7. 最小可运行迁移路径

| 顺序 | 交付 | 完成判据 |
|---|---|---|
| 0 | 补齐高级假期专项、明确仓库当前入口/历史归档/忽略规则，完成用户授权的GitHub同步 | 新设计仍为设计，未完成细则不伪装代码；同步记录可核对 |
| 1 | 更新开发契约，锁定React+Node单进程、生产pg/Broker显式配置、一个部署库、统一身份及领域端口 | 不改已应用迁移；旧AGENTS与新授权冲突处有明确新规则 |
| 2 | React构建骨架、统一设计token和V16导航，Node托管构建静态资源 | `build`后不需Vite常驻；同一Node端口能打开深链，静态资源正常且CSP不过度放开 |
| 3 | 选PostgreSQL适配完成真实最小纵切：登录→授权上下文→人事花名册分页/员工全貌→一项有审计的维护命令 | 用隔离全虚构数据库，跨品牌/字段/操作拒绝有效，ID/日期无损，重启不丢数据 |
| 4 | 实现假期的最小闭环、日报月报版本与工资输入；再进入薪酬核心 | 客户必要法定规则可配置；额度、审批、生效、采用历史可追溯，不仅有菜单 |
| 5 | 工资计算→输入追溯→绩效/其他结果采用→复核确认→工资单；资金执行另设已核路径 | 统一取数、金额和版本，未真实接银行/税局不得显示已发薪/已申报 |
| 6 | Broker真实契约及沙盒纵切 | 相同命令、权限、幂等、并发和恢复用例在两适配下通过；平台未开放能力逐项留待核 |
| 7 | 逐模块替换旧页面及旧新映射，移除已证明无引用的兼容前端 | V16功能不丢，实际交互验收通过；旧页面撤下不等于删除迁移与历史数据 |

不建议第一步引入微服务、多个Node守护进程、独立BFF、另起第二套账号或第二套人员身份。构建期可以编译和检查，生产只运行一个应用HTTP服务；数据库是外部服务，并不意味着要求把数据库也塞进Node进程。

## 8. 清理清单：现在可排除什么，何时才可删什么

本轮没有删除任何文件。以下为清理分类，防止“无用物”误伤业务和历史。

| 类别 | 对象 | 建议动作与前提 |
|---|---|---|
| 不应进入发布包 | `node_modules/`、缓存、日志、`.DS_Store`、本地虚拟环境、测试截图/渲染中间件 | 依赖按lock重建；源码包只保留所需输入，交付报告和证据放本地环境而非应用运行包 |
| 永不进入公开仓库 | `.env*`中真实配置、`.runtime/`、`workspace-access.json`、`test-accounts.json`、真实原件、数据库dump、备份及访问凭据 | 根.gitignore已有相应规则；需检查tracked/untracked覆盖，不能把忽略规则当已清历史提交的证据 |
| 可合并重复脚本入口 | `test:workbench/test:customer-ui`，`test:login/test:login-name`，多个init/test别名 | 保留一个推荐命令，旧别名可以过渡期保留；删之前查CI、文档及调用引用，不影响测试本体 |
| 需修旧注释/说明 | server开头“内存Map/无限流”等、AGENTS旧依赖数/测试数/旧首页说明、compose旧口令提示 | 更新为当前可核实现及正式部署方式；不抄写过时口令到新公开文档 |
| 明确不可达分支候选 | `workspace.mjs:168` 的 `route==='organization'` | 更前面的组织/编制分支已经返回；可在新React迁移时移除重复分支。对应模块还有可复用时点辅助函数，不能因此整文件盲删 |
| 替换后才撤下 | `index.html`旧大页、workspace旧shell、iframe桥、legacy-theme及各旧UI模块 | 先列路由/能力/测试对照，替换完成再停止发布；当前旧业务仍有依赖，不能立即当废文件 |
| 从正式请求剥离 | 旧 `provisionLedger`、`CONTROL_URL`多物理库路由、`new-ledger`开库脚本 | 新逻辑帐套走领域命令；旧运维脚本可归档/显式工具保留，不让云应用拿建库特权 |
| 本地辅助而非云默认 | dws进程、Chrome子进程、本机固定路径、PGlite持久目录、PG备份工具 | 设计运行时端口替换；保留本地工具或明确可选能力，不能简单删除导入、打印、备份业务能力 |
| 必须保留 | `db/001–210`、可信迁移账本约定、必要测试、只读交接史、V7–V16权威设计 | 归档重复说明可以，不能为“清爽”改历史迁移、删验收或将待开发标记改成完成 |

当前metadata只确认开发code下存在 `node_modules`；没有据此宣称存在或已经清除了运行库/凭据文件。同步GitHub前的具体删除由主任务执行并记录。

## 9. 正式编码前需关闭的具体技术缺口

1. **生产模式失配**：缺配置现在回落PGlite内存；改为明确失败并保持readiness不就绪。
2. **Broker事务能力未确证**：先固定领域命令、幂等结果与原子写边界，再按真实契约实现；不得发布前端数据库密钥。
3. **连接失败归还**：`db.mjs` 的 `_checkout` 在 `initOnce` 抛错、`withTx` 在第二次 `app_init_session()` 抛错时，尚未进入负责release的finally；后续应保证已取得的client无论初始化成败都归还/销毁，避免连接池耗尽。此为静态代码发现，本轮未故障注入验证。
4. **类型契约**：旧pg parser把所有int8转Number，很多接口进一步Number化ID；新端口采用字符串ID和十进制字符串金额，迁移期做显式兼容，不把超出安全整数的ID静默舍入。业务日期和时刻分类型并附时区。
5. **授权组织不统一**：旧四维临时表、新ty_access_grant、演示profile和前端菜单是不同层；应统一政策求值契约，逐域替换，不能以profile白名单或菜单隐藏作为唯一后端权限。
6. **业务审计与outbox**：`runWrite`目前业务提交后另事务写请求日志。失败请求留痕可保留事务外；正式命令的权威业务审计、版本、占用/采用和outbox需在同一业务事务，投递状态独立。不能把“请求日志存在”当V16全部联动已经原子化。
7. **构建和静态托管**：旧Docker只复制app/db，不构建React；需构建阶段、受控assets路径、404与SPA fallback区别、缓存hash、版本清单和CSP；未知 `/api` 不得回首页HTML。
8. **单进程任务可恢复**：导入、算薪、报表及outbox处理使用持久任务+租约/检查点，重启可续，不能只存内存timer；云端是否允许后台长任务及休眠待核。若需要外部调度，属于明确运行依赖，不伪装单进程已解决所有限制。
9. **文件/PDF与平台授权**：外部连接、附件、PDF、备份分别适配；平台网页登录/站点密码不替代天意的操作人员、字段与数据权限。

以上是可开发的准入项，不代表现系统已发生数据泄露或业务事故。

## 10. 官方公开资料与不确定性

查阅日期为2026-11-17，只读公开文档，没有调用企业业务API。

| 官方来源 | 阅读范围与确证事实 | 对天意的推导/边界 |
|---|---|---|
| [React：Add React to an Existing Project](https://react.dev/learn/add-react-to-an-existing-project) | 现有项目渐进接入、模块/JSX构建、Vite选项和子路由静态输出 | 可以渐进替换旧UI；不需要把旧Node服务改成多个运行进程 |
| [React：Build a React app from Scratch](https://react.dev/learn/build-a-react-app-from-scratch) | 构建工具章节：Vite/Parcel/Rsbuild及构建产物 | 本项目已有后端，拟用React静态构建；这是天意工程选择，不是官方指定其为HR架构 |
| [Vite：Getting Started](https://vite.dev/guide/) | 前提与react-ts模板；当前文档列Node 20.19+、22.12+ | 锁定依赖后选择本地与平台均支持的Node版本，不能只写“Node22”而不核最低小版本；未核平台Node版本 |
| [Node HTTP](https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener) | createServer、listen、响应及请求超时章节 | 同一HTTP服务可以分发静态及API；不由此证明平台支持全部系统调用/后台任务 |
| [node-postgres：Transactions](https://node-postgres.com/features/transactions)；[官方仓库同页源文](https://raw.githubusercontent.com/brianc/node-postgres/master/docs/pages/features/transactions.mdx) | 官方源文0–35行，事务使用同一client、rollback及finally释放 | 支持保持本仓同连接事务；不能跨数次任意HTTP自动获得同一事务 |
| [PostgreSQL CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html) | TEMP和ON COMMIT章节，临时表及保留行行为 | 临时作用域不是普通REST请求天然具备的能力；需适配器明确证明会话保证 |
| [千问办公：我的网页](https://www.alibabacloud.com/help/zh/qwenwork/my-webpage) | 官方页面2026-10-30，定向读动态网站、数据库和限制 | 明确有Node后端及可选托管数据库；每站一个数据库，挂载后不可替换；**没有在此文确证数据库类型、pg直连、SQL函数、事务Broker或备份接口** |
| [千问办公：平台功能](https://help.aliyun.com/zh/qwenwork/platform-features/) | 网页、文件、扩展及任务概述；中国站my-webpage路径查阅时重定向此页 | 概述不能替代具体部署接口和能力契约；国际站详细说明与目标账号实际开放范围仍须一致核对 |
| [千问办公：连接器](https://help.aliyun.com/zh/qwenwork/qw-connectors-1) | MCP Streamable HTTP/SSE、STDIO连接章节 | AI连接器与应用托管数据库Broker是不同能力，不能混同；不把能接MCP当可原子更新工资账 |

公开搜索还使用了钉钉、阿里云及千问官方域的“Broker/REST/数据库/Node.js/网页”定向组合；未找到足以落地本系统数据库Broker的公开方法、路径及权限规范。排除第三方教程、社区转载和不能确认归属的“千问AI平台”站点作为架构依据。这里的“未找到”只是本轮查阅结果，不是宣称平台永远不提供。

## 11. 迁移验证的最小集合

下列为之后开发需实跑的检查，不是本轮测试结论：

1. 一次构建后仅一个Node应用进程与外部PG/Broker配置，首页/深链/API/404资源各正确。
2. 正式缺配置拒绝启动或readiness为否；进程重启后业务与会话按制度保存，不偷偷落入空库。
3. 同一虚构人员跨两个品牌保留永久ID，品牌HR只看到被授权片段，集团HR可穿透全部授权经历。
4. 前端隐藏动作仍不能通过直接API、导入或导出绕过功能/字段/数据权限。
5. 两个并发命令竞争同一额度或采用义务，只能成功一次或按合法区间拆分，不超额不重复。
6. 业务写入后outbox创建失败时全部回滚；通知失败只重投，不重复批准、扣假或算薪采用。
7. Broker超时未知后，查询相同commandId得到既有结果；不自动释放未确证占用，不双发。
8. PG连接初始化失败和事务回滚后连接可正确释放，后续请求权限不串人。
9. 金额、超大ID、香港/内地日期和跨午夜时刻在两个适配的JSON往返中无精度/日期丢失。
10. 可信迁移账本缺失/哈希漂移/顺序遗漏会停止相关部署，不自动承认历史；旧迁移保持不变。
11. 上传压缩文件受大小/解压量/格式限制；导入暂存、预检、审批、生效和幂等覆盖断网重试。
12. 浏览器打印、服务端PDF能力状态、附件及集成运行状态如实显示；没有真实授权的连接不能标为实连。

本轮结论：现有服务、规则、测试和纯函数有明显复用价值；前端shell与部署/数据接入边界需要重构。先以PostgreSQL跑通同一Node+React的完整纵切，再用真实Broker契约证明可迁移性，才能把“能完整复制”从架构目标变成可验证结果。
