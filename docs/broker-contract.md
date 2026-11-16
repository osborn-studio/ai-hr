# 领域REST/Broker契约 V1

本契约由ty-hr定义，不是钉钉或千问尚未公开的私有API。云数据库适配器须显式配置能力、查询和命令三个HTTPS地址及服务端凭据；接口路径可通过环境变量对接真实提供者。浏览器只访问同源Node，不接触数据库口令或Broker服务凭据。

## 启动和身份

`TYHR_DATA_MODE=broker`不创建PostgreSQL连接、PGlite、物理帐套数据库或后台Node子进程。单个Node进程提供React构建、登录与业务REST。正式PostgreSQL模式使用`TYHR_DATA_MODE=postgres`和`DATABASE_URL`。未指定连接会失败；`pglite_demo`只允许明确的非生产隔离演示。

GET能力探针须返回：

```json
{"protocol":"tyhr-domain-port/1","atomic_commands":true,"session_identity":true,"scoped_authorization":true,"idempotency":true,"decimal_strings":true}
```

声明这些能力只能通过客户端准入检查，不能取代提供者实际事务、授权及并发验证。缺能力或无法连接不能伪装就绪。Node对每个业务请求先调用`auth.session`，取得服务端绑定的`userId`；业务命令必须在同一原子执行中重新验证有效会话、角色、范围、字段、状态及版本。

保留认证操作：`auth.login`、`auth.session`、`auth.me`、`auth.capabilities`、`auth.password`、`auth.logout`。真实提供者负责口令摘要、限流、过期与吊销。除登录外不能接受客户端指定操作者或角色。平台只提供表CRUD时，必须增加合格领域网关/RPC；不能逐条REST SQL模拟事务和pg_temp会话授权。

## 查询和命令

查询请求POST至配置的查询地址；命令POST至命令地址：

```json
{"protocol":"tyhr-domain-port/1","name":"leave.adjustment.apply","input":{"id":123},"context":{"userId":7,"sessionToken":"SERVER_BOUND_SESSION"},"request_id":"trace-uuid","operation_id":"STABLE_OPERATION_UUID"}
```

`operation_id`仅命令必需，客户端通过`Idempotency-Key`提供并保留至得到确定回执。Node生成追踪号不代替业务幂等号。经济义务还必须有稳定来源根，不能以换操作号规避重复发放。所有金额及额度为精确Decimal字符串，日期、分钟、时区和版本显式。

查询返回`{"result":...}`。命令还返回：

```json
{"result":{"adjustment":{"id":123,"status":"applied"}},"receipt":{"operation_id":"STABLE_OPERATION_UUID","atomic":true}}
```

命令原子完成当前授权、基线校验、状态/余额更改、业务幂等记录及outbox。失败整组回滚；同号同内容重试返回原结果但重验当前读取授权；同号不同内容冲突。过期、撤权、字段权限变化不得借旧回执下载历史敏感载荷。提供者应提供按原操作号对账能力及稳定业务回执，不能要求失败后换号。

网络超时、无效JSON、丢失或不匹配回执均为`E_BROKER_EXECUTION_UNKNOWN`，Node不会自动再次发写请求。必须用原编号查验，保留未知占用。查询失败是暂不可用；不能把失败响应当空数组或0金额。服务凭据不得放URL或前端资源，禁止向重定向目标转发凭据。

## Node入口

POST `/api/v2/query/{registered_name}`用于只读查询；POST `/api/v2/command/{registered_name}`用于所有持久写入。表单体直接为input。即便“预演”会创建待复核意图，也必须使用command（例如`leave.adjustment.preview`）。未登记名称及任意SQL接口不开放。

现有REST兼容映射和领域注册表逐模块迁移，未开放的路径明确404，不能调用旧页面或返回模拟成功。Broker客户端及HTTP壳已用独立回环提供者验证；具体千问/钉钉云数据库尚须接实际契约进行沙盒适配，不能据此宣称已经外部实连。
