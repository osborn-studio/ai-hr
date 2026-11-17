# 部署与初始化

本说明适用于当前 React 与单 Node 标准应用。首次业务建帐和完整演示建库是两个显式过程，使用不同数据库。已有数据库及原确认工资保持原样，不把完整演示生成器用于升级。

## 安装与构建

使用满足 `code/package.json` 要求的 Node.js，安装锁定依赖后构建：

```sh
cd code
npm ci
npm run build
```

PostgreSQL 必须具备[运行架构](cloud-architecture.md)列出的事务、扩展和约束能力。应用运行账号、数据库及扩展由部署方准备；标准应用不会申请创建物理客户数据库。网页与 API 由同一 Node 进程提供。

## 首次业务建帐

在代码仓库外保存受控环境文件，或由部署环境注入变量。参照 `code/.env.example` 配置 `TYHR_DATA_MODE=postgres`、`DATABASE_URL`、监听地址、端口和运行模式。设置稳定的 32 字节 Base64 集成密钥；人员原件可使用独立数据密钥。密码、密钥和数据库连接串均保留在服务端。

空数据库显式初始化技术管理员：

```sh
node --env-file=/absolute/private/production.env tools/init-workspace.mjs
node --env-file=/absolute/private/production.env app/cloud-server.mjs
```

初始化工具不创建演示集团、员工或工资。技术管理员初始访问资料写入 `TYHR_RUNTIME_DIR/workspace-access.json`，文件只允许本机所有者读取，终端不打印口令。未提供新管理员口令时，重复执行保留原凭据；明确设置 `TYHR_ADMIN_PASSWORD` 会重设该初始化账号，部署时不要无意重复注入。

登录后先建立集团帐。首次建集团时，未绑定身份的初始化管理员在同一事务中绑定为系统配置人员；当前菜单和工作范围随之刷新。随后创建品牌公司和门店，配置部门岗位、正常操作人员及当前授权。技术初始化账号只用于首次设置，完成正常管理员交接后停用。日常系统配置、集团HR、品牌HR、门店和员工分别使用自己的操作身份。生产规则、税供款主体及接口配置按实际依据核定。

## 完整演示建库

准备专门的新空 PostgreSQL 数据库与本地场景目录。在单独的受控演示环境文件中配置：

```dotenv
TYHR_DATA_MODE=postgres
NODE_ENV=development
PORT=8787
HOST=127.0.0.1
TYHR_DEMO_OWNED_EMPTY=1
TYHR_RUNTIME_DIR=/absolute/private/tyhr-demo
TYHR_NOTIFICATION_ALLOWED_ORIGINS=http://127.0.0.1:8787
TYHR_NOTIFICATION_DEMO_ORIGIN=http://127.0.0.1:8787
TYHR_PAYROLL_SCRIPT_SANDBOX=quickjs-wasm-v1
TYHR_ESIGN_ALLOW_LIVE=0
```

另外在同一受控环境设置专用 `DATABASE_URL`、本地选择的 `TYHR_OPERATOR_INITIAL_PASSWORD` 和稳定加密密钥，不把这些值写入仓库。通知演示源必须明确出现在允许列表中，不能从请求 Host 推导。

```sh
node --env-file=/absolute/private/demo.env tools/seed-complete-demo.mjs --confirm-synthetic --scene-directory /absolute/private/tyhr-demo
node --env-file=/absolute/private/demo.env app/cloud-server.mjs
```

生成器创建天意集团、两个品牌共20家门店、62名人员和77个日常账号，按顺序生成排班、打卡、假期、人事、两地工资及关联业务。它核对连续迁移及身份数量，拒绝覆盖非空库；场景索引不保存初始密码。全部案例为编写资料，不导入客户原件，不生成外部签署、平台已读或银行实付事实。

完成后访问所配置的本地端口。查看 `complete-demo-manifest.json` 及各模块场景索引，按分角色演示手册操作。重演有状态的流程时恢复到新的专用复本，保留原确认历史。

## 存量升级与备份

先停止应用领新任务，备份数据库、加密密钥、当前源码版本及受控运行设置，核对备份可恢复。使用 `tools/migrate-checked.mjs`，按实际缺失的连续编号传入 `--only`；工具核对已有账本和全部文件 SHA256。不要修改已应用迁移，不猜测或自动接受存量历史。

升级后构建前端并使用标准入口启动。`/livez` 表示进程存活，`/readyz` 表示数据库可访问；还须完成当前角色登录、菜单、字段授权、原件、工资与关键业务抽查。迁移不匹配时标准入口停止，不能用旧独立服务绕过该检查。

备份恢复需保留原加密密钥，否则恢复数据库也无法读取加密原件。外部消息或付款结果未知时先核对原操作和真实平台结果，不建立新操作号重复发送。

## 云端与企业接口

部署到千问或其他托管环境前，核验 PostgreSQL 语义或真实 Broker 原子契约、持久文件及密钥管理、HTTPS回调、出网与后台运行条件。Broker 使用服务端能力、查询及命令端点，不能把浏览器直接连接数据库或把多条 SQL 拆成逐行 HTTP 请求。

企业 SSO 和消息源需要配置精确允许的完整 origin。三平台组织人员同步、招聘和电子签分别建立连接、凭据、对照及核准配置，页面按真实状态显示待配置、待核或已完成。默认关闭真实电子签任务；开启不表示合同已签署。平台结果、站内阅读、审批和业务完成分别核对。
