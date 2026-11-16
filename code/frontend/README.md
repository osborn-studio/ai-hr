# 天意HR React前端

React + Vite，生产构建由同一个Node应用服务托管。源码在本目录，构建产物为 `code/dist`，不是第二个生产前端服务。

在 `code` 目录安装依赖和运行：

```sh
npm ci
npm run dev
npm run build
npm run test:frontend
npm run test:frontend-ui
```

需要Node >=22.12；开发服务默认127.0.0.1:5174，`/login`及`/api`代理到127.0.0.1:8787。可通过 `TYHR_API_TARGET`调整开发代理。生产 `npm start` 使用 `app/cloud-server.mjs`，数据连接由服务端显式配置。

正式仓库只保留 `code/package-lock.json` 一个依赖锁；本目录不单独生成锁。React、Vite等前端依赖放本workspace中，后端原有依赖仍留code根。

当前已接登录、会话、授权与范围、工资批次/规则查看/试算/确认/CSV、组织树、花名册与人员经历，以及新高级假期领域接口。未接的导航页面明确显示不可办理。浏览器菜单和按钮只改善体验，业务授权仍由后端实施。

`test:frontend-ui`使用独立全虚构REST夹具和隔离无头浏览器，不连接应用数据库，也不代表真实工资、审批或外部平台已验收。需有Chrome/Chromium，可用 `CHROME_BIN`指定；测试截图位于忽略的 `test-artifacts`，不得提交。该测试不依赖用户正在使用的浏览器配置。

高级假期命令通过 `src/commands.mjs`保存稳定操作号。首次发送前必须保存成功；失败或结果未知保留原号和冻结内容，重试原样发送。未知结果不能直接丢弃；已明确拒绝的命令可以经用户核对后关闭。

当前边界：工资规则可视化编辑、新建工资导入、完整人员字段维护、假期Excel文件预检、历史长表继续分页等还需扩展；这些入口不伪装成已完成。读取现有批次和人员均使用真实REST，不嵌入旧页面。
