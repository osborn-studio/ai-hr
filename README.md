# 天意人力资源系统 · ty-hr

专门服务餐饮集团、多品牌、多门店的人力资源系统。以员工工资和企业人力成本为结果，以人事组织为底座，优先建设薪酬、高级排班考勤及绩效。

## 当前进度

- 已有可运行的React工作台、单Node服务、PostgreSQL及显式演示帐套；已实现范围与后续工作见[开发进度](docs/development-status.md)。
- 已统一总体及各专项设计；设计目录中的页面、接口和验收项是开发规格，不能视为已经实现。
- 原生组织花名册、入转调离与编制、招聘合同、高级排班日报月报、假期、工资来源与两地薪税、绩效评分及奖金、宿舍证照领用已有实际接口和PC/手机页面。系统权限、表单设计器与统一审批已接业务来源；其余模块继续按[全模块清单](docs/module-acceptance.md)开发。
- 检查点见[供应商用工、工资资金与公式扩展](docs/releases/20261117-workforce-finance-scripts.md)、[排班假期统一审批](docs/releases/20261117-time-workflows.md)、[平台登录与通知门户](docs/releases/20261117-platform-login-notices.md)。演示工资确认、站内发布、实际支付与税务申报分别记录；测试政策示例不作为现行法定政策包。
- 测试组织仅使用天意集团、香香鱼米、大富烤肉及中文假名。客户原件、数据库、口令、环境文件、研究中间件不进入仓库。

## 设计与开发

- [总体功能设计](docs/design/overall.md)：薪酬第一、排班考勤第二、绩效第三，组织人事与权限先行。
- [设计目录](docs/README.md)：组织、薪酬、排班假期、招聘合同、绩效、培训考试、证照、宿舍、用工协作及集成。
- [云端架构](docs/cloud-architecture.md)：React构建由一个Node服务托管，数据经领域命令和查询接口访问。
- [开发约定](AGENTS.md)：迁移、事务、权限、公式、演示数据和验收边界。

## 本地启动与检查

需要Node.js 22.12或以上。安装、构建及检查：

```sh
cd code
npm ci
npm run build
npm test
npm run test:frontend-ui
npm run test:platform-ui --workspace frontend
```

配置部署环境变量后使用`npm start`；也可按`.env.example`配置本地`.env`，运行`node --env-file=.env app/cloud-server.mjs`。正式入口要求显式PostgreSQL/Broker连接，核心空库不会自动建立演示用户或帐套。

React工作台为`/`；存活及就绪探针`/livez`、`/readyz`。账号与演示数据必须显式初始化，初始口令由本地安全配置提供，不在仓库公布。原`serve`和`/workspace`保留供原业务验证，默认PGlite内存模式重启清空，不能用于生产。

## 云端复制边界

目标是React + Node单进程 + PostgreSQL兼容REST/Broker。平台必须支持所需事务或领域级原子RPC；不能把多条SQL拆成无状态HTTP调用。千问云端具体数据库能力及Broker契约需要配置和适配验证，不能仅凭静态页面能打开宣称全系统迁移成功。

历史迁移和有用业务代码保留用于可验证复用；旧截图、重复过程文档及无用提取工具已从工作树移除。历史仍可在Git中追溯，当前文档以本目录为准。
