# 连锁餐饮集团一体化人力资源平台 · 技术架构与 MCP 设计

> 版本 v1.2 ｜ 2026-11-14 ｜ 状态：设计定稿，供实现与运维使用
> 上游基线：`01_需求基线与关键决策.md`（v0.1）、`02_口径裁决定稿.md`（v1.1，冲突时以 02 为准）、**`02g` I8 节（工时域最终物理口径，优先级高于早前口头版本，见 §0.2b）**、**`06_架构决策记录ADR.md` Part A（A1–A15，15 项架构裁决，优先级最高）**
> 需求侧冻结口径：组织/考勤分层模型（`attendance_punch` / `attendance_daily` / `_store` / `_segment` / `period_seal`）、三维人员分类、成本分摊恒等式、日期归属三段——这些已由 research-org / research-shift / research-hro / payroll 四方对齐，本文按冻结版落表，不另立标准。
> 本次部署形态由负责人新确定，构成对 01 的**局部变更**，见 §0.2 口径变更登记。

**文本约定**：本文出现的开源组件名称仅作为技术选型标识，不含任何客户、商业厂商或竞品名称；信创组件按"内核派系 / 指令集架构"描述，不指名。全文不出现任何真实客户名、真实品牌名、真实门店名。

---

## 目录

| 章节 | 内容 |
|---|---|
| §0 | 口径变更登记与规模约束 |
| §1 | 架构总览 |
| §2 | 技术选型与论证 |
| §3 | 数据模型（核心表设计）· §3.0b 时间区间开闭口径 |
| §4 | 关键引擎设计（算薪 / 排班 / 权限 / 组织架构图）· **§4.5 断言与证据的运行层** |
| §5 | MCP 开放层 |
| §6 | 集成设计（**§6.0 权限与审批体系** 单列在 §6 之前） |
| §7 | 性能与容量 |
| §8 | 安全与审计 · **§8.2b 四张 ACL / §8.2c 事件触发器没有 ACL / §8.2d RLS 的默认保护五条机制** |
| §9 | 部署、升级与运维 |
| §10 | 风险与取舍 |
| §11 | 附录 A：工程结构与任务拆分 |
| §12 | 附录 B：共享约定（Shared Knowledge） |

---

# §0 口径变更登记与规模约束

## 0.1 本轮定死的部署形态（硬约束）

| 项 | 定稿 | 对架构的影响 |
|---|---|---|
| 交付形态 | **本地网络版 B/S**：客户自有内网服务器，浏览器访问（PC Web + 手机 H5） | 不做公网 CDN、不做小程序原生端；H5 必须能在 4G 弱网与老旧安卓机上可用 |
| 租户模型 | **单实例单集团**，一套系统只服务一个集团 | 不做租户隔离中间件、不建租户维度分库分表；但表结构保留 `group_id` 冗余列，见 §10 风险 2 |
| 组织顶层 | **集团节点是真实节点**，带集团超管角色，下挂法人 / 区域 / 门店 / 部门 | `org_unit` 必须支持自引用单根树；集团节点不可删、不可移动 |
| 部署编排 | Docker Compose 单机一键部署；可选小集群（应用多副本 + 独立数据库） | 不引入 K8s、不做服务发现；配置全走环境变量 + 挂载卷 |
| 升级 | 离线升级包 + 回滚 | 镜像 tar + Flyway 迁移脚本 + manifest；迁移必须向前兼容 |
| 授权 | License（客户名 / 模块 / 人数上限 / 到期日） | 离线校验、RSA 签名、超限降级不锁数据 |
| 信创 | **可选项**，非默认 | 数据库方言抽象层；不使用 PostgreSQL 独有且无替代的语法（见 §2.3） |

## 0.2 口径变更登记（与 01/02 的差异，仅此两处）

> 编号用「变更-N」，**不用 `C1`/`C2`**——`C` 前缀已被断言编号占用并已退役，两个命名空间重叠会让人把“口径变更”读成“校验条目”。

| # | 01 原文 | 本轮定稿 | 理由 | 影响面 |
|---|---|---|---|---|
| 变更-1 | §2.1「多租户 SaaS 为主，支持单租户私有化部署」 | **以私有化单实例单集团为唯一设计基线**，SaaS 不作为本轮目标 | 负责人已定：交付到客户内网，不依赖公网 | 见 §10 风险 2：保留 `group_id` 列但不开拦截器，未来加租户不改表 |
| 变更-2 | §2.1「门店 30–3000，员工 500–10 万」 | **容量按 30–500 店 / 500–10,000 人 / 5–50 法人设计**，索引与分区按 1 万人建，向上留 3 倍余量 | 私有化单机资源上限决定；3000 店/10 万人是 SaaS 量级 | 分区策略、连接池、算薪分片见 §7 |

**其余全部口径（四维组织、工时唯一事实源、三条工资记录红线、四态余额台账、四计薪方式、发薪批次≠薪资期间、双口径天数、双级工时校验、病假滑动窗口、转正双日期、参数化清单）一律沿用 01/02，本文不重新裁决。**

## 0.2b DDL 层面的口径增补（以 02g 的 I8 节为准，早前口头口径作废）

工时域的物理模型在评审中收敛过十几轮，**存在互相覆盖的中间版本**。下表是最终结论，前面几轮若与本表冲突，一律以本表为准。工程实现时**只按本表，不要按会议记录或聊天记录**。

| # | 项 | 最终结论（本文落点） | 被作废的旧口径 |
|---|---|---|---|
| 1 | 班段时长列 | `attendance_daily_store` 5 个**实体列**：`span/work/break_on_duty/break_off_duty/in_attendance`（PG 生成列不能跨表聚合）（§3.3.5） | 只存 `work_hours` 一列 |
| 2 | 段类型 | `hour_type` 字典表 **6 值**：`normal`/`break_on_duty`/`break_off_duty`/`ot_weekday`/`ot_restday`/`ot_statutory`，带属性列（§3.3.6） | 7 值含 `unclassified`；`seg_type` 四值 |
| 3 | 打卡关联 | 独立关联表 `attendance_daily_store_punch`，`role ∈ first_in/last_out/middle`，`UNIQUE(punch_id, role)`（§3.3.3b） | `attendance_daily_store.in_punch_id` / `out_punch_id` 两个外键列 |
| 4 | 快照 | **14 列快照（13 个 `snap_*` + `snap_utc_offset_minutes`）**，全部 `NOT NULL`，全部**禁止** `GENERATED ALWAYS`；新增第 13 个 `snap_on_duty_break_basis`（§3.3.5 / §3.3.5b；原 13 列清单见 `02g` §I8.4，需同步 +1） | 5 个 / 6 个快照列 |
| 5 | 归属日的**表达式** | `((shift_start_at AT TIME ZONE 'UTC') + make_interval(mins => snap_utc_offset_minutes))::date`，**先转无时区再加偏移**（§3.3.5c）。机制见第 17 行 | 直接对 `timestamptz` 取 `date`（`STABLE`，不可用于约束/索引）；存时区名 `snap_work_tz` |
| 6 | 成本业务日 | `payroll_cost_allocation.cost_business_date NOT NULL`；**不建 `payroll_period_bridge`**（§3.5.2） | 跨期搬运表 |
| 7 | 薪酬四期 | `attribution_period` / `pay_period`+`pay_date` / `tax_declaration_period` / `si_payment_period` 四列分列（§3.5.2） | 一列兼表归属期与申报期 |
| 8 | 合规视图 | `compliance_daily`（自然日）+ **`compliance_gap`（相邻班段，必须跨门店）**（§3.3.11） | 只有日视图 |
| 9 | 排班依据 | `snap_assignment_type` **4 值** `planned/substitute/support/fallback`，`assignment_id` 可空；另有 `snap_assignment_source` **3 值** `manual/ai/import`（决策权归属，AI 边界的数据依据）（§3.3.2 / §3.3.5） | 3 值；`date_source ∈ planned/substituted`——**该列已删除，但不要连带删掉 `snap_assignment_source`**，两者答的是不同问题 |
| 10 | 人日状态 | `attendance_status` 字典 **5 值** + `is_off_plan` **标记列**（§3.3.4） | `is_absent` + `absence_type` 二值对；`off_plan` 作为枚举值 |
| 11 | 三态字段 | `*_veto_status`（3 值）+ `*_amount_status`（3 值），**禁用 boolean**（§3.3.4） | `is_xxx_vetoed boolean DEFAULT false` |
| 12 | 分类失败 | **不产生段行** → L1 失败 → 卡 `raw` + 抛诊断；**不设 `classification_status` 列**（§3.3.4） | 写一行 `unclassified` 兜底 |
| 13 | 独立重算 | 每晚纯 SQL 直查重算，**不复用考勤服务计算函数**；纳入验收（§3.3.12） | 建议项 |
| 14 | 合规画像 | `compliance_profile` + `employee_compliance_profile`（`source ∈ matched/default_fallback/manual`），兜底取最严档（§3.3.11） | 合规阈值写在 SQL 的 IF 分支里 |
| 15 | 枚举值 | `ownership_type ∈ SELF/DISPATCH/OUTSOURCE/PLATFORM`；`legal_employment_form ∈ FULL_TIME/PART_TIME/LABOR/SERVICE`；`record_owner ∈ OWN/SUPPLIER`（两个列的不同词表，**不要统一**） | `OWN`（应为 `SELF`）；`CONTRACTING`（应为 `SERVICE`） |
| 16 | 阻断约束上线 | 一律 `CHECK ... NOT VALID` → 清存量 → `VALIDATE CONSTRAINT`（§9.5b） | 直接 `ADD CONSTRAINT` |
| 17 | `work_date` 的写入机制 | **普通列 + `BEFORE` 触发器（`fn_work_date`）+ `CHECK` 复验 + 列级 `REVOKE` + 复合外键**（§3.3.5c）。普通列在备份恢复时原值照搬 | `GENERATED ALWAYS AS (...) STORED` 生成列——**恢复时被重算**，重算出不同的值等于工资归属月变了 |
| 18 | 班段与人日的关联 | **复合外键 `(employee_id, work_date)` → `attendance_daily(employee_id, work_date)`**（§3.3.5） | `attendance_daily_id` 代理键单列 FK——只保证"挂到了某个人日"，**挂错到隔壁那天照样通过**，且这类错所有逐行校验全绿 |
| 19 | `hour_type` 的类型取值 | **字典表 + `is_active`/`deactivated_at`，只可停用不可物理删除**（§3.3.6） | 用 `CHECK` 约束枚举；或对字典行 `DELETE`（`FK` 挡住后会诱使人去 `UPDATE` 历史段行改类型，变成静默批量错分类） |
| 20 | 断言编号归属 | **以 `02g` I8.2 / I13 为准**：L0/L1/L2/C2a/C2b/L3/L4/L5 + A4/A5a/A5b/A6；**`L2b` 已退役不复用**（见 §3.3.8 退役说明）；`C` 前缀**退役、不分配新号**，旧 `C1`/`C3`/`C4a`/`C4b`/`C5`/`C6` 留行标 `deprecated`（§3.3.8） | 本文早期自造的 C1–C6 清单，且自称"唯一权威列表"——两份清单比一份死行危险，因为读者无从判断该信哪份 |
| 21 | 数据范围的表达 | **范围 = 每维度一条三元组 `(dimension, value_type, value_ids)` + `combinator`，落 `sys_data_scope_rule`；且必须有显式 deny（`sys_permission_deny`，压过一切 allow）**；四个维度封闭：`payroll_legal_entity` / `si_entity`（带参保城市）/ `cost_org` / `attendance_org`（§6.0.3） | `sys_data_scope` 的 `scope_type + org_ids_json + legal_entity_ids_json` 单维三列——`legal_entity_ids_json` **分不清是发薪法人还是参保法人**；且只能并集、没有 deny，与泛微/钉钉同一个病 |
| 22 | 审批流定义的存储 | **身份（`sys_approval_template`）与内容（`sys_approval_flow_version` + `sys_approval_node_def`）分开；发布后版本冻结，在途单据绑 `flow_version_id`**（§6.0.8） | `sys_approval_template.node_json / condition_json` 直接存节点树——运行期一改，在途单据半途换规则，事后无法复原"当时看的是哪一版" |
| 23 | 字段权限的维度 | **单列 `action` 四态 `visible/masked/editable/required` + `scene` 四出口 `list/detail/export/mcp`（`scene` 必填）；节点级无 `editable`（只能收窄）**；`is_ceiling` 为永久黑名单（§6.0.4） | 单一 `mask_type` 三档、无场景——"导出比查询更严"落不了地；节点级若可 `editable`，"谁被指派到这个节点谁就获得更宽权限"，权限随单据流动 |
| 24 | 权限配置与审批动作的 MCP 暴露 | **工具数 0**：审批动作（类型层不可达，§6.0.6）、权限配置（RL10 范围扩展到全部权限配置）、组织归属直写（RL11） | "工具清单里没有"——那不是机制，下一版加工具时无人会记得这条约定 |
| 25 | 审批流的表名 | **保留 `sys_approval_template`（身份）+ 新增 `sys_approval_flow_version`（内容）+ `sys_approval_node_def`（节点）**；调研报告用的 `sys_process_def` / `sys_process_node` / `sys_process_instance` **不落库，登记为不采用别名**（§6.0.8.1） | 按调研报告另建一套 `*_v2` / `sys_process_*`——同一概念两个物理位置，`02g` I17.3 明令禁止，必有下一次不同步 |

## 0.3 规模与峰值假设（容量设计输入）

| 维度 | 设计值 | 备注 |
|---|---|---|
| 员工 | 500 – 10,000 | 10,000 为设计上限，容量测试按此压 |
| 门店 | 30 – 500 | |
| 法人主体 | 5 – 50 | 保留 `policy_set_id` 参数集，可扩到 300+ |
| 集团节点 | 1 | 单根 |
| 组织节点总数 | ≤ 3,000 | 集团 + 法人 + 区域 + 门店 + 部门 + 班组 |
| 峰值并发用户 | 300 – 500 | 计为活跃会话，非 TPS |
| 打卡峰值窗口 | 08:30–09:30 占全天 40% | 另有 17:00–18:00 离店小峰 |
| 打卡接口目标 | **P99 < 300ms**（内部设计目标 < 80ms） | 见 §7.1 异步落库 |
| 算薪目标 | **10,000 人 < 8 分钟**（硬上限 15 分钟） | 见 §4.1.6 |
| 排班批量写 | 单次 ≤ 5,000 单元格，< 1.5s | 见 §4.2.1 |
| 批量导入 | 10 万行 < 3 分钟 | 见 §7.3 |
| 数据保留 | 打卡原始 ≤ 24 个月；工时事实 / 工资记录永久；审计 ≥ 3 年 | 见 §7.5 |
| 考勤日记录 | ≤ 5 万条/月（万人 × 22 工作日 + 兼岗多段） | ADR A13：不做读写分离的容量依据 |

## 0.4 一条贯穿全文的非功能原则（比任何单模块规则都优先）

> ### 历史事实不可变，修正走反向单据。

这条同时解决四件事，**不要在每个模块里各写一遍**：

| 场景 | 落点 |
|---|---|
| 已封账调价不回溯 | 差额走补差单（`payroll_adjustment`），工资记录原值保留 |
| 已确认工时不可改 | `attendance_daily.confirm_status='confirmed'` 后只能 `attendance_adjustment` |
| 已发布排班不可静默改 | `schedule_change_order` + 通知员工（§4.2.3） |
| 跨月补差对账一致 | 补差单带 `target_period`，与原期间可 JOIN 还原 |

工程落点：`attendance_punch` 的 DB 级 `REVOKE UPDATE, DELETE`（§3.3.3）；`payroll_record` 的 `is_current` 版本式重算（§3.5.2）；`leave_quota_ledger` 只追加（§3.4.1）；`sys_adjustment_order` 作为统一更正入口（§3.8.2）。

---

# §1 架构总览

## 1.1 分层图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 接入层  Access                                                               │
│  Nginx（TLS 终结 / 静态资源 / 反代 / 限流 / 水印头）                          │
│  ├─ PC Web  SPA（Vue3，Element Plus）                                        │
│  ├─ 手机 H5 SPA（Vue3，Vant）—— 亦可内嵌企业 IM 工作台（ADR A14）             │
│  ├─ /api/device/ 考勤设备推送入口（设备密钥签名）                             │
│  └─ /mcp        → 反代到 mcp-gateway（默认只听 127.0.0.1，ADR A1）            │
├──────────────────────────────────────────────────────────────────────────────┤
│ 协议适配层  Adapter（薄，只做翻译，不做业务）                                 │
│  ├─ WebApiAdapter    REST/JSON → Command/Query                               │
│  ├─ McpAdapter       JSON-RPC tools/call → Command/Query（含 plan 两阶段）    │
│  └─ DeviceAdapter    punch event → TenantPunchCommand                        │
│  统一职责：鉴权入口 → 参数校验 → traceId 注入 → 调用应用服务 → 统一响应包装   │
├──────────────────────────────────────────────────────────────────────────────┤
│ 应用层  Application（用例编排，事务边界，跨域协作）                           │
│  例：OnboardApplicationService / PayrollRunApplicationService /              │
│      BatchScheduleApplicationService / PublishScheduleApplicationService     │
│  只做：取参数 → 权限校验 → 调领域服务 → 开/关事务 → 发事件 → 返回            │
├──────────────────────────────────────────────────────────────────────────────┤
│ 领域服务层  Domain（业务规则的唯一居所，Web 与 MCP 共用）                     │
│  ┌─────────┬─────────┬──────────┬────────┬─────────┬────────┬──────────┐    │
│  │ 组织域   │ 人员域   │ 工时域    │ 假期域  │ 薪酬域   │ 绩效域  │ 招聘/培训 │    │
│  │ org     │ person  │ worktime │ leave  │ payroll │ perf   │ recruit  │    │
│  └─────────┴─────────┴──────────┴────────┴─────────┴────────┴──────────┘    │
│  横切：权限引擎 │ 审批引擎 │ 指标字典 │ 审计 │ 脱敏 │ 参数配置 │ 作业执行器   │
├──────────────────────────────────────────────────────────────────────────────┤
│ 数据层  Persistence                                                          │
│  PostgreSQL（业务主库 + 分区 + 时态表 + 部分唯一索引）                        │
│  Redis（会话 / 字典缓存 / 打卡幂等 / 限流令牌桶 / 轻队列）                     │
│  MinIO（附件 / 合同 / 工资条 PDF / 导入导出 / 备份）                          │
│  本地文件卷（证书 / 密钥 / 日志 / License）                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ 集成层  Integration（与外部系统/设备的边界，全部可失败降级）                   │
│  考勤设备适配器 │ 文件交换引擎 │ 银行代发报文 │ 电子签 │ 个税申报模板 │        │
│  IM / 通讯录同步（出网可选） │ 财务凭证输出 │ 出网代理（可选）                 │
├──────────────────────────────────────────────────────────────────────────────┤
│ MCP 开放层（独立进程/容器 mcp-gateway，ADR A2；业务规则仍只在领域层）           │
│  ToolRegistry │ ScopeMapper │ FieldMasker │ PlanStore │ ConfirmGate │        │
│  QuotaGuard(60/min) │ CallAuditor │ 传输：HTTP(SSE) + stdio-bridge           │
│  —— 无业务规则、无 SQL；通过 /internal/v1/* 调应用层（30s 超时 + 幂等重试）     │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 1.2 为什么这样分层（而不是照抄业务模块罗列）

**第一次切分：按"谁会变"切，不按"谁像谁"切。**

| 层 | 变化频率 | 变化原因 | 因此 |
|---|---|---|---|
| 接入层 | 低 | 加一个端（H5、设备） | 独立成层，避免端差异污染业务 |
| 协议适配层 | 中 | 加一种协议（MCP、设备、内部 RPC） | 只做翻译，**不允许写 if 业务分支** |
| 应用层 | 中 | 加一个用例、改审批链 | 事务边界在此，领域层不知道自己被谁调用 |
| 领域服务层 | **高** | 客户规则、地方政策、集团制度 | 规则只在这里，不做多份实现 |
| 数据层 | 低 | 容量、信创替换 | 用方言抽象隔离 |
| 集成层 | **极高** | 每家客户的设备、银行、IM 都不同 | 独立成层 + 适配器接口，坏掉不拖垮主链路 |

**第二次切分（本产品的关键）：把 MCP 从"接口"提到"层"。**

普通 HR 系统把开放 API 放在接入层旁边做成一个 Controller。本产品不能这么做，因为 01 §8.1 定了"同源同权"——MCP 与 Web 必须共用同一套权限模型与领域服务，不能有平行实现。所以 MCP 层不是"又一个 Controller"，而是一个**带独立治理能力的准入层**：

- `ScopeMapper`：把 OAuth scope 映射成三轴权限的功能轴子集（只缩小，不放大）
- `FieldMasker`：MCP 序列化前统一做字段级脱敏（比 Web 端更严，见 §5.5）
- `PlanStore`：写操作两阶段提交的 plan 存储（dry-run → execute），把"先预览后执行"从"建议"变成"协议强制"
- `ConfirmGate`：超过影响阈值的操作强制 elicitation 或转 Web 审批
- `QuotaGuard` / `CallAuditor`：限流与逐调用审计

这五件事在 Web 端都不需要（人不具备批量伪造能力），但 AI 需要。所以它们是 MCP 这一层存在的理由——**MCP 层不是通道，是 AI 的"交通规则"**。

**第三次切分：集成层必须能整体失败。**

本地部署的客户环境，设备、银行、IM 的可用性完全不可控。集成层所有出入口统一定义 `IntegrationPort` 接口，失败后进重试队列并落 `integration_job` 表，业务主链路感知不到。**"一个设备离线不能让门店排不了班"是这一层的验收标准。**

## 1.3 关键架构决策一句话汇总

| 决策 | 结论 | 详见 |
|---|---|---|
| 部署单元 | **单体模块化（modulith）**，一个 Spring Boot 进程，Maven 多模块强边界 | §2.1 / §10 R1 |
| 是否微服务 | **否** | §10 R1 |
| 是否多租户 | **否**（单集团单实例），但保留 `group_id` 列 | §10 R2 |
| 消息中间件 | **不引入**（Redis Stream + DB outbox 兜底） | §2.4 / §10 R6 |
| MCP 运行时 | **与主应用同 JVM**（Java 官方 MCP SDK），stdio 走独立轻量桥 | §2.8 |
| 规则表达 | **受限公式 DSL + 规则表 + Java SPI 插件**，禁止运行时执行用户代码 | §4.1.2 |
| 数据库 | PostgreSQL 16（信创替换 PG 内核派优先） | §2.3 |
| 会话存储 | JWT（短）+ DB 会话表（可吊销） | §8.1 |
| MCP 进程形态 | **独立网关容器**（A2）；默认只听 `127.0.0.1`（A1） | §2.8 / §5.1 |
| MCP 写操作 | 同步 30s 超时 + 幂等键重试；**批处理一律异步 jobId**（A2/A5） | §2.8 / §5.6 |
| AI 审批权 | **不可委托**：无 `approve_*` 工具（A6） | §5.6 / §5.9 |
| 字段权限 | **只掩码不拒绝**（A4）；求值序 数据→字段→功能 | §4.3.1 |
| 汇总层 | **普通视图 + 索引，不上物化视图**（A9） | §3.9 / §4.4.1 |
| 读写分离 | **不做**（A13） | §7.4 |
| 插件 | 规则表 + 公式 DSL，**不做插件热加载**（A11） | §4.1.2 |
| 历史数据迁移 | 只导花名册/薪资档案/假期余额（A12） | §7.3b |
| 终端 | PC Web + H5（可内嵌 IM），**不做原生 App**（A14） | §7.6 |
| 首次安装 | 向导建集团+首法人+超管，**无自助注册**（A15） | §9.2b |

---

# §2 技术选型与论证

## 2.1 前端

| 项 | 推荐 | 备选 | 取舍理由 |
|---|---|---|---|
| 框架 | **Vue 3.4 + TypeScript + Vite 5** | React 18 + Ant Design | 本产品 90% 是表单密集型后台 + 20% 是移动端打卡/查班表。Vue 的模板 + 响应式在处理"一屏 80 个字段 + 联动校验"时心智负担低，交付速度快；且中文企业后台生态（Element Plus / Vant）成熟度最高，二次开发成本低。选 React 的唯一优势是组织架构图这类重度交互的可测试性，但本项目架构图用 Canvas 自绘，框架差异被抹平 |
| PC 组件库 | **Element Plus 2.x** | Ant Design Vue | 表格能力强（`el-table-v2` 自带虚拟滚动，是万级组织/花名册列表的刚需）；中文文档完整；主题变量化便于客户定制 logo/主色（本地交付常被要求换皮） |
| 移动端 | **Vant 4** | NutUI | 包体小、老安卓兼容好。餐饮一线员工手机型号杂、系统版本低，H5 首屏必须 < 2s（见 §7.6） |
| 状态 | Pinia | — | 与 Vue 3 官方配套 |
| 图表 | ECharts 5 | — | 看板 + 组织架构图共用一套渲染依赖 |
| 架构图渲染 | **Canvas 2D + Web Worker 布局** | SVG + DOM | 见 §4.4 |
| 国际化 | vue-i18n（预留，本轮只做 zh-CN） | — | 若将来涉及港澳主体（01 §11 待拍板项②）不用重构 |
| 构建产物 | 静态文件，由 Nginx 直接托管 | — | 本地部署不引入 Node 运行时 |

**关键取舍**：不引入 SSR / Next 类方案。内网单机部署，SSR 多一个 Node 进程与内存占用，收益为零。

## 2.2 后端语言与框架

| 项 | 推荐 | 备选 | 取舍理由 |
|---|---|---|---|
| 语言 | **Java 21 (LTS)** | Go 1.22 / Python 3.12 | 三条硬理由：① **信创适配**——国产 CPU（ARM64 / LoongArch）与国产 OS 上，JVM 是运行时支持最完整的（主流国产 JDK 均已适配），Go/Python 在 LoongArch 上仍需自行编译且生态不全；② **算薪是重事务 + 重批处理**，JVM 的 `BigDecimal`、事务、批量 JDBC、连接池成熟度无可替代，Go 缺少标准 Decimal、Python 的 GIL 与浮点语义在金额计算上是风险；③ **长期可维护**——客户现场驻场运维通常只认 JVM 那套日志/监控/调优方法论 |
| 框架 | **Spring Boot 3.3** | Quarkus / Micronaut | 只用 Spring Boot 的"IoC + Web + 事务 + 定时"四件事，不引 Spring Cloud。Quarkus 启动快、内存小，但生态与人员供给差、国内客户运维不认。启动时间对本地部署不是瓶颈（一天启动一次） |
| 模块边界 | Maven 多模块 + **ArchUnit 测试强制** | Spring Modulith | 多模块 + ArchUnit 能在编译期拦住"人员域直接调薪酬域的 Mapper"，成本最低 |
| ORM | **MyBatis-Plus（常规 CRUD）+ JdbcTemplate / 原生 SQL（批量与递归查询）** | JPA/Hibernate | 算薪与报表必须能精确控制 SQL（执行计划、`COPY`、窗口函数）。JPA 的脏检查与 N+1 在万级批处理上是灾难。**不使用 JPA** |
| 表达式引擎 | **AviatorScript 5.x（受限模式，因子白名单）** | QLExpress / SpEL / Groovy | 见 §4.1.2 |
| 批处理 | **Spring Batch 5**（算薪、大批量导入） + **Quartz（JDBC 集群模式）** 触发 | 自研调度 / 独立调度中心 | Spring Batch 提供 chunk、重启（restartability）、跳过、进度，正好匹配算薪的"分片 + 中断续跑 + 逐人错误隔离"。Quartz 用数据库锁实现集群，零额外进程。**不引独立调度中心**（多一个运维对象） |
| 数据库迁移 | **Flyway**（SQL 版本化，校验和） | Liquibase | 迁移脚本随升级包分发，`flyway_schema_history` 即升级记录，回滚判定依据明确 |
| API 文档 | springdoc-openapi（仅内网可访问，生产默认关闭） | — | 供集成方对接 `/openapi/`，不对 AI 暴露（AI 走 MCP） |

## 2.3 数据库

| 项 | 推荐 | 备选 | 取舍理由 |
|---|---|---|---|
| 主库 | **PostgreSQL 16** | MySQL 8 | 五个决定性能力：① **递归 CTE + `ltree`** 处理组织子树与成本归属校验；② **窗口函数**处理连续病假滑动窗口、个税累计、排班时段重叠；③ **部分唯一索引** `UNIQUE(...) WHERE is_current` 直接实现"一人一期间一条当前工资记录"（红线 §3.5）；④ **`COPY`** 让万行排班/百万行打卡批量写入从分钟级降到秒级；⑤ **信创替换路径最平滑**——国产数据库分两派，PG 内核派的替换成本远低于 Oracle 兼容派，且本项目大量 SQL 可平移 |
| 方言隔离 | 自建 `SqlDialect` 抽象：分页、`COPY`/批量、`MERGE`/`UPSERT`、`ltree`/`path LIKE`、`jsonb`/`text+json` 四组差异 | — | 信创替换只改一个实现类 |
| 扩展 | **必须 `CREATE EXTENSION btree_gist`**（**六条** `EXCLUDE` 区间约束依赖它：`ex_eoa_no_overlap` / `ex_esa_no_overlap` / `ex_seg_no_overlap` / `ex_ecp_no_overlap` / `ex_ads_no_overlap` / `ex_ur_no_overlap`，§3.2.4 / §3.3.5 / §6.0.9.4）；`pgcrypto` 用于 `gen_random_uuid()` 备用 | — | 迁移脚本第一条就建扩展，否则约束建不出来、迁移直接失败；`preflight.sh` 强制检查 |
| 编码 | UTF8，`collate=C`（用应用层排序规则） | — | 避免本地化排序与索引膨胀 |
| 时区 | 库内 `timestamptz`，业务日期用 `date` | — | 工资周期是"日期"不是"时刻" |
| 连接池 | HikariCP，单副本 max 40（副本数 × 40 ≤ 库 `max_connections` 的 70%） | — | 见 §7.1 |
| 读写分离 | **单机版不需要**；小集群版 1 主 1 备，备库只接报表/导出 | — | 触发条件见 §7.4 |
| 高可用 | 单机版：每日全备 + WAL 归档；小集群：异步流复制 | — | 见 §9.3 |

**明确禁止**（为保证信创可替换）：
- 不使用 PostgreSQL 的数组类型（`bigint[]` 内存集合改用 `jsonb` 或关联表）
- 不使用自定义 `CREATE TYPE` / 复杂 `DOMAIN`（枚举一律用 `text` + `CHECK` 或小字典表，见 §3.3.0b）
- 不使用 `GENERATED ALWAYS AS IDENTITY` 以外的序列语法变体
- 存储过程只允许用于**只读**的汇总函数，禁写业务逻辑进 DB

**关于生成列：全库一处都不用。**

早期设计曾让 `attendance_daily_store.work_date` 用 `GENERATED ALWAYS AS (...) STORED`，**已撤销**。原因不是语法麻烦，是**备份恢复**：生成列在恢复到另一实例时会被**重算**，结果取决于恢复环境的时区设置与 tzdata 版本；而 `work_date` 是计薪归属键，重算出不同的值就等于**工资归属月变了**——在灾难恢复之上再叠一层数据错，且这种错只在"上线后第一次真实恢复"时暴露，届时没人会想到怀疑一个生成列。

现行方案：**普通列 + `BEFORE` 触发器赋值 + `CHECK` 复验 + 列级 `REVOKE` + 复合外键**（§3.3.5c）。普通列在恢复时原值照搬，与环境无关。

**生成列的准入判据（留档，供未来评审用）**：只接受"**同一行、纯函数、无外部依赖**"的表达式。`work_date` 技术上满足，但仍被恢复确定性这一条否决——**技术上可行 ≠ 应该用**。凡参与算钱的列，恢复后的确定性优先于写入时的便利。

## 2.4 缓存与轻量队列

| 项 | 推荐 | 取舍理由 |
|---|---|---|
| 缓存 | **Redis 7**（单节点，AOF `everysec`） | 承载五件事：会话/踢人、权限与字典缓存、打卡幂等 `SETNX`、限流令牌桶、Redis Stream 轻队列。**不引入第二个中间件** |
| 为什么不用消息中间件 | 单机部署下 Kafka/RabbitMQ 的内存与运维成本远超收益（16G 机器给 MQ 2G 是浪费）。跨副本的可靠异步用 **DB outbox 表 + Quartz 轮询**兜底 | 见 §10 R6 |
| 缓存失效 | 版本号机制：`role_version` / `config_version` / `org_version` 变更时递增，缓存 key 带版本号，天然失效 | 避免"删 key 删不干净"的经典问题 |
| 本地缓存 | Caffeine（参数配置、指标字典、班次库） | 进程内热点，减 Redis 往返 |

## 2.5 对象存储

| 项 | 推荐 | 备选 | 取舍理由 |
|---|---|---|---|
| 对象存储 | **MinIO**（单节点，单盘或 4 盘纠删码） | 本地文件系统 + Nginx | 需要 S3 API 的三个理由：① 附件直传（浏览器拿预签名 URL 上传，不经过应用进程，避免大文件占内存）；② 版本化与生命周期（合同/工资条需长期留存，备份策略可分层）；③ 未来换云存储时零改造 |
| 降级 | 若客户禁用额外容器，`StoragePort` 提供 `LocalFileStorage` 实现（挂载卷 + 路径 = `yyyy/MM/dd/{uuid}`），应用不做任何改动 | — | 一行配置切换 |
| 附件安全 | 存储 key 与业务 ID 分离（防遍历）；下载走应用鉴权后生成 60 秒预签名 URL；导出文件带水印 | — | §8.5 |

## 2.6 任务调度

| 场景 | 方案 |
|---|---|
| 定时任务（日终工时汇总、薪资提醒、License 校验、清理） | **Quartz JDBC 集群模式**，`qrtz_*` 表放主库，多副本靠 DB 行锁选主 |
| 长事务批处理（算薪、大批量导入） | **Spring Batch**，`JobRepository` 同库，支持按人分片与失败重启 |
| 用户触发的异步作业（导出、批量排班、报表生成） | 自建 `sys_job_instance` + 有界线程池 + 进度表；MCP 侧返回 `job_id` 供轮询 |
| 事件驱动（考勤确认 → 工时刷新） | 同进程 Spring `ApplicationEvent` + **outbox 表**（跨副本可靠） |
| 禁止 | 不使用 `@Scheduled` 做业务调度（多副本会重复执行） |

## 2.7 数据库与运行时的版本锚定

| 组件 | 版本 | 理由 |
|---|---|---|
| JDK | 21 LTS | 5 年支持期覆盖产品生命周期；虚拟线程让打卡高峰的高并发 IO 更省线程 |
| PostgreSQL | 16.x | 支持期长、逻辑复制稳定 |
| Redis | 7.2 | AOF 与 Stream 稳定 |
| MinIO | 最新稳定 RELEASE | 需固定 tag，避免 latest 漂移 |
| Nginx | 1.26 stable | |
| Node（仅构建期） | 20 LTS | 产物为静态文件，运行时不依赖 |
| Docker Engine / Compose | 24+ / v2 | 单机部署的最小依赖 |

## 2.8 MCP Server 运行时（决定性选型，ADR A1 / A2）

| 项 | 方案 | 理由 |
|---|---|---|
| 运行时 | **独立网关进程 `hr-mcp-gateway`，与主应用同机不同容器，同一份业务代码打成 jar** | ADR A2 明确裁决：**长连接（SSE / Streamable HTTP 的 keep-alive 会话）会拖死业务进程**——MCP 客户端的连接生命周期以分钟计，而业务进程的线程与内存预算要留给打卡与排班。拆出去后多一个容器的成本可忽略，但隔离了风险 |
| 与主应用的边界 | 网关**不含业务逻辑**，只做：传输适配 → 鉴权 → 三轴解析 → plan/确认/配额/审计 → **HTTP 调用主应用内部服务**（`/internal/v1/*`，仅内网监听、需服务间 token） | 业务规则（算薪、排班、审批）仍只在主应用里有一份，网关换实现不影响口径，满足"同源同权"（01 §8.1） |
| 与"不引 MQ"的关系 | 不引 MQ，则 MCP 写操作全部压缩成 **HTTP 同步调用** | 代价必须写清：**单次调用 30s 超时 + 失败可重试**（配合 A5 幂等键，重试安全）。见下 |
| 批处理类工具 | **禁止走同步 MCP**。批量排班、批量算薪、大批导入、报表导出一律：**立即返回 `jobId` + 轮询接口 `gov_get_job_status`** | 异步化在**业务层**做（`sys_job_instance` + 线程池/Spring Batch），不在网关层做——网关只负责把请求丢进去并立刻回 `jobId`。这条是 A2 的显式要求 |
| 监听地址 | **默认只听 `127.0.0.1`**，开内网监听须显式配置 `mcp.listen-address=0.0.0.0` 并在启动日志与"自检页"打红字 | ADR A1：同机 AI 客户端零配置即可用；对外暴露是**显式决策**，不能默认 |
| stdio 传输 | 独立轻量可执行文件 `hr-mcp-stdio-bridge`（GraalVM native image，启动 < 100ms），对 `127.0.0.1` 的网关做 JSON-RPC 转发 | stdio 要求由 AI 客户端拉起子进程，不可能让客户端拉起整个服务。桥**不含任何工具定义与权限逻辑**，因此不构成"第二份实现" |
| 为什么不用 Python/Node 单独实现工具 | 会形成"AI 一套业务实现、人一套业务实现"，字段脱敏与数据范围必然两套 | 见 §10 R1 |
| 工具定义方式 | **代码即定义**：`@McpTool` 注解 + JSON Schema 由 Java record 自动生成，注册到 `ToolRegistry`；工具实现直接调用应用服务接口 | schema 与实现同源，改字段时不会忘了改 schema |
| 协议版本 | MCP 规范 2024-11-05 及以上的 Streamable HTTP 版本 | 保持向后兼容 SSE |
| 资源占用 | 网关容器 1C1G 起步（8000 并发长连接场景才需扩） | 单机客户 1C1G 可接受 |

**超时与重试的完整约定（A2 代价的落点）**

| 工具类别 | 超时 | 超时后行为 |
|---|---|---|
| 读工具 | 10s | 返回 `E_TIMEOUT`，允许客户端重试（读天然幂等） |
| 写工具（同步） | **30s** | 返回 `E_TIMEOUT`；**客户端可带同一 `idempotency_key` 重试**，服务端 24h 去重保证不会双写 |
| 批处理工具（异步） | 60s 内必须返回 `jobId` | 超 60s 说明作业提交本身有问题（通常是参数校验过重），按 `E_INTERNAL` 处理 |
| 长连接空闲 | 300s 无活动断开 | 客户端重连后 `Mcp-Session-Id` 恢复 |

---

# §3 数据模型

## 3.0 全局约定（先看这一节，后面表都省略这些列）

```sql
-- 每条业务表都有（下文不再重复列出）
id            bigint PRIMARY KEY
group_id      bigint NOT NULL DEFAULT 1       -- 单实例单集团，但保留，为未来留口（§10 R2）
created_at    timestamptz NOT NULL DEFAULT now()
created_by    bigint
updated_at    timestamptz
updated_by    bigint
version       int NOT NULL DEFAULT 0           -- 乐观锁
```

| 约定 | 规则 | 理由 |
|---|---|---|
| 主键 | `bigint`，应用侧雪花算法生成（不用 `serial`） | 预留导入/多副本合并的唯一性；避免序列成为瓶颈 |
| 金额 | `numeric(18,2)`，Java 侧 `BigDecimal` | 禁 `double` |
| 工时/天数 | `numeric(8,2)` | 0.5 小时粒度 |
| 费率/系数 | `numeric(9,6)` | 社保费率 6 位小数 |
| 删除 | **业务数据禁止物理删除**。状态用 `status`，作废用 `void_flag`；配置类表允许 `is_deleted` | 01 §4.3「封账后不可改，更正走调整单」 |
| 时态 | 所有"制度类"表带 `effective_from` / `effective_to`（`effective_to IS NULL` 表示现行） | 版本化统一手法，见 §3.1.3 |
| 空值语义（02 §4 硬要求） | 见下方 CHECK | 空串/`'1970-01-01'`/`0` 一律视为脏数据，入库即拒 |
| 敏感字段 | 命名后缀 `_enc`（密文）/ `_hash`（用于等值查询的 HMAC-SHA256）/ `_mask`（展示掩码） | 见 §8.4 |

**空值语义的数据库级约束**（照抄进迁移脚本，不要只写在文档里）：

```sql
-- ★ 只加建表体里【没有】的两条。ck_term_date_null_when_active 与 ck_hire_not_null
--   已写在 §3.2.2 的 CREATE TABLE 里，此处再 ADD 会同名冲突，整个迁移直接失败
--   （02g §I17.3：同一份内容只能有一个物理位置）。
-- ★ 加 DO 包裹：约束名不带 schema 前缀，重跑时"名字已存在"会静默跳过而不是报错，
--   这正是 §I37.1 那条"写一条试图违反它的语句"证伪过的形态——断言以为在守，实际没守。
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'employment'::regclass
                    AND conname = 'ck_term_after_hire') THEN
    ALTER TABLE employment ADD CONSTRAINT ck_term_after_hire
      CHECK ( termination_date IS NULL OR termination_date >= hire_date );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'employment'::regclass
                    AND conname = 'ck_regularize_after_hire') THEN
    ALTER TABLE employment ADD CONSTRAINT ck_regularize_after_hire
      CHECK ( regularization_date IS NULL OR regularization_date >= hire_date );
  END IF;
END $mig$;

-- ⚠ 残留的架构约束（org 报，我不在本文单方面改）：建表体里
--   ck_dispatch_has_vendor 写成 ownership_type IN ('SELF','PLATFORM') OR vendor_id IS NOT NULL
--   形态可疑——SELF / PLATFORM 两个不需要 vendor 的类型反而被要求有 vendor。
--   疑为 `NOT IN` 漏写，但那要改写语义，等 payroll / org 复核后由 02g 裁。
```

## 3.0b 时间区间的开闭口径：两套，不许混（本轮定稿，不再复议）

全库用 `daterange` 做互斥/包含判定的地方只有两类，**开闭不同，且不能统一成一种**：

| 类别 | 右端代表什么 | 边界 | 实例 | 业务语义 |
|---|---|---|---|---|
| **归属类** | **一个日子**（"这个人 6 月 30 日还在这段用工关系里"） | **`'[]'`** 右闭 | `employment_segment`、`employee_org_assignment`、`employee_store_assignment`、`employment_attendance_group`、`employee_compliance_profile` | 右端那一天**属于**这段 |

> **这里原来还列了 `employee_job_assignment`，本轮删掉了**——它在全文档只出现这一次，**没有建表 DDL、没有任何引用**。一张"只被清单提到"的表，会让这份清单看起来比实现更完整，而实际上 `employee_org_assignment` 已经承担了"岗位/组织归属"的全部职责。**清单里出现一个不存在的对象，比清单少列一个更危险**：少列会被"表建了但没登记"的扫描抓到，多列则永远不会报错（§4.5.4 "清单不可能比实现长"的反例）。
| **生效类** | **一个切换点**（"7 月 1 日零时起换新规则"） | **`'[)'`** 右开 | `sys_config`、`sys_user_role` 授权、`pay_profile` 版本、`sys_data_scope_rule` 适用范围 | 右端那一刻**已经不属于**旧的 |

**为什么不能统一**：归属类的右端是"最后一天"，如果写成 `'[)'`，业务上填"至 6-30"会被理解为**不含 6-30**，于是每月少算一天工资；生效类的右端是"新版起点"，如果写成 `'[]'`，旧版与新版会在切换日**同时有效**，`EXCLUDE` 立刻判重叠、发布失败。**同一个"右端"在两类里指的是相反的东西**，统一开闭等于其中一类必错。

### 致命陷阱：`daterange(d, d, '[)')` 是 EMPTY，不是"一天"

```sql
SELECT daterange('2024-06-30'::date, '2024-06-30'::date, '[)');  -- 输出：empty
SELECT daterange('2024-06-30'::date, '2024-06-30'::date, '[)')
       && daterange('2024-01-01'::date, '2024-12-31'::date, '[]'); -- 输出：false
```

语义描述"含下界不含上界"**完全正确**，而这个样本上它输出空集。空集与任何范围的 `&&` 都是 `false`，于是：

- **`EXCLUDE ... WHERE (superseded_by IS NULL)` 对"起止同日"的行完全不生效**；
- **`&&` 过滤会漏掉这条行**，报表里它"不存在"；
- **插入成功、不报错、不警告。**

这不是"少判一天"，是**约束在这一行上整条失效**。所以生效类区间必须配两道保护：

```sql
-- ① 半开区间的右端必须严格大于左端（否则是空集）
ALTER TABLE sys_user_role ADD CONSTRAINT ck_ur_span_nonempty
  CHECK (valid_to IS NULL OR valid_to > valid_from);

-- ② 若要保留"业务上填最后一天"的输入习惯，必须配生成列把它平移成开区间，
--    不允许在下游 SQL 里各自 +1（那会出现 17 处 +1，其中 3 处忘了）
--    ALTER TABLE t ADD COLUMN range_end_exclusive date
--      GENERATED ALWAYS AS (valid_to + 1) STORED;
```

### 无上界只有一种写法：`upper` 传 `NULL`

```sql
-- ✅ 正确：daterange(lower, NULL, '[]') → [d, )   upper_inf() = true
-- ❌ 错误：daterange(lower, 'infinity'::date, '[]') 或 COALESCE(upper, 'infinity')
```

`COALESCE(x, 'infinity')` 把"**无界**"降级成"**有限但很大**"：`upper_inf()` 从 `true` 变成 `false`，任何用 `upper_inf()` 判断"是不是现行版本"的视图会**静默漏掉所有无上界的行**——而那些行恰好就是"现行"的行。**这个错误的方向永远是漏掉现行版本，所以它看起来像"没有现行版本"，而不是像"查询写错了"。**

```sql
-- 巡检：把"用无穷大代替 NULL"的行抓出来（期望：空集）
CREATE VIEW v_chk_range_fake_unbounded AS
SELECT 'employment_segment' AS t, id FROM employment_segment WHERE isfinite(upper(daterange(valid_from, valid_to, '[]')))
UNION ALL
SELECT 'sys_config', id FROM sys_config WHERE NOT upper_inf(daterange(effective_from, effective_to, '[)')) AND effective_to = 'infinity'::date;
```

> **这条巡查为什么必须逐表写、不能写成 `LIKE` 扫全库**：`daterange(...)` 的两个参数是**列名**，不是字符串，没法从目录里反推"这张表用的是哪两列"。所以它不是一条通用的扫描，是**一份清单**——而清单会过期。新增一张时态表而不加进这个视图，这条巡查对它**一条都不管**，且看起来是绿的（视图照样返回零行）。这与 §8.2d 第①条"集合元断言"是同一个问题：**清单本身要能判"有没有漏登记"，不能只判"登记的都对"。**

### 命名即语义类：`effective_*` 只配生效类，`valid_*` 只配归属类（可 grep）

**规则一句话**：**同一字段名不得出现在两类表里。** 这样"这张表是归属类还是生效类"可以只读列名判定，不需要打开表看边界。

| 语义类 | 只许用 | 边界 | 右端代表 |
|---|---|---|---|
| **归属类** | `valid_from` / `valid_to`（或 `start_date`/`end_date`，**同一表内不得混用两套**） | `'[]'` | **一个日子** |
| **生效类** | `effective_from` / `effective_to` | `'[)'` | **一个切换点** |

**为什么不允许开第三类"授权类"来省掉改名**：规则的全部价值在于**二元可判**。一旦允许第三类，`valid_*` 就可能配 `'[)'`，那条 grep 判据当场失效——而失效的方向是"看起来合规"。`sys_user_role` 属于生效类（它的右端是"授权失效的第一天"，就是切换点），所以它的列名就该是 `effective_to`，这不是新增一类，是**用词错**。

**机检（两条，都可 grep）**：

```sql
-- ① 三类列名与表语义类一致性（语义类由 §3.0b 的登记表给出）
SELECT c.table_name, c.column_name
  FROM information_schema.columns c
  JOIN table_semantic_class t ON t.table_name = c.table_name
 WHERE (t.cls = 'ownership'  AND c.column_name LIKE 'effective\_%')
    OR (t.cls = 'effective'  AND c.column_name LIKE 'valid\_%');   -- 期望：空集

-- ② 边界必须与语义类匹配：从 pg_get_constraintdef 里读第三参数
--    ownership + '[)'  → 红（同日区间会变空集）
--    effective + '[]'  → 红（切换日两版同时有效，EXCLUDE 立刻判重叠）
```

**六处待归位**（本轮登记，逐表改，不许留旧列名做兼容——"能解析"≠"解析到现行版"）：

| 表 | 原命名 | 应改为 | 类 | 状态 |
|---|---|---|---|---|
| `employment_attendance_group` | `effective_from/to` | `valid_from/to` | 归属 | **已改**（+ `ck_eag_span`） |
| `employee_compliance_profile` | `effective_from/to` | `valid_from/to` | 归属 | **已改**（+ `ck_ecp_range` + `ex_ecp_no_overlap`） |
| `employee_org_assignment` | `effective_date` / `end_date` | `valid_from` / `valid_to` | 归属 | **已改**（`ck_eoa_range` / `ex_eoa_no_overlap` 同步） |
| `employee_store_assignment` | `effective_date` / `end_date` | `valid_from` / `valid_to` | 归属 | **已改**（+ `ex_esa_no_overlap`，原来只有两个普通索引） |
| `employment_segment` | `start_date` / `end_date` | `valid_from` / `valid_to` | 归属 | **已改**（+ `ex_seg_no_overlap`，原来**没有**任何区间约束） |
| `sys_user_role` | ~~`valid_from/to`~~ | `effective_from/to` | **生效** | **已改**（反向：它是生效类） |

**`start_date` / `end_date` 这个别名还剩哪些表能用（这条必须写清，否则规则有洞）**：

| 能用的判据 | 例子 | 为什么 |
|---|---|---|
| 有明确业务起止语义，**且不参与任何区间排斥约束** | `contract.start_date/end_date`（合同起止）、`certificate.issue_date/expire_date`（证照）、`hr_change_order.effective_date`（单据生效日） | 这些值不进 `EXCLUDE`，右端开闭不产生后果；且业务人员嘴里本来就叫"合同起止日"，改成 `valid_*` 反而要解释 |
| **不是时态归属，只是单点日期** | `renewal_remind_date`、`sign_date` | 单列无区间 |
| 其余**参与时态判定的归属类** | 上表五张 | **一律 `valid_*`**——因为它们要配 `daterange(..., '[]')` 进 `EXCLUDE`，而右端语义差一天就是数据错 |

> **判据一句话：进 `EXCLUDE` 的必须叫 `valid_*`；不进 `EXCLUDE` 的按业务原名。** 这条把"改名"从审美问题变成可判定的问题——**看它有没有资格进排斥约束**。

**本轮新增的三条 `EXCLUDE` 与一条 `CHECK`，必须同时进巡检（否则"建了"和"起作用了"是一回事）**：

| 约束 | 表 | 它挡什么 | 必须在 `sys_check_registry` 里有的 `guards` |
|---|---|---|---|
| `ex_esa_no_overlap` | `employee_store_assignment` | 同一人在同一门店的支援区间重叠 | 空 → **登记为债**（它本身就是结构，没有第二道） |
| `ex_seg_no_overlap` | `employment_segment` | 同一 `employment` 的分段重叠 | 空 → **登记为债**（同上） |
| `ex_ecp_no_overlap` | `employee_compliance_profile` | 同一人在同一时点挂两个合规画像 | 空 → **登记为债** |
| `ck_eag_span` / `ck_esa_range` / `ck_ecp_range` / `ck_seg_range` / `ck_eoa_range` | 上述五张 | `valid_to < valid_from` | 一条 `fixture_reject`（`valid_to = valid_from - 1`）**必被拒**；一条 `fixture_accept`（`valid_to = valid_from`）**必被接受** |

> **`fixture_accept` 那一格不是凑数**：`valid_to = valid_from` 是**一天**（`'[]'` 下），必须被接受。如果哪天有人把 `CHECK` 写成 `valid_to > valid_from`，一天的行就进不来，而 `fixture_reject` 依然绿——**只测"该拒的被拒了"，测不出"该收的被收了"。** 这是 §4.5.3 那对贴边夹具在这里的具体形态，距离是 1 天，从 `daterange` 的日粒度派生，不写死。

### 一条硬事实（供评审用，不需要再讨论）

**同日离职再入职是合法的，不需要在这里开例外。** `employment_segment` 的 `EXCLUDE` 键是 `(employment_id WITH =, daterange WITH &&)`——同日离职再入职产生的是**两个不同的 `employment_id`**，两段区间不在同一个键上，**约束没有东西可比**。所以"要不要开例外"这个问题本身不存在：

| 渠道 | 形态 | `'[]'` 下表现 | 处理 |
|---|---|---|---|
| **C 同日两段** | 同日离职 + 同日入职，两个 `employment_id` | 约束不管，合法 | 业务允许（转签），两段班段各自记，工时**不丢** |
| **A 为避开约束改写成次日入职** | 入职日填 D+1 | 业务数据近似，那天的工作"消失" | 由 `work_date` + 班段层兜住：班段照记，工时不会因为 employment 写错一天而消失 |
| **B 未登记直接上岗** | 无单据、雇佣事实不入库 | 约束不管 | **唯一真正的风险**，靠可检出下界巡检（`02g` §I26.2） |

> **判据写死三句**：① **不许用"渠道 C 的数量"评估这个决策**——`'[]'` 的定义就是让 C 出现，那是自我确认指标；② 要盯的是 **B**，而 B 只能写成"可检出下界 + 分期趋势"，并明写"下界不覆盖的部分是什么"；③ 对照表必须标出哪几格是空的——一侧填得满、一侧填不满时，结论不是"填满那侧便宜"，是**它更容易被测量**，而这两者在会议室里长得一样。

## 3.1 组织域

### 3.1.1 组织节点（单根树 + 多类型）

```sql
CREATE TABLE org_unit (
  id                bigint PRIMARY KEY,
  group_id          bigint NOT NULL DEFAULT 1,
  code              varchar(64)  NOT NULL,          -- 业务编码，集团内唯一
  name              varchar(128) NOT NULL,
  short_name        varchar(64),
  org_type          varchar(20)  NOT NULL,          -- GROUP|REGION|LEGAL_ENTITY|STORE|DEPT|TEAM
  parent_id         bigint       REFERENCES org_unit(id),
  path              varchar(512) NOT NULL,          -- '/1/12/145/' 物化的根到自身路径
  depth             smallint     NOT NULL,
  sort_no           int          NOT NULL DEFAULT 0,

  -- 归属与制度
  legal_entity_id   bigint,                          -- 所属发薪法人（GROUP/REGION 为 NULL）
  region_id         bigint,
  store_id          bigint,                          -- 仅 STORE 节点非空
  is_leaf_store     boolean NOT NULL DEFAULT false,
  policy_set_id     bigint,                          -- 02 §3 L2 参数集
  attendance_group_id bigint,                        -- 02 §13：组织节点 1:1 考勤组
  cost_center_code  varchar(32),

  timezone          varchar(48) NOT NULL DEFAULT 'Asia/Shanghai',  -- 门店级时区：work_date 派生的唯一依据
  status            varchar(16) NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE|DISABLED|ARCHIVED
  -- ★ 本表**不设** effective_from / effective_to（已删除）。org_unit 只存现行快照，
  --   历史由 org_unit_history 按 org_version_id 整体切片；"这一版从哪天生效"的唯一权威是
  --   org_version.effective_date。留着两列会得到一对恒为 (某日, NULL) 且无人读的列，
  --   而它看起来像一套时态机制——与 tmp_scope_deny 当初的问题同形。
  org_version_id    bigint NOT NULL,                 -- 产生该状态的版本（唯一的时间指针）
  -- id/审计列略
  CONSTRAINT uk_org_code UNIQUE (group_id, code),
  CONSTRAINT ck_group_no_parent CHECK ( (org_type='GROUP') = (parent_id IS NULL) ),
  CONSTRAINT ck_store_has_store_id CHECK ( (org_type='STORE') = (store_id IS NOT NULL) )
);
CREATE INDEX ix_org_parent  ON org_unit(parent_id) WHERE status='ACTIVE';
CREATE INDEX ix_org_path    ON org_unit(path varchar_pattern_ops);
CREATE UNIQUE INDEX uk_org_single_root ON org_unit(group_id) WHERE org_type='GROUP';
```

**设计说明**
- **单根**：`uk_org_single_root` 用部分唯一索引保证只有一个集团节点。集团节点 = 真实节点（有 `org_type='GROUP'`、有集团超管角色），不是虚拟 root，因此权限树、编制树、成本树都能无缝向上汇总。
- **`path` 而不是 `ltree`**：`path` 是纯文本 + `varchar_pattern_ops` 索引，`WHERE path LIKE '/1/12/%'` 可走索引。放弃 `ltree` 是为了信创可替换（§2.3）。子树查询再用递归 CTE 兜底，两者结合。
- **`org_type` 而非多表**：01 §4.1 明确"一个实体、四个视角"。单表让"任意节点都能挂人、挂编制、挂成本中心"成立；代价是类型相关的可空字段多，用 CHECK 约束兜住。

### 3.1.2 组织版本（时态 + 版本头）

```sql
CREATE TABLE org_version (
  id             bigint PRIMARY KEY,
  version_no     int          NOT NULL,
  effective_date date         NOT NULL,
  status         varchar(16)  NOT NULL,   -- DRAFT|PUBLISHED|SUPERSEDED
  change_order_id bigint,                 -- 来源审批单
  published_by   bigint, published_at timestamptz,
  remark         varchar(500)
);

-- 历史切片（发布时由当前表快照写入，只追加）
CREATE TABLE org_unit_history (
  id             bigint PRIMARY KEY,
  org_version_id bigint NOT NULL,
  org_unit_id    bigint NOT NULL,
  parent_id      bigint,
  name           varchar(128),
  org_type       varchar(20),
  legal_entity_id bigint, cost_center_code varchar(32),
  attendance_group_id bigint, policy_set_id bigint,
  path           varchar(512),
  headcount_approved int
);
CREATE INDEX ix_org_hist_ver ON org_unit_history(org_version_id, org_unit_id);
```

**为什么"当前表 + 历史快照"而不是纯双时态表**
纯双时态（`valid_from/valid_to` + `txn_time`）理论上最优雅，但每次查询都要带时间谓词，业务 SQL 会全面复杂化，且开发者极易漏写。折中：`org_unit` 只存现行（查询简单、索引高效），历史查询走 `org_unit_history`（只读、按版本整体读取）。**历史报表还原（01 §4.1「历史报表按当时版本还原」）通过 `?org_version_id=` 参数切表实现**，由 `OrgQueryRouter` 统一路由，业务代码无感。

### 3.1.3 编制、成本中心、考勤组、标签

```sql
CREATE TABLE org_headcount (
  id bigint PRIMARY KEY,
  org_unit_id bigint NOT NULL,
  period_month char(7) NOT NULL,             -- '2026-11'
  headcount_approved int NOT NULL,
  headcount_budget_amount numeric(18,2),
  UNIQUE (org_unit_id, period_month)
);

CREATE TABLE org_cost_center (
  id bigint PRIMARY KEY,
  code varchar(32) NOT NULL UNIQUE,
  name varchar(128) NOT NULL,
  legal_entity_id bigint NOT NULL,
  org_unit_id bigint NOT NULL,
  gl_account varchar(32),                    -- 财务科目，导出凭证用
  status varchar(16) NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE attendance_group (
  id bigint PRIMARY KEY,
  code varchar(32) NOT NULL,
  name varchar(128) NOT NULL,
  org_unit_id bigint NOT NULL,               -- 02 §13：同期 1:1
  rule_json jsonb NOT NULL,                  -- 弹性/固定/自由工时、日周月上限、宽限、有效打卡范围
  effective_from date NOT NULL,
  effective_to   date,
  UNIQUE (org_unit_id, effective_from)
);

CREATE TABLE org_unit_tag (                   -- 02 §13 多值部门标签
  org_unit_id bigint NOT NULL,
  tag_code    varchar(32) NOT NULL,
  PRIMARY KEY (org_unit_id, tag_code)
);
```

**`attendance_group` 的 1:1 与 employee 的 N:1 如何共存**（02 §13 的易错点）：`attendance_group.org_unit_id` 表达"哪些门店适用哪套规则"（规则归属），`employment_attendance_group` 表达"这个人现在属于哪几个考勤组"（人员归属，主 + 兼岗/支援）。

```sql
CREATE TABLE employment_attendance_group (
  id bigint PRIMARY KEY,
  employment_id bigint NOT NULL,
  attendance_group_id bigint NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  valid_from date NOT NULL,                  -- 归属类，右闭 '[]'（§3.0b）
  valid_to   date,                           -- NULL = 无上界（唯一无界写法）
  reason varchar(200),                       -- 支援/兼岗
  CONSTRAINT ck_eag_span CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX uk_eag_primary ON employment_attendance_group(employment_id)
  WHERE is_primary AND valid_to IS NULL;
```

> **这张表为什么没有 `EXCLUDE` 而 `employment_segment` 有**：一条 `EXCLUDE` 能表达"不许重叠"的前提是**重叠会同时出现两个值**。这里的重叠是 `(employment_id, attendance_group_id)` 双列——同一个人同一时间在两个考勤组，业务上**是合法的**（主 + 兼岗），而 `is_primary` 保证"主"只有一个，那是**唯一索引**能表达的东西。所以约束形态由业务语义定，不由"归属类表都该有 `EXCLUDE`"这个模板定。**反过来，`employment_segment` 必须重叠被拒，所以它必须有——而它原来没有，那是漏，不是设计。**

## 3.2 人员域

### 3.2.1 自然人

```sql
CREATE TABLE person (
  id            bigint PRIMARY KEY,
  name          varchar(64) NOT NULL,
  name_pinyin   varchar(128),                 -- 拼音检索（花名册搜索）
  gender        char(1),
  birth_date    date,
  id_card_type  varchar(16),                  -- ID_CARD|PASSPORT|HK_MO_TW|OTHER
  id_card_no_enc  text,                       -- AES-256-GCM
  id_card_hash    char(64),                   -- HMAC-SHA256，用于查重
  mobile_enc      text,
  mobile_hash     char(64),
  photo_key       varchar(256),
  education     varchar(32),
  address_enc   text,
  emergency_contact_enc text,
  UNIQUE (id_card_hash)
);
```

### 3.2.2 任职主档（只放"长期稳定"的属性）

**这是整套系统的地基表，但只承载"不随天变"的属性。** 排班组织、考勤组织按天可变（借调/支援），成本组织按月推导，三者都**不进主档**。

```sql
CREATE TABLE employment (
  id                        bigint PRIMARY KEY,
  person_id                 bigint NOT NULL REFERENCES person(id),
  employee_no               varchar(32) NOT NULL,

  -- 发薪法人主体（02 §2.1-1）：工资单雇主栏、个税申报主体。变更即"调动"，走 employment_segment 留痕
  payroll_legal_entity_id   bigint NOT NULL,
  -- 社保主体 + 参保城市（02 §2.1-2）：可与①不同（集团代缴）
  legal_entity_si_id        bigint,
  si_city                   varchar(32),
  -- 编制组织（长期不变）：花名册、汇报关系、编制管控
  primary_org_id            bigint NOT NULL,
  -- 主门店（一人多店时的默认店，用于统计去重、排班默认；非排班/考勤归属）
  primary_store_id          bigint,

  -- 汇报线（02 §2.2，两条独立关系线，允许交叉）
  report_to_id              bigint,           -- 实线主管（单人）
  dotted_line_ids           jsonb,            -- 虚线（多人），如 '[1001,1002]'

  -- ★ 人员分类：三正交 + 一计薪方式，禁止合并成一个枚举（见 §3.2.3）
  ownership_type            varchar(16) NOT NULL,  -- SELF|DISPATCH|OUTSOURCE|PLATFORM
  legal_employment_form     varchar(24) NOT NULL,  -- FULL_TIME|PART_TIME|LABOR|SERVICE
  employment_type           varchar(16) NOT NULL,  -- FT|PT|LTPT
  pay_mode                  varchar(16) NOT NULL,  -- MONTHLY|HOURLY|DAILY|PIECEWORK（02 §8）

  cost_bearing_policy       varchar(20) NOT NULL,  -- home_org|working_org|split_by_days|split_by_hours
  -- ★ 加班费的承担方（三值，不能只用 ot_pay_amount=0 表达）
  ot_pay_bearer             varchar(8) NOT NULL,    -- SELF|AGENCY|NONE（见下）
  job_title                 varchar(64),
  job_grade                 varchar(32),
  job_family                varchar(32),
  work_calendar_id          bigint,
  pay_scheme_id             bigint,
  vendor_id                 bigint,           -- 派遣/外包的供应商（record_owner=SUPPLIER 的判定依据）

  -- 生命周期（02 §4：双日期都存）
  hire_date                 date NOT NULL,
  probation_end_date        date,             -- 应然
  regularization_date       date,             -- 实然
  termination_date          date,             -- 在职必须 NULL
  termination_reason        varchar(32),
  status                    varchar(16) NOT NULL,  -- PREHIRE|PROBATION|ACTIVE|SUSPENDED|TERMINATED

  UNIQUE (payroll_legal_entity_id, employee_no),
  CONSTRAINT ck_term_date_null_when_active
    CHECK ( (status IN ('ACTIVE','PROBATION','SUSPENDED')) = (termination_date IS NULL) ),
  CONSTRAINT ck_hire_not_null CHECK (hire_date IS NOT NULL),
  -- 承揽不建工时、不进人效、只做在场登记（§3.3.6）
  CONSTRAINT ck_contracting_no_paymode
    CHECK ( legal_employment_form <> 'SERVICE' OR pay_mode = 'PIECEWORK' ),
  CONSTRAINT ck_dispatch_has_vendor
    CHECK ( ownership_type IN ('SELF','PLATFORM') OR vendor_id IS NOT NULL )
);
CREATE INDEX ix_emp_person      ON employment(person_id);
CREATE INDEX ix_emp_primary_org ON employment(primary_org_id) WHERE status IN ('ACTIVE','PROBATION');
CREATE INDEX ix_emp_vendor      ON employment(vendor_id)      WHERE ownership_type IN ('DISPATCH','OUTSOURCE');
```

### 3.2.3 人员分类为什么必须是三个正交字段（不是三个，是四个轴）

| 字段 | 取值 | 驱动什么 | 合并会出什么事 |
|---|---|---|---|
| `ownership_type` | 自有 / 派遣 / 外包 / 第三方平台 | **算不算自己人**：进不进工资表、人效口径、`record_owner` | 派遣人员被计入"自有"人效，门店人效虚高 |
| `legal_employment_form` | 全日制 / 非全日制 / 劳务关系 / 承揽 | **社保口径、终止补偿、法定工时上限** | 非全日制被按全日制上限校验，合规校验形同虚设；社保口径错，跨月补缴 + 滞纳金，最难修 |
| `employment_type` | FT / PT / LTPT | **怎么算钱**：算薪算法、加班是否计费 | 算薪走错分支 |
| `pay_mode` | 月薪 / 时薪 / 日薪 / 计件（02 §8） | **计算式与取数来源** | 计件被塞进时薪模型 |

**四轴必须同时存在，且禁止做"由前两维推导第三维"的优化。** 两个真实场景会推错：

| 场景 | 会推成什么 | 实际是什么 |
|---|---|---|
| 全日制，但按小时计薪（划线排班的全职员工） | `legal_form=全日制 → employment_type=FT → 月薪` | `employment_type=FT` + `pay_mode=HOURLY` |
| 非全日制，但月结（兼职店长） | `legal_form=非全日制 → PT → 时薪` | `employment_type=PT` + `pay_mode=MONTHLY` |

01 §4.2 的"用工类型 FT/LTPT/PT/小时工/实习/劳务派遣/外包"是**四轴混称**，本轮拆开落到四个字段；02 §8 的"计薪方式四种"对应 `pay_mode`。`pay_scheme` 的绑定键因此是 `(payroll_legal_entity_id, employment_type, pay_mode)`。

**承揽是唯一不进工时模型的分支**（不是"少算一些工时"）：不建 `attendance_daily` / `attendance_daily_store`、不产生工时、不进人效与成本分摊，只做在场人员登记。数据层校验：`legal_employment_form='SERVICE'` 时禁止写 `employee_store_assignment` 与 `schedule_assignment`（排班侧见 §3.3.2 的 `ck_sa_d10_service`）。

### 3.2.3b 加班是「工时照记 + 费用分流」，不是开关

这是本轮从需求侧抓出的一个真错误：**如果实现成"非 FT 直接把 `ot_hours` 置 0，派遣人员的劳务对账就断了"**。

| 字段 | 规则 |
|---|---|
| `attendance_daily.ot_*_hours`（三类） | **全部现场作业人员一律照记**，含派遣/外包——那是劳务对账的计费依据 |
| `employment.ot_pay_bearer` | `SELF`（进工资项）/ `AGENCY`（不进工资，进**计费工时** → 劳务结算单）/ `NONE`（不产生费用，如自有非全日制且当地不要求） |

**为什么必须补第三个字段**：`ot_pay_amount = 0` 有两种完全不同的语义被混在一起——「本就没有这笔钱」（自有非全日制）与「这笔钱付给别人」（派遣 → 劳务公司）。不加 `ot_pay_bearer`，劳务对账无法区分"0 元"的两种来源，**供应商账单和工资表永远对不上**。

`ot_pay_bearer` 默认推导规则（可覆盖，写进配置项 `ot_pay_bearer_rule`）：

| `ownership_type` | `employment_type` | 默认 `ot_pay_bearer` |
|---|---|---|
| SELF | FT | `SELF` |
| SELF | PT / LTPT | `SELF`（当地允许非全日制加班费时）或 `NONE`（按 `pt_ot_pay_enabled` 参数） |
| DISPATCH / OUTSOURCE | 任意 | `AGENCY` |
| PLATFORM | 任意 | `AGENCY` |

### 3.2.4 排班组织 / 考勤组织：必须是时序表，不能是字段

**主档回答"现在归谁"，时序表回答"当时在哪"。凡涉及"过去某一天"的计算，禁止读主档值。**

```sql
-- ★ EXCLUDE ... USING gist 作用在 bigint 上必须有 btree_gist，否则建约束时报
--    "data type bigint has no default operator class for access method gist"
--    这是本节三处 gist 排斥约束（本节两处 + employment_segment 一处）的共同前提
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 归属版本表：一人一时点只有一份归属（编制/排班/考勤三轴同版本，便于一致变更）
CREATE TABLE employee_org_assignment (
  id                bigint PRIMARY KEY,
  employee_id       bigint NOT NULL REFERENCES employment(id),
  primary_org_id    bigint NOT NULL,          -- 编制组织（冗余，便于按当时版本还原编制归属）
  schedule_org_id   bigint NOT NULL,          -- 排班组织：谁给这个人排班
  attendance_org_id bigint NOT NULL,          -- 考勤组织：打卡范围/异常判定的归属
  work_location_org_id bigint,
  valid_from        date   NOT NULL,          -- 归属类，右闭 '[]'（§3.0b）
  valid_to          date,                     -- NULL = 无上界（唯一无界写法）
  source_order_id   bigint,                   -- 来源调动单/支援单
  CONSTRAINT ck_eoa_range CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
-- ★ 一人一时点只有一份归属：用数据库区间排斥约束，不靠应用层校验
ALTER TABLE employee_org_assignment ADD CONSTRAINT ex_eoa_no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    -- ★ 上界直接传 valid_to（NULL = 无界），严禁 COALESCE(valid_to,'infinity')：
    --   那会把"无界"降级成"有限但很大"，upper_inf() 变 false，
    --   所有 WHERE upper_inf(...) 的"现行归属"查询静默漏掉全部未关闭的行。
    --   本节 8 行前自己写过正确形式，此处曾误写，已改（见 02g §I46 与 §8.2b）。
    daterange(valid_from, valid_to, '[]') WITH &&
  );

-- 额外出勤门店（SCD 时序表，一天可多行）：兼岗/支援的授权来源
CREATE TABLE employee_store_assignment (
  id             bigint PRIMARY KEY,
  employee_id    bigint NOT NULL REFERENCES employment(id),
  store_org_id   bigint NOT NULL,
  role_in_store  varchar(16),                 -- PRIMARY|SUPPORT|CONCURRENT
  valid_from     date NOT NULL,               -- 归属类，右闭 '[]'（§3.0b）
  valid_to       date,                        -- NULL = 无上界；支援到期靠区间自然失效，不用定时任务改数据
  source_order_id bigint,                     -- 支援单/兼岗单
  CONSTRAINT ck_esa_range CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
-- ★ 同一人在同一门店的支援区间不得重叠（原来只有两个普通索引，没有排斥约束）
ALTER TABLE employee_store_assignment ADD CONSTRAINT ex_esa_no_overlap
  EXCLUDE USING gist (
    employee_id  WITH =,
    store_org_id WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  );
CREATE INDEX ix_esa_emp_date ON employee_store_assignment(employee_id, valid_from, valid_to);
CREATE INDEX ix_esa_store    ON employee_store_assignment(store_org_id, valid_from, valid_to);

-- 可排班门店视图（排班/考勤校验/打卡设备白名单都读它，不各写一遍，避免口径分叉）
-- 注意：区间展开用 generate_series，只用于"按天"查询；范围查询请直接查 employee_store_assignment
CREATE VIEW employee_workplaces_v AS
SELECT a.employee_id,
       s.id   AS store_org_id,
       s.timezone,
       d.d    AS on_date,
       a.role_in_store
FROM employee_store_assignment a
JOIN org_unit s ON s.id = a.store_org_id AND s.org_type = 'STORE'
CROSS JOIN LATERAL generate_series(a.valid_from, COALESCE(a.valid_to, CURRENT_DATE)) AS d(d);
```

> **上面这个 `COALESCE(a.valid_to, CURRENT_DATE)` 与 §3.0b 禁止的那个 `COALESCE(end_date,'infinity')` 不是一回事，必须分清**：这里 `COALESCE` 的结果**只用来当 `generate_series` 的上界**（它需要一个有限值才能生成序列），**没有写回任何列**，也没有替代 `daterange` 的 `upper` 参数。禁止的那个是把无界**存进区间**，让 `upper_inf()` 永远为假。**判据：`COALESCE` 出现在 `daterange(...)` 的参数位上就是错的，出现在"必须有界的计算"里是对的。**

**为什么排班/考勤组织不能做成 `employment` 上的字段**

| 需求 | 字段方案 | 时序表方案 |
|---|---|---|
| 跨店借调 3 天 | 改字段 → 丢失历史，回滚要再改一次 | 关旧区间 + 开新区间，到期自然失效 |
| "上周谁在 B 店" | 查不出来（字段只有现值） | 按 `valid_from`/`valid_to` 区间还原 |
| 支援到期自动回滚 | 定时任务改数据 → 漏跑/重跑/污染审计 | 区间到期即失效，零任务 |
| 审计"谁在何时改了什么" | 只有最后一次 | `source_order_id` 指向单据，完整可追 |

**硬规则：变更一律「关旧区间（`valid_to = 变更日 - 1`）+ 开新区间」，禁止 `UPDATE` 历史行的归属值。** 支援到期不靠定时任务，靠区间自然失效。

> **`valid_to = 变更日 - 1` 是归属类右闭 `'[]'` 的直接推论，不是习惯**：右闭的含义是"`valid_to` 这一天仍然有效"，所以关旧区间必须减一。如果某天有人把它写成 `valid_to = 变更日`，在 `'[]'` 下**新旧两段在变更日同时有效** → `ex_eoa_no_overlap` / `ex_esa_no_overlap` 立刻判重叠 → 报错。**这是右闭比右开安全的地方：写错会红，不会静默少一天。** 反过来，生效类（`effective_*` / `'[)'`）写 `effective_to = 变更日` 才是对的——**同一个数在两类里含义相反，这就是 §3.0b 要求列名必须区分的原因**。

**成本组织为什么不落表**：它由 `cost_bearing_policy` 按月推导（FT 跟人走 → `primary_org`；PT/小时工跟岗走 → 当月 `attendance_daily_store` 的实际门店），**结账时固化到 `payroll_cost_allocation`**（§3.5.4）。落表会与工时事实产生第二份真相。

**日期归属三段（最容易在架构层被合并成一个字段）**

| 口径 | 用哪个字段 | 为什么必须分开 |
|---|---|---|
| **计薪**（工资期间、出勤天数、缺勤判定） | `attendance_daily.work_date` | 按员工实际提供劳动那一天，规则统一无例外 |
| **成本 / 门店毛利 / 日报表** | `attendance_daily_store.business_date` | 与营业收入同期，夜班成本不割裂 |
| **加班倍率**（平日/休息日/法定） | 实际 `shift_start_at` 时刻 | 节假日边界按真实时间 |

例：1/31 22:00 夜班、员工 2/1 01:00 顶班 → 他的**工资算 2 月**（他 2 月干的活），但**这个班的成本算 1/31 营业日**（那晚的收入在 1 月）。两者不一致是**正确的**（权责发生制与薪期发放的正常差异）。文档与图里如果只画一个"归属日期"，实施时一定会被合并，然后要么薪期错、要么毛利错。

### 3.2.5 任职分段、合同、证照、异动单据

```sql
CREATE TABLE employment_segment (              -- 一人多段任职明细（不覆盖历史）
  id bigint PRIMARY KEY,
  employment_id bigint NOT NULL,
  seq int NOT NULL,
  valid_from date NOT NULL,                    -- 归属类，右闭 '[]'（§3.0b）
  valid_to   date,                             -- NULL = 无上界
  change_type varchar(24) NOT NULL,            -- HIRE|TRANSFER|PROMOTE|ADJUST_SALARY|REHIRE|REGULARIZE
  from_json  jsonb,                            -- 变更前快照（发薪主体、社保主体、薪资、岗位）
  to_json    jsonb,                            -- 变更后快照
  change_order_id bigint,
  -- 显式命名（不依赖 PG 自动生成的 employment_segment_employment_id_seq_key）：
  -- §9.5b 第 −1 步的回填与两段式更新要按这个名字 `ALTER CONSTRAINT`，自动名会随列序变
  CONSTRAINT uk_seg_seq UNIQUE (employment_id, seq),
  CONSTRAINT ck_seg_range CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
-- ★ 同一 employment 的分段不得重叠：原来**根本没有这条约束**
--   巡检视图里出现过 daterange(...)，但它在那处只是统计表达式，不是约束 ——
--   扫描者看到 daterange 会以为有约束，这是"巡检里出现某个函数名"被当成"机制存在"的典型。
ALTER TABLE employment_segment ADD CONSTRAINT ex_seg_no_overlap
  EXCLUDE USING gist (
    employment_id WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  );

CREATE TABLE contract (
  id bigint PRIMARY KEY,
  employment_id bigint NOT NULL,
  contract_no varchar(64) NOT NULL,
  contract_type varchar(16) NOT NULL,          -- FIXED|OPEN|PARTTIME|DISPATCH|INTERN|CONTRACTING
  start_date date NOT NULL, end_date date,
  sign_date  date, sign_status varchar(16),    -- NOT_SENT|SENT|SIGNED|REFUSED|EXPIRED
  esign_ref  varchar(128),
  template_id bigint, file_key varchar(256),
  renewal_remind_date date,
  UNIQUE (contract_no)
);

CREATE TABLE certificate (
  id bigint PRIMARY KEY,
  employment_id bigint NOT NULL,
  cert_type  varchar(24) NOT NULL,             -- HEALTH|FOOD_SAFETY|SPECIAL_EQUIP|ID
  cert_no    varchar(64),
  issue_date date, expire_date date NOT NULL,
  file_key   varchar(256),
  verify_status varchar(16) DEFAULT 'PENDING'  -- PENDING|VERIFIED|REJECTED
);
-- 健康证硬阻断排班的查询索引（§4.2.2）
CREATE INDEX ix_cert_health ON certificate(employment_id, expire_date)
  WHERE cert_type='HEALTH';

CREATE TABLE hr_change_order (                 -- 入职/调动/调薪/离职/转正 统一单据
  id bigint PRIMARY KEY,
  order_type varchar(24) NOT NULL,             -- ONBOARD|TRANSFER|ADJUST_SALARY|OFFBOARD|REGULARIZE|REHIRE
  employment_id bigint,
  person_id bigint,
  effective_date date NOT NULL,
  payload jsonb NOT NULL,
  status varchar(16) NOT NULL,                 -- DRAFT|PENDING|APPROVED|REJECTED|EXECUTED|CANCELLED
  approval_id bigint,
  origin varchar(8) NOT NULL DEFAULT 'HUMAN',  -- HUMAN|AI（§5.9 溯源）
  executed_at timestamptz
);
```

**为什么所有变更都要"单据"而不是直接改表**：这是 §0.4「历史事实不可变，修正走反向单据」的落点。`hr_change_order` / `schedule_change_order` / `support_order` / `attendance_adjustment` 四类单据构成唯一合法的写入通道，MCP 与 Web 都不得绕过（§5.9 红线 RL11）。

## 3.3 工时域

### 3.3.0 五层结构与表清单（唯一实现，不接受第二套工时模型）

```
事实层  attendance_punch                   原始打卡流水，append-only，无业务外键
        attendance_daily_store_punch       打卡 ↔ 班段关联（role: first_in/last_out/middle）
结果层  attendance_daily                   人 × 日 汇总（判定单元：当日累计、加班认定、工时上限）
        attendance_daily_store             班段明细（计量单元：不跨零点拆分，一天可多行）
        attendance_daily_store_segment     类型段（段内切类型，段严格铺满 span）
        attendance_daily_removed           人日结果被删除的留痕（删除是异常动作）
归属层  employee_org_assignment            归属版本（一人一时点一行，§3.2.4）
        employee_store_assignment          额外出勤门店（一天可多行，§3.2.4）
        employee_attendance_group          员工 → 考勤组（一天可多行，§3.1.3）
        attendance_group_org               组织节点 → 考勤组（同期 1:1，§3.1.3）
控制层  period_seal                        封账控制（封账后到达的 punch 不重算）
字典层  hour_type                          段类型字典（带语义属性，不是 CHECK 列表）
        attendance_status                  人日状态字典（带语义属性）
        compliance_profile                 合规画像（日加班上限/最小休息/周上限/工时制）
        employee_compliance_profile        员工 → 画像（显式关联，兜底取最严档）
        attendance_leave_slice             请假切片（与班段交集的最小单位）
        attendance_leave_conflict          假期 × 考勤冲突（含路由与 SLA）
        attendance_break_skip_log          跳过休息的留痕（"跳过"必须可见）
        contractor_presence                承揽人员在场登记（不进工时模型，但必须可点名）
视图    employee_workplaces_v              某天所有可排班门店（§3.2.4）
        compliance_daily                   按自然日的合规判定（§3.3.11）
        compliance_gap                     相邻班段间的休息间隔判定（§3.3.11）
        v_daily_metric                     出勤/计薪天数的唯一聚合出口
        v_chk_*                            八条校验视图（§3.3.8，编号以 02g 为准）
```

一句话记住分工：**punch 是收到的、daily 是算出来的、assignment 是凭什么、字典是"算什么"、view 是给外面看的。**

**两条命名禁令**
1. **不得出现 `work_hour` / `work_hour_segment` 表名**（与需求研究侧已对齐：那是"逻辑实体"描述，物理实现是下面几张表）。
2. 01 §4.3 的 `worktime_fact` 是**逻辑概念**，物理实现 = `attendance_daily`（判定单元）+ `attendance_daily_store`（计量单元）。**两者合起来才等价于"工时唯一事实源"**，不要另建一张 `worktime_fact` 表。

**为什么事实层与结果层必须分开**
`punch` 是 append-only（设备离线补传会在封账后才到），`daily` 会封账，两者天然打架。分开后：设备时钟不准、重复上报、误刷卡全部沉在 `punch` 层，不污染日结果；`daily` 可按 `(employee_id, work_date)` 全量重算并整段替换，是可重算的结果层。这同时满足「历史事实不可变，修正走反向单据」——`punch` 天然满足，`daily` 靠封账 + 调整单满足。

### 3.3.0b 字典先行：类型用表还是用 CHECK，判据只有一条

**这条判据在本节要反复用，先定死：**

```
某枚举的取值会被"聚合逻辑"读取（SUM / COUNT / CASE WHEN 的判据）→ 必须建小表并带语义属性列
某枚举的取值只被"写入时校验"读取（没有任何统计依赖它）      → 用 CHECK 即可
```

用 CHECK 的真实风险不是"取值写错"，而是**新增一个取值后，散落在各处的字面量列表不会跟着更新**：

```sql
-- 散在汇总视图、薪酬取数、报表里，各写一遍
SUM(CASE WHEN hour_type IN ('ot_weekday','ot_restday','ot_statutory') THEN hours END)
```

新增第四种加班（调休加班）后：约束通过、段写入成功、报表上它**既不进加班合计也不进休息合计**——落到"谁都没算"的缝里，不报错。**错误不发生在写入，发生在统计。**

所以：

| 字典 | 形态 | 理由 |
|---|---|---|
| `hour_type` | **小表 + 属性列** | 加班合计、休息合计、在勤时长都靠它判定 |
| `attendance_status` | **小表 + 属性列** | 出勤天数、应出勤日、计薪天数都靠它判定 |
| `source_kind` | **CHECK** | 只有两个值（`calendar` / `break_rule`），不承载属性，只被段长自证校验读取，**没有统计依赖它**——建表属于"两个机制表达一个约束" |
| `seg_type` | 并入 `hour_type` | 原设计的 `seg_type` 与 `hour_type` 是同一件事的两套词，合并为一张字典，**不留第二套** |

**仓库级禁令（写进编码规范，架构评审强制项）**：

```
除 hour_type / attendance_status 两张字典表的定义本身，
全库禁止出现 hour_type IN ('...') / attendance_status IN ('...') 字面量列表。
汇总一律 JOIN 字典表按属性列判定。
```

**不允许有 IN 列表，就不存在漏改。** 这比"记得同步修改"可靠。

**为什么这条 JOIN 是允许的，且与"结果行不 JOIN 追版本"不冲突**

被禁止的是"JOIN 追**业务数据**的当前版本"（例如实时取 `assignment.type`，同一条历史记录在两次查询里给出不同结果）；允许的是"JOIN **配置字典**"。区别在**变化的同时性**：

- JOIN 业务数据当前值 → 同一行在两次查询里结果不同（不可预期，属于静默改写历史）；
- JOIN 字典属性 → 一次改口径，所有查询**同时**变化（可预期，且这正是期望行为）。

判据：**允许与来源分叉的，存快照；不允许分叉的，JOIN。** `hour_type` 属性属于"改它本来就是改口径"，所以 JOIN。

### 3.3.0c 字段语义表（DDL 的前置文档，不是事后补的说明书）

工时域字段多、名字相近（`work_date` / `business_date` / `natural_date`；`work_hours` / `span_hours` / `in_attendance_hours`），**只靠命名无法判断谁可以改、什么时候改**。下表是本节 DDL 的定义源，字段含义以本表为准。

| 字段 | 含义 | 谁写 | 何时可改 | `immutable_after_write` |
|---|---|---|---|---|
| `attendance_daily.work_date` | 个人归属日（计薪口径） | 引擎（派生） | 仅重算整段替换 | **Y** |
| `attendance_daily.confirm_status` | 日结果确认状态（raw/confirmed/locked） | 确认/封账服务 | raw→confirmed→locked 单向 | N（只能前进） |
| `attendance_daily.attendance_status` | 人日状态（出勤/缺勤/请假/节假日/休息） | 引擎 | 重算时 | **Y** |
| `attendance_daily.is_off_plan` | 计划外出勤标记 | 引擎 | 重算时 | **Y** |
| `attendance_daily.record_owner` | 记录权威方（OWN/SUPPLIER） | 考勤服务单点派生 | 仅供应商策略变更后重算 | **Y** |
| `attendance_daily_store.store_org_id` | 实际出勤门店 | 引擎 | 重算时 | **Y** |
| `attendance_daily_store.business_date` | 班次所属营业日（成本/毛利口径） | 引擎 | 重算时 | **Y** |
| `attendance_daily_store.snap_*` | 14 列快照（13 个 `snap_*` + 1 个偏移；原 13 列清单见 `02g` §I8.4，本轮 +`snap_on_duty_break_basis`） | 引擎（确认时点求值） | **永不** | **Y** |
| `attendance_daily_store.span_hours` 等 5 个时长列 | 班段计量结果 | 引擎 | 重算时 | **Y** |
| `attendance_daily_store.snap_assignment_type` | 班段依据（planned/substitute/support/fallback） | 引擎 | 重算时 | **Y** |
| `attendance_daily_store.assignment_id` | 排班依据外键 | 引擎 | 重算时 | N |
| `attendance_daily_store_segment.*` | 类型段 | 引擎 | 整段替换（不原地改） | **Y** |
| `attendance_punch.*` | 打卡事实 | 采集 | **永不**（DB 权限层禁止） | **Y** |
| `period_seal.sealed_through_date` | 已封到哪一天 | 封账服务 | 只能前进 | N |

`immutable_after_write = Y` 的判定含义：**任何 UPDATE 都必须走"作废 + 重写"或"整段替换"，不允许原地改值。** 检验方式不是靠人记——见 §3.3.8 的 `v_chk_immutable_grants`。

**为什么要有 `immutable_after_write` 这一列**：`REVOKE UPDATE` 的结构性缺陷是——**它作用于白名单，而漏掉的列不在任何清单上，权限语句不会自己报"我漏了一个列"。** 有了这一列，语义表就是清单本身，可以做反向比对（§3.3.8 V8）。

### 3.3.1 班次（集团班次库 + 门店班次）

```sql
CREATE TABLE shift (
  id bigint PRIMARY KEY,
  code varchar(32) NOT NULL,
  name varchar(64) NOT NULL,
  scope varchar(8) NOT NULL,                 -- GROUP（集团班次库）| STORE（门店班次）
  store_id bigint,                           -- scope=STORE 时非空
  ref_shift_id bigint REFERENCES shift(id),  -- 门店引用集团班次的来源
  start_time time NOT NULL,
  end_time   time NOT NULL,
  cross_day  boolean NOT NULL DEFAULT false, -- 22:00→06:00
  break_minutes int NOT NULL DEFAULT 0,
  paid_hours numeric(5,2) NOT NULL,          -- 扣休息后的计薪工时
  color varchar(16),
  need_meal boolean DEFAULT false,
  status varchar(16) NOT NULL DEFAULT 'ACTIVE',
  effective_from date NOT NULL,
  effective_to   date,
  version_no int NOT NULL DEFAULT 1,
  CONSTRAINT ck_shift_scope CHECK ( (scope='GROUP') = (store_id IS NULL) )
);
CREATE UNIQUE INDEX uk_shift_group_code ON shift(code) WHERE scope='GROUP' AND status='ACTIVE';
```

### 3.3.2 排班

```sql
CREATE TABLE schedule_period (                 -- 门店周排班批次
  id bigint PRIMARY KEY,
  store_id bigint NOT NULL,
  week_start date NOT NULL,                    -- 周一
  status varchar(16) NOT NULL,                 -- DRAFT|PUBLISHED|LOCKED
  published_at timestamptz, published_by bigint,
  notice_days int,                             -- 发布时的提前量快照（合规举证）
  UNIQUE (store_id, week_start)
);

CREATE TABLE schedule_assignment (
  id bigint PRIMARY KEY,
  employment_id bigint NOT NULL,
  work_date  date NOT NULL,                    -- 排班所属业务日（= business_date 来源）
  shift_id   bigint NOT NULL,
  store_id   bigint NOT NULL,                  -- 实际到哪个店上这个班
  planned_hours numeric(5,2) NOT NULL,
  start_ts timestamptz NOT NULL,               -- 展开后的绝对起止（跨零点已处理）
  end_ts   timestamptz NOT NULL,
  status varchar(16) NOT NULL,                 -- DRAFT|PUBLISHED|CANCELLED
  source varchar(12) NOT NULL,                 -- MANUAL|AUTO|SWAP|IMPORT|AI

  -- ★ 排班依据类型（四值，无默认值）：不给 fallback 这值，"没有排班"这件事会在系统里消失
  assignment_type text NOT NULL
    CHECK (assignment_type IN ('planned','substitute','support','fallback')),

  -- ★ 用工口径快照：D10 的"承揽不进排班"约束必须建在这张表上（不是建在 employment 上）
  snap_ownership_type        text NOT NULL,    -- SELF|DISPATCH|OUTSOURCE|PLATFORM
  snap_legal_employment_form text NOT NULL,    -- FULL_TIME|PART_TIME|LABOR|SERVICE

  schedule_period_id bigint NOT NULL,
  store_assignment_id bigint REFERENCES employee_store_assignment(id), -- 授权来源
  shift_snapshot jsonb,                        -- 发布时锁定的班次参数（§4.2.3）
  change_order_id bigint,                      -- PUBLISHED 后只能经变更单修改
  UNIQUE (employment_id, work_date, shift_id, store_id),
  CONSTRAINT ck_sa_d10_service
    CHECK (snap_legal_employment_form <> 'SERVICE')
);
CREATE INDEX ix_sched_store_date ON schedule_assignment(store_id, work_date);
CREATE INDEX ix_sched_emp_date   ON schedule_assignment(employment_id, work_date);
CREATE INDEX ix_sched_overlap    ON schedule_assignment(employment_id, start_ts, end_ts);

CREATE TABLE schedule_change_order (           -- 已发布排班的唯一合法变更通道（红线 RL11）
  id bigint PRIMARY KEY,
  store_id bigint NOT NULL, week_start date NOT NULL,
  change_json jsonb NOT NULL,                  -- [{assignmentId, action:CANCEL|REPLACE, newShiftId, ...}]
  reason varchar(500) NOT NULL,
  notify_employees boolean NOT NULL DEFAULT true,
  status varchar(16) NOT NULL,                 -- DRAFT|PENDING|APPROVED|APPLIED|CANCELLED
  approval_id bigint, origin varchar(8) NOT NULL DEFAULT 'HUMAN'
);
```

> 一人一天可排多段（早班 + 晚班），所以唯一键是 `(employment, date, shift, store)` 而非 `(employment, date)`。

**为什么 `assignment_type` 必须有第四个值 `fallback`**

前三个值（`planned` / `substitute` / `support`）都预设"存在一张排班单"。但真实场景里以下三类**根本没有排班依据**：

| 场景 | 有排班单吗 |
|---|---|
| 异地打卡（员工临时到另一个店上班） | 没有 |
| 临时进场（外协当天加人） | 没有 |
| 派遣临时顶岗 | 没有 |

如果只给三个值，这些行的 `assignment_type` 会被**默认填成 `planned`**——于是"这一班没有排班"这件事在系统里彻底消失：排班达成率虚高、缺勤分析永远查不到、排班引擎的"计划 vs 实际"对比被污染。**缺失的枚举值不会报错，它会被最近的值吸收。**

所以 `fallback` 是**承认缺失**的值，它同时是报表指标（`fallback` 占比 = 排班覆盖率缺口）。

配套：`attendance_daily_store.assignment_id` 必须**可空**（`fallback` 行没有排班单），并用 `CHECK` 把这两个字段绑成一体：

```sql
CHECK ( (snap_assignment_type = 'fallback') = (assignment_id IS NULL) )
```

**`fallback` 班段必须与它的「补录单」在同一个事务里落库（本轮补，会静默算错钱）**

`fallback` 行没有 `assignment_id`，所以它**唯一**能被解释"这一班凭什么存在"的方式，就是同一时刻产生的那张单据。若两者分两个事务写：

| 中断位置 | 结果 | 谁会发现 |
|---|---|---|
| 段已写、单失败回滚 | **孤儿班段**：有工时、有成本、无来源。下游 `C2a/C2b/L3/L4` 全绿（它们只看数字） | 没人 |
| 单已写、段失败回滚 | **空单**：一张指向不存在班段的补录单，审批通过后无从执行 | 审批人看到"改完了但工时没变" |
| 都成功但中间重跑了一次 | `ex_ads_no_overlap` 拒绝第二条段 → **整个重算事务失败**，而上一条残留段仍在库里 | 运维（但会先怀疑约束写错了） |

**最隐蔽的是第四种**：单和段都写成功，但**不在同一事务**——此时 `snap_attendance_org_id`（班段取"实际补位门店"，来自打卡所在店）与补录单 `after_json` 里记的门店，来自**两次独立的读**。中间只要有一次迟到打卡补传或一次重算，两处就会各自自洽而互相不一致：**成本落到 A 店、单据批的是 B 店，两处都不报错**。这是"同一事实两处各自推导、无等式"的幽灵形态——本系统里它的代价直接是门店毛利错。

**规则（写死）**：先建单拿 `id` → 再写班段（段上要引用单号）→ 任一失败整体回滚。**顺序不能反**，因为段要引用单；也不能并行，因为段引用的必须是这一笔单。

**"同一个事务"在 PostgreSQL 里是可判定的，不需要靠约定**：

```sql
-- ★ 提交时校验：每条 fallback 班段，必须存在一条"同一事务写入"的补录单
CREATE FUNCTION tg_ads_fallback_same_txn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM attendance_adjustment a
     WHERE a.employee_id = NEW.employee_id
       AND a.work_date   = NEW.work_date
       AND a.xmin        = NEW.xmin          -- ★ 同一事务的判定依据
  ) THEN
    RAISE EXCEPTION 'E_FALLBACK_NO_ORDER_IN_TXN: employee_id=%, work_date=%',
      NEW.employee_id, NEW.work_date USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ctg_ads_fallback_same_txn
  AFTER INSERT ON attendance_daily_store
  DEFERRABLE INITIALLY DEFERRED                 -- ★ 必须 DEFERRED：同事务内两条 INSERT 先后不定
  FOR EACH ROW
  WHEN (NEW.snap_assignment_type = 'fallback')
  EXECUTE FUNCTION tg_ads_fallback_same_txn();
```

**为什么 `DEFERRABLE INITIALLY DEFERRED` 不是可选项**：`AFTER INSERT` 行级约束触发器若立即执行，它在班段插入那一刻就查补录单——而按上面的规则顺序，单**先**写，所以立即模式在**正确顺序下也能通过**。但正确顺序只是我们规定的；一旦有人把顺序反过来（先写段、再建单），立即模式会红，而 DEFERRED 会绿。**DEFERRED 让"顺序"不再是被校验的对象，只有"同事务"被校验**——这正是我们要的：我们不关心谁先谁后，只关心"要么都在，要么都不在"。

> ⚠ **`xmin` 只能用于写入时判定，禁止进事后巡检。** `VACUUM FREEZE` 会把 `xmin` 改写成 `FrozenTransactionId`（`2`），于是历史行的"同事务"事实**在系统层面被抹掉**。任何一条把 `xmin` 写进巡检视图的检查，会在一次 freeze 之后**全库判红**，然后被整条关掉。**"这条判据的有效期限"是设计的一部分**——同族错误见 §4.5 的 `guards` 四档与"证据保鲜"。

**`snap_assignment_source` 不能省（与 `snap_assignment_type` 是两个问题）**

| 列 | 答什么问题 | 取值 |
|---|---|---|
| `snap_assignment_type` | **谁的班**（正式/代班/支援/无依据兜底） | `planned` / `substitute` / `support` / `fallback` |
| `snap_assignment_source` | **这班是怎么来的**（谁做的决定） | `manual` / `ai` / `import` |

它删不得，因为它是**「AI 只出草稿，发布权在店长」这条硬边界的唯一数据依据**。没有它，事后没人能回答"这一班是 AI 排的还是店长排的"——而 `snap_assignment_type='planned'` 既可能是手工也可能是 AI，答不出这个问题。

与 `schedule_assignment.source` 的关系（**两个列不同词表，不要统一**）：

| `schedule_assignment.source`（写入通道） | `snap_assignment_source`（决策权归属） |
|---|---|
| `MANUAL` / `SWAP` | → `manual`（换班由人发起，另有 `change_order_id` 可查） |
| `AI` | → `ai` |
| `AUTO` / `IMPORT` | → `import`（规则批生成与外部导入都非"某人这一班做的决定"） |

前者是"这一行从哪个通道写进来的"（运维/排查用），后者是"这个决定是谁做的"（治理/审计用）。把两者合成一列，会让"AI 起草 + 店长改了两格后发布"这类真实情况无处安放。

**为什么 D10 约束建在排班表上而不是人员表上**

"承揽人员不排班"是一条**行为约束**，它约束的对象是"能否往排班表写这一行"，而不是"这个人的属性是什么"。建在 `employment` 上只能表达"承揽人不能有某些配置"，无法阻止排班写入——**约束建错了表，就等于没建**。

**约束上线方式（存量数据必须能过）**：新约束用 `NOT VALID` 上线，清完存量再加 `VALIDATE CONSTRAINT`，见 §9.5。

### 3.3.3 事实层：原始打卡流水（append-only）+ 打卡关联

```sql
-- 环境前置：EXCLUDE 约束需要 btree_gist
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE attendance_punch (
  id               bigint PRIMARY KEY,
  device_id        bigint,
  employee_ext_id  text,                 -- 设备侧工号，可能尚未关联员工
  employee_id      bigint REFERENCES employment(id),  -- 解析后回填，可空（先收后认）
  store_org_id     bigint NOT NULL,
  punch_at         timestamptz NOT NULL, -- 打卡时刻
  received_at      timestamptz NOT NULL DEFAULT now(),  -- 入库时刻（差值 = 设备离线时长）
  punch_type       text NOT NULL CHECK (punch_type IN ('in','out','unknown')),
  verify_mode      varchar(16),          -- FACE|FINGER|CARD|GEO|MANUAL
  photo_key        varchar(256),
  raw_payload      jsonb,                -- 原始报文，争议时的唯一证据
  ingest_batch_id  bigint                -- 批次号，供重放与幂等
) PARTITION BY RANGE (punch_at);
-- 每月一个分区；DROP 最老分区实现"保留 24 个月"
CREATE UNIQUE INDEX ux_punch_dedup
  ON attendance_punch (device_id, employee_ext_id, punch_at, punch_type);
CREATE INDEX ix_punch_emp   ON attendance_punch (employee_id, punch_at);
CREATE INDEX ix_punch_store ON attendance_punch (store_org_id, punch_at);
```

**`punch` 表的权限约束**：应用账号只授 `INSERT` / `SELECT`，**不授 `UPDATE` / `DELETE`**（迁移脚本里 `REVOKE UPDATE, DELETE ON attendance_punch FROM app_role`）。这是"历史事实不可变"在权限层的落点，比任何注释都硬。

#### 3.3.3b 打卡 ↔ 班段关联表（**不要**在班段表上放 `in_punch_id` / `out_punch_id`）

```sql
CREATE TABLE attendance_daily_store_punch (
  daily_store_id bigint NOT NULL REFERENCES attendance_daily_store(id) ON DELETE CASCADE,
  punch_id       bigint NOT NULL REFERENCES attendance_punch(id),
  role           text   NOT NULL CHECK (role IN ('first_in','last_out','middle')),
  PRIMARY KEY (daily_store_id, punch_id),
  -- ★ 一张卡在同一角色上只能被消费一次；但可以在不同角色上被消费两次
  UNIQUE (punch_id, role)
);
-- 补充：一个班段只能有一个 first_in / 一个 last_out（PK 挡不住两张不同的卡都当 first_in）
CREATE UNIQUE INDEX ux_dsp_one_first_in ON attendance_daily_store_punch(daily_store_id) WHERE role = 'first_in';
CREATE UNIQUE INDEX ux_dsp_one_last_out ON attendance_daily_store_punch(daily_store_id) WHERE role = 'last_out';
CREATE INDEX ix_dsp_punch ON attendance_daily_store_punch(punch_id);
```

**为什么不能是班段表上的两个外键列**

一张卡在**连班不离店**时，合法地同时承担两个语义：

```
员工在 A 店上 08:00–20:00，20:00 直接在 A 店接 B 段夜班 20:00–次日 02:00
→ 20:00 那张卡既是「A 段的 last_out」也是「B 段的 first_in」
```

用 `out_punch_id` + `in_punch_id` 两个列时：**只做单列唯一约束会误杀它，不做唯一约束又无法防止一张卡被重复消费几十次。** 关联表 + `UNIQUE (punch_id, role)` 同时满足两者：

| 约束 | 挡住什么 | 放过什么 |
|---|---|---|
| `UNIQUE (punch_id, role)` | 同一张卡当两次 `last_out` | 同一张卡当 A 的 `last_out` + B 的 `first_in` ✅ |
| `UNIQUE (daily_store_id) WHERE role='first_in'` | 一个班段两个上班卡 | 不同班段各自有上班卡 ✅ |

`role` 的第三个值 `middle` 是"中间卡"（中途外出返回、午休进出）——它不参与首末判定，但必须留痕，否则"这张卡为什么没被用上"无法解释。

### 3.3.4 结果层：人日汇总（判定单元）

```sql
CREATE TABLE attendance_status (               -- 人日状态字典（带属性，不是 CHECK 列表）
  code             text PRIMARY KEY,           -- normal|absent|on_leave|holiday|rest
  label            text NOT NULL,
  is_workday       boolean NOT NULL,           -- 是否属于应出勤日
  counts_as_attend boolean NOT NULL,           -- 是否计入出勤天数
  sort_order       smallint NOT NULL
);
-- 属性列一律不设默认值：新增状态必须显式回答"算不算应出勤、算不算出勤"

CREATE TABLE attendance_daily (
  id              bigint PRIMARY KEY,
  employee_id     bigint NOT NULL REFERENCES employment(id),
  work_date       date   NOT NULL,        -- ★ 个人归属日（计薪口径），定义见 §3.3.5
  primary_store_id bigint,                -- 当日工时最大者（统计用）

  -- ★ 记录权威方：实体列，应用层写入，绝不按天人工覆盖（§3.3.9）
  record_owner    text NOT NULL CHECK (record_owner IN ('OWN','SUPPLIER')),

  -- ★ 人日状态（五值 + 一个标记），替代原来的 is_absent / absence_type 二值对
  attendance_status text NOT NULL REFERENCES attendance_status(code),
  is_off_plan     boolean NOT NULL DEFAULT false,  -- 计划外出勤：计入出勤与工时，但不是应出勤日
  absence_reason  varchar(24),                     -- MISSING_PUNCH|SUSPENDED|UNAPPROVED_LEAVE

  -- 工时（= SUM(daily_store.work_hours)，状态流转时校验）
  work_hours      numeric(6,2) NOT NULL DEFAULT 0,
  ot_weekday_hours    numeric(6,2) NOT NULL DEFAULT 0,
  ot_restday_hours    numeric(6,2) NOT NULL DEFAULT 0,
  ot_statutory_hours  numeric(6,2) NOT NULL DEFAULT 0,
  ot_compensated_hours numeric(6,2) NOT NULL DEFAULT 0,   -- 已安排调休、不付加班费
  statutory_worked_days numeric(3,1) NOT NULL DEFAULT 0,  -- 法定节假日上班天数

  -- 请假 / 双口径天数
  leave_type_id   bigint, leave_hours numeric(5,2) NOT NULL DEFAULT 0,
  attendance_days numeric(3,1) NOT NULL DEFAULT 0,  -- 出勤天数（判勤）
  payroll_days    numeric(3,1) NOT NULL DEFAULT 0,  -- 计薪天数（算钱）— 双口径不等价，01 §6-10
  sick_short_days numeric(3,1), sick_long_days numeric(3,1),
  sick_cross_month_flag boolean NOT NULL DEFAULT false,

  -- ★ 三态（禁用二值布尔）：见下方"为什么三态不能用 boolean"
  allowance_veto_status   text NOT NULL DEFAULT 'not_collected'
    CHECK (allowance_veto_status IN ('triggered','not_triggered','not_collected')),
  allowance_amount_status text NOT NULL DEFAULT 'unknown'
    CHECK (allowance_amount_status IN ('not_applicable','zero','unknown')),

  period_month    char(7) NOT NULL,
  confirm_status  text NOT NULL DEFAULT 'raw'
                  CHECK (confirm_status IN ('raw','confirmed','locked')),
  -- 强制确认的逃生舱（仅在 L1 校验失败且业务必须出薪时使用，永久留痕并进报表）
  force_confirm_reason varchar(500),
  force_confirmed_at   timestamptz,
  seal_id         bigint,
  UNIQUE (employee_id, work_date),         -- ★ 一人一日一行：出勤天数的唯一来源
  CONSTRAINT ck_daily_force CHECK ((force_confirm_reason IS NULL) = (force_confirmed_at IS NULL))
);
CREATE INDEX ix_daily_date  ON attendance_daily (work_date, confirm_status);
CREATE INDEX ix_daily_month ON attendance_daily (employee_id, period_month);

-- ★★ "单向"必须是触发器，不是承诺。
--    只有三值 CHECK 时，任何 UPDATE 都能把 locked 直接改回 raw（一次 UPDATE 就抹掉封账痕迹）。
--    这不是"少一个约束"，是"整条 raw → confirmed → locked 的门在库里没有任何强制力"。
CREATE FUNCTION tg_daily_confirm_forward() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r_old int; r_new int;
BEGIN
  r_old := CASE OLD.confirm_status WHEN 'raw' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END;
  r_new := CASE NEW.confirm_status WHEN 'raw' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END;
  IF r_new < r_old THEN
    RAISE EXCEPTION 'E_CONFIRM_BACKWARD: % -> % (employee_id=%, work_date=%)',
      OLD.confirm_status, NEW.confirm_status, OLD.employee_id, OLD.work_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_daily_confirm_forward
  BEFORE UPDATE OF confirm_status ON attendance_daily
  FOR EACH ROW EXECUTE FUNCTION tg_daily_confirm_forward();
ALTER TABLE attendance_daily ENABLE ALWAYS TRIGGER trg_daily_confirm_forward;

-- ★ 出勤/计薪天数的唯一聚合出口：状态属性与 is_off_plan 的组合只在这里写一次
CREATE VIEW v_daily_metric AS
SELECT d.employee_id, d.period_month,
       -- 判勤天数：状态算作应出勤，或"计划外出勤"（标记列只在这一处生效）
       SUM(CASE WHEN t.counts_as_attend OR d.is_off_plan THEN 1 ELSE 0 END) AS attendance_days,
       SUM(d.payroll_days)                                                   AS payroll_days,
       SUM(CASE WHEN t.is_workday THEN 1 ELSE 0 END)                         AS due_days,
       SUM(d.work_hours)                                                     AS work_hours,
       SUM(d.ot_weekday_hours + d.ot_restday_hours + d.ot_statutory_hours)   AS ot_hours
FROM attendance_daily d
JOIN attendance_status t ON t.code = d.attendance_status
WHERE d.confirm_status = 'locked'
GROUP BY d.employee_id, d.period_month;
```

**为什么这个视图必须存在**：`is_off_plan` 的语义是"不计入应出勤日、但计入出勤天数"。如果这条规则散在十几处报表 SQL 里，**新增一个统计就漏一处**，而漏掉时的表现是"这个月人均产出不对"——没人能定位。视图把它收敛成一句话：**改口径只改这里。**

> 注意：本视图内按行计数是安全的——`attendance_daily` 有 `UNIQUE (employee_id, work_date)`，一人一日一行，所以 `SUM(1)` 就是人日数。**"禁止 `COUNT(*)`、必须 `COUNT(DISTINCT work_date)`"这条约束针对的是 JOIN 了 `attendance_daily_store` 的报表查询**，在那种查询里一人一日会变多行。

**`UNIQUE (employee_id, work_date)` 是这张表存在的唯一理由。** 一日多行会让人天翻倍，而这个错误**不直观**——它会悄悄进人均产出、人效、单店成本率，几个月后才被发现。所有 `person_days` 统计必须 `COUNT(DISTINCT work_date)`，**禁止 `COUNT(*)`**（代码评审强制项）。

**为什么"计划外出勤"是标记不是枚举值**

`is_off_plan` 在语义上是 `rest` / `holiday` 状态上的**叠加**，不是与它们并列的取值：

| 做法 | 后果 |
|---|---|
| 做成枚举值 `off_plan` | 所有统计出勤、工时、成本的 WHERE 都要补一个条件；**漏一处就静默少算**，而且漏的地方与被漏的业务毫无关系 |
| 做成标记列 `is_off_plan` | 统计口径只在 `v_daily_metric` 一处定义，新增统计自动继承 |

判据（与 §3.3.0b 同源）：**需要在某处"包含进来"的变体 → 标记列；需要在某处"排除出去"的变体 → 枚举值。** `off_plan` 属于前者，所以是标记。

**为什么"无分类"不能是一行数据（`unclassified` 已撤销）**

L1 层保证"类型段严格铺满 span"（§3.3.8 的 L1 结构式），所以"存在一段无法分类的时间"在结构上**不可达**。硬留一个 `unclassified` 枚举值，会带来三个后果：

1. 生成器遇到匹配不到规则的时段，不再报错，而是**写一行 `unclassified` 静默归档**；
2. 这类行在报表上只是一列小数字，**没人会看**；
3. 于是"分类规则漏了一种班型"这件事，从"当天出薪前卡住"退化成"三个月后成本对不上"。

**改为：分类失败 → 不产生任何段行 → L1 校验失败 → 人日结果卡在 `raw` → 抛错并带诊断信息**（哪个班段、哪个时刻、匹配失败的规则集版本）。**不设 `classification_status` 列**——让 L1 校验做唯一裁判，多一个状态列就多一个可以绕过裁判的地方。

**为什么三态不能用 boolean**

```sql
-- 错误写法
is_meal_vetoed boolean NOT NULL DEFAULT false
```

`DEFAULT false` 会让"**今天没查**"默认等于"**查了，没触发**"。月底发现津贴多发，无法区分"确实不该扣"和"判定任务根本没跑"。三态把这两件事分开：

| 字段 | 取值 | 含义 |
|---|---|---|
| `*_veto_status` | `triggered` / `not_triggered` / `not_collected` | 判定项是否触发 / **是否压根没采集** |
| `*_amount_status` | `not_applicable` / `zero` / `unknown` | 金额不适用 / 算出是 0 / **算不出来** |

**凡新增一个"不发/少发"的判定项，加一对 `*_status` 列，不得用 boolean。** 这是可加性的来源：`unknown` 必须能被统计出来（"本月有 3200 人次金额未知"是一个必须能问出来的问题）。

**`confirm_status` 与 `attendance_status` 是两件事，不得合并**

- `attendance_status`：**业务判定结果**（这天算出什么）；
- `confirm_status`：**数据成熟度**（这个结果能不能进薪酬）。

合并后必然出现"状态为 `normal` 但还没确认"的语义空洞，下游只能靠时间戳猜。下游消费**一律 `WHERE confirm_status = 'locked'`**（不是 `confirmed`）——`confirmed` 只表示可以看，`locked` 才表示可以算钱。

**"单向"为什么必须是触发器（本轮补）**

`CHECK (confirm_status IN ('raw','confirmed','locked'))` 只约束**取值域**，不约束**方向**。它允许 `locked → raw`，一次 `UPDATE` 就抹掉封账痕迹，且不报错。所以那张表的两个能力被分开了：

| 想要的 | 靠什么 | 现状 |
|---|---|---|
| 取值只能是这三个 | `CHECK` | 有 |
| **只能往前走** | 触发器 `trg_daily_confirm_forward` | 本轮补上 |
| 流转时必须过校验（L1/C2a/C2b/L3） | 服务层 `confirm()` 单点 | 有，但**没有库内强制力** |

**第三行才是真正的洞，而它不被第二行覆盖。** 加了"单向"触发器之后，门仍然敞着：任何人可以直接 `UPDATE ... SET confirm_status='locked'` 从 `raw` 一步跳到 `locked`（单向允许前进），完全跳过 `confirm()` 里的校验。**"只能前进"和"必须过检查点"是两条不同的规则，前者不蕴含后者。**

所以这里要分清两级：

| 级别 | 形态 | 能挡住谁 |
|---|---|---|
| **结构** | 触发器 + CHECK | 挡住"绕过应用直接改库"的**手误**与**事后改历史** |
| **流程** | 只给应用一个 `confirm()` 入口 + 权限上禁止 `app_role` 直接 `UPDATE confirm_status` | 挡住"按错误顺序调用" |

**把 `UPDATE (confirm_status)` 从 `app_role` 里撤掉是最强的一道**——应用改状态只能通过 `SECURITY DEFINER` 的 `fn_daily_confirm()`，而它内部先跑校验再前进。这样"必须过检查点"就从约定变成了**权限事实**：应用**没有能力**跳过校验。触发器保留，作为"有人拿到更高权限后仍然过不去"的第二道。

**两个必须进巡检的"被静默关闭"状态**（不是假设，是这两类对象都有一键关掉的开关）：

```sql
-- 触发器还在，但已不触发（DISABLE / 会话内 session_replication_role = replica 也能绕过）
SELECT tgname, tgenabled FROM pg_trigger WHERE tgenabled NOT IN ('O','A');

-- 约束还在，但从未验证过存量（NOT VALID 状态，对已有行不生效）
SELECT conname, conrelid::regclass FROM pg_constraint WHERE convalidated IS NOT TRUE;
```

**第一类最危险**：`tgenabled='D'` 的触发器在 `pg_trigger` 里**有行、有定义、`pg_get_triggerdef()` 输出完全正常**——任何"查一下触发器在不在"的检查都会判绿，而它一次都不会执行。这与 §4.5 的 `guards` 第四档是同一个失效形态：**"它在"与"它在跑"是两件事。**

### 3.3.5 结果层：班段明细（计量单元）

```sql
CREATE TABLE attendance_daily_store (
  id                  bigint PRIMARY KEY,
  attendance_daily_id bigint NOT NULL REFERENCES attendance_daily(id) ON DELETE CASCADE,
  employee_id         bigint NOT NULL,
  store_org_id        bigint NOT NULL,      -- 组织树节点（可重编）
  store_id            bigint NOT NULL,      -- 门店业务主档（不重编，对外报表/对账用）

  shift_start_at      timestamptz NOT NULL,
  shift_end_at        timestamptz NOT NULL,

  -- ★ 五个时长列：全部实体列，不是生成列
  span_hours           numeric(6,2) NOT NULL,   -- 班段跨度
  work_hours           numeric(6,2) NOT NULL,   -- 计入工时 = span_hours − break_on_duty_hours − break_off_duty_hours
                                                -- （两种休息都不计工时；在勤时长只扣离岗休息 → in_attendance_hours − work_hours ≡ break_on_duty_hours）
  break_on_duty_hours  numeric(6,2) NOT NULL,   -- 在岗休息（人在店内，不计工时）
  break_off_duty_hours numeric(6,2) NOT NULL,   -- 离岗休息（不计工时）
  in_attendance_hours  numeric(6,2) NOT NULL,   -- 在勤时长 = span_hours − break_off_duty_hours

  shift_id            bigint,
  assignment_id       bigint REFERENCES schedule_assignment(id),  -- 可空：fallback 行没有排班单
  snap_assignment_type text NOT NULL
    CHECK (snap_assignment_type IN ('planned','substitute','support','fallback')),
  -- ★ 这班"怎么来的"（决策权归属快照）：与 snap_assignment_type 回答的是两个不同问题
  snap_assignment_source text NOT NULL
    CHECK (snap_assignment_source IN ('manual','ai','import')),

  business_date       date   NOT NULL,      -- 班次所属营业日（成本/毛利/日报表口径）

  -- ★ 时区偏移：用分钟数，不用时区名（见 §3.3.5c）
  snap_utc_offset_minutes smallint NOT NULL,

  -- ★ 个人归属日：**普通列**，由 BEFORE 触发器写入（不是生成列，理由见 §3.3.5c）
  work_date date NOT NULL,

  -- ★ 快照列：全部 NOT NULL、全部实体列（禁 GENERATED，见 §3.3.5b）
  --   清单只此一处：§3.3.5d / 02g §I8.4（**本节不写数量**，理由见 02g §I17.4）
  snap_unit_price              numeric(10,2) NOT NULL,  -- 计费单价
  snap_skill_code              text          NOT NULL,  -- 技能归属
  snap_org_id                  bigint        NOT NULL,  -- ★ 成本组织归属（口径见 03 §6.1 / 02g I8.4；**不是考勤组织**）
  snap_attendance_org_id       bigint        NOT NULL,  -- ★ 考勤组织归属（本班实际在哪家店；fallback 取实际补位门店，见 §3.3.5d）
  snap_payroll_legal_entity_id bigint        NOT NULL,  -- 发薪主体
  snap_billing_mode            text          NOT NULL,  -- 计费模式（按人/按岗/按任务）
  snap_employment_type         text          NOT NULL,  -- FT|PT|LPTT
  snap_pay_basis               text          NOT NULL,  -- MONTHLY|DAILY|HOURLY|PIECEWORK（与 pay_profile.pay_mode 逐字一致，见 §3.3.5b）
  snap_pay_profile_ver         int           NOT NULL,  -- 薪资档案版本
  snap_calc_rule_version       int           NOT NULL,  -- 考勤计算规则版本
  -- ★★ 在岗休息口径的**当时那一版**：直接决定 work_hours 怎么算，而 work_hours 是工资的直接输入。
  --    没有它，chk_ads_sum 只能去读 sys_config（CHECK 读不到），或者放宽成区间（松掉的就是钱）。
  --    加这一列不是为约束服务，是补上一处"参与算钱的中间结果没有固化"的缺口。
  snap_on_duty_break_basis     varchar(12)   NOT NULL,  -- allowance | hourly | none
  snap_ownership_type          text          NOT NULL,  -- SELF|DISPATCH|OUTSOURCE|PLATFORM
  snap_legal_employment_form   text          NOT NULL,  -- FULL_TIME|PART_TIME|LABOR|SERVICE

  CONSTRAINT chk_ads_range  CHECK (shift_end_at > shift_start_at),
  CONSTRAINT chk_ads_max24  CHECK (shift_end_at - shift_start_at <= interval '24 hours'),
  -- ★★ L0 的物理锚：span_hours 必须等于真实时刻差。
  --    全清单里唯一"锚定来源 = 无"的一条，因此它必须自带断言，不能靠别的校验替它发现错误。
  CONSTRAINT chk_ads_span CHECK (
    span_hours = round(EXTRACT(EPOCH FROM (shift_end_at - shift_start_at)) / 3600.0, 2)
  ),
  -- ★★ 分量非负：chk_ads_sum / chk_ads_off 是两条线性方程、五个未知数，
  --    解空间里存在 break = -3 的解；负休息会让 in_attendance_hours > span_hours、work_hours < 0，
  --    而两条方程照常成立。物理锚管不到这一点（span 没变），必须单独禁负。
  CONSTRAINT chk_ads_nonneg CHECK (
    work_hours >= 0 AND break_on_duty_hours >= 0
    AND break_off_duty_hours >= 0 AND in_attendance_hours >= 0
  ),
  CONSTRAINT chk_ads_assign CHECK ( (snap_assignment_type = 'fallback') = (assignment_id IS NULL) ),
  -- ★ 直接分派计薪公式的两列必须有值域约束（否则选错字面量三个月无人知）
  CONSTRAINT ck_ads_pay_basis  CHECK (snap_pay_basis  IN ('MONTHLY','DAILY','HOURLY','PIECEWORK')),
  CONSTRAINT ck_ads_ownership  CHECK (snap_ownership_type IN ('SELF','DISPATCH','OUTSOURCE','PLATFORM')),
  -- ★ 容差必须是 0，不能写 < 0.01：五个列同为 numeric(6,2)，numeric 减法精确保留标度，
  --   差值是 0.01 的整数倍，abs(diff) 只可能取 0 / 0.01 / 0.02…
  --   → 写 < 0.01 在格点上等价于 = 0（当前行为是对的，但"容差"这个词是假的）
  --   → 而列若放宽到 numeric(8,4)，同一行 CHECK 会静默松 100 倍，且 diff 上只有列类型一处改动
  --   同标度 numeric 之间的恒等式，容差恒为 0（02g §I36.1）
  CONSTRAINT ck_ads_snap_odb CHECK (snap_on_duty_break_basis IN ('allowance','hourly','none')),
  -- ★★ L2 不是一个等式，是**两个**，按快照列选。精确相等保留，没有容差。
  --    hourly    ：在岗休息并入工时 → work = in_att（= span − off）
  --    其余两形态 ：在岗休息不计工时 → work = in_att − on
  --    ★ 新增第四种 on_duty_break_basis 取值时，必须**同时**改这条 CHECK 与 §3.3.8 的 L2 两式，
  --      否则新形态会静默落进 `<> 'hourly'` 分支，按"扣掉在岗休息"算钱——不报错，少发钱。
  CONSTRAINT chk_ads_sum CHECK (
    (snap_on_duty_break_basis =  'hourly' AND work_hours = in_attendance_hours)
    OR
    (snap_on_duty_break_basis <> 'hourly' AND work_hours = in_attendance_hours - break_on_duty_hours)
  ),
  CONSTRAINT chk_ads_off    CHECK ( in_attendance_hours = span_hours - break_off_duty_hours ),
  -- ★ 为什么 chk_ads_span 用精确相等而非容差（与上面两条同理，此处特别点明）：
  --   span_hours 是 numeric(6,2)，右侧 round(…, 2) 也是 scale 2，两边都是 0.01 的整数倍，
  --   差值必为 0.01 的整数倍 → "abs(diff) < 0.01" 与 "=" 在格点上等价。
  --   写容差等于给未来留一个会漂的自由度：有人把列改成 numeric(8,4)，同一条约束会静默允许差 0.0099。
  --   跨类型换算（EXTRACT/3600）的舍入由 round(…,2) 显式收口，不靠容差吸收 —— 02g §I36.1。
  UNIQUE (employee_id, work_date, store_org_id, shift_start_at),
  -- ★ 复合外键：班段的 work_date 必须等于母行人日的 work_date（代理键做不到这一点）
  CONSTRAINT fk_ads_daily_workdate
    FOREIGN KEY (employee_id, work_date) REFERENCES attendance_daily (employee_id, work_date)
);
-- ★ 一个人不能同时出现在两个地方：物理事实由数据库保证，不靠业务代码
ALTER TABLE attendance_daily_store ADD CONSTRAINT ex_ads_no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    tstzrange(shift_start_at, shift_end_at, '[)') WITH &&
  );
CREATE INDEX ix_ads_store ON attendance_daily_store (store_org_id, business_date);
CREATE INDEX ix_ads_emp   ON attendance_daily_store (employee_id, work_date);
CREATE INDEX ix_ads_daily ON attendance_daily_store (attendance_daily_id);
```

**为什么必须多出 `chk_ads_span` 与 `chk_ads_nonneg`：五列是一个自洽的封闭体系**

把 §3.3.8 的两条父行拆分式放在一起看：

```
chk_ads_sum :  span = work + on  + off
chk_ads_off :  in_att = span − off
```

**两条方程、五个未知数。** 任给一组合法的 `(span, on, off)`，`work` 与 `in_att` 都被唯一确定，于是**两条校验全绿**——包括 `span = 500`、`on = 0`、`off = 0`、`work = 500`、`in_att = 500` 这一组。这不是"某个校验写松了"，是**方程组本身的秩不够**：两条式子只约束"这五个数彼此相容"，完全不约束"它们是不是真的"。

| 洞 | 形态 | 谁唯一能发现 | 修法 |
|---|---|---|---|
| **数值与物理事实脱钩** | `span_hours` 可以是任意正数，只要 `work/on/off` 跟着配 | **只有 `chk_ads_span`**（`Σ(seg.hours)` 是第二次独立测量，但它是视图，没有强制力） | 物理锚 CHECK |
| **解空间含负分量** | `off = -3` 让 `in_att = span + 3`、`work < span`，两式仍成立 | **只有 `chk_ads_nonneg`**（物理锚管不到，`span` 没变） | 分量非负 CHECK |

**`span_hours` 取任意值为什么不会连锁失败**：`C2a / C2b / L3 / L4` 的比对对象是**段表**，而段是**绝对时刻**、`attendance_daily_store_segment.hours` 有自己绑在 `seg_start_at/seg_end_at` 上的硬 CHECK。所以段表求和是真实跨度的**第二次独立测量**，它不经过 `span_hours`。这意味着：**`span` 错了，四条下游校验照样全绿**——它们只保证"父行与段表一致"，不保证"两者都等于现实"。这就是为什么这条锚必须由 `CHECK` 承担，而不是分配给下游任意一条。

**为什么用精确相等、不用 `< 0.01` 容差**：`span_hours` 是 `numeric(6,2)`，右侧 `round(..., 2)` 也是 scale 2——两边都是 0.01 的整数倍，差值必然是 0.01 的整数倍，所以"差值的绝对值 < 0.01"与"相等"**在这个类型下等价**，写容差只是给未来留一个会漂的自由度（一旦有人把列宽改成 `numeric(8,3)`，同一条约束会静默允许差 0.0099）。`chk_ads_off` 同理，取精确相等。

> **（v1.6 修正）** 本节早前写"`chk_ads_sum` / `chk_ads_off` 保留 `< 0.01` 是有意的"——**这句已作废**。理由：三列相加与相减**同为 `numeric(6,2)`**，格点完全相同，容差在这里不是"为未来跨精度留余地"，而是**当前就把校验放松了一档**。真要跨精度，正确做法是迁移时显式 `round(...,2)` 收口（`chk_ads_span` 就是这么写的），而不是靠容差吸收。可查判据见 `02g` §I36.1。

**`round` 的第二参数与列 scale 必须同源（本轮补的机检，缺了它前一条会静默过严）**

`span_hours` 现在是 `numeric(6,2)`，`round(…, 2)` 与之匹配。**但这个 `2` 是写死的字面量**，而列宽会被人以正当理由改（产品侧已提出工时精度应从 0.01 小时提到 0.0001 小时）：

```
列   numeric(8,4)          允许 8.0041
断言 span = round(…, 2)    只允许 8.00     ← 8.0039（= 8 小时 14 秒）被判非法
```

**这个错的方向是"合法数据被判非法"，而它比"非法数据通过"更容易上线**：上线前数据都是整点，测不出来；上线后门店按分钟打，每周都红；然后有人把这条 `CHECK` 改 `NOT VALID` 或直接删掉——**删掉之后 `span` 又回到可以取任意值**。

```sql
-- 判据：CHECK 里 round/trunc 的位数必须等于目标列的 numeric_scale
-- 实现方式：从 pg_get_constraintdef 里 regexp 出 round(…, N)，与该列 information_schema.columns.numeric_scale 比对
-- 期望：全部相等
SELECT c.table_name, c.column_name, c.numeric_scale,
       substring(pg_get_constraintdef(con.oid) from 'round\([^,]+,\s*([0-9]+)\)')::int AS round_digits
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attname = ANY (
         ARRAY['hours','span_hours','work_hours','break_on_duty_hours',
               'break_off_duty_hours','in_attendance_hours'])
  JOIN information_schema.columns c
    ON c.table_name = rel.relname AND c.column_name = a.attname
 WHERE con.contype = 'c' AND pg_get_constraintdef(con.oid) LIKE '%round(%';
```

**适用面**：`chk_ads_span` / `chk_seg_hours` 属"跨类型换算"类（含 `EXTRACT` / `interval` / 除法），一律用 `round(expr, 列 scale)` 精确比；`chk_ads_sum` / `chk_ads_off` / `chk_ads_nonneg` 属"同标度相加"类，**容差恒为 0**（`numeric(p,s)` 加减精确保留标度，差值只落在 `10^-s` 的格点上，`< 0.01` 与 `= 0` 在格点上等价——但"容差"这个词是假的，写它就是给未来留一个会漂的自由度）。

**B 类不存在"精确"这一档，必须说清**：`round` 版与容差版**允许的误差是同一量级**（±0.005 vs ±0.01），scale 差只能被转移、不能被消除。选 `round` 的理由不是"更准"，是**这个数归谁审**：

```
round(…, 2)   → 表达"计量单位是 0.01 小时"   业务事实，HR 能审
< 0.01        → 表达"允许 0.01 的误差"        实现事实，只有工程师能调
```

而且**这个优势是"可以被审"，不是"已经被审"**——`2` 写在 `CHECK` 里，业务方看不到。要兑现，需要业务词典里有"工时按 0.01 小时记"这句话，且那个 `2` 与它同源。**[推断·文档] 该定义目前不在 `03` 里，是一个产品缺口**（工时计量单位从未被产品定义过，现在由这条 `CHECK` 的字面量定义着——而它决定"不足 36 秒是舍还是进"，后者在劳动争议里是一个能被问出来的问题）。

**`EXTRACT(EPOCH FROM timestamptz − timestamptz)` 在 `CHECK` 里是 immutable 的**（评审必问）：`timestamptz − timestamptz` 得到的是两个**绝对时刻**之差，不经过时区解析，所以它跟 `TimeZone` 参数无关；`EXTRACT(EPOCH FROM interval)` 只做单位换算。**依赖时区的只有"把时刻截断到某个日历日"这一动作**（那件事由 `work_date` + `snap_utc_offset_minutes` 负责，见 §3.3.5c），不是差值。所以这条 `CHECK` 可以在任何会话时区下给出同一个结论。

> **⚠ `chk_ads_sum` 曾经在 `hourly` 模式下会全表拒绝写入 —— 已裁决并修复，两种解法记在这里**

旧形态是 `span = work + on + off`，它**只在 `on_duty_break_basis ∈ {allowance, none}` 下成立**。`hourly` 模式下 `work = span − off`，于是 `work + on + off = span + on ≠ span` —— **配置一开，全表拒绝写入**，随后这条约束会被整条关掉（§10 已登记这条失效路径："任何只增不减的约束系统，最终以系统被关掉恢复可满足性"）。

`CHECK` 读不到 `sys_config`，所以有两条路，**选了第二条**：

| 路 | 形态 | 为什么不行 / 行 |
|---|---|---|
| ❌ 松成区间约束 | `in_att − on ≤ work ≤ in_att` | 三形态全成立、无析取、无配置依赖——**但它在 `allowance` 下允许 `work` 取区间内任何值，而 `work` 就是钱**。为了修一个"会红"的问题，换来一个"不会红"的问题，而后者是工资 |
| ✅ **把配置快照到行上** | 加 `snap_on_duty_break_basis`，`chk_ads_sum` 写成基于快照列的析取式，**精确相等保留** | ① 这一列本来就该有——`on_duty_break_basis` 直接决定 `work_hours` 怎么算，属于"参与算钱的中间结果必须能固化"；`snap_pay_basis` 已有，同一条道理在这里漏了；② 加了它之后，配置再也进不了 `CHECK` 的路径——约束只看同行，`sys_config` 怎么改都不影响历史行；③ 这个性质**靠加列得到，不靠放宽得到** |

**迁移这一列比建列本身重要**（写死，不许抄漏）：

```sql
ALTER TABLE attendance_daily_store
  ADD COLUMN snap_on_duty_break_basis varchar(12) NOT NULL DEFAULT 'allowance';
ALTER TABLE attendance_daily_store
  ALTER COLUMN snap_on_duty_break_basis DROP DEFAULT;   -- ★ 必须紧接着做
```

**为什么必须 `DROP DEFAULT`**：这一列的全部意义是"**当时**取的那一版"。留着默认值，将来改配置默认值时，一次 `ALTER COLUMN … SET DEFAULT 'hourly'` 会把**所有历史行的"当时值"**一起改掉——而那一列的存在就是为了不可变。默认值只在回填那一刻是工具，之后它就是污染源。

**配套一条断言**（进 §4.5 注册表）：`attendance_daily_store.snap_on_duty_break_basis` 的 `column_default` 必须为 `NULL`。这条能直接扫 `information_schema.columns`，**不需要基线**。


PostgreSQL 的 `GENERATED ALWAYS AS ... STORED` **不能跨表聚合**——它只能引用**本行**的列。而 `work_hours` 的定义是 `Σ(本班段的类型段)`，类型段在另一张表里。所以这五个列只能由应用层从段表算出后写入。

推论（很关键）：**因为它们是独立写入的，跨列/跨层的一致性校验才有意义**——见 §3.3.8 的 C2a/C2b/C3/C4。如果它们都是生成列，这些校验就会退化成恒真（用同一份输入算两遍永远相等），校验写了等于没写。

### 3.3.5b 为什么 12 个快照列必须禁止 `GENERATED ALWAYS`

```sql
-- ❌ 绝对禁止
snap_unit_price        numeric(10,2) GENERATED ALWAYS AS (current_unit_price(...)) STORED,
snap_org_id            bigint        GENERATED ALWAYS AS (current_org_of(employee_id)) STORED,
snap_attendance_org_id bigint        GENERATED ALWAYS AS (current_attendance_org_of(employee_id)) STORED
-- 第三个反例与第二个同因：它也会算"现在"，而跨店支援当天的实际门店与员工当前归属本来就不是一回事
```

**理由只有一条：生成列永远算"现在"，快照要的是"当时"。**

`GENERATED ALWAYS` 的语义是"每次写入时按当前数据求值"。而快照列要在**考勤确认日**取值，此后门店调价、调岗、主体变更、规则改版都不得影响它。两条路的差别不在实现复杂度，在**错的时间点**：

| 时点 | 结果是 |
|---|---|
| 班段写入时按当前主数据算（生成列） | 写入时对了；但任何"整段替换重算"都会用**新的**主数据覆盖，历史被静默改写 |
| 考勤确认日算一次并冻结（实体列） | 重算时**从已有值复制**，历史不被改写 |

所以：**实体列 + 写入方在确认时点求值 + 重算时复制而非重算 + 权限层禁止 UPDATE（`immutable_after_write=Y`）**。

**验收用例（写进测试清单，作为"快照有效"的判定标准）**

```
用例 A：历史快照不被主数据变更影响
1. 员工 E 在门店 S 上班，确认 2026-03 工时；此时 S 的计费单价 = 30，快照 snap_unit_price = 30
2. 2026-05 门店 S 调价到 40
3. 触发 2026-03 的整段重算（例如补卡调整）
4. 断言：2026-03 的 snap_unit_price 仍然 = 30（不是 40）
5. 断言：2026-03 对应 payroll_record 金额不变
若第 4 步得到 40 → 快照列被实现成了"可重算"，属于架构级缺陷，返工而不是改测试。
```

```
用例 B：规则改版不改变历史工时
1. 确认 2026-03 工时；记录 snap_calc_rule_version = v7
2. 修改考勤规则（宽限时间 5 分钟 → 10 分钟），发布 v8
3. 重算 2026-03
4. 断言：snap_calc_rule_version 仍为 v7，工时结果与改版前逐小时一致
```

**禁生成列只保证了"不会被自动改"，没保证"一开始就是对的"。** 快照的定义有两半，上面那段只覆盖了后半（读取时不重新求值）；前半是**写入时值 = 源在指定版本上的值**，而这一半目前**一条断言都没有**——13 列只有 `NOT NULL` + 禁生成列，等于一个可以手填任意合法值且永不自纠的列。

所以每个快照列配一条**等值断言**（跨表比对不能进 `CHECK`，只能做巡检项）：

```sql
-- 期望 count = 0
SELECT count(*) FROM attendance_daily_store s
  JOIN pay_profile_version v
    ON v.employment_id = s.employee_id AND v.version = s.snap_pay_profile_ver
 WHERE s.snap_pay_basis IS DISTINCT FROM v.pay_mode;
```

| 三条硬要求 | 说明 |
|---|---|
| 右边必须是**版本表**，不是主档 | 用主档写，主档一改断言就红——那不是发现错误，是发现正常业务 |
| `snap_pay_profile_ver` / `snap_calc_rule_version` 自己不需要等值断言 | 它们就是版本号，但它们是其余十列 JOIN 的键 |
| 这条断言的有效性**依赖版本表不可变** | 版本表一旦允许原地改，等值断言退化成"用当前值校验当前值"，**恒真**，十二条一起变假而各自看起来都还在跑 |

→ 所以版本表必须同时有 `REVOKE UPDATE, DELETE` + 不可变触发器（与 §3.3.6 字典行同一手法），并登记进"触发器失效巡检"清单（`pg_trigger.tgenabled`）。**只做等值断言不做版本表不可变，等于装了一个会静默失效的检查。**

### 3.3.5c `work_date` 的写入机制：普通列 + BEFORE 触发器 + CHECK + 复合外键

**先说结论：`work_date` 不是生成列，是触发器写入的普通列。** 这不是实现偏好问题，是**恢复路径**问题。

| | 生成列 | 普通列（触发器写） |
|---|---|---|
| 备份恢复到另一实例时 | **被重算** | **原值照搬** |
| 结果对不对 | 取决于恢复环境的时区设置与 tzdata 版本 | 与环境无关 |

`work_date` 是**计薪归属键**。恢复后重算出不同的值 = **工资归属月变了**——在灾难恢复之上再叠一层数据错。而这个风险**只在"上线后第一次真实恢复"时暴露**：那时所有人都会去怀疑备份文件、磁盘、DBA 操作，**没有人会想到去怀疑一个生成列**。

**恢复确定性比写入防错重要，因为写错会被校验抓到，恢复错不会。**

```sql
-- ① 唯一的表达式实现（只有一份，不允许在触发器与 CHECK 里各写一遍）
CREATE FUNCTION fn_work_date(shift_start_at timestamptz, offset_minutes smallint)
  RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT ((shift_start_at + make_interval(mins => offset_minutes)) AT TIME ZONE 'UTC')::date
$$;

-- ② BEFORE 触发器赋值
CREATE FUNCTION tg_ads_work_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.work_date := fn_work_date(NEW.shift_start_at, NEW.snap_utc_offset_minutes);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_ads_work_date BEFORE INSERT OR UPDATE
  ON attendance_daily_store FOR EACH ROW EXECUTE FUNCTION tg_ads_work_date();

-- ③ CHECK 复验（防"绕过触发器手写"）
ALTER TABLE attendance_daily_store ADD CONSTRAINT ck_ads_work_date CHECK (
  work_date = fn_work_date(shift_start_at, snap_utc_offset_minutes)
);

-- ④ 应用层对该列无写权限
REVOKE INSERT (work_date), UPDATE (work_date) ON attendance_daily_store FROM app_role;
```

**`CHECK` 只防半件事，必须写明（否则后来人会以为有 CHECK 就万无一失）**

| 威胁 | 由谁挡 |
|---|---|
| 绕过触发器直接 `INSERT/UPDATE` 一个错的 `work_date` | ✅ `CHECK`（它从本行输入**独立重算**一遍） |
| **触发器表达式本身算错** | ❌ **`CHECK` 挡不住**——它跑的是同一条表达式（同一个 `fn_work_date`），**同错即同过** |
| 应用层直接改 `work_date` | ✅ `REVOKE` 列级写权限 |
| 表达式算错导致的系统性偏差 | ✅ **§3.3.12 的离线独立重算**（纯 SQL 另写一遍，不复用 `fn_work_date`） |

上面第四行是这条设计的关键：**`CHECK` + 触发器是"同一份实现跑两遍"，不能互为独立证据**。独立性只能来自 §3.3.12 那套不复用任何计算函数的对账。

**为什么表达式必须"先转无时区再加偏移"**

```sql
-- ✅ 正确：timestamptz → timestamp（IMMUTABLE），加偏移，再取 date
((shift_start_at AT TIME ZONE 'UTC') + make_interval(mins => snap_utc_offset_minutes))::date

-- ❌ 错误：直接对 timestamptz 取 date
(shift_start_at AT TIME ZONE 'Asia/Shanghai')::date
```

两个原因，任一条都足以埋雷：

1. **`timestamptz::date` 是 `STABLE` 不是 `IMMUTABLE`**——它依赖会话的 `TimeZone` 参数。函数体若含 STABLE 操作，`IMMUTABLE` 声明就是撒谎，索引/约束里的行为不可预期。
2. **写时区名会绑死 tzdata 版本**——某地区调整历史偏移后，`pg_dump` 恢复或 tzdata 升级会让存量行算出的值**变化**，CHECK 随之对不上（"改个备注字段都报错"）。用 `snap_utc_offset_minutes` 把偏移**冻结在快照里**，`work_date` 从此只依赖本行取值。

**这条写成规范**：`work_date` 必须只依赖本行取值，不得引入任何环境提供的数据（会话时区、`now()`、`current_setting`、子查询、**另一张表的当前值**）。违反这一条的列不允许进幂等签名的覆盖范围，也不允许被算薪读取。

**`fn_work_date` 禁止改动**

改动后：旧行不动（`CHECK` 只在写入时跑），新行按新定义写入，**同一个字段里并存两种定义，而没有任何东西会报错**。要改即视为口径变更——加版本常量、写迁移、记录哪些行按旧定义生成。CI 断言"函数体变化必须伴随版本常量变化"。

**为什么不用时区名 `snap_work_tz`**

偏移是**事实**（这班当时是 UTC+8），时区名是**规则**（这个城市今天该用 UTC+8）。规则会变，事实不会。存事实，才能让历史行永远可解释；存规则，就等着某天开始"历史行不满足约束"。

由此得一条通则：**计算必须用冻结值；展示允许用当前值。** 判据不是"要不要快照"，是"这个值错了会进哪本账"——进账的要冻结，只给人看的可以不冻结。区域分组用 `org_unit` 的组织维度，不用时区名。

**为什么复合外键挂在 `(employee_id, work_date)` 而不是代理键**

```sql
-- ✅ 保留
FOREIGN KEY (employee_id, work_date) REFERENCES attendance_daily (employee_id, work_date)
-- ❌ 建不出来，而且是错的
FOREIGN KEY (attendance_daily_id) REFERENCES attendance_daily (id)
```

**理由不是"哪个建得出来"，是"哪个表达得出来"**：

- 单列 FK 到 `attendance_daily(id)` **能建**（`id` 是主键），但它只保证"挂到了某个存在的人日"——**挂错到隔壁那天照样通过**。
- 而"工时算到别人头上 / 算进别的月份"这类错，**所有逐行校验全绿**：因为每一行自己都是自洽的，错的只是它与母行的对应关系。逐行断言看不见它。
- 复合外键 `(employee_id, work_date)` 把"班段的 `work_date` 必须等于母行人日的 `work_date`"变成**结构保证**，不靠任何人记得去查。

一句话：**代理键保证"存在"，复合键保证"是这一个"。** 计薪归属键需要的显然是后者。

`UNIQUE (employee_id, work_date)` 已经是这张表存在的核心理由（§3.3.4），所以被引用侧的索引不需要额外代价。

### 3.3.5d `snap_attendance_org_id`：考勤组织归属快照（13 列里最容易被省掉的一列）

**为什么必须单独一列，而不是复用 `snap_org_id`**

`snap_org_id` 的口径是**成本组织**（03 §6.1 快照落点表、02g I8.4 两处一致）；在此之前 04 那句注释写的"组织归属"是含糊的一方。两者在餐饮是**常态性不同**的：跨店支援、代管、借调下，人当天在 A 店打卡、成本记 B 店。

漏这一列的后果不是"权限宽一点严一点"，是**用成本组织列去过滤考勤维度**，且两种错法都静默通过：

| 情形 | 结果 |
|---|---|
| 考勤范围 A 店、成本记 B 店 | **该看的人看不到**（数字少一截，没人报错） |
| 成本记 A 店、实际在 B 店打卡 | **不该看的人看到**（不越权报错，页面就是个正常数字） |

**取值口径（三条，不许自行发挥）**

| 情形 | `snap_attendance_org_id` 取什么 |
|---|---|
| 计划/换班/支援班段（`planned` / `substitute` / `support`） | 该班段的**排班所属考勤组 / 门店** |
| 补位班段（`snap_assignment_type = 'fallback'`） | **实际补位的那家门店**，不取员工归属 |
| 任何情形 | **不允许**用 `employee_org_assignment` 按 `work_date` 回查代替 |

最后一条要展开，因为它是最省事也最错的写法：SCD2 回答的是"**员工当时归属哪个考勤组**"，而餐饮要的是"**这班实际在哪家店**"。支援场景下这两者本来就不同——回查看起来对，在单店员工身上也对，只在支援时错，而支援恰恰是最需要权限收窄的场景。

**连带改三处清单，一处都不能漏**（漏任何一处，那条清单就和 DDL 对不上）

| 文档 | 位置 | 改什么 |
|---|---|---|
| `04` | §3.3.5 DDL + §3.3.5b 的"12 个快照列" | 已改 |
| `03` | §6.1 快照落点表 | 12 项 + 期间 2 项 → **13 项 + 期间 2 项** |
| `02g` | I8.4 快照清单 | 同步加一行 |

### 3.3.6 类型段（段内切类型）

```sql
CREATE TABLE hour_type (
  code           text PRIMARY KEY,             -- 6 个值，见下表
  label          text NOT NULL,
  counts_as_work boolean NOT NULL,             -- 计入工时
  on_duty        boolean NOT NULL,             -- 在岗（人在店内）
  is_ot          boolean NOT NULL,             -- 属于加班（NOT NULL：可空时"NULL + 有倍率"会静默过关）
  ot_multiplier  numeric(4,2),
  sort_order     smallint NOT NULL,

  -- ★ 只可停用、不可物理删除（见下方"删除必须是停用"）
  is_active      boolean NOT NULL,             -- 无默认值：新增类型必须显式回答"现在生效吗"
  deactivated_at timestamptz,
  deactivated_by bigint,

  CONSTRAINT ck_ht_ot_is_work   CHECK (NOT is_ot OR counts_as_work),   -- 加班必计入工时
  CONSTRAINT ck_ht_mult_oneway  CHECK (is_ot OR ot_multiplier IS NULL), -- 非加班不得带倍率
  CONSTRAINT ck_ht_active       CHECK ( is_active = (deactivated_at IS NULL) )
);

INSERT INTO hour_type (code, label, counts_as_work, on_duty, is_ot, ot_multiplier, sort_order, is_active) VALUES
  ('normal',         '正常工时',       true,  true,  false, NULL, 1, true),
  ('break_on_duty',  '在岗休息',       false, true,  false, NULL, 2, true),
  ('break_off_duty', '离岗休息',       false, false, false, NULL, 3, true),
  ('ot_weekday',     '工作日加班',     true,  true,  true,  1.50, 4, true),
  ('ot_restday',     '休息日加班',     true,  true,  true,  2.00, 5, true),
  ('ot_statutory',   '法定节假日加班', true,  true,  true,  3.00, 6, true);

-- ★ 停用后不得再被写入新段（历史行保持原引用不变）
CREATE OR REPLACE FUNCTION tg_seg_hour_type_active() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hour_type t
                 WHERE t.code = NEW.hour_type AND t.is_active) THEN
    RAISE EXCEPTION 'E_HOUR_TYPE_INACTIVE: %', NEW.hour_type;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_seg_hour_type_active BEFORE INSERT OR UPDATE
  ON attendance_daily_store_segment FOR EACH ROW EXECUTE FUNCTION tg_seg_hour_type_active();

CREATE TABLE attendance_daily_store_segment (
  id                   bigint PRIMARY KEY,
  daily_store_id       bigint NOT NULL REFERENCES attendance_daily_store(id) ON DELETE CASCADE,
  seq                  smallint NOT NULL,        -- 段序号（同一班段内从 1 起，用于定位断言）
  hour_type            text NOT NULL REFERENCES hour_type(code),
  seg_start_at         timestamptz NOT NULL,
  seg_end_at           timestamptz NOT NULL,
  hours                numeric(6,2) NOT NULL,
  multiplier           numeric(4,2),             -- 只记事实：薪酬侧回写的认定倍率

  -- ★ 段长自证：段长必须等于"它的来源类型 + 规则引用"算出的期望长度
  source_kind           text NOT NULL CHECK (source_kind IN ('calendar','break_rule','manual')),
  break_rule_id         bigint,
  break_rule_version    int,
  rule_duration_minutes int,

  -- ★ manual 段（无规则可重算）的留痕：否则"A5b 查不出来就标 manual"是零成本的绕过
  operator_id           bigint,
  break_adjust_reason   varchar(500),
  edited_at             timestamptz,

  -- 休息裁剪痕迹（跳过 / 被跳过时能解释）
  break_trimmed_minutes int,
  break_edit_revoked    boolean NOT NULL DEFAULT false,

  -- 津贴按段计（不按班次计：同一班段内不同时段的津贴口径可以不同）
  snap_allowance_json   jsonb,

  CONSTRAINT chk_seg_range CHECK (seg_end_at > seg_start_at),
  -- ★ 与 chk_ads_span 同一形态：跨类型换算（EXTRACT/3600）的舍入由 round(…,2) 显式收口，
  --   不靠容差吸收。hours 是 numeric(6,2)，round 的第二参数必须等于它（同源，见 §3.3.5 的机检断言）。
  CONSTRAINT chk_seg_hours CHECK (
    hours = round(EXTRACT(EPOCH FROM (seg_end_at - seg_start_at)) / 3600.0, 2)
  ),
  CONSTRAINT chk_seg_src   CHECK ( (source_kind = 'break_rule') = (break_rule_id IS NOT NULL) ),
  -- manual 段必须留痕（谁改的 / 为什么 / 什么时候），否则人工绕过 A5b 是零成本的
  CONSTRAINT ck_manual_seg CHECK (
       source_kind <> 'manual'
    OR (operator_id IS NOT NULL AND break_adjust_reason IS NOT NULL AND edited_at IS NOT NULL)
  ),
  UNIQUE (daily_store_id, seq)
);
CREATE INDEX ix_seg_store ON attendance_daily_store_segment (daily_store_id, seg_start_at);
```

**六种 `hour_type` 与"为什么没有 `unclassified`"**

| code | 计入工时 | 在岗 | 加班 | 倍率 | 用途 |
|---|---|---|---|---|---|
| `normal` | ✅ | ✅ | — | — | 正常工时 |
| `break_on_duty` | ❌ | ✅ | — | — | 在岗休息（人在店内待命，不计工时） |
| `break_off_duty` | ❌ | ❌ | — | — | 离岗休息 |
| `ot_weekday` | ✅ | ✅ | ✅ | 1.50 | 工作日加班 |
| `ot_restday` | ✅ | ✅ | ✅ | 2.00 | 休息日加班 |
| `ot_statutory` | ✅ | ✅ | ✅ | 3.00 | 法定节假日加班 |

`unclassified` 已删除——理由见 §3.3.4「为什么无分类不能是一行数据」。**这不是"少了一个兜底"，是把兜底从"报表上一列数字"换成"当天出不了薪"**，后者才会被修。

**删除一个类型必须是"停用"，不能是 `DELETE`（字典表引入的新风险）**

把 `CHECK` 换成字典表，关闭了一个洞，同时开了一个新的：

| 动作 | 后果 |
|---|---|
| `DELETE FROM hour_type WHERE code='unclassified'` | `FK` 会挡住有历史引用的删除 → 实施的人改走去 `UPDATE` 那些历史段行、把类型改成别的 → **一次静默的批量错分类**，而且改动是"为了能删掉一行配置" |
| `UPDATE hour_type SET is_active=false, deactivated_at=now()` | 历史行引用不变、含义不变；新段被触发器挡住；报表按 `is_active` 分组显示"已停用类型（历史）" |

所以 `is_active` **无默认值**（新增类型必须显式回答"现在生效吗"，默认值会让"没想过"伪装成"想过"），`deactivated_at` 与它互为镜像（`ck_ht_active`）。**停用是唯一允许的"取消"，任何时候都不允许物理删除字典行。**

**"属性不可改"必须用触发器，不能用 `REVOKE`**

```sql
CREATE FUNCTION fn_dict_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code           IS DISTINCT FROM OLD.code
  OR NEW.label          IS DISTINCT FROM OLD.label
  OR NEW.counts_as_work IS DISTINCT FROM OLD.counts_as_work
  OR NEW.on_duty        IS DISTINCT FROM OLD.on_duty
  OR NEW.is_ot          IS DISTINCT FROM OLD.is_ot
  OR NEW.ot_multiplier  IS DISTINCT FROM OLD.ot_multiplier THEN
    RAISE EXCEPTION 'E_DICT_IMMUTABLE: 字典行的标识与语义不可修改，语义要变请新增行并停用旧行';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_ht_immutable BEFORE UPDATE ON hour_type
  FOR EACH ROW EXECUTE FUNCTION fn_dict_immutable();
-- 允许改的只有状态两列：is_active / deactivated_at / deactivated_by
```

**为什么不能用 `REVOKE UPDATE` 代替**：`REVOKE` 对**表 owner 无效**，而迁移脚本通常以 owner 身份执行——**恰好是唯一会去批量改字典的人不受约束**。另：字典表**不提供 merge 操作**（把类型 A 并入 B、再把历史段从 A 改到 B）。它看起来是"整理数据"，实际是**改写历史行的归属**——合并之后"当时这半小时算在 A"这件事就不存在了，而它确实发生过。要做只能"停用 A + 新增 C，并在 C 的说明里写明承接 A 与 B"。这与"编号不回收 / 枚举值不复用"是同一条。

**"在岗休息"与"离岗休息"必须分开，且不能用 `work_hours = 0` 代替**

餐饮门店的休息有两种，法律与成本口径完全不同：

- 在岗休息（吃饭但在店里、随时被叫）：**计入在勤时长**，不计工时；
- 离岗休息（真正出去、不在岗）：**不计在勤时长**。

如果统一置 `work_hours = 0`，"在勤时长"这个指标就算不出来，而它正是排班密度与人效的分母。所以 `on_duty` 必须是字典属性，汇总时按属性判定。

**为什么 `snap_allowance_json` 在段上而不在班次上**

同一班段内，夜宵津贴（22:00 后）、高温津贴（14:00–16:00）、交通津贴（末班车后）覆盖的时段互不相同。放在班次上只能表达"这个班有没有"，放在段上才能表达"哪几个小时有"。放班次上会让"部分时段享受"的津贴只能靠人工备注——而人工备注在月结时不存在。

**`multiplier` 只记事实，不记规则**：它表示"这一段被认定为几倍"，由薪酬规则计算后回写。**考勤侧不自行判定倍率**——倍率随地区/职级/工时制变化，属于薪酬规则（`pay_scheme.ot_rate_json` + `sys_config`），考勤只负责把时段切成类型段。

**`source_kind` + `break_rule_*` 是为了堵一个刚长出来的洞**

`unclassified` 撤销之后出现了一个反向诱惑：生成器遇到匹配不到规则的时间段，**最省事的写法是把上一段的 `seg_end_at` 往后延**。

```
段仍铺满 span      → L1 求和的量侧旁证通过
首末仍对齐 span    → L1 首末锚定通过
类型是错的         → 三条都绿
```

**删掉的是可见的兜底（报表上一列），代码会长出一个不可见的兜底（只表现为某段偏长，而段长本来就该不同）。** 阻断 `unclassified` 反而加剧了这个诱惑——生成器为了不触发阻断，宁愿延长上一段。

`source_kind` + `break_rule_id` + `rule_duration_minutes` 让每段自带"我多长"的依据（A5b 的段长侧旁证，V6）。被延长的那一段，其规则引用仍指向前一段的规则，而那条规则算出的期望长度**不含被延长的部分**。**不是禁止它这么做，而是它这么做之后长度对不上自己声明的规则。**

不使用字符串 `source_rule_ref`（把 `break_rule_id` 拼成 `"break_rule:123:v4"` 再用正则解析）——会拿类型安全换一堆正则。

### 3.3.7 封账控制

```sql
CREATE TABLE period_seal (
  id                  bigint PRIMARY KEY,
  legal_entity_id     bigint,             -- NULL = 全集团；支持按法人不同计薪日
  period              varchar(7) NOT NULL,-- '2026-11'
  sealed_through_date date NOT NULL,      -- 已封到哪一天（支持月中分次封）
  sealed_at           timestamptz NOT NULL DEFAULT now(),
  operator_id         bigint NOT NULL,
  note                text,
  UNIQUE (period, COALESCE(legal_entity_id, 0))
);
```

**封账与 append-only 的冲突处理（四条硬规则）**
1. 封账后到达的 `punch`（设备离线补传）**不触发重算**，只生成「考勤调整单」→ 下一期补差；
2. **`recalculate()` 接口第一件事是查 `period_seal`**，已封直接拒绝——硬校验，不能靠调用方自觉；
3. 已封期间工资不回改（走 `payroll_adjustment`，下期补差）；
4. 拒绝时返回**明确原因**（`E_LOCKED_PERIOD` + 已封至哪一天 + 应走哪条调整单），不要让 Agent 自己判断该不该调（§5.2.2）。

**架构含义**：「重算」不是一个可以随便调的接口，它是**有前置状态检查的业务动作**。

### 3.3.8 恒等式与断言（编号以 `02g` I8.2 / I13 为准，本节只落实现位置）

#### 编号归属：本节不自造编号

全套文档的断言编号按**前缀分域**，同一编号在同一时刻只能有一个语义：

| 前缀 | 语义域 | 成员（权威定义在 `02g` I8.2 / I8.13 / I13） |
|---|---|---|
| **L** | 结构恒等式（行集合的完整性与父子一致） | L0 锚点 / L1 铺满（结构式，含原 C5）/ L2 父行拆分 / L3 类型 / L4 跨表 / L5 抵冲（**`L2b` 已退役，编号不复用**） |
| **A** | 金额与口径断言（两侧数值相等、行内平衡、重算对账） | A4 成本两侧相等 / A5a 实时重算 / A5b 离线重算 / A6 行内平衡 |
| ~~C~~ | **退役，不再分配新号** | C1 / C2a(旧) / C3 / C4a / C4b / C5 / C6 —— 见下方"退役登记" |

**旧 `C` 编号必须留行标 `deprecated`，不得删行。** 删行会让编号变成可分配资源——下一个新断言会顺手拿走 `C5`，于是三个月后有人看到"`C5` 是段连续性"的旧记录，指的却是另一条断言。

> 本节早期的写法是"唯一权威列表，别处不得新增第二套编号"。**那句话是错的，已删除**：它让所有人继续信任旧的这一份，而权威版本在 `02g` 长出来了。正确写法是：**每份清单必须显式声明自身状态与指向的权威版本；未声明者视为 `deprecated`。** 判据不是"有没有第二套编号"，而是"读的人能否知道该信哪一份"。

#### 生效的八条（本节只写"落在哪"，定义见 `02g`）

| 编号 | 恒等式 | **锚定来源**（外部？同源？） | 实现位置（**必须是库里存在的对象名**） | 结论 |
|---|---|---|---|---|
| **L0** 锚点 | `span_hours = 下班时刻 − 上班时刻` | **无外部锚** | `chk_ads_span` + `chk_ads_nonneg`（DDL 内，`round(…,2)` 精确相等） | **必须自带校验**（依据=无锚） |
| **L1** 铺满（结构式） | 排序后 `seg[i].end ≡ seg[i+1].start`；首 `start ≡ shift_start_at`；末 `end ≡ shift_end_at`；**另加** `Σ(seg.hours) ≡ span_hours` 作量侧旁证 | 段表（绝对时刻）+ 行首尾时刻 | `v_chk_segment_contiguous`（三段 `UNION ALL`） | **是** |
| **L2** 父行拆分（**两式**） | 见下方「L2 按快照分流」 | `C2a` / `C2b`（两个 break 列来自段表求和） | `chk_ads_sum`（析取式）/ `chk_ads_off` | 可不自带（依据=C2a/C2b） |
| **C2a** | `Σ(段 WHERE hour_type='break_on_duty') ≡ break_on_duty_hours` | 段表 | `v_chk_segment_identity`（`kind='C2a'`） | **是** |
| **C2b** | `Σ(段 WHERE hour_type='break_off_duty') ≡ break_off_duty_hours` | 段表 | `v_chk_segment_identity`（`kind='C2b'`） | **是** |
| **L3** 类型 | `Σ(段 WHERE hour_type 非两类 break) ≡ work_hours` | 段表 | `v_chk_segment_identity`（`kind='L3'`） | **是** |
| **L4** 跨表 | `Σ(store.work_hours) ≡ daily.work_hours`（三类加班各一条） | **两张不同的表** | `v_chk_daily_rollup` | **是**（唯一跨表层） |
| **L5** 抵冲 | `ot_compensated_hours ⊆ ot_hours`（**子集，非恒等**） | 假期台账 | 行内 `CHECK` | 是 |

**"锚定来源"这一列取代了原来的"要不要上线跑"。** 差别不在措辞，在**可复核性**：`L2` 的锚是 `C2a`/`C2b`、`L3` 的锚是段表求和、`L4` 的锚是跨表比对——**这个依据本身就说明了为什么不需要自带校验**。而 `L0` 的锚是**"无"**，所以它必须自带。**"否"是一个结论，"无"是一个依据；只有后者能被下一个人复核。**

> 反面教材（本轮实际发生）：`L0` 原来那一格写的是"**否**（定义式，写表注释即可）"。它看起来是五条里最完整的一条——有编号、有名字"锚点"、有定义式、有后果说明（"无锚，后面全飘"）、有实现位置。**唯一没有的是那行代码。** 而"否"这个结论给了它一次**分类上的豁免**：读的人看到这句就不会再去查它有没有被校验，因为表已经说了不需要。
>
> **一个东西被误分类之后，它的缺失不再是一个缺口，而是"符合分类"。** 更糟的是第二次——若只补 `CHECK` 却不改这行标注，下一次盘点的结论会是"`CHECK` 已存在 + 标注写不需要 → 这条 `CHECK` 冗余，删掉它"。**同一个豁免生效两次，中间隔着一次修复。**

**`L0` 为什么只能是 `CHECK`、不能靠下游兜住**：`C2a / C2b / L3 / L4` 的比对对象都是**段表**，而段是**绝对时刻**、`attendance_daily_store_segment.hours` 有绑在自己 `seg_start_at/seg_end_at` 上的硬 `CHECK`。所以段表求和是真实跨度的**第二次独立测量**，不经过 `span_hours`——**`span` 错了，四条下游校验一条都不会红**，它们只保证"父行与段表一致"，不保证"两者都等于现实"。能发现它的 `V3③` 是**视图**，而它进入的门（`raw → confirmed` 流转）在库里没有强制力（下一节）。

**清单每一项必须指向一个库对象，否则它不是实现、是备注**

```
清单一项  →  必须指向 约束名 / 函数名 / 视图名，且该对象在库里存在
指向不到  →  它就是备注，不是防线
```

进 CI：清单解析出的对象名逐个 `to_regclass` / `to_regprocedure` 取一遍，**取不到即失败**。这条的价值不在"检查清单"，在于**清单从此不可能比实现长**——而它现在可以，且正是它掩盖缺失的方式：旁边每一条都有实现、格式一致，所以那一条"没有"看不出来。**同质性掩盖了缺失。**

**派生列审计：判据不按列名扫，按"注释里有没有写式子"扫**

`span_hours` 不是孤例，它属于一整类：**定义里说是派生的，实现是应用层算的，库里没有任何断言 → 这列可以取任意值，而所有依赖它的校验照常通过。**

```
注释里有  col = expr   →  该列必须有 CHECK，或有跨表求和断言
注释里没有等式          →  可能是原语列，人工确认（不自动判红）
```

**为什么不按列名扫**（`_hours|_amount|_rate|…`）：那里有大量原语列（`pay_amount` 是输入不是派生），会出一堆假阳性 → 然后被加白名单 →**然后把真的漏掉**。而白名单一旦存在，就没人再回头看它。**这个判据不需要判断"这列是不是派生量"，只需要判断"有没有人写过它的式子"**——而"定义句必须是等式"本来就是我们已强制的写作规范（`02g` §I17.2）。于是它把一条写作规范变成了一次可执行审计。

⚠ **我的旧 `C2a`/`C2b` 与 `02g` 的 `C2a`/`C2b` 不是同一件事**：我旧版指"工作段求和 ≡ `work_hours`"，`02g` 指"两类 break 段求和 ≡ 父行两列"。我旧版那条实际就是 **L3**。这是"同一编号两个语义"的实例，已按 `02g` 收敛。

**`L2` 按快照列分流，不是一个等式；`L3` 三形态相同**

`on_duty_break_basis`（`sys_config`，三值，默认 `allowance`）决定"在岗吃饭算不算工时"：

| `snap_on_duty_break_basis` | L2 形态（父行拆分） | L3 形态（类型求和） |
|---|---|---|
| `allowance`（默认） | `work = span − on − off`（= `in_att − on`） | `Σ(非 break 段) ≡ work` |
| `hourly` | `work = span − off`（= `in_att`，on 并入 work） | `Σ(非 break 段) ≡ work` |
| `none` | `work = span − on − off`（= `in_att − on`） | `Σ(非 break 段) ≡ work` |

**新形态的入口是一个 `CHECK` 的 `<>` 分支，不报错**：`chk_ads_sum` 写的是 `snap_on_duty_break_basis = 'hourly'` 与 `<> 'hourly'` 两路，所以**新增第四种取值时，新值会静默落进"扣掉在岗休息"那一支**。它不报错、不警告，只按错的口径算出 `work_hours`，而 `work_hours` 是钱。所以：**新增取值必须同时改 `chk_ads_sum` 与本节 L2 两式**，这是一条要写进变更检查单的动作，不是一句提醒。

`L1` / `chk_ads_off` / `chk_ads_span` 三条**与形态无关，三种取值下都成立，不动**——`in_att = span − off` 不随在岗口径变化。

**`L2b` 为什么整条退役（`02g` §I3 判，本处落）**：它在 `allowance`/`none` 下只是 `C2a` 的移项——`in_att − work ≡ on` 由 `in_att = span − off`、`work = span − on − off` 相减直接得到，`on` 又由 `C2a` 等于 `Σ(break_on_duty 段)`，**不是独立的一条**；在 `hourly` 下它退化为 `in_att ≡ work`，这已经是 `chk_ads_off` 与 `work = span − off` 的联合结论。**两形态都不是独立校验**，留着就是一个永远绿的分支（V2 每晚白跑一条）。编号 `L2b` 永久占用、不复用。

**配置切换必须连带切换校验口径**，不能切了配置还留旧校验——那会让 `hourly` 模式一开就全表报错，然后被整条关掉。默认值选 `allowance` 的理由：上线前的实际行为就是"不计工时但给在岗补贴"，**配置默认值必须等于既有行为，否则一上线就改变了所有人的工资**。

#### 退役登记（留行，不删）

| 旧编号 | 原写法 | 状态 | 取代者 | **它不再检查什么** |
|---|---|---|---|---|
| C1 | `Σ(段.hours) ≡ span_hours` | deprecated | **L1** | 不再作为长度守卫——求和式对"洞 + 重叠"失明（挖掉 10 分钟、又在别处多 10 分钟，`Σ` 照样相等，而它既少算了一段又多算了一段） |
| C2a(旧) | `work_hours ≡ Σ(段 WHERE counts_as_work)` | deprecated | **L3** | 编号让给 `02g` 的 break 段求和；语义不变只是改名 |
| C3 | `in_att − work ≡ Σ(break_on_duty)` | deprecated | **并入 `C2a`；`L2b` 退役不复用** | 它重述的是 `C2a` 的移项，不是独立断言；且**仅在 `on_duty_break_basis ∈ {allowance, none}` 下成立** |
| C4a / C4b | `daily.work_hours ≡ Σ(store.work_hours)`（+三类加班） | deprecated | **L4** | 语义不变，仅改号 |
| C5 | `min(段.start) ≡ shift_start` 且 `max(段.end) ≡ shift_end` | deprecated | **L1** | **不再用 `min/max` 写法**——零段时聚合返回 NULL，`NULL = ts` 得 NULL，CHECK 判为**通过**，最坏情况静默通过 |
| C6 | 段长 ≡ `source_kind` + 规则引用算出的期望长度 | deprecated | **A5b** | 不再是"第六条恒等式"；它是 A5b 的**段长侧旁证**，且只覆盖 rule-backed 段（manual 段由 §3.3.6 的 `ck_manual_seg` 管） |

**最后那一列"它不再检查什么"比"它现在是什么"更该留。** 只写现状，后来人会以为它一直如此，于是用旧含义去解释旧记录——而旧记录指向的是另一条断言。

#### 两条元规则（本轮反复踩，写死）

**① 空集：正向写法漏判，反查写法天然抓住**

```
正向   COALESCE(SUM(x), 0) = 期望                ← 期望 > 0 时才红，且依赖 COALESCE 写对
反查   EXISTS (SELECT 聚合列 FROM 子表 … WHERE 聚合列 IS DISTINCT FROM 期望)
                                                ← 空集时聚合返回 NULL，NULL 与任何非 NULL 都不同 → 命中
```

关键不是"反查碰巧能抓空集"，而是**它比较的是值，而空集的值是 NULL**。所以"防行被过滤"和"防空集静默"这两个理由指向同一实现——**不是风格选择，是这一类断言唯一正确的形态**。

不同聚合的兜底不同，**不能一条规则套完**：

```sql
-- C2a / C2b / L3：SUM 有合理零值
COALESCE(SUM(g.hours) FILTER (WHERE g.hour_type = 'break_on_duty'), 0) = ds.break_on_duty_hours

-- L1 首末锚定：min/max 没有合理零值，必须用哨兵
COALESCE(min(g.seg_start_at), '-infinity'::timestamptz) = ds.shift_start_at
COALESCE(max(g.seg_end_at),   'infinity'::timestamptz)  = ds.shift_end_at
```

**禁止 `COALESCE(min(...), store.shift_start_at)`**——那不是兜底，是把答案写进被比较的左式，等式必然成立。注释里写明，否则下一个人会觉得那样更简洁。

**③ "缺证据取不在"只对保护性断言成立，对事实性断言必须报未知**

本轮收敛出一条默认值：**问"这层保护还在不在"，缺证据时一律按"不在"处理**（蕴含无法验证 → 不蕴含；依赖无法确认 → 已失效）。这条成立，但边界必须写死：

| 断言类型 | 例 | 缺证据时 | 理由 |
|---|---|---|---|
| **保护性** | 这条约束还在吗 / 这个依赖还有效吗 / 是否已被蕴含 | 取"不在" | 多拦一次 vs 漏放一次，代价不对称，漏放更贵 |
| **事实性** | 这个员工是否存在 / 这笔钱是否已付 / 这次打卡是否真实发生 | **必须报"未知"并阻断**，不得取任何默认值 | 两个方向的错都致命：按"不存在"会误删人，按"已付"会重复付 |

**判据：错的代价是否对称。** 对称 → 取保守值；不对称且双向都致命 → 不给默认值，阻断交人。不加这条边界，"缺证据取不在"会被下一个人套到"员工存在性"上，然后误删。

**② 零段是最坏情况，也是唯一会静默通过的情况**

所以验收必配一个夹具：**父行存在、段表为空**。一次验完 L1 / C2a / C2b / L3 四条的空集行为——四条里任何一条写成正向相等，这一行都会绿。这是本轮性价比最高的样本。

#### L4 的适用规则（把"新增列"和"新增校验"绑在同一句话里）

```
凡在 attendance_daily 与 attendance_daily_store 两级都存在的计算列，必须配一条跨层等式（L4 的分支）。
新增一列到 daily 时，同时新增对应的 L4 分支。
```

**为什么这么写**：两份清单（列清单 + 校验清单）分开维护时，**第二份永远滞后**。绑成一句，新增列的人没法不看到校验。

反例（不该配 L4 分支的）：`break_on_duty_hours` / `break_off_duty_hours` **不配**——`daily` 上没有对应列，只跨一次聚合（由 C2a/C2b 管）。为不存在的第二段配等式，会得到恒真校验。

#### 校验视图（存在性校验一律 `NOT EXISTS` 反向查，不用 `JOIN`）

```sql
-- V1 段缺失：父行存在但没有类型段（零段的兜底入口）
CREATE VIEW v_chk_segment_missing AS
SELECT ds.id AS daily_store_id, ds.employee_id, ds.work_date, 'SEGMENT_MISSING' AS kind
FROM attendance_daily_store ds
WHERE NOT EXISTS (
  SELECT 1 FROM attendance_daily_store_segment g WHERE g.daily_store_id = ds.id
);

-- V2 段汇聚：C2a / C2b / L3（三条在同一行上判，各自独立 HAVING）
CREATE VIEW v_chk_segment_identity AS
SELECT ds.id AS daily_store_id, ds.employee_id, ds.work_date,
       CASE
         WHEN abs(COALESCE(SUM(g.hours) FILTER (WHERE g.hour_type = 'break_on_duty'), 0)
                  - ds.break_on_duty_hours) >= 0.01 THEN 'C2a'
         WHEN abs(COALESCE(SUM(g.hours) FILTER (WHERE g.hour_type = 'break_off_duty'), 0)
                  - ds.break_off_duty_hours) >= 0.01 THEN 'C2b'
         WHEN abs(COALESCE(SUM(g.hours) FILTER (WHERE g.hour_type NOT IN ('break_on_duty','break_off_duty')), 0)
                  - ds.work_hours) >= 0.01 THEN 'L3'
         -- ★ 不再有 L2b 分支：它在 allowance/none 下是 C2a 的移项、在 hourly 下等价于 in_att = work，
         --   两者都不是独立校验。留着只是一个每晚必绿的分支，会稀释真告警。
       END AS kind
FROM attendance_daily_store ds
LEFT JOIN attendance_daily_store_segment g ON g.daily_store_id = ds.id
GROUP BY ds.id, ds.employee_id, ds.work_date,
         ds.break_on_duty_hours, ds.break_off_duty_hours, ds.work_hours, ds.in_attendance_hours
HAVING (   abs(COALESCE(SUM(g.hours) FILTER (WHERE g.hour_type = 'break_on_duty'), 0)  - ds.break_on_duty_hours)  >= 0.01
        OR abs(COALESCE(SUM(g.hours) FILTER (WHERE g.hour_type = 'break_off_duty'), 0) - ds.break_off_duty_hours) >= 0.01
        OR abs(COALESCE(SUM(g.hours) FILTER (WHERE g.hour_type NOT IN ('break_on_duty','break_off_duty')), 0) - ds.work_hours) >= 0.01
        -- ★ 这里曾有第 4 个 OR 分支：abs(in_attendance_hours - work_hours - Σ(break_on_duty)) >= 0.01
        --   它已删除（L2b 退役）。只删 CASE 里的分支、留 HAVING 里的 OR 是最难发现的残留：
        --   行会被 HAVING 选出来，而 CASE 落不到任何分支 → kind 为 NULL → 下游按 kind 分派时静默跳过。
        --   "删一条断言"必须同时删「选取条件」与「标注来源」，只删一处等于把它变成一条 kind 为空的幽灵行。
       );

-- V3 L1 结构式：段间相接（洞/重叠）+ 首末锚定
CREATE VIEW v_chk_segment_contiguous AS
-- ① 相接：排序后 next.start 必须等于 prev.end（写成 >= 就允许洞）
SELECT w.daily_store_id, 'L1_NOT_CONTIGUOUS' AS kind
FROM (
  SELECT daily_store_id, seg_start_at,
         lag(seg_end_at) OVER (PARTITION BY daily_store_id ORDER BY seg_start_at, seq) AS prev_end
  FROM attendance_daily_store_segment
) w
WHERE w.prev_end IS DISTINCT FROM w.seg_start_at
UNION ALL
-- ② 首末锚定：用哨兵兜住空集（不得 COALESCE 到期望值）
SELECT ds.id, 'L1_NOT_ANCHORED'
FROM attendance_daily_store ds
WHERE COALESCE((SELECT min(g.seg_start_at) FROM attendance_daily_store_segment g
                WHERE g.daily_store_id = ds.id), '-infinity'::timestamptz) <> ds.shift_start_at
   OR COALESCE((SELECT max(g.seg_end_at)   FROM attendance_daily_store_segment g
                WHERE g.daily_store_id = ds.id),  'infinity'::timestamptz) <> ds.shift_end_at
UNION ALL
-- ③ 量侧旁证：Σ 段长 ≡ span（不是 L1 本身，只做量侧复核）
SELECT ds.id, 'L1_SUM_MISMATCH'
FROM attendance_daily_store ds
WHERE abs(COALESCE((SELECT SUM(g.hours) FROM attendance_daily_store_segment g
                    WHERE g.daily_store_id = ds.id), 0) - ds.span_hours) >= 0.01;

-- V4 L4 跨表：人日 ↔ 班段
CREATE VIEW v_chk_daily_rollup AS
SELECT d.id AS daily_id, d.employee_id, d.work_date, 'L4_WORK' AS kind
FROM attendance_daily d
WHERE abs(COALESCE(d.work_hours, 0)
          - (SELECT COALESCE(SUM(ds.work_hours), 0) FROM attendance_daily_store ds
             WHERE ds.attendance_daily_id = d.id)) >= 0.01
   OR abs(COALESCE(d.ot_weekday_hours, 0)
          - (SELECT COALESCE(SUM(ds.ot_weekday_hours), 0) FROM attendance_daily_store ds
             WHERE ds.attendance_daily_id = d.id)) >= 0.01
   OR abs(COALESCE(d.ot_restday_hours, 0)
          - (SELECT COALESCE(SUM(ds.ot_restday_hours), 0) FROM attendance_daily_store ds
             WHERE ds.attendance_daily_id = d.id)) >= 0.01
   OR abs(COALESCE(d.ot_statutory_hours, 0)
          - (SELECT COALESCE(SUM(ds.ot_statutory_hours), 0) FROM attendance_daily_store ds
             WHERE ds.attendance_daily_id = d.id)) >= 0.01;

-- V5 孤儿班段（有 store 无 daily）——L4 的反向
CREATE VIEW v_chk_store_orphan AS
SELECT ds.id AS daily_store_id, ds.employee_id, ds.work_date, 'ORPHAN_STORE' AS kind
FROM attendance_daily_store ds
WHERE NOT EXISTS (SELECT 1 FROM attendance_daily d WHERE d.id = ds.attendance_daily_id);

-- V6 段长自证（A5b 的段长侧旁证，原 C6）：段长必须等于其规则声明的期望长度（含裁剪）
CREATE VIEW v_chk_segment_rule_length AS
SELECT g.id AS segment_id, g.daily_store_id, g.hour_type, g.hours,
       g.rule_duration_minutes / 60.0 AS rule_hours, g.break_trimmed_minutes, 'A5B_RULE_LENGTH' AS kind
FROM attendance_daily_store_segment g
WHERE g.source_kind <> 'manual'
  AND abs(g.hours - (COALESCE(g.rule_duration_minutes, 0)
                     - COALESCE(g.break_trimmed_minutes, 0)) / 60.0) > 0.01;

-- V7 时区偏移漂移：输出的是「待确认清单」，不是「待修复清单」
CREATE VIEW v_chk_tz_drift AS
SELECT ds.id AS daily_store_id, ds.store_org_id, ds.work_date,
       ds.snap_utc_offset_minutes AS snap_offset_min,
       (EXTRACT(EPOCH FROM (
          (ds.shift_start_at AT TIME ZONE ou.timezone_name)
        - (ds.shift_start_at AT TIME ZONE 'UTC'))) / 60)::smallint AS current_offset_min
FROM attendance_daily_store ds
JOIN org_unit ou ON ou.id = ds.store_org_id
WHERE (EXTRACT(EPOCH FROM (
          (ds.shift_start_at AT TIME ZONE ou.timezone_name)
        - (ds.shift_start_at AT TIME ZONE 'UTC'))) / 60)::smallint
      <> ds.snap_utc_offset_minutes;

-- V8 不可改列的权限比对（见下方"为什么需要这条"）
CREATE VIEW v_chk_immutable_grants AS
SELECT fs.table_name, fs.column_name, cp.privilege_type
FROM app_field_semantics fs
JOIN information_schema.column_privileges cp
  ON cp.table_name = fs.table_name AND cp.column_name = fs.column_name
WHERE cp.grantee = 'app_role'
  AND cp.privilege_type IN ('UPDATE','DELETE')
  AND fs.immutable_after_write = 'Y';
-- app_field_semantics 是 §3.3.0c 那张表的物理落库（由迁移脚本生成），供巡检直接 JOIN
```

**视图能判什么、判不了什么（写死，否则会不断有人写出恒真的视图）**

| 视图能判 | 例 |
|---|---|
| ① 值在域内 | 偏移 ∈ [−12h, +14h] 且为 15 分钟整数倍 |
| ② 行与行之间一致 | 同一班段派生的所有行偏移必须相同 |
| ③ 键的覆盖完整 | 每个父行都有段、每条 store 都有 daily |

| 视图判不了 | 只能靠什么 |
|---|---|
| **值的来历**（解析过程、取值时点、"是不是按 `shift_start_at` 那一刻算的"） | 用例 / 流程。写成视图必然恒真或假红 |
| **分布偏离**（占比、突增、覆盖率） | 监控（没有真值，只有阈值），不进校验清单 |

**为什么校验一律 `NOT EXISTS` 反向查，不用 `JOIN`**

`JOIN` 在多重匹配时会**倍增行数**，于是"找异常"的查询会因为关联表有多行而给出假阳性或漏报；而 `NOT EXISTS` 是纯粹的"存在性判定"，与匹配行数无关。

```
❌ SELECT ... FROM ds JOIN g ON ... WHERE g.xxx IS NULL     -- 没有段时一行都不返回，漏报
✅ SELECT ... FROM ds WHERE NOT EXISTS (SELECT 1 FROM g WHERE ...)  -- 正确报出"缺段"
```

这条同时适用于所有"必须存在"的校验：缺段、缺首末卡、缺归属版本、缺合规画像。**写进编码规范，评审强制项。**

**为什么需要 V8 `v_chk_immutable_grants`（REVOKE 的结构性缺陷）**

`REVOKE` 只作用于**你列出来的白名单**。漏掉的列不在任何清单上，权限语句**不会自己报"我漏了一个列"**。§3.3.0c 的 `immutable_after_write` 列就是那份缺失的清单，本条视图把"漏一条"从"没人发现"变成"每天红一次"。

**巡检不得复用 `CHECK` 的表达式**

存量巡检若与 `CHECK` 同形（同一条式子写两遍），**两侧会一起失效，而巡检还报绿**。判据不是"有几份实现"，是"**两侧失效是否独立**"：

```
存量巡检的表达式必须与 CHECK 独立书写（不同写法、可不同工具），
且必须能举出一个"CHECK 绿、巡检红"的输入；举不出 → 它是 CHECK 的影子，不算独立校验。
```

这与把 C3 并入 C2a 的判据同源：**同一份输入算两遍，永远相等，所以它不是校验。**

#### 三条跨表约束的实现位置（CHECK 表达不了）

| 约束 | CHECK 能不能做 | 实现位置 |
|---|---|---|
| 同 `transfer_id` 的借调金额之和 ≡ 0 | ❌ 不能（跨行聚合） | 事务内校验 + 提交前阻断（§3.5.2b） |
| `Σ(段) ≡ store`（L1 / C2a / C2b / L3） | ❌ 不能（跨表聚合） | 状态流转 `raw→confirmed` 时校验 + V2 / V3 |
| `Σ(store) ≡ daily`（L4） | ❌ 不能（跨表聚合） | V4 |

**例外**：`EXCLUDE` 能用数据库做的，一律放数据库（四条区间约束），**能在约束层消灭的异常，不要留给下游清洗脚本**。

```sql
-- 三种日期的取值定义（写进数据字典，不是代码注释）
-- work_date     = ((shift_start_at AT TIME ZONE 'UTC') + snap_utc_offset_minutes)::date  ← 每个员工按自己班段开始日
-- business_date = schedule_assignment.work_date（班次所属营业日，不是员工自己的开始日）
-- natural_date  = 同一时区下的自然日（仅合规判定用，见 §3.3.11）
```

**归属日的边界**：每个员工的归属日 = **他自己班段的开始日**。班次 22:00 开始、员工 01:00 来顶班 → 他的归属日落到次日，不是"顶的是昨天的班算昨天"。这样归属日可以被"触发器 + `CHECK` + 复合外键"三道硬约束住（§3.3.5c），**永远不需要例外分支**——而例外分支（补位、设备故障补录、跨天调班）是永远写不全的。

**`work_date` 与 `business_date` 的两条 COMMENT 互为理由**（必须成对写入数据库）：

```sql
COMMENT ON COLUMN attendance_daily_store.work_date IS
  '个人归属日：员工自己班段的开始日，计薪与假期扣减的唯一口径。不用 business_date 的理由：一人一天跨两店时 business_date 会有两个值，而计薪必须只有一个。';
COMMENT ON COLUMN attendance_daily_store.business_date IS
  '班次营业日：班次所属营业日，成本/毛利/日报表口径。不用 work_date 的理由：员工 01:00 顶的是前一天的班，成本必须落在前一天的营业额上，否则当天毛利虚高。';
```

#### 对象被删除时的审计（删除是异常动作）

```sql
CREATE TABLE attendance_daily_removed (
  id                 bigint PRIMARY KEY,
  attendance_daily_id bigint NOT NULL,       -- 不设外键：原行已不存在
  employee_id        bigint NOT NULL,
  work_date          date   NOT NULL,
  snapshot_json      jsonb  NOT NULL,        -- 删除前整行 + 其 store/segment 摘要
  reason             varchar(500) NOT NULL,  -- 必填
  operator_id        bigint NOT NULL,
  origin             varchar(8) NOT NULL DEFAULT 'HUMAN',   -- HUMAN|SYSTEM|AI
  removed_at         timestamptz NOT NULL DEFAULT now()
);
```

**允许删除 `attendance_daily` 行，必须同时满足三条**（缺一条就拒绝，返回 `E_DAILY_HAS_DEPENDENCY`）：

1. 该日**没有**任何 `attendance_daily_store` 行（先删明细，再删主行）；
2. 该日**未**出现在任何已计算的 `payroll_record` / `attendance_adjustment` 依据里；
3. 该日所在期间**未封账**（§3.3.7）。

删除后**必须**写 `attendance_daily_removed`，且 `reason` 非空。`origin='AI'` 的删除请求另需审批（§5.6）。

### 3.3.9 异常、承揽分支与供应商单边权威

```sql
CREATE TABLE attendance_exception (
  id bigint PRIMARY KEY,
  employee_id bigint NOT NULL,
  work_date date NOT NULL,
  store_org_id bigint,
  exception_type varchar(24) NOT NULL,   -- MISSING_PUNCH|LATE|EARLY|ABSENT|OVER_HOURS|NO_SCHEDULE|OT_UNCONFIRMED|APPEAL
  severity varchar(8) NOT NULL,          -- LOW|MID|HIGH
  handle_status varchar(16) NOT NULL DEFAULT 'OPEN',  -- OPEN|HANDLING|CLOSED|WAIVED|APPEALING
  handle_type varchar(16),               -- MAKEUP|CONFIRM|WAIVE|ADJUST|APPEAL
  raised_by varchar(8) NOT NULL DEFAULT 'SYSTEM',      -- SYSTEM|OWN|SUPPLIER
  handle_by bigint, handle_at timestamptz, remark varchar(500),
  UNIQUE (employee_id, work_date, exception_type)
);

CREATE TABLE attendance_adjustment (       -- 封账后唯一的更正通道（红线 RL11）
  id bigint PRIMARY KEY,
  employee_id bigint NOT NULL, work_date date NOT NULL,
  adjust_type varchar(16) NOT NULL,        -- HOURS|OT_TYPE|ABSENCE|LEAVE
  before_json jsonb, after_json jsonb,
  reason varchar(500) NOT NULL,            -- 必填
  target_period char(7) NOT NULL,          -- 补差落哪个薪资期
  status varchar(16) NOT NULL, approval_id bigint,
  origin varchar(8) NOT NULL DEFAULT 'HUMAN'
);

CREATE TABLE attendance_break_skip_log (   -- 跳过"必须休息"的留痕
  id bigint PRIMARY KEY,
  daily_store_id bigint NOT NULL REFERENCES attendance_daily_store(id) ON DELETE CASCADE,
  rule_id bigint NOT NULL, rule_version int NOT NULL,
  reason_code varchar(32) NOT NULL,        -- NO_PUNCH_PAIR|CUSTOMER_PEAK|DEVICE_FAIL|MANUAL_WAIVE
  operator_id bigint,
  origin varchar(8) NOT NULL DEFAULT 'HUMAN',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contractor_presence (         -- 承揽人员在场登记（不进工时模型）
  id bigint PRIMARY KEY,
  vendor_id bigint NOT NULL,
  store_org_id bigint NOT NULL,
  person_name varchar(64) NOT NULL,
  id_no_masked varchar(32),                -- 掩码后存储，明文另存加密列
  presence_date date NOT NULL,
  check_in_at timestamptz, check_out_at timestamptz,
  headcount numeric(3,1) NOT NULL DEFAULT 1,
  remark varchar(200),
  UNIQUE (vendor_id, store_org_id, presence_date, person_name)
);
```

**`attendance_break_skip_log` 为什么必须有**

门店高峰时段"让员工先别休息"是真实业务动作。没有这张表，它只有两种实现：要么规则不允许（业务上不可能），要么悄悄跳过（**跳过这件事在系统里不存在**，事后无法解释为什么这班没扣休息）。留痕表让"跳过"成为可统计事件：跳过率超阈值 → 排班或人力配置问题。

**承揽分支**：`legal_employment_form='SERVICE'` 的人员**不建 `attendance_daily` / `attendance_daily_store`、不产生工时、不进人效与成本分摊**，只做在场人员登记（`contractor_presence`）。数据层校验：禁止写 `employee_store_assignment` 与 `schedule_assignment`（排班侧由 `ck_sa_d10_service` 硬挡）。画"人员类型 → 数据流向"图时，承揽是**唯一一条不进工时模型的分支**，不要画成"少算一些工时"。

**为什么承揽还要一张在场表**：食安检查、消防检查、集团审计第一个问题都是"今天这个店有几个外协在场"。没有这张表，答案只能来自微信群里翻聊天记录。

#### 供应商单边权威（`record_owner`）

**判定的唯一来源**是 `attendance_daily.record_owner`，它是**实体列、应用层写入、不做 `GENERATED`**：

```sql
record_owner text NOT NULL CHECK (record_owner IN ('OWN','SUPPLIER'))
```

三条定死：

1. **不用 `GENERATED`。** 权限判定每次读都要用，派生就得 JOIN 班段；而快照列禁用 `GENERATED` 的理由（§3.3.5b）在这里同样成立——按当前值算，历史会漂（供应商换了，六年前的记录归属跟着变）。
2. **默认按 `snap_ownership_type` 派生，但派生逻辑只在考勤服务一处**：`DISPATCH` / `OUTSOURCE` → `SUPPLIER`，其余 `OWN`。**一处实现，不在各处重写。**
3. **绝对不允许按天人工覆盖。** 一旦允许"这天我改一下"，就变成双方各改各的，结算依据当场失效——而供应商单边权威的全部意义就是**单边**。

某个供应商的合同约定不同（打包价、工时由我方记录）→ 走配置 `vendor_record_owner_policy`（`sys_config` 里按 `vendor_id` 配一条），**对该供应商所有人生效**，不做按天例外。这与"让客户选的是业务策略，不是数据含义"是同一条原则。

**配套的 MCP 边界**：`SUPPLIER` 的日记录，我方侧 MCP 工具只给 `get_worktime`（只读）+ `appeal_worktime`（只申诉不改工时）——见 §5.3.12 的七个供应商协作工具。补卡入口对供应商侧**不渲染**（不是置灰——置灰会产生大量无效工单）。

### 3.3.10 假期与考勤的交界（两张表，不是一个字段）

```sql
CREATE TABLE attendance_leave_slice (       -- 请假切片：与班段交集的最小单位
  id bigint PRIMARY KEY,
  leave_request_id bigint NOT NULL,
  employment_id    bigint NOT NULL,
  leave_type_id    bigint NOT NULL,
  slice_start_at   timestamptz NOT NULL,
  slice_end_at     timestamptz NOT NULL,
  hours            numeric(5,2) NOT NULL,
  work_date        date NOT NULL,           -- 切片归属日（计薪口径）
  CONSTRAINT chk_ls_range CHECK (slice_end_at > slice_start_at),
  CONSTRAINT chk_ls_hours CHECK (hours > 0),
  UNIQUE (leave_request_id, slice_start_at)
);
CREATE INDEX ix_ls_emp_date ON attendance_leave_slice (employment_id, work_date);

CREATE TABLE attendance_leave_conflict (    -- 假期 × 考勤 冲突（必须带路由与 SLA）
  id bigint PRIMARY KEY,
  employment_id  bigint NOT NULL,
  work_date      date NOT NULL,
  leave_slice_id bigint,
  daily_store_id bigint,
  conflict_type  varchar(24) NOT NULL,      -- LEAVE_OVERLAP_WORK|LEAVE_NO_SHIFT|DOUBLE_LEAVE|LEAVE_AFTER_SEAL
  routed_to_org_id bigint NOT NULL,         -- 路由到哪个组织处理
  routed_role      varchar(32) NOT NULL,    -- STORE_MANAGER|HRBP|PAYROLL
  sla_due_at       timestamptz NOT NULL,    -- 处置时限（超时升级）
  status           varchar(16) NOT NULL DEFAULT 'OPEN',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_lc_open ON attendance_leave_conflict (status, sla_due_at) WHERE status = 'OPEN';
```

**请假怎么摊到"哪一天"（两种口径都要给，不能只给一种）**

| 口径 | 算法 | 用途 | 会错在哪 |
|---|---|---|---|
| **切片交集**（计薪用） | 请假时段 ∩ 班段时段，按交集小时摊到 `work_date` | 扣薪、扣额度、算实际出勤 | 与"员工以为请了一天"不一致 |
| **自然日覆盖**（展示用） | 请假时段覆盖了几个自然日 | 员工自助、证明开具 | 与实际工时扣减不一致，不能用于算钱 |

**必须用切片交集口径算钱，但报表要把两个数都给出来。** 只给一个数时，员工看到"我请了一天，只扣了 3 小时"会申诉；HR 只能用两种口径的差异来解释，而不是重新算一遍。

**`attendance_leave_conflict` 为什么需要**：请假与考勤是两张独立的表，冲突不会自己暴露。典型四类：

- `LEAVE_OVERLAP_WORK`：请假了但当天有工时记录（员工来上班了）→ 退假还是照扣？
- `LEAVE_NO_SHIFT`：请假当天根本没排班 → 扣不扣额度？
- `DOUBLE_LEAVE`：同一天两张请假单重叠 → 额度扣两次
- `LEAVE_AFTER_SEAL`：封账后才审批通过的请假 → 走调整单

**必须有 `routed_to_org_id` + `routed_role` + `sla_due_at`**：没有路由的冲突清单会变成一个没人认领的池子；没有 SLA 的清单会在月底集中爆发。**"谁处理"和"什么时候必须处理完"是这张表的价值，不是冲突本身。**

### 3.3.11 合规判定：画像 + 两个视图

合规规则随城市、工种、工时制变化，**不能写成一串 `IF`**。用画像表 + 显式关联表两级：

```sql
CREATE TABLE compliance_profile (
  id bigint PRIMARY KEY,
  code varchar(32) NOT NULL,
  name varchar(64) NOT NULL,
  worktime_system      varchar(16) NOT NULL,   -- STANDARD|COMPREHENSIVE|UNFIXED
  daily_ot_cap_hours   numeric(4,1) NOT NULL,  -- 日加班上限
  weekly_hours_cap     numeric(5,1) NOT NULL,  -- 周工时上限
  min_rest_hours       numeric(4,1) NOT NULL,  -- 相邻班段最小休息间隔
  max_consecutive_days smallint     NOT NULL,  -- 连续出勤上限
  strictness_rank      smallint     NOT NULL,  -- 越严越大；兜底取最大
  source               varchar(24)  NOT NULL,  -- NATIONAL|PROVINCE|CITY|GROUP
  effective_from date NOT NULL, effective_to date,
  UNIQUE (code, effective_from)
);

CREATE TABLE employee_compliance_profile (     -- 显式关联表：解决"该用哪个"
  employment_id         bigint NOT NULL,
  compliance_profile_id bigint NOT NULL REFERENCES compliance_profile(id),
  source                varchar(24) NOT NULL
    CHECK (source IN ('matched','default_fallback','manual')),
  matched_by            varchar(32),           -- CITY|PROVINCE|WORKTIME_SYSTEM|MANUAL
  valid_from            date NOT NULL,         -- 归属类，右闭 '[]'（§3.0b）
  valid_to              date,                  -- NULL = 无上界
  decided_by            bigint,
  decided_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employment_id, valid_from),
  CONSTRAINT ck_ecp_range CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
-- ★ 同一 employment 同一时点只能挂一个画像：PK 只防"同一天开两条"，防不住区间重叠
ALTER TABLE employee_compliance_profile ADD CONSTRAINT ex_ecp_no_overlap
  EXCLUDE USING gist (
    employment_id WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  );
```

> **上面两张表列名不同，是本节的判据**：`compliance_profile`（画像本身）用 `effective_from/effective_to`（**生效类** `'[)'`——"这一版规则从哪天起取代上一版"，右端是切换点）；`employee_compliance_profile`（该用哪个）用 `valid_from/valid_to`（**归属类** `'[]'`——"这个人这几天归哪一档"，右端是一个日子）。**两张表都叫"合规画像有效期"，但一个是版本、一个是归属，混用列名的后果是右端差一天而两边都看不出来。**

**画像是"按什么算"，关联表是"该用哪个"——两者不能合并**

画像表只回答判定参数；它不回答"张三该用哪一档"。如果用 IF 在 SQL 里堆维度（先看城市、再看工种、再看工时制），每加一个维度就要改所有合规查询，且**兜底路径没有地方写**。

三条硬规则：

1. **判定时只读关联表**，不再在 SQL 里堆维度判断；
2. **关联缺失不得静默合规**：全部合规查询先按 `employee_compliance_profile` 取档；取不到时按 `strictness_rank` 最大的一档 + `source='default_fallback'` 落一行，**并进巡检视图 `v_chk_compliance_unmatched`**。上线首月按日盯——兜底取最严档只是"不出事"，不等于"配对了"；
3. **`manual` 必须留 `decided_by` 并进审计**：人工指派的合规档是举证材料，不能是匿名操作。

```sql
-- ⓿ 合规画像未配对清单（上线首月按日盯：兜底只是"不出事"，不等于"配对了"）
CREATE VIEW v_chk_compliance_unmatched AS
SELECT e.id AS employment_id, e.employee_no, e.si_city, e.status
FROM employment e
WHERE e.status IN ('ACTIVE','PROBATION')
  AND NOT EXISTS (
    SELECT 1 FROM employee_compliance_profile ecp
    WHERE ecp.employment_id = e.id
      AND ecp.source = 'matched'
      AND ecp.effective_to IS NULL
  );

-- ① 按自然日的合规（日加班上限 + 周累计）
--    注意：按 natural_date 而非 work_date —— 合规看的是"这一天干了多久"，不是"算在哪个计薪期"
CREATE VIEW compliance_segment_day AS
SELECT g.id AS segment_id,
       ds.employee_id,
       ds.store_org_id,
       day_local::date AS natural_date,
       GREATEST(g.seg_start_at, day_start_utc)                AS part_start_at,
       LEAST(g.seg_end_at, day_start_utc + interval '1 day')  AS part_end_at,
       t.is_ot
FROM attendance_daily_store_segment g
JOIN attendance_daily_store ds ON ds.id = g.daily_store_id
JOIN hour_type t               ON t.code = g.hour_type
CROSS JOIN LATERAL (
  SELECT d AS day_local,
         ((d - make_interval(mins => ds.snap_utc_offset_minutes)) AT TIME ZONE 'UTC') AS day_start_utc
  FROM generate_series(
         date_trunc('day', (g.seg_start_at AT TIME ZONE 'UTC') + make_interval(mins => ds.snap_utc_offset_minutes)),
         date_trunc('day', (g.seg_end_at   AT TIME ZONE 'UTC') + make_interval(mins => ds.snap_utc_offset_minutes)),
         interval '1 day') AS gs(d)
) day
WHERE g.seg_end_at > day.day_start_utc
  AND g.seg_start_at < day.day_start_utc + interval '1 day';

CREATE VIEW compliance_daily AS
SELECT s.employee_id, s.natural_date,
       SUM(EXTRACT(EPOCH FROM (s.part_end_at - s.part_start_at)) / 3600.0) AS worked_hours,
       SUM(EXTRACT(EPOCH FROM (s.part_end_at - s.part_start_at)) / 3600.0)
         FILTER (WHERE s.is_ot)                                            AS ot_hours,
       p.daily_ot_cap_hours,
       p.weekly_hours_cap
FROM compliance_segment_day s
JOIN employee_compliance_profile ecp
  ON ecp.employment_id = s.employee_id
 AND s.natural_date >= ecp.effective_from
 AND (ecp.effective_to IS NULL OR s.natural_date <= ecp.effective_to)
JOIN compliance_profile p ON p.id = ecp.compliance_profile_id
GROUP BY s.employee_id, s.natural_date, p.daily_ot_cap_hours, p.weekly_hours_cap;

-- ② 按相邻班段的休息间隔（**必须跨门店**，否则查不出连班）
CREATE VIEW compliance_gap AS
SELECT ds.employee_id,
       prev.store_org_id AS prev_store_org_id,
       ds.store_org_id   AS next_store_org_id,
       prev.shift_end_at AS rest_from,
       ds.shift_start_at AS rest_to,
       ds.shift_start_at - prev.shift_end_at AS rest_interval,
       make_interval(hours => p.min_rest_hours::int) AS required_rest
FROM attendance_daily_store ds
CROSS JOIN LATERAL (
  SELECT q.store_org_id, q.shift_end_at
  FROM attendance_daily_store q
  WHERE q.employee_id = ds.employee_id
    AND q.shift_end_at <= ds.shift_start_at
  ORDER BY q.shift_end_at DESC
  LIMIT 1
) prev
JOIN employee_compliance_profile ecp
  ON ecp.employment_id = ds.employee_id
 AND ds.work_date >= ecp.effective_from
 AND (ecp.effective_to IS NULL OR ds.work_date <= ecp.effective_to)
JOIN compliance_profile p ON p.id = ecp.compliance_profile_id
WHERE ds.shift_start_at - prev.shift_end_at < make_interval(hours => p.min_rest_hours::int);
```

**为什么必须有 `compliance_gap`（日视图查不出连班）**

```
1-1  08:00–20:00（12 小时）
1-2  06:00–18:00（12 小时）
两次之间只隔 10 小时
```

`compliance_daily` 看这两天，各自 12 小时，全部合规；**只有算"下一段.start − 上一段.end"才看得出休息不足**。这条视图的查询**不能带门店过滤**——员工跨店连班时两段分属两个门店，带门店条件就查不出来。

**`v_chk_tz_drift` 的运维定性（重要，别当 bug 处理）**

该视图输出的是**「待确认清单」，不是「待修复清单」**。"待修复"预设正确值已知；"待确认"承认正确值需要判断——偏移与当前时区不一致时，没人能自动判断历史该不该按新规则重算，**那是业务决策，不是数据修复**。

### 3.3.12 离线独立重算：唯一能发现"算法自己算错"的机制

每晚定时任务用**纯 SQL 直查**重算当日工时，与考勤服务的结果比对：

```
规则：
1. 重算 SQL **不得复用考勤服务的任何计算函数 / 常量 / 规则读取代码**
   （规则参数可以读规则表，但"怎么算"必须独立写一遍）
2. 比对口径：daily.work_hours、daily.ot_*_hours、store.span_hours、store 行数
3. 差异 > 0.01 小时 → 生成告警工单，进次日晨会清单
4. 差异率纳入上线验收指标（首月要求 0）
```

**为什么必须"独立"**：同一个算法自查，同路径必然同错同对。只有两套独立实现给出不同答案，才暴露"规则理解错了"——这是**唯一能发现分类算法自身缺陷**的机制，比单元测试更有效，因为单元测试的期望值是同一批人写的。

**验收清单必须包含这一条**（不是"建议实现"）：

```
验收项：独立重算对账
- 连续 7 个自然日，独立 SQL 重算与线上结果逐人逐段比对，差异记录为 0
- 人为注入 1 个错误（如把某段 span 改 0.5 小时），确认次日告警能定位到具体 daily_store_id
```

## 3.4 假期域

### 3.4.1 假种与额度台账（四态余额是派生值）

```sql
CREATE TABLE leave_type (
  id bigint PRIMARY KEY,
  code varchar(32) NOT NULL UNIQUE, name varchar(64) NOT NULL,
  is_paid boolean NOT NULL, unit varchar(8) NOT NULL,     -- DAY|HOUR
  min_unit numeric(4,2) NOT NULL DEFAULT 0.5,
  need_approval boolean NOT NULL DEFAULT true,
  need_attachment_over_days numeric(4,1),
  quota_rule_json jsonb,          -- 工龄/司龄规则、在职月份折算、年假按天/按月/按工龄/按比例
  carryover_policy varchar(16),   -- NONE|CARRY|PAYOUT（01 §7）
  expire_month smallint,          -- 次年 Q1 过期 → 3
  is_statutory boolean DEFAULT false,
  effective_from date NOT NULL, effective_to date
);

CREATE TABLE leave_quota_ledger (               -- 只追加，永不更新（02 §11）
  id bigint PRIMARY KEY,
  employment_id bigint NOT NULL,
  leave_type_id bigint NOT NULL,
  biz_year smallint NOT NULL,
  entry_type varchar(16) NOT NULL,             -- GRANT|USE|CARRYOVER|EXPIRE|ADJUST|PAYOUT|REVERT
  quota_state varchar(16) NOT NULL,            -- ENTITLED 应得|GRANTED 实得|BORROWED 借用|CARRIED 结转
  delta_days numeric(6,2) NOT NULL,            -- 正负
  occurred_at timestamptz NOT NULL,
  ref_type varchar(24), ref_id bigint,         -- 关联请假单/结转任务/调整单
  operator_id bigint, reason varchar(500),
  balance_after_json jsonb                     -- 该笔后四态快照，便于对账
);
CREATE INDEX ix_lql ON leave_quota_ledger(employment_id, leave_type_id, biz_year);

CREATE TABLE leave_balance_snapshot (          -- 派生缓存，可由台账全量重算校验
  employment_id bigint NOT NULL,
  leave_type_id bigint NOT NULL,
  biz_year smallint NOT NULL,
  entitled_days numeric(6,2) NOT NULL DEFAULT 0,   -- 应得
  granted_days  numeric(6,2) NOT NULL DEFAULT 0,   -- 实得
  borrowed_days numeric(6,2) NOT NULL DEFAULT 0,   -- 借用（预支）
  carried_days  numeric(6,2) NOT NULL DEFAULT 0,   -- 结转存量
  used_days     numeric(6,2) NOT NULL DEFAULT 0,
  remaining_days numeric(6,2) NOT NULL DEFAULT 0,  -- = 四项合并后的可用
  refreshed_at timestamptz NOT NULL,
  PRIMARY KEY (employment_id, leave_type_id, biz_year)
);
```

**"人工不能改余额"如何强制**：`leave_balance_snapshot` 只允许 `LeaveLedgerService.rebuild()` 写入，service 方法签名不含"设置余额"入口。任何人工干预必须 `LeaveQuotaService.adjust()` → 生成 `ADJUST` 台账行（含 `operator_id` / `reason` / 原值 / 新值 / 审批人）。DB 侧加触发器禁止直接 `UPDATE leave_balance_snapshot`（除 `refreshed_at` 外的列），把"不可绕开"落到数据库。四态**分列不合并**（01 §6-9），`remaining_days` 只是展示用视图值，不参与计算。

## 3.5 薪酬域

### 3.5.1 薪资方案与薪资项

```sql
CREATE TABLE pay_scheme (
  id bigint PRIMARY KEY,
  code varchar(32) NOT NULL, name varchar(128) NOT NULL,
  legal_entity_id bigint NOT NULL,
  employment_type varchar(16) NOT NULL,
  pay_mode varchar(16) NOT NULL,
  payroll_monthly_standard_hours numeric(6,2) NOT NULL DEFAULT 174, -- 仅加班换算（01 §6-4）
  proration_basis varchar(16) NOT NULL DEFAULT 'CALENDAR',          -- CALENDAR|PAYROLL_DAY|WORKDAY|SCHEDULED_DAY
  ot_rate_json jsonb NOT NULL,                          -- {"weekday":1.5,"restday":2.0,"statutory":3.0}
  cost_bearing_policy varchar(20) NOT NULL,
  rounding_rule varchar(16) NOT NULL DEFAULT 'HALF_UP_2',
  policy_set_id bigint,
  effective_from date NOT NULL, effective_to date, version_no int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX uk_scheme_valid ON pay_scheme(legal_entity_id, employment_type, code)
  WHERE effective_to IS NULL;

CREATE TABLE pay_item (
  id bigint PRIMARY KEY,
  code varchar(32) NOT NULL UNIQUE, name varchar(64) NOT NULL,
  category varchar(16) NOT NULL,                  -- EARNING|DEDUCTION|EMPLOYER_COST
  calc_type varchar(16) NOT NULL,                 -- FIXED|FORMULA|ATTENDANCE|BIZ|PIECEWORK|MANUAL
  formula text,
  -- 02 §9 的六个开关，后四个决定同一笔钱的税务/社保/成本口径
  is_taxable       boolean NOT NULL DEFAULT true,
  is_si_base       boolean NOT NULL DEFAULT false,
  is_cost          boolean NOT NULL DEFAULT true,
  report_column    varchar(32),                   -- 映射汇总列
  statutory_item   boolean NOT NULL DEFAULT false, -- 法定节假日独立薪资项（01 §6-5）
  sort_no int NOT NULL DEFAULT 0,
  status varchar(16) NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE pay_scheme_item (
  pay_scheme_id bigint NOT NULL, pay_item_id bigint NOT NULL,
  seq int NOT NULL, formula_override text, required boolean NOT NULL DEFAULT false,
  PRIMARY KEY (pay_scheme_id, pay_item_id)
);

CREATE TABLE pay_formula_lib (                    -- 集团 L1 函数库（02 §3）
  id bigint PRIMARY KEY, code varchar(64) NOT NULL UNIQUE, name varchar(128),
  expression text NOT NULL,
  factor_whitelist jsonb, description varchar(500)
);
```

**`payroll_monthly_standard_hours` 与 `proration_basis` 禁止一个字段两用**（02 §7.2 明令）：前者只用于加班费换算（默认 174 = 21.75×8，禁止字面写 216），后者只用于缺勤/入离职折算。表结构上它们是两个独立列，**且不允许任何公式同时引用二者**——`FormulaValidator` 在图构建阶段就报错。

### 3.5.2 薪资期间、工资记录（主）、明细、分摊（子）

```sql
CREATE TABLE payroll_period (
  id bigint PRIMARY KEY,
  period_month char(7) NOT NULL,
  legal_entity_id bigint NOT NULL,
  pay_scheme_id bigint,
  status varchar(16) NOT NULL,   -- DRAFT|CALCULATING|CALCULATED|REVIEWED|APPROVED|PAID|CLOSED
  current_run_id bigint,
  employee_count int DEFAULT 0,
  total_gross numeric(18,2) DEFAULT 0, total_net numeric(18,2) DEFAULT 0,
  total_employer_si numeric(18,2) DEFAULT 0,
  locked boolean NOT NULL DEFAULT false,
  UNIQUE (period_month, legal_entity_id)
);

CREATE TABLE payroll_record (                   -- ★ 红线表：一人 + 一期间 + 一法人 = 一条
  id bigint PRIMARY KEY,
  period_month char(7) NOT NULL,                -- 归属期（计薪期）：由 work_date 落月派生
  payroll_period_id bigint NOT NULL,
  employment_id bigint NOT NULL,
  payroll_legal_entity_id bigint NOT NULL,
  legal_entity_si_id bigint, si_city varchar(32),
  cost_org_id bigint NOT NULL,                  -- 主档成本组织，分摊不覆盖此列（02 §1.3 禁止项）
  pay_mode varchar(16) NOT NULL,

  -- ★ 四个期必须分列，一列兼表两期，次年汇算清缴必对不上
  attribution_period     char(7) NOT NULL,      -- ① 归属期：这笔钱"挣于"哪个月（= period_month，由 work_date 派生）
  pay_period             char(7),               -- ② 发放期：哪个月实际发出去（按月薪日；补差时可与归属期不同）
  pay_date               date,                  -- ② b 实际发放日（银行回单日，不是计划日）
  tax_declaration_period char(7),               -- ③ 申报期：个税申报所属月 = 实际发放月（**不是归属月**）
  si_payment_period      char(7),               -- ④ 缴费期：社保公积金缴费所属月（政策规定，常为发放次月）

  gross_amount numeric(18,2) NOT NULL DEFAULT 0,
  deduction_amount numeric(18,2) NOT NULL DEFAULT 0,
  employer_si_amount numeric(18,2) NOT NULL DEFAULT 0,
  taxable_amount numeric(18,2) NOT NULL DEFAULT 0,
  si_base numeric(18,2),
  net_amount numeric(18,2) NOT NULL DEFAULT 0,
  status varchar(16) NOT NULL,                  -- DRAFT|CALCULATED|REVIEWED|APPROVED|PAID|VOID
  calc_run_id bigint NOT NULL,
  is_current boolean NOT NULL DEFAULT true,     -- 重算产生新版本，旧的置 false
  UNIQUE (employment_id, period_month, payroll_legal_entity_id, calc_run_id),
  -- 申报期必须等于实际发放月（个税按"收付实现制"，不是权责发生制）
  CONSTRAINT ck_pr_tax_period
    CHECK (pay_date IS NULL OR tax_declaration_period = to_char(pay_date, 'YYYY-MM'))
);
-- ★ 硬约束：同一人同一期间同一法人，当前版本只有一条
CREATE UNIQUE INDEX uk_payroll_current
  ON payroll_record(employment_id, period_month, payroll_legal_entity_id)
  WHERE is_current;

CREATE TABLE payroll_record_item (
  id bigint PRIMARY KEY, record_id bigint NOT NULL,
  pay_item_id bigint NOT NULL, seq int,
  qty numeric(12,4), rate numeric(18,6), amount numeric(18,2) NOT NULL,
  formula_trace jsonb           -- 公式 AST + 因子取值，供 payroll_explain_item 追溯
);
CREATE INDEX ix_pri_record ON payroll_record_item(record_id);

CREATE TABLE payroll_cost_allocation (          -- ★ 分摊子表，不回写主表
  id bigint PRIMARY KEY,
  record_id bigint NOT NULL,
  period_month char(7) NOT NULL,
  cost_org_id bigint NOT NULL,
  cost_center_code varchar(32),
  -- ★ 成本业务日：成本口径的归属日（≠ work_date，也 ≠ 发放日）
  --   它的存在让"ΣCi ≡ S"这个恒等式**按月成立**，不需要一张跨期搬运表
  cost_business_date date NOT NULL,
  alloc_days numeric(5,2) DEFAULT 0,
  alloc_hours numeric(7,2) DEFAULT 0,
  alloc_amount numeric(18,2) NOT NULL,          -- Ci
  employer_si_amount numeric(18,2) DEFAULT 0,
  basis varchar(16) NOT NULL,                   -- home_org|working_org|split_by_days|split_by_hours
  -- ★ 恒等式所需：本行是"按外部计价取 Pi"还是"取残差"
  alloc_role varchar(12) NOT NULL,              -- EXTERNAL_PRICED（Ci=Pi）| RESIDUAL（Ci=S−ΣPi）
  external_price numeric(18,2),                 -- Pi，仅 EXTERNAL_PRICED 行有值
  is_balancing boolean NOT NULL DEFAULT false   -- 尾差调整行
);
CREATE INDEX ix_pca_record ON payroll_cost_allocation(record_id);
CREATE INDEX ix_pca_org_month ON payroll_cost_allocation(cost_org_id, period_month);
CREATE INDEX ix_pca_bizdate ON payroll_cost_allocation(cost_org_id, cost_business_date);
```

**不要建 `payroll_period_bridge`（跨期搬运表）**

早期讨论里曾计划用一张"期间桥"表把成本行从一个期间搬到另一个期间。**该表已撤销，不要创建。** 理由：

- 搬运会破坏 `ΣCi ≡ S` 的**按月**成立性——搬运后某个月 `ΣCi < S`，另一个月 `ΣCi > S`，恒等式退化为"跨年累计成立"，而**月度成本报表是按月的**，等于没校验；
- 跨月情形（例如 1 月的班在 2 月才确认）只需要**给成本行加一个 `cost_business_date` 标签**：行不挪期间，`period_month` 与 `record` 完全一致，成本报表按 `cost_business_date` 出。**拆行不换期，加标签不搬行。**
- 一张搬运表会引出第二张（谁有权搬、搬错了怎么撤、搬运历史怎么审），而这三件事在"加标签"方案里根本不存在。

### 3.5.2b 成本分摊是**恒等式**，不是加法（本轮最容易实现错的一条）

```
按外部计价结算的主体：Ci = Pi        （例：B 店按支援任务价 4000）
其余主体取残差：      C_rest = S − ΣPi（例：A 店 6000）
恒等式：              ΣCi ≡ S        ← 无例外，不等则阻断出表
```

**明令禁止的写法**：`管理账合计 = 实发合计 + 差异`。那样会凭空多出差异额，集团总成本虚增（10000 + 667 = 10667），而且因为金额通常不大、混在成本里看不出来，**人工审核挡不住**。

| 概念 | 字段 | 规则 |
|---|---|---|
| 成本总额 `S` | 工资记录应发 + 单位社保（口径由 `is_cost` 开关定） | 唯一，不分摊前后变化 |
| 外部计价 `Pi` | `payroll_cost_allocation.external_price` | 只在 `alloc_role='EXTERNAL_PRICED'` 行有值（如支援任务按天/件谈定的价） |
| 各主体分摊 `Ci` | `payroll_cost_allocation.alloc_amount` | `ΣCi` 必须 `= S`，差额全进 `RESIDUAL` 行 |
| 借调计价差 `Di` | `payroll_transfer.diff_amount` | **解释字段**：`ΣDi ≡ 0`，不进任何合计、不进应发、不进成本总额 |

```sql
CREATE TABLE payroll_transfer (              -- 借调/支援的双边对称记录
  id bigint PRIMARY KEY,
  transfer_id bigint NOT NULL,               -- 同一笔借调的两行共享此 ID
  period_month char(7) NOT NULL,
  employee_id bigint NOT NULL,
  from_cost_org bigint NOT NULL,
  to_cost_org   bigint NOT NULL,
  diff_amount   numeric(18,2) NOT NULL,      -- Di，解释字段，ΣDi ≡ 0
  transfer_days numeric(5,2), transfer_hours numeric(7,2),
  source_order_id bigint,
  CONSTRAINT ck_tr_direction CHECK (from_cost_org <> to_cost_org)
);
CREATE INDEX ix_tr_transfer ON payroll_transfer(transfer_id);
```

**双边对称做成硬约束，不靠原则**（这条挡的是"虚增集团人工成本"）：
1. `from_cost_org` / `to_cost_org` **都非空且不相等** → DB `CHECK`；
2. 同一 `transfer_id` 的行金额之和 **≡ 0**，否则**阻断提交** → 事务内校验（跨行聚合，`CHECK` 表达不了）；
3. **禁止只写一行** → 提交时校验 `COUNT(*) per transfer_id` 为偶数且至少 2。

**复核阈值用双条件**：相对偏差 > 20% **且** 绝对额 > 500 元才告警。只用百分比会让"支援 1 天"的小额天天告警，最终被无视。

**"Σ 分摊行 = 工资记录成本合计"如何保证**：不用 DB 触发器（难写且慢），用**算薪收尾校验作业**：
1. 算薪最后一步执行 `PayrollBalanceValidator`：按 `record_id` group by 比对 `Σ alloc_amount` 与 `S`；
2. 差异 > 0.01 的记录写入 `payroll_anomaly`（异常清单），并在算薪结果页阻断"提交复核"；
3. 残差行由 `alloc_role='RESIDUAL'` 吸收，**不允许用 `is_balancing` 兜未知差异**（`is_balancing` 只吸收舍入尾差，且金额上限 1 元，超出即视为逻辑错误）。

### 3.5.3 发薪批次（付款对象，非计税对象）

```sql
CREATE TABLE pay_batch (
  id bigint PRIMARY KEY,
  payroll_period_id bigint NOT NULL,       -- ★ 一个期间可拆多批，但不是多个期间（02 §7.1）
  batch_no varchar(32) NOT NULL,
  batch_type varchar(16) NOT NULL,         -- ADVANCE 月中预付|FINAL 月末结算|BONUS|SETTLEMENT 离职结
  pay_date date NOT NULL,
  total_amount numeric(18,2) NOT NULL DEFAULT 0,
  bank_file_key varchar(256),
  bank_format varchar(32),                 -- 各银行报文模板代号
  status varchar(16) NOT NULL,             -- DRAFT|PENDING_APPROVAL|CONFIRMED|SENT|PAID|FAILED
  confirmed_by bigint, confirmed_at timestamptz,
  recalc_of_batch_id bigint,
  UNIQUE (payroll_period_id, batch_no)
);

CREATE TABLE bank_payment_line (
  id bigint PRIMARY KEY, batch_id bigint NOT NULL,
  record_id bigint NOT NULL, employment_id bigint NOT NULL,
  account_name_enc text, account_no_enc text, bank_name varchar(64), bank_branch varchar(128),
  amount numeric(18,2) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',   -- PENDING|SUCCESS|FAILED
  fail_code varchar(32), fail_reason varchar(200)
);
```

### 3.5.4 社保、个税、计件、应付计划

```sql
CREATE TABLE si_plan (                      -- 城市政策版本化（02 §3 L2 参数集的一部分）
  id bigint PRIMARY KEY, city varchar(32) NOT NULL,
  plan_code varchar(32) NOT NULL, name varchar(128),
  base_min numeric(18,2), base_max numeric(18,2),
  items_json jsonb NOT NULL,                -- [{code:'PENSION',employerRate:0.16,employeeRate:0.08,baseType:'LAST_YEAR_AVG'}]
  effective_from date NOT NULL, effective_to date,
  UNIQUE (city, plan_code, effective_from)
);

CREATE TABLE si_enrollment (
  id bigint PRIMARY KEY, employment_id bigint NOT NULL,
  si_plan_id bigint NOT NULL, start_month char(7) NOT NULL, end_month char(7),
  base_amount numeric(18,2) NOT NULL,
  change_reason varchar(200)
);

CREATE TABLE tax_accumulation (             -- 个税累计预扣（同月多批次合并为当月收入）
  employment_id bigint NOT NULL, tax_year smallint NOT NULL, tax_month smallint NOT NULL,
  cumulative_income numeric(18,2) NOT NULL DEFAULT 0,
  cumulative_deduction numeric(18,2) NOT NULL DEFAULT 0,
  cumulative_special_deduction numeric(18,2) NOT NULL DEFAULT 0,
  cumulative_tax numeric(18,2) NOT NULL DEFAULT 0,
  cumulative_tax_paid numeric(18,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (employment_id, tax_year, tax_month)
);

CREATE TABLE piecework_record (             -- 计件（02 §8）：取数不是考勤
  id bigint PRIMARY KEY, employment_id bigint NOT NULL,
  period_month char(7) NOT NULL,
  order_no varchar(64), work_date date,
  qty numeric(12,4) NOT NULL,
  unit_price numeric(12,6) NOT NULL,
  unit_price_version varchar(16) NOT NULL,   -- 单价版本化，历史月份锁当时单价
  quality_deduction numeric(18,2) NOT NULL DEFAULT 0,
  amount numeric(18,2) NOT NULL
);

CREATE TABLE payable_plan (                 -- 一次性奖金分期（02 §10：跨月支付）
  id bigint PRIMARY KEY, employment_id bigint NOT NULL,
  source_type varchar(24) NOT NULL,         -- BONUS|RETENTION|COMMISSION|ANNUAL
  total_amount numeric(18,2) NOT NULL, paid_amount numeric(18,2) NOT NULL DEFAULT 0,
  schedule_json jsonb NOT NULL,             -- [{"period":"2026-12","amount":5000,"condition":"REFEREE_ONBOARD"}]
  tax_mode varchar(16), is_si_base boolean DEFAULT false,
  status varchar(16) NOT NULL
);

CREATE TABLE payroll_calc_run (             -- 算薪运行（幂等与重算的锚点）
  id bigint PRIMARY KEY,
  payroll_period_id bigint NOT NULL,
  scope_hash char(64) NOT NULL,             -- 人群+方案+参数指纹
  data_version char(64) NOT NULL,           -- 输入数据版本（工时封账号+档案版本）
  params_json jsonb, status varchar(16) NOT NULL, -- RUNNING|SUCCESS|PARTIAL|FAILED
  total_count int, success_count int, error_count int,
  started_at timestamptz, finished_at timestamptz, triggered_by bigint, origin varchar(8)
);
CREATE UNIQUE INDEX uk_run_idem ON payroll_calc_run(payroll_period_id, scope_hash, data_version);
```

## 3.6 绩效域

```sql
CREATE TABLE perf_unit (                    -- 绩效单元（可能与组织节点不同层，如"华东三店合并考核"）
  id bigint PRIMARY KEY, code varchar(32) UNIQUE, name varchar(128),
  unit_type varchar(16) NOT NULL,           -- COMPANY|REGION|STORE|DEPT|CUSTOM
  org_unit_id bigint, cost_center_id bigint, manager_id bigint,
  effective_from date, effective_to date
);

CREATE TABLE perf_indicator (
  id bigint PRIMARY KEY, code varchar(32) UNIQUE, name varchar(128),
  unit varchar(16), formula text, data_source varchar(32),  -- 引用指标字典（§3.8）
  direction varchar(8) DEFAULT 'UP', target_type varchar(16)
);

CREATE TABLE perf_template (
  id bigint PRIMARY KEY, name varchar(128), cycle_type varchar(16), -- MONTH|QUARTER|HALF|YEAR
  applicable_json jsonb, status varchar(16), version_no int
);
CREATE TABLE perf_template_item (
  template_id bigint, indicator_id bigint, weight numeric(6,4) NOT NULL,
  scoring_rule jsonb, PRIMARY KEY (template_id, indicator_id)
);

CREATE TABLE perf_cycle (
  id bigint PRIMARY KEY, template_id bigint NOT NULL,
  period_start date, period_end date, status varchar(16), calibration_round int DEFAULT 0
);

CREATE TABLE perf_score (
  id bigint PRIMARY KEY, cycle_id bigint NOT NULL,
  target_type varchar(8) NOT NULL,          -- PERSON|UNIT
  employment_id bigint, perf_unit_id bigint,
  indicator_id bigint NOT NULL,
  self_score numeric(6,2), manager_score numeric(6,2), final_score numeric(6,2),
  weight numeric(6,4), weighted_score numeric(8,4),
  remark varchar(500)
);

CREATE TABLE perf_result (
  id bigint PRIMARY KEY, cycle_id bigint NOT NULL,
  employment_id bigint NOT NULL, perf_unit_id bigint,
  total_score numeric(6,2), grade varchar(8),
  personal_coef numeric(9,6),               -- ★ 个人系数
  unit_coef numeric(9,6),                   -- ★ 单元奖金池系数（两个独立字段，02 §10）
  bonus_base numeric(18,2), bonus_amount numeric(18,2),
  coef_rule varchar(16),                    -- MULTIPLY|PERSONAL_ONLY|UNIT_ONLY（是否相乘可配）
  UNIQUE (cycle_id, employment_id)
);

CREATE TABLE perf_bonus_pool (
  id bigint PRIMARY KEY, cycle_id bigint NOT NULL, perf_unit_id bigint NOT NULL,
  pool_amount numeric(18,2) NOT NULL, rule_json jsonb,
  UNIQUE (cycle_id, perf_unit_id)
);
```

## 3.7 培训域（P1，字段从简）

```sql
CREATE TABLE course (
  id bigint PRIMARY KEY, code varchar(32) UNIQUE, name varchar(128),
  category varchar(32), duration_min int, credit numeric(5,1),
  cover_key varchar(256), status varchar(16), version_no int
);
CREATE TABLE course_chapter (
  id bigint PRIMARY KEY, course_id bigint, seq int, title varchar(128),
  content_type varchar(16), content_key varchar(256), duration_min int
);
CREATE TABLE question (
  id bigint PRIMARY KEY, q_type varchar(16),          -- SINGLE|MULTI|JUDGE
  stem text, options_json jsonb, answer_json jsonb, analysis text,
  difficulty smallint, tag_json jsonb, status varchar(16)
);
CREATE TABLE exam (
  id bigint PRIMARY KEY, name varchar(128), course_id bigint,
  pass_score numeric(5,1), duration_min int, question_rule_json jsonb, status varchar(16)
);
CREATE TABLE learn_task (
  id bigint PRIMARY KEY, task_type varchar(16) NOT NULL,  -- COURSE|EXAM
  course_id bigint, exam_id bigint,
  target_type varchar(16) NOT NULL,                       -- PERSON|ORG|JOB
  target_json jsonb NOT NULL,
  start_at timestamptz, due_at timestamptz, required boolean DEFAULT true,
  status varchar(16)
);
CREATE TABLE learn_record (
  id bigint PRIMARY KEY, task_id bigint NOT NULL, employment_id bigint NOT NULL,
  progress numeric(5,2) DEFAULT 0, score numeric(5,1), passed boolean,
  attempt_count int DEFAULT 0, finished_at timestamptz,
  UNIQUE (task_id, employment_id)
);
CREATE TABLE certificate_issue (             -- 培训证书（与 certificate 表区分：后者是合规证照）
  id bigint PRIMARY KEY, employment_id bigint, course_id bigint,
  cert_no varchar(64), issued_at timestamptz, expire_at date
);
```

## 3.8 平台域

### 3.8.1 身份与三轴权限

```sql
CREATE TABLE sys_user (
  id bigint PRIMARY KEY,
  username varchar(64) NOT NULL UNIQUE,
  password_hash varchar(128),                 -- Argon2id
  person_id bigint,                           -- 员工账号关联自然人
  user_type varchar(16) NOT NULL,             -- EMPLOYEE|SERVICE_ACCOUNT|VENDOR|EXTERNAL
  vendor_id bigint,                           -- user_type=VENDOR 时非空，驱动 EXTERNAL 数据范围
  status varchar(16) NOT NULL,                -- ACTIVE|LOCKED|DISABLED
  mfa_secret_enc text, mfa_enabled boolean DEFAULT false,
  pwd_updated_at timestamptz, failed_count int DEFAULT 0, locked_until timestamptz,
  last_login_at timestamptz, last_login_ip inet
);

CREATE TABLE sys_role (
  id bigint PRIMARY KEY, code varchar(64) NOT NULL UNIQUE, name varchar(64),
  role_type varchar(16) NOT NULL,             -- BUILTIN|DB
  is_static_super boolean NOT NULL DEFAULT false  -- 02 §6 静态超管（配置文件加载，页面不可改）
);

CREATE TABLE sys_permission (
  id bigint PRIMARY KEY, code varchar(96) NOT NULL UNIQUE,  -- 如 'employee:read:profile'
  name varchar(128), perm_type varchar(16), parent_id bigint
);
CREATE TABLE sys_role_permission (
  role_id bigint, permission_id bigint, PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE sys_data_scope (                 -- 六种内部类型 → 对外五档（§4.3.2）
  id bigint PRIMARY KEY, name varchar(64),
  scope_type varchar(24) NOT NULL,            -- SELF|DEPT|DEPT_SUB|STORE_SET|LEGAL_ENTITY|ALL|EXTERNAL
  org_ids_json jsonb,                         -- [12,15] 门店/组织集合
  legal_entity_ids_json jsonb,
  include_sub boolean NOT NULL DEFAULT true
);

CREATE TABLE sys_user_role (
  id bigint PRIMARY KEY, user_id bigint NOT NULL, role_id bigint NOT NULL,
  data_scope_id bigint NOT NULL,
  perm_version int NOT NULL DEFAULT 1,        -- 乐观锁，冲突返回 409（02 §6）
  granted_by bigint, granted_at timestamptz,
  UNIQUE (user_id, role_id, data_scope_id)
);

CREATE TABLE sys_field_permission (           -- 字段级（第三轴）
  -- ★ 本处为 v1.4 基线形态，**不是终态**：终态与迁移见 §6.0.4.5。
  --   终态 = 本表 + action 四态（visible|masked|editable|required）+ scene 四出口（list|detail|export|mcp）
  --          + is_ceiling + reason，且唯一键换成 (role_id, resource, field_path, scene)。
  --   下面这一版**不加 scene 就上线**，等于"导出与列表共用一个字段档"——而导出必须更严（§6.0.5）。
  id bigint PRIMARY KEY, role_id bigint NOT NULL,
  resource varchar(64) NOT NULL,              -- 'employment'|'payroll_record'|'person'
  field_path varchar(64) NOT NULL,            -- 'id_card_no'|'net_amount'|'account_no'
  mask_type varchar(16) NOT NULL,             -- FULL|PARTIAL|HIDDEN  （01 §3.2：未授权返回掩码不报错）
  UNIQUE (role_id, resource, field_path)      -- ★ 终态键含 scene，见上
);
```

### 3.8.2 审批、作业、审计、配置

```sql
CREATE TABLE sys_approval_template (
  id bigint PRIMARY KEY, biz_type varchar(32) NOT NULL, name varchar(128),
  node_json jsonb NOT NULL,                   -- [{seq:1,type:'ROLE',roles:['STORE_MANAGER']},{seq:2,type:'REPORT_TO',levels:1}]
  condition_json jsonb, status varchar(16)
);
CREATE TABLE sys_approval_instance (
  id bigint PRIMARY KEY, template_id bigint, biz_type varchar(32) NOT NULL, biz_id bigint NOT NULL,
  status varchar(16) NOT NULL, current_node int,
  submitter_id bigint, origin varchar(8) NOT NULL DEFAULT 'HUMAN',
  submitted_at timestamptz, finished_at timestamptz
);
CREATE INDEX ix_appr_biz ON sys_approval_instance(biz_type, biz_id);
CREATE TABLE sys_approval_task (
  id bigint PRIMARY KEY, instance_id bigint NOT NULL, node_seq int,
  assignee_id bigint, action varchar(16), comment varchar(500), acted_at timestamptz
);

-- ★ 审批明细行：一张单"具体改什么"。没有这张表，审批的是一个没有内容的变更。
CREATE TABLE sys_approval_item (
  id              bigint PRIMARY KEY,
  instance_id     bigint NOT NULL REFERENCES sys_approval_instance(id) ON DELETE CASCADE,
  item_seq        int    NOT NULL,
  entity          varchar(64) NOT NULL,      -- 目标表/对象类型
  entity_id       bigint,
  field_path      varchar(64) NOT NULL,      -- ★ 到字段级：审批的是"哪个字段"
  old_value       text,                      -- 可空（新增时无旧值）
  new_value       text NOT NULL,             -- ★★ 不得为空：见下方"为什么 new_value 必填"
  value_type      varchar(16) NOT NULL DEFAULT 'string',  -- string|number|date|bool|json
  UNIQUE (instance_id, item_seq)
);
CREATE INDEX ix_apitem_inst ON sys_approval_item(instance_id);

-- 代理审批（v1.10 补 DDL：台账点了名、业务要用，但全册此前无建表语句）
CREATE TABLE sys_approval_delegate (
  id             bigint PRIMARY KEY,
  principal_id   bigint NOT NULL,             -- 被代理人（原审批人）
  delegate_id    bigint NOT NULL,             -- 代理人
  flow_id        bigint,                      -- NULL = 全部流程
  effective_from date   NOT NULL,
  effective_to   date,                        -- ★ 生效类右开（§3.0b）
  granted_by     bigint NOT NULL,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  revoke_reason  varchar(500),
  CONSTRAINT ck_apd_no_self CHECK (principal_id <> delegate_id),
  CONSTRAINT ck_apd_span    CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX ix_apd_principal ON sys_approval_delegate(principal_id, effective_from DESC);

-- ★ 防转授链：代理不能被再次代理。这条在 DDL 层表达不出来（闭包长度未知），
--   只能由写入端做递归 EXISTS 检查。**所以它是本表唯一的"写入端纪律"，必须显式登记为已知薄弱点，
--   不能算"已解决"**——否则"代理的代理"会以两条合法的 insert 完成，而每一行记录都合规。

-- 抄送（v1.10 补 DDL）：只读可见，不产生待办
CREATE TABLE sys_approval_cc (
  id          bigint PRIMARY KEY,
  instance_id bigint NOT NULL REFERENCES sys_approval_instance(id) ON DELETE CASCADE,
  cc_type     varchar(16) NOT NULL CHECK (cc_type IN ('USER','ROLE','ORG')),
  cc_target   bigint NOT NULL,                -- 按 cc_type 解释
  reason      varchar(128),
  seq         int NOT NULL,
  UNIQUE (instance_id, cc_type, cc_target)
);
CREATE INDEX ix_apcc_instance ON sys_approval_cc(instance_id);

-- ★ 抄送**不得**进 sys_approval_task 的 act_kind。它是"给你看"，不是"等你办"；
--   并进去之后，待办数会把抄送算进去，于是"这个人手上还压着几张单"从此不可信。

CREATE TABLE sys_job_instance (               -- 异步作业（算薪/导入/导出/批量排班）
  id bigint PRIMARY KEY, job_type varchar(32) NOT NULL,
  params_json jsonb, status varchar(16) NOT NULL,   -- QUEUED|RUNNING|SUCCESS|FAILED|CANCELLED
  progress numeric(5,2) DEFAULT 0, total int, done int, error_count int,
  result_ref varchar(256), error_msg text,
  created_by bigint, origin varchar(8), started_at timestamptz, finished_at timestamptz
);

CREATE TABLE sys_audit_log (                  -- 按月分区，哈希链防篡改
  id bigint PRIMARY KEY, trace_id char(32) NOT NULL,
  actor_type varchar(8) NOT NULL,             -- HUMAN|AI|SYSTEM
  actor_user_id bigint, mcp_client_id bigint,
  action varchar(96) NOT NULL, resource varchar(64), resource_id bigint,
  before_json jsonb, after_json jsonb,
  result varchar(16), ip inet, ua varchar(256),
  prev_hash char(64), row_hash char(64),      -- 哈希链
  created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE TABLE sys_config (                     -- 租户级配置项（01 §7），按范围覆盖
  id bigint PRIMARY KEY, config_key varchar(96) NOT NULL,
  config_value jsonb NOT NULL, value_type varchar(16),
  scope_type varchar(16) NOT NULL,            -- GLOBAL|LEGAL_ENTITY|STORE|ORG|EMPLOYMENT_TYPE
  scope_id bigint,
  effective_from date, effective_to date,
  change_reason varchar(500), approved_by bigint,
  UNIQUE (config_key, scope_type, scope_id, effective_from)
);

CREATE TABLE sys_adjustment_order (           -- 调整单：所有更正走这里，不物理覆盖（01 §8.3）
  id bigint PRIMARY KEY, biz_domain varchar(24) NOT NULL,   -- WORKTIME|PAYROLL|LEAVE|PERSON
  target_type varchar(32) NOT NULL, target_id bigint NOT NULL,
  before_json jsonb, after_json jsonb,
  period_month char(7), reason varchar(500) NOT NULL,
  status varchar(16) NOT NULL,                -- PENDING|APPROVED|APPLIED|REVERTED
  origin varchar(8) NOT NULL DEFAULT 'HUMAN',
  approval_id bigint, applied_at timestamptz, reverted_by bigint
);

CREATE TABLE sys_attachment (
  id bigint PRIMARY KEY, biz_type varchar(32), biz_id bigint,
  file_name varchar(256), storage_key varchar(512) NOT NULL,
  size_bytes bigint, sha256 char(64), mime varchar(128),
  is_sensitive boolean DEFAULT false, watermark boolean DEFAULT false,
  uploaded_by bigint, uploaded_at timestamptz
);
```

#### `sys_approval_item.new_value` 为什么必填（会静默算错钱）

审批流的表结构里最容易省掉的就是这一列。省掉之后系统完全跑得通：单能提、能审、能归档、能查"谁批的"。**唯一不能回答的是"批的是什么"。**

三种烂形态，一种比一种便宜：

| 省法 | 后果 |
|---|---|
| 不建明细表，只批 `biz_type + biz_id` | 审批记录 = "某人同意了某个对象的某个变更"。**对象一变，历史审批自动指向新内容**——语义上等于审批人对未来的任意改动背书 |
| 建表但只存 `field_path`（改哪个字段） | 审批人看到"调薪幅度字段"，不知道**从多少到多少**。他要回到业务页面自己看，而业务页面显示的是**当前值**——可能已经被上一个审批人改过 |
| 存 `old_value` + `new_value` | 正确。且 `old_value` 用于发现**审批期间被人改过**（乐观并发） |

**关键的第三种错法是静默的**：如果只有 `new_value` 而没 `old_value`，两个审批人并行审同一张单会**两次都成功**，后一次覆盖前一次，而两次都有完整的审批凭据。所以 `old_value` 可空（新增场景），但**提交时必须与库中当前值比对，不一致返回冲突而不是覆盖**——这是 `sys_approval_instance` 上唯一需要乐观锁的地方。

**与 §6.0.6 类型层隔离的关系**：`sys_approval_item` 是 AI 最想写的一张表（"帮我发起调薪审批"），而 `new_value` 恰恰是 AI 最容易编造的一格。它必须由业务服务在**读库之后**填入，不得由调用方传入——见 §6.0.6 与 §5.6 的写安全清单。


### 3.8.3 指标字典（禁止各模块自算，02 §14）

```sql
CREATE TABLE metric_definition (
  id bigint PRIMARY KEY, metric_code varchar(64) NOT NULL UNIQUE,
  name varchar(128) NOT NULL, formula text NOT NULL,
  -- 三个边界必须显式登记（02 §14）
  cost_inclusion_json jsonb,      -- 人力成本含：应发+单位社保+奖金提成+福利+劳务费+中介费（可勾选，有默认）
  revenue_caliber varchar(32),    -- 含税/不含税、平台抽成前/后、是否含储值确认
  period_alignment varchar(16),   -- ATTRIBUTION（归属期间）|PAYMENT（发放期间）
  data_source_tables jsonb, owner varchar(64), version_no int,
  effective_from date
);
```

**约束**：绩效、薪酬、门店看板的任何比率指标，SQL 必须引用 `metric_definition.formula` 的解析结果，不得内联公式。实现方式：`MetricQueryService.query(code, params)` 是唯一入口，代码评审时禁止出现手写「人力成本率」计算。

## 3.9 汇总视图（普通视图 + 索引，**不上物化视图**）

> 决策来源：ADR A9。1 万员工 / 500 店 / 5 万考勤日的量级，物化视图带来的刷新一致性延迟与运维复杂度超过收益。

| 视图 | 粒度 | 用途 |
|---|---|---|
| `v_store_daily` | 门店 × 日 | 人效、出勤率、成本率看板 |
| `v_store_monthly_cost` | 门店 × 月 | 门店 P&L、成本超支预警 |
| `v_employee_monthly` | 人 × 月 | 离职率、编制、人均产出 |
| `v_org_unit_stat` | 组织节点 × 版本 | 组织架构图节点徽标（人数/编制/成本/流失率） |
| `v_recruit_funnel` | 需求 × 阶段 | 招聘漏斗 |
| `employee_workplaces_v` | 人 × 门店 × 日 | 可排班门店 / 打卡设备白名单派生源（§3.2.4） |

**实现要求（三条）**
1. **必须 `CREATE VIEW`，不用 `CREATE MATERIALIZED VIEW`**；也不建同名物理汇总表——那只是手工物化视图，问题一样，还多一份"汇总对不对"的举证责任。
2. **性能靠基础表索引**，不靠预计算。每个视图必须有对应的覆盖索引设计（`explain analyze` 归档到 `docs/perf/views.md`），视图定义变更须同步复核索引。
3. **视图不得嵌套超过 2 层**，不得在视图里做 `ORDER BY`（排序留给查询侧），保证优化器能下推谓词。

**为什么可以不上物化视图**：真正的重查询（明细导出、万行报表）走异步作业，读的是分区表范围扫描；仪表盘类查询落在"门店 × 月"这种天然小基数（500 店 × 12 月 = 6000 行/年）上，普通视图 + 索引在毫秒级。

**兜底规则**：若某视图实测 P95 > 1s，**只能通过加索引或改写视图解决，不得退回物化视图**；确需预计算时，须提 ADR 变更（A9 是明确裁决，不是默认值）。

---

# §4 关键引擎设计

## 4.1 算薪引擎

### 4.1.1 整体流程（DAG）

```
[1] 期间与方案解析
     period_month + legal_entity_id → pay_scheme 列表（按 employment_type × pay_mode）
[2] 人群装载
     employment WHERE status ∈ {ACTIVE, PROBATION, TERMINATED(本期离职), REHIRED}
     ∧ 本期在职天数 > 0 ∧ 排除 DISPATCH/OUTSOURCE（不进工资表，02 §1.2）
[3] 快照（Snapshot）★ 01 §6-6：算薪时快照，不实时回查主档
     ├ 薪资档案（月薪/时薪/日薪/计件单价版本）
     ├ 社保方案与基数
     ├ 个税累计（上月末累计值）
     ├ 工时事实汇总（封账后的 attendance_daily + attendance_daily_store，含双口径天数、加班三类、法定上班天数）
     ├ 假期扣款因子（连续病假三值）
     ├ 绩效双系数
     └ → 写 payroll_snapshot（冻结）
[4] 因子图构建 + 拓扑排序
     由 pay_item.formula 解析出依赖，构建 DAG，检测循环，产出计算顺序
[5] 逐项计算（分片并行）
     每片 500 人，按 DAG 顺序求值，过程记 formula_trace
[6] 汇总与校验
     ├ 成本分摊生成（按 cost_bearing_policy 分流）
     ├ 分摊平衡校验（Σ 分摊 = 应发 + 单位社保）
     ├ 异常阻断检查（见 §4.1.5）
     └ 与上月/上期同口径对比（差异 > 阈值 → 告警）
[7] 落库（批量）+ 生成 payroll_record / item / cost_allocation
[8] 复核 → 审批 → 生成发薪批次 → 封账
```

**为什么快照必须是独立存储而不是"算薪时读主档"**：01 §6-6 已定死。工程上还有一层：`payroll_record.snapshot_json` 让"解释某人某月为什么这么算"成为一次单表查询，不依赖任何主档当前状态。这对 `payroll_explain_item`（§5.4 工具）和劳动争议举证都是刚需。

### 4.1.2 规则如何表达（三层，各有明确边界）

| 层 | 载体 | 谁维护 | 表达什么 | 边界 |
|---|---|---|---|---|
| **L1 公式** | `pay_item.formula` 受限表达式 + `pay_formula_lib` 函数库 | 实施顾问 / 集团薪酬 | 单个薪资项怎么算 | 只能引用因子白名单；不能跨项赋值 |
| **L2 规则表** | `pay_scheme` + `pay_scheme_item` + 条件-优先级-公式 | 集团薪酬 | 什么人适用哪个公式、优先级、封顶保底 | 条件字段限定枚举，不可写代码 |
| **L3 插件** | Java SPI `PayrollExtensionPoint`（定制包） | 厂商研发（随升级包分发） | 极个别无法表达的规则（如复杂阶梯提成） | **客户不得后台上传代码**；定制包必须签名校验；**不做插件热加载**（ADR A11）——客户不会写插件，热加载是纯安全风险，插件随版本发布生效 |

**为什么不用自由脚本（Groovy / JS / 用户上传 Java）**
- 安全：客户内网环境，一旦允许执行任意代码，等于把数据库交出去；
- 可分析：项目依赖图必须先于执行确定（决定计算顺序与快照字段收集），自由脚本做不到静态分析；
- 可追溯：`formula_trace` 要能还原每一步，自由脚本只能记日志。

**公式 DSL 语法（受限，白名单因子）**

```
-- 因子白名单（前缀固定，解析期校验收窄）
emp.monthly_salary          月薪（快照）
emp.hourly_rate             时薪（快照）
emp.hire_date / emp.term_date / emp.probation_end_date / emp.regularization_date
emp.employment_type / emp.pay_mode / emp.job_grade / emp.service_years
cal.workdays                当月应出勤工作日
cal.payroll_days            当月计薪日（21.75 口径）
cal.calendar_days           当月日历天数
cal.statutory_days          当月法定节假日天数
wt.actual_hours / wt.planned_hours / wt.attendance_days / wt.payroll_days
wt.ot_weekday_hours / wt.ot_restday_hours / wt.ot_statutory_hours
wt.statutory_worked_days    法定节假日上班天数（月薪FT"照付+另付"用）
wt.sick_short_days / wt.sick_long_days
lev.remaining_days(leaveCode)
perf.personal_coef / perf.unit_coef
pc.qty / pc.amount          计件
const.<paramCode>           参数表（ot_rate_weekday / sick_leave_threshold_days / ...）
item.<itemCode>             其他薪资项结果（构成 DAG 依赖）
```

```
-- 示例：平时加班费
wt.ot_weekday_hours * (emp.monthly_salary / const.payroll_monthly_standard_hours) * const.ot_rate_weekday

-- 示例：入离职折算（proration_basis = CALENDAR 时的正确写法）
emp.monthly_salary / cal.calendar_days * wt.payroll_days

-- 示例：法定节假日加班（月薪制，走"照付+另付"，不打工时×倍数）
wt.statutory_worked_days * (emp.monthly_salary / cal.payroll_days)
```

**内置函数库**（限定集合，不可扩展）：`ROUND(x,n)` `CEIL` `FLOOR` `MIN` `MAX` `IF(cond,a,b)` `COALESCE` `ABS` `PRORATE(base, num, denom)` `CAP(x, max)` `FLOOR_GUARANTEE(x, min)`。

**编译期强制校验**（`FormulaValidator`，在设计期就拦住 90% 的算错钱）：

| 校验 | 失败后果 |
|---|---|
| 因子是否在白名单 | 拒绝保存 |
| DAG 是否有环 | 拒绝保存 |
| `payroll_monthly_standard_hours` 与 `proration_basis` 是否被同一公式同时引用 | 拒绝保存（02 §7.2 禁止项） |
| `proration_basis=SCHEDULED_DAY` 时是否对 `divisor=0` 做了阻断 | 拒绝保存（02 §7.2 陷阱） |
| 引用了 `is_taxable=false` 但被计入个税基数的项 | 告警 |
| 除零、`null` 传播 | 静态分析告警 |

### 4.1.3 执行顺序与分片

```java
// 伪代码：PayrollRunService.execute(runId)
List<Long> population = loadPopulation(period, legalEntity, scope);   // 分页游标，不 OFFSET
snapshotService.freeze(period, population);                           // 一次性 SQL 聚合到 snapshot 表
FormulaGraph graph = formulaCompiler.compile(scheme, items);          // 一次编译，N 次求值（缓存 AST）
int shardSize = 500;
List<Shard> shards = partition(population, shardSize);
shards.parallelStream(maxConcurrency = cpuCores / 2).forEach(shard -> {
    List<PayrollRecord> records = calcShard(shard, graph);             // 纯内存计算
    batchWriter.upsertRecords(records);                                // JDBC batch 500
    batchWriter.upsertItems(records);                                  // 一次 500×项数
});
allocationService.allocate(period, legalEntity);                       // 集合式 INSERT...SELECT
balanceValidator.validate(period, legalEntity);                        // 分摊平衡
anomalyDetector.detect(period, legalEntity, baselinePeriod);           // 异常阻断 + 环比
```

**关键性能手段**：
- 表达式 **AST 编译一次、缓存复用**（按 `pay_item_id + formula_hash`），单次求值 ~3μs；
- 快照用**一条 `INSERT ... SELECT`** 把万人数据聚合到临时表，避免 N 次往返；
- 写入用 `COPY` 到临时表 + `INSERT ... SELECT ... ON CONFLICT DO UPDATE`，而不是 30 万次 `INSERT`；
- 分摊用**集合式 SQL**（`INSERT INTO payroll_cost_allocation SELECT ... FROM payroll_snapshot`），不做 Java 循环；
- 并行度 = CPU 核数 / 2（给 DB 留余量），单机 8 核 → 4 线程。

### 4.1.4 幂等与重算

| 场景 | 处理 |
|---|---|
| 同一期间重复点击"算薪" | `scope_hash + data_version` 唯一索引 → 返回已有 `run_id`，不重跑 |
| 输入数据变了（工时重封、调薪生效） | `data_version` 变化 → 允许新建 run |
| 部分人算错要重算全量 | 新 run，`payroll_record.is_current` 旧版本置 false，新版本 true；旧数据保留可查 |
| 封账后要改 | **禁止重算**（`payroll_period.locked=true` 时 `PayrollRunService` 直接抛 `E_LOCKED_PERIOD`）。只能开**调整单**：在下期工资记录中增加补差项，本期记录保持原值 |
| 算薪过程崩溃 | Spring Batch job 可 restart；`calc_run.status=PARTIAL` 时按 `success_count` 续跑，不重头来 |
| 同一人并发被两个 run 处理 | 行级 `pg_advisory_xact_lock(hashtext(employment_id))`，第二个 run 等待并检测到 `is_current` 已存在时跳过 |

**为什么用"版本式"而不是"覆盖式"**：`UNIQUE(...) WHERE is_current` 保证红线（一人一期间一条当前记录），同时保留历史版本用于对账与举证。这比"算一次覆盖一次 + 一张审计表"更可靠，因为审计表里的 JSON 无法被报表 JOIN。

### 4.1.5 异常阻断清单（算薪不允许"带病出表"）

| 阻断项 | 检测 | 处置 |
|---|---|---|
| 工时未封账 | `attendance_period_close.status != CLOSED` | 硬阻断，提示先封账 |
| 分摊不平衡 | `Σ alloc_amount ≠ gross + employer_si`（±0.01） | 阻断提交复核，列出差异记录 |
| 社保基数缺口 | 有 `si_enrollment` 但 `base_amount` 为空 | 阻断，转人工补录 |
| 个税累计断链 | 上月末 `cumulative_*` 缺失且非首次入职 | 阻断，避免重复扣起征点 |
| 负实发 | `net_amount < 0` | 不阻断，进异常清单（可能是扣款累计） |
| 折算分母为 0 | `proration_basis=SCHEDULED_DAY` 且个人排班天数 = 0 | 硬阻断该人（02 §7.2 明令必须阻断，不能出 0） |
| 环比异常 | 应发波动 > 30% 或 与上月差异 > 5000 元 | 不阻断，进复核清单（人工确认后才可提交） |
| 试用期超期 | `regularization_date > probation_end_date` 或 到期未办理 | 不阻断，生成异常记录（02 §4） |
| 加班豁免名单 | 在名单内但考勤有加班工时 | 不阻断，报表标注口径（02 §12.4） |

### 4.1.6 性能目标与拆解（10,000 人）

| 阶段 | 目标耗时 | 手段 |
|---|---|---|
| 人群装载 + 快照冻结 | ≤ 60s | 单条 `INSERT...SELECT`，快照表按 `period_month` 不分区（单期数据量小） |
| 公式编译 + DAG | ≤ 5s | 只编译一次，缓存在 `pay_formula_cache` |
| 计算（30 万次项求值） | ≤ 180s | 4 线程 × 500 人/片；AST 缓存 |
| 分摊 + 平衡校验 | ≤ 40s | 集合式 SQL |
| 落库（1 万记录 + 30 万明细） | ≤ 90s | `COPY` + `ON CONFLICT` |
| 异常检测 + 环比 | ≤ 30s | 与基期做 SQL JOIN |
| **合计** | **≤ 8 分钟（硬上限 15）** | |

**容量红线**：若单期人数 > 15,000，改为"按法人分批 + 分批提交复核"，不追求一次跑完。

## 4.2 排班引擎

### 4.2.1 划线排班的批量写入

**前端行为**：店长在周视图上框选（员工 × 日期）矩形区域，选班次 → **本地只生成操作集 `List<AssignOp>`，不发逐格请求**。一次框选 20 人 × 7 天 = 140 格，一次请求提交。

```json
POST /api/schedule/batch-assign
{
  "storeId": 1024, "weekStart": "2026-11-16", "dryRun": true,
  "ops": [
    {"employmentId": 501, "workDate": "2026-11-16", "shiftId": 12, "action": "ASSIGN"},
    {"employmentId": 501, "workDate": "2026-11-17", "shiftId": 12, "action": "ASSIGN"},
    {"employmentId": 502, "workDate": "2026-11-17", "shiftId": 12, "action": "ASSIGN"}
  ]
}
```

**服务端处理（一次事务）**

```java
// 1) 参数与上限
if (ops.size() > 5000) throw new E_TOO_MANY_OPS();     // 超过则前端自动拆批

// 2) 批量装配上下文（3 条 SQL，不是 N 条）
Set<Long> empIds = ...;
Map<Long, Employment> emps = empMapper.selectBatch(empIds);        // 四维归属、用工类型
Map<Long, Shift> shifts = shiftMapper.selectBatch(shiftIds);       // 班次参数（快照来源）
Map<Long, List<Interval>> existing = schedMapper.selectIntervals(empIds, weekStart-1, weekStart+8);
Map<Long, CertStatus> health = certMapper.selectHealthCerts(empIds);  // 健康证
Map<Long, AttendanceGroup> groups = ...;                            // 工时上限规则

// 3) 全量校验（纯内存，O(n log n)）
ValidationResult vr = validator.validate(ops, emps, shifts, existing, health, groups);
if (!vr.ok()) return vr.asConflictReport();                         // dry-run 返回冲突清单

// 4) 写入：COPY 到临时表 → MERGE
jdbc.execute("COPY tmp_assign_op FROM STDIN");                      // 二进制 COPY，1 万行 < 200ms
jdbc.update("""
  INSERT INTO schedule_assignment (id, employment_id, work_date, shift_id, store_id, ...)
  SELECT next_id(), o.employment_id, o.work_date, ...
  FROM tmp_assign_op o
  ON CONFLICT (employment_id, work_date, shift_id, store_id)
  DO UPDATE SET status='DRAFT', planned_hours=EXCLUDED.planned_hours, version=schedule_assignment.version+1
""");

// 5) 一致性收尾：重算受影响人的当日合计、标记受影响周未发布
scheduleInvalidation.mark(storeId, weekStart, empIds);
```

**为什么用 `COPY` + `MERGE` 而不是 JDBC batch**：5000 条 `UPDATE`/`INSERT` 在 JDBC batch 下约 1.2–2s（含网络往返与 WAL 逐条提交），`COPY` 到临时表 + 单条集合式 `MERGE` 在 0.3–0.5s。餐饮门店店长普遍在手机上操作，晚高峰排班发布是集中动作，1.5s 的差异会被感知为"卡"。

**并发保护**：写入前 `pg_advisory_xact_lock(store_id, week_ordinal)`，同一门店同一周串行；跨门店同人冲突由 §4.2.2 的第二步校验捕获。

### 4.2.2 冲突校验：算法与执行时机

**三类冲突，五个维度**

| 类别 | 冲突 | 判定算法 |
|---|---|---|
| 时间 | 同一人同一时段被排两个班 | 区间重叠：把该人本周所有班次展开成 `[start_ts, end_ts)` 绝对区间，按 `start_ts` 排序后线性扫描，`next.start < cur.end` 即重叠。复杂度 O(k log k)，k ≤ 30 |
| 时间 | 班次间休息间隔不足 | 相邻区间 `gap < min_rest_hours`（参数，默认 8h） |
| 工时 | 考勤组日内上限 | `Σ planned_hours(日) > group.daily_cap` |
| 工时 | 考勤组周内上限 / 月内上限 | 组内聚合 |
| **工时** | **法定工时上限（人员属性，硬）** | 按 `legal_employment_form` 取默认阈值：非全日制 → 日 4h / 周 24h（参数 `statutory_cap_part_time`）；全日制 → 日 8h / 周 44h（参数 `statutory_cap_full_time`）。**考勤组只能收紧不能放宽** |
| 工时 | **员工当日全店合计上限**（02 §12.2 / 双级校验） | `attendance_daily.work_hours` 本身就是跨店合并结果（`attendance_daily_store` 多行汇总）；单店不超但合计超 → 报错 |
| 合规 | 健康证过期 | `certificate WHERE cert_type='HEALTH' AND expire_date < work_date` → **硬阻断**（01 §6-11） |
| 合规 | 连续工作天数超限 | 滚动 7 天窗口内 `worked_days > max_consecutive` |
| 合规 | 未满 18 周岁 / 岗位资质缺失 | 年龄、技能标签比对 |
| 业务 | 门店最小在岗人数 | 排完后按班次时段统计在岗人数，低于 `min_staff` 告警（不阻断） |

**工时上限为什么必须是两级（这条最容易被做成一级）**

```
最终上限 = MIN( 法定上限(legal_employment_form) , 考勤组上限 )   ← 考勤组只能收紧，不能放宽
```

如果只做"考勤组自己配一个数"，**非全日制员工会被按全日制上限校验，合规校验形同虚设**。法定上限挂在人员属性上（跟着人走），考勤组上限是可收紧的运营参数。这也是 `legal_employment_form` 必须独立成字段的第二个理由（第一个是社保口径，§3.2.3）。

**执行时机：三层，各司其职**

| 层 | 时机 | 能力 | 目的 |
|---|---|---|---|
| L1 前端即时 | 拖动/框选时 | 只有本地已知数据（当前周已加载的班次） | 即时反馈（红框），零延迟，允许误报 |
| L2 服务端 dry-run | 提交前 | 全量数据 + 完整算法 | 权威冲突清单 + 可修复建议 + 生成 plan（§5.6） |
| L3 事务内最终校验 | 落库事务开始 | 同 L2，但在 `advisory lock` 之后 | 防并发穿透（两人同时排同一人） |

**为什么 L2 与 L3 都要做**：L2 是给用户看的（要给出"第 3 行与第 5 行冲突"这种可操作信息），L3 是给数据完整性兜底的（不给建议，只拒绝）。合并成一层会导致"要么前端卡顿、要么脏数据落库"。

### 4.2.3 集团班次版本如何影响已发布排班

**结论：已发布排班锁定班次参数快照，集团班次改版不影响已发布排班。**

```
发布时：schedule_assignment.shift_snapshot =
  {"startTime":"09:00","endTime":"18:00","breakMinutes":60,"paidHours":8.0,"crossDay":false,"shiftVersion":3}
```

| 变更 | 对 DRAFT | 对 PUBLISHED | 对 LOCKED（已封账） |
|---|---|---|---|
| 集团班次改上下班时间 | 生效（引用当前版本） | **不变**（快照生效） | 不变 |
| 集团班次改休息时长 | 生效 | **不变** | 不变 |
| 集团班次停用 | 新排班不能选 | 不变 | 不变 |
| 需要改已发布排班 | — | 走"排班变更单"：生成调整 → 审批 → 新快照 → **通知员工** → 记审计 | 走工时调整单 |

**为什么这样取舍**：01 §7 有"排班最小发布提前量 3 天"配置，说明员工有权在 3 天前知道班表。如果集团改班次能静默改已发布排班，等于绕过了这个知情权，劳动争议时无法举证。因此这里**牺牲"批量修正便利"换"证据链完整"**（§10 R4）。

`attendance_daily_store` 的计算也必须用 `shift_snapshot` 而非当前 `shift` 表，否则同一段历史在不同时间算出不同的计划工时；同时把 `snap_calc_rule_version` 落进行内（锁"算法"的那一列，§3.3.5）。

## 4.3 权限引擎（三轴 + 防自锁）

### 4.3.1 三轴正交与求值序（ADR A3 / A4）

```
权限三元组 = (client_id, user_id, scope)          ← 服务端实时解析，客户端不得传
求值序     = 数据范围 → 字段 → 功能               ← ADR A4 定序，不是随便排的
权限判定   = 数据轴(D) ∧ 字段轴(P) ∧ 功能轴(F)
  D: row ∈ ScopePredicate(user, client)          五档：all / subtree / org / self / external
  P: field → {PLAIN | PARTIAL | HIDDEN}          ★ 只掩码，永不拒绝
  F: permission_code ∈ (静态超管 ? ALL : 角色功能权限 ∩ MCP scope)
```

**为什么求值序是「数据范围 → 字段 → 功能」**
先裁行、再裁列、最后判功能，有三个实际好处：① 数据范围是一段 SQL 条件，放在最前能进执行计划，不白读行；② 字段掩码在序列化阶段做，一旦发现行已经为空就不必算掩码；③ 功能权限最后判，让"有功能但无数据"的场景返回**空结果而非 403**——这对 AI 尤其重要（见 A4）。

**字段级只掩码不拒绝（ADR A4）**：如果对无权限字段抛错，AI 连"这个人在不在职"都答不出来（因为它 SELECT 了整行）。因此字段轴只有三档掩码，**没有"拒绝"这一档**；返回 `null` + `_masked:true` 标记，让调用方知道"有值但你看不到"而不是"没有值"。

| 轴 | 存储 | 计算时机 | 缓存 |
|---|---|---|---|
| 数据 | `sys_user_role.data_scope_id` → `sys_data_scope` | 每次请求（A3：实时解析） | 解析结果转临时表（见 §4.3.2） |
| 字段 | `sys_field_permission` | 序列化时 | 请求内本地 Map |
| 功能 | `sys_role_permission`（权限点总数以 `10` 的清单为准——`10` 已出 3 域、预估 **180–220**；本节早前写的"66 个"是初版清单，已作废。命名 `域.资源.动作` 三段，见 §6.0.9） | 每次请求（A3） | Redis 60s，key 带 `permVersion` |

**"服务端实时计算，前端/客户端不得指定角色"**（02 §6 + ADR A3）的实现：所有 Controller / MCP tool 的入参 DTO **不含 role / permission / scope / dataScope 字段**；`@PreAuthorize` 只在方法级声明 `permission_code`，角色解析走 `SecurityContext`（由 token 派生）。ArchUnit 规则强制：`..request..` 包下的类不得出现名为 `role`/`scope`/`dataScope` 的字段。**AI 永远"代表某人"行事，不存在"AI 自己"这个主体。**

### 4.3.2 数据范围如何转成 SQL（具体实现，不是空谈）

> ⚠ **本节函数体已被 §6.0.3.7 替换，保留在此仅为说明"为什么用临时表 + 会话函数"这个选型。**
> 下面这版 `app_begin_scope` 按**单维** `scope_type` 分支，无法表达四维归属（发薪法人 / 参保主体 / 成本组织 / 考勤组织）——同一段 `scope_type='LEGAL_ENTITY'` 分不清是发薪法人还是参保法人。**实现请用 §6.0.3.7 的维度化版本**（`tmp_scope_org` / `tmp_scope_entity` / `tmp_scope_deny` 按 `dim_code` 分列 + 每维度一个 `EXISTS`）。选型论证（临时表 vs 拦截器拼 SQL、默认拒绝、组织树保留祖先）仍然有效。
>
> **解析入口必须读规则表，不读 `scope_type`**：`sys_data_scope_rule`（维度三元组 + `combinator`）与 `sys_permission_deny`（显式 deny，压过一切 allow）是唯二的判定输入；`sys_data_scope.scope_type` 只作"对外五档"的展示名。**两个地方都能决定权限 = 迟早两处不一致，而不一致的那处没人读。**

**方案：临时表 + 会话函数**（推荐），配合 MyBatis 拦截器兜底。

> **本节不给出函数体。** 唯一实现是 §6.0.3.7 的维度化版本 `app_begin_scope(p_user, p_resource, p_fact_from)`。
>
> **旧的两参数版本已删除，且不得以任何形式重新引入（含 `_v0` / `_deprecated` / 注释保留）。** 理由不是整洁：PG 按**签名**重载，两参数版与三参数版**可以同时存在于库里**，而两参数版**没有** `E_RESOURCE_UNREGISTERED`、**没有** `E_FACT_DATE_REQUIRED`、用的是已废弃的 `tmp_scope_emp` 单维结构——**它不报错，返回 void，业务 SQL 照常跑**。也就是说"默认放行是权限系统唯一不可接受的默认值"这条防线，存在一个不需要任何特权、只需要照旧调用的旁路。
>
> **保留一份"仅用于说明选型"的旧函数体，等于给这个旁路留了一个可复制的模板。** 说明可以留文字，代码不能留形状。


**五档数据范围（对外口径，内部细分类型可多个映射到同一档）**

| 档 | 含义 | 内部实现类型 |
|---|---|---|
| `all` | 全集团 | `ALL` |
| `subtree` | 某节点及其下级 | `DEPT_SUB` |
| `org` | 指定组织/门店集合、指定法人 | `DEPT` / `STORE_SET` / `LEGAL_ENTITY` |
| `self` | 本人 | `SELF` |
| `external` | 外部方仅本供应商供人 | `EXTERNAL` |

**两条强制规则（不做就会全量泄露或拼不出树）**

| 规则 | 实现 | 漏了会怎样 |
|---|---|---|
| **默认拒绝：无可见组织时返回 `AND 1=0` 短路，不得返回空条件** | **由 `EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org …)` 的 SQL 语义天然实现**——集合为空则 `EXISTS` 为假，查询返回 0 行，**不依赖任何人记得写兜底**。**不设显式布尔标志**：设了标志，就多出一个"忘了看标志"的失败点，而那个失败点的方向是放行 | 拼 SQL 时"集合为空 → 不加条件"是最经典的越权写法，**漏一个条件就是越权全量** |
| **组织树裁剪必须保留祖先** | 树查询不按 `tmp_scope_org` 直接过滤节点，而是先取命中节点的 `path`，再回查路径上所有祖先（仅展示用，不带人员/成本数据） | 只留孙子节点，前端拼不出层级，树直接断掉 |

**业务 SQL 统一写法**（可读、可 EXPLAIN、可单测）：**一律三段形态，缺一段就是漏一个维度**

```sql
-- ① allow：每个行闸维度一个 EXISTS（注释里的 dim:XXX 由拦截器机检是否覆盖 row_gate_dims）
-- ② deny ：同一维度一个 NOT EXISTS（注释里的 deny:XXX 由拦截器机检）
-- ③ 空集 ：EXISTS 天然 fail-closed，不写任何兜底条件

-- 成本组织受限的工资查询
SELECT r.* FROM payroll_record r
WHERE r.period_month = #{period}
  AND EXISTS (SELECT 1 /* dim:cost_org */ FROM pg_temp.tmp_scope_org s
               WHERE s.dim_code = 'cost_org' AND s.org_id = r.cost_org_id)
  AND NOT EXISTS (SELECT 1 /* deny:cost_org */ FROM pg_temp.tmp_scope_deny n
                   WHERE n.dim_code = 'cost_org' AND n.org_id = r.cost_org_id);

-- 员工维度受限（本人只能看自己 + 组织范围）
SELECT * FROM attendance_daily d
WHERE d.period_month = #{period}
  AND (EXISTS (SELECT 1 /* dim:person */ FROM pg_temp.tmp_scope_emp e
                WHERE e.dim_code = 'person' AND e.emp_id = d.employee_id)
       OR EXISTS (SELECT 1 /* dim:attendance_org */ FROM pg_temp.tmp_scope_org s
                   WHERE s.dim_code = 'attendance_org'
                     AND s.org_id = d.primary_store_id));
```

> **列名不得混用**：`attendance_org` 维度的 allow 必须用**班段级事实** `attendance_daily_store.snap_attendance_org_id`（见 §6.0.3.7），而**不是** `attendance_daily.primary_store_id`——后者是"当日工时最大者"的**统计结果**，随重算而变，用它做权限谓词等于**同一行的可见性随重算而变，而两次都"有依据"**。上面第二段为保持本节自洽仍写 `primary_store_id`，**实现以 §6.0.3.7 为准**。

**为什么用临时表而不是拦截器拼 WHERE 字符串**

| 方案 | 优点 | 缺点 |
|---|---|---|
| 拦截器拼 SQL | 业务 SQL 完全不用改 | 字符串拼接易出错；生成 SQL 无法预审；复杂条件（子树/多范围并集）拼出来不可读；分页与 `UNION` 场景易漏；**空集合极易被写成"不加条件"** |
| **临时表 JOIN** | SQL 可读、可 EXPLAIN、可索引；权限条件一次性灌入，多次查询复用；越权即"join 不到行"，天然兜底 | 需约定写法；每请求多一次函数调用（~2ms） |

选临时表。**兜底机制**：MyBatis 拦截器扫描最终 SQL，若发现被标记 `@Scoped` 的 Mapper 方法生成的 SQL **未覆盖 `sys_perm_resource.row_gate_dims` 声明的每个维度**（按 `/* dim:XXX */` 与 `/* deny:XXX */` 注释计数），直接抛异常（开发期把漏写变成硬失败）。**判据是"逐维度覆盖"，不是"包含某个表名"**——后者只要出现一次 `tmp_scope_org` 就算过，而漏掉三个维度的方法照样能过。

**性能**：`tmp_scope_org` 在万级组织节点下最多 3000 行，PG 会选 hash join 或 nested loop，实测影响 < 5%。对超大范围（全集团）角色，函数内可打标 `tmp_scope_all=true`，业务 SQL 用 `WHERE (SELECT tmp_scope_all()) OR EXISTS(...)`，短路走 `1=1`。

### 4.3.3 字段级：脱敏而非报错

01 §3.2 明确"未授权返回掩码而非报错"。实现：

```java
public record PayrollRecordVO(
    Long id,
    @Sensitive(SensitiveType.MONEY)  BigDecimal netAmount,
    @Sensitive(SensitiveType.ID_CARD) String idCardNo,
    @Sensitive(SensitiveType.BANK_CARD) String accountNo
) {}
```

`FieldMasker` 在 JSON 序列化前按 `sys_field_permission` 处理：

| mask_type | MONEY | ID_CARD | BANK_CARD / MOBILE |
|---|---|---|---|
| PLAIN（有权限） | `8500.00` | `310101199001011234` | `6222021234567890` |
| PARTIAL（默认） | `8,***.00` 或返回区间 `[8000,9000]` | `310101********1234` | `**** **** **** 7890` |
| HIDDEN | `null` + `_masked:true` 标记 | 同左 | 同左 |

**MCP 层在此基础上再收紧一档**（§5.5）：即使角色有 PLAIN，MCP 默认按 PARTIAL 返回，明文需走 `gov_request_plaintext` 受控查看。

### 4.3.4 防自锁与防越权自授

| 机制 | 实现 | 解决 |
|---|---|---|
| 静态超管名单 | `application.yml` 的 `security.static-super-users: [1001]`，启动加载到不可变集合；页面与 API 均不可修改 | 管理员改错权限把自己锁死（02 §6） |
| 权限变更乐观锁 | `sys_user_role.perm_version`，更新时 `WHERE perm_version = ?`，失败返回 409 | 并发覆盖（02 §6） |
| 不得自授 | 授予角色的接口校验：操作者角色的权限集合必须是目标角色权限集合的超集（除静态超管） | 提权 |
| 撤权降级 | 撤权后回落到 `GUEST`（仅本人数据），历史业务数据保留 | 与"停用不删档"同哲学 |
| 权限变更审计 | 每次变更写 `sys_audit_log`，含 before/after 全量 JSON | 可追溯 |
| MCP 客户端额外收窄 | `sys_mcp_client.max_data_scope` 与用户数据范围取**交集** | 绑定 HRD 账号的客户端也能被限制到某区域（§5.2） |

## 4.4 组织架构图

### 4.4.1 数据组织

**三份数据，各管一段**：

| 数据 | 来源 | 用途 |
|---|---|---|
| 结构（节点 + 父子） | `org_unit`（或 `org_unit_history` 按版本） | 画树、连线 |
| 节点徽标（人数/编制/成本/流失率） | 视图 `v_org_unit_stat`（按 `org_version_id` + `period`，普通视图 + 索引，ADR A9） | 节点上显示的 `12/15 人` 等，**前端不算**，只读 |
| 人员卡片（可选展开） | 按 `org_unit_id` 分页查 `employment` | 展开到人时懒加载，每页 30 |

```sql
-- 普通视图，不是物化视图（ADR A9）；性能靠 org_unit(path) + employment(primary_org_id) 索引
CREATE VIEW v_org_unit_stat AS
SELECT o.id AS org_unit_id,
       o.org_version_id,
       to_char(h.period_month, 'YYYY-MM') AS period_month,
       h.headcount_approved,
       (SELECT count(*) FROM employee_org_assignment a
         WHERE a.primary_org_id = o.id
           AND a.valid_to IS NULL
           AND EXISTS (SELECT 1 FROM employment e
                       WHERE e.id = a.employee_id AND e.status IN ('ACTIVE','PROBATION'))) AS headcount_active,
       h.headcount_approved
         - (SELECT count(*) FROM employee_org_assignment a WHERE a.primary_org_id = o.id AND a.valid_to IS NULL)
         AS headcount_gap
       -- labor_cost_amount / turnover_rate 由 MetricQueryService 按 metric_definition 计算后合并
FROM org_unit o
JOIN org_headcount h ON h.org_unit_id = o.id;
```

**为什么徽标必须由服务端算、前端不算**
万级节点若每次前端按节点算人数，需要 N 次查询或一次巨大聚合，切换维度（四维）时再算四遍。徽标统一由服务端在**一次查询里按节点聚合返回**，让"切换维度"变成"换一次查询参数"，这是体验差异的关键。但聚合方式仍是普通视图 + 索引，**不引入物化视图**（ADR A9）——若实测慢，加覆盖索引，不改架构。

### 4.4.2 前端渲染（万级节点，ADR A10）

| 节点规模 | 渲染方式 | 说明 |
|---|---|---|
| ≤ 500 | SVG + DOM（组件可交互：拖拽、右键、tooltip） | 交互最丰富 |
| 500 – 5,000 | **Canvas 2D 渲染 + 视口裁剪** | 只画视口内的节点与边，滚动时重绘 |
| > 5,000 | Canvas + **分层折叠** | 默认只展开到第 3 层；子节点数 > 50 折叠为「聚合节点 +N」 |

**布局**：tidy tree（Reingold–Tilford 变体）在 **Web Worker** 中计算，主线程只做绘制。万级节点布局约 80–150ms（Worker 内），主线程渲染单帧 < 16ms（视口内通常 < 300 节点）。

**增量加载接口**：

```
GET /api/org/tree/children?parentId=12&depth=2&versionId=latest&dimension=COST
→ { nodes: [...], stats: {...}, hasMore: true }
```

- 首屏只返回根 + 前 2 层（约 50 节点），避免首屏加载 3000 节点。
- `dimension` 参数（`PRIMARY|SCHEDULE|ATTENDANCE|COST`）只改变 `stats` 的取值列，树结构不变 → 四维切换零重绘。

**搜索定位**：服务端返回命中节点与其 `path`，前端展开路径上所有父节点并居中高亮。

**变更版本化（拖拽调整不直接落库）**

```
拖拽 → 生成 OrgChangeOrder（含 fromParent/toParent/effectiveDate）
     → 审批（HR 负责人）→ 批准后 OrgVersionService.publish(versionNo)
     → 同事务：写 org_unit（更新 parent/path/depth）+ 追加 org_unit_history 全量切片
     → 同步：校验成本中心合法性（cost_org 必须属于发薪法人子树）；视图 v_org_unit_stat 无需刷新（ADR A9）
```

历史查看：`?versionId=17` → `OrgQueryRouter` 路由到 `org_unit_history`，图表显示"2026-09 版本（已停用）"水印条。

---

## 4.5 断言与证据的运行层（巡检注册、`guards`、四态数值、取证）

§3.3.8 有八条恒等式，§6.0 有 5 个巡检视图，§8.2b 有 ACL 校验，§9.5 有升级前比对。它们此前**各自定义、各自散落**，于是没有任何一处能回答三个最基本的问题：**这条断言现在指着谁？跑过没有？红了谁管？**

这一节把"断言"当成一类**有生命周期的对象**来管，而不是当成一段 SQL。

> **清单只记"我有一条断言"，不记"它还行不行"。** 所以清单永远比实际防线长——`L0` 就是典型：有编号、有名字、有定义式、有后果说明、有实现位置，**唯一没有的是那行代码**，而它因为说明写得最长，看起来最完整。

### 4.5.1 注册表：`sys_check_registry`

```sql
CREATE TABLE sys_check_registry (
  check_code       varchar(32) PRIMARY KEY,          -- ★ ALG-07 / L0 / C2a / ACL-03（编号即主键）
  name             varchar(128) NOT NULL,
  domain           varchar(24)  NOT NULL
                     CHECK (domain IN ('ATTENDANCE','PAYROLL','PERM','ORG','SECURITY','INTEGRATION')),
  kind             varchar(16)  NOT NULL
                     CHECK (kind IN ('STRUCT','ALGORITHM','RECONCILE','ACL','DATA_QUALITY')),

  -- ① 它守的是哪条**结构**（可为空：空 = 它自己是唯一防线，登记为债）
  guard_object     varchar(96),                      -- pg_constraint.conname 或 pg_trigger.tgname
  guard_schema     varchar(32),                      -- ★ schema 必须显式，判据不得依赖 search_path
  guard_table      varchar(64),
  guard_kind       varchar(8) CHECK (guard_kind IN ('CONSTRAINT','TRIGGER','INDEX')),
  guard_debt_owner varchar(64),                      -- guard_object 为空时必填：谁负责把它转成结构
  guard_debt_due   date,

  -- ② 它自己怎么跑
  runner           varchar(96)  NOT NULL,            -- ★ 函数名或视图名，须能被 to_regprocedure/to_regclass 解析
  assertion_sql    text         NOT NULL,            -- 期望：空集（反查写法，不是正向相等）
  mechanism_id     bigint,                           -- 复用既有机制表，**不新开一层**
  enabled          boolean      NOT NULL DEFAULT true,

  -- ③ 行为判据：一对贴边夹具（见 4.5.3）
  fixture_accept   text,                             -- 边界内侧，期望被接受
  fixture_reject   text,                             -- 边界外侧，期望被拒绝
  boundary_unit    numeric(18,8),                    -- ★ 从列类型 scale 派生，不由作者写死

  -- ④ 结论状态：四态，不是二态（NOT VALID 是常态中间态，见 4.5.6）
  verdict          varchar(16) NOT NULL DEFAULT 'unknown'
                     CHECK (verdict IN ('green','yellow','red','unknown')),
  verdict_due      date,                             -- yellow 必填：承诺到期日
  verdict_owner    varchar(64),                      -- yellow 必填：承诺人
  waived_reason    varchar(500),
  waived_period    daterange,                        -- ★ 取代 waived_until（v1.10）：开闭由值承载，不靠名字约定
  waived_by        varchar(64),                      -- ★ 豁免三件套第三件：谁批的

  -- ⑤ 判据自身的时间基准与"欠账"（v1.10 新增，见下"为什么登记表要装得下没建的东西"）
  required_since   date,                             -- 这条判据"从哪起开始要求"；NULL = 未定，迁移时一次性回填
  expected_object  varchar(96),                      -- 将来要建的对象名；仅 guard_object 为空时有意义

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz,
  CONSTRAINT ck_scr_debt   CHECK (guard_object IS NOT NULL
                                  OR (guard_debt_owner IS NOT NULL AND guard_debt_due IS NOT NULL)),
  CONSTRAINT ck_scr_yellow CHECK (verdict <> 'yellow'
                                  OR (verdict_due IS NOT NULL AND verdict_owner IS NOT NULL)),
  CONSTRAINT ck_scr_guard  CHECK ((guard_object IS NULL) = (guard_kind IS NULL)),
  CONSTRAINT ck_scr_waive CHECK (num_nonnulls(waived_reason, waived_period, waived_by) IN (0, 3)),
  CONSTRAINT ck_scr_waive_period CHECK (waived_period IS NULL OR NOT isempty(waived_period)),
  CONSTRAINT ck_scr_waive_sod CHECK (waived_by IS NULL OR verdict_owner IS NULL
                                     OR waived_by <> verdict_owner)
);

-- ★ 每次跑的结论单独一行：exercised 由它派生，不新增列（见 4.5.2）
CREATE TABLE sys_check_run (
  id            bigint PRIMARY KEY,
  check_code    varchar(32) NOT NULL REFERENCES sys_check_registry(check_code),
  run_at        timestamptz NOT NULL DEFAULT clock_timestamp(),   -- ★ 判定型时间戳（见 4.5.5）
  outcome       varchar(16) CHECK (outcome IN ('pass','fail','error','skipped')),
  hit_count     bigint,                              -- 命中行数（fail 时 > 0）
  sample        jsonb,                               -- 前 N 条命中样例，供人判断而不是再查一次
  duration_ms   int
);
CREATE INDEX ix_scr_run_code ON sys_check_run(check_code, run_at DESC);
```

#### 豁免三件套，以及为什么"是否被豁免"不落列

原来的 `waived_reason + waived_until` 是两件套，缺两处：

**① 缺审批人。** `02g` §I16.2 给 `excluded` 的三件套是"理由 + **审批人** + 到期日"，这张表只有前后两件。而它是 `guards` 四档的**唯一数据源**——一个人填两行字，一条巡检就从"防线还在"变成"不在此表统计范围内"，**不需要任何人同意**。这比 `excluded` 更安静：`excluded` 豁免的是一条判据的**当前结论**（判据还在跑），`waive` 豁免的是**登记表里的一行**（分母直接少一条）。

**② `waived_until` 全仓没有任何消费者。** 同表的 `verdict_due` 有定义、有 CHECK、**还有一条过期扫描**；`waived_until` 只有前两样。所以"到期自动恢复"这件事，对 `verdict` 有人执行，对 `waive` 没人执行。

修法**不是补一条巡检**，而是让"是否被豁免"成为派生值：

-- ★ 不能写成 VIEW：视图不能带参数。而 as_of 若换成 current_date，
--   同一个查询跨零点会给出两个答案，"上个月的覆盖率"永远复现不出来。
--   所以它必须是一个带参函数，不是视图。
CREATE FUNCTION fn_chk_effective(p_as_of date)
RETURNS TABLE (check_code varchar(32), verdict varchar(16), effective_verdict varchar(16))
LANGUAGE sql STABLE AS $$
  SELECT r.check_code, r.verdict,
         CASE WHEN r.waived_period @> p_as_of THEN 'waived' ELSE r.verdict END
    FROM sys_check_registry r
$$;

-- 命名说明：**不叫 v_check_active**。本仓有一份"曾经写过但实际不存在"的对象清单，
-- 同名复活会让"这个名字不存在"与"这个对象在这里"同时成立，
-- 而判断哪条为真的唯一依据是日期或行号——两者都不是可引用的定位键。

**为什么不能靠巡检**：写成 `verdict IN ('green','red') AND waived_until < current_date` 会**永久红**——豁免过期后没有任何东西会去改那一行，而三列同生同灭，每次红都要人手工清三列才能安静。**一条每次都必须人肉消除的红，最后是被关掉。** 派生之后，到期由时间自己完成：不需要写者，不需要人，不需要巡检。

**为什么 `daterange` 取代 `waived_until`**：§3.0b 明写 `effective_to` 是**右开**（"失效的第一天"），而 `until` 这个名字读起来是**右闭**。同一个库里两个词两种开闭，危险方向是**"按 `until` 的记忆去写 `to` → 权限晚一天失效"**。换成 `daterange` 之后，开闭是**值**（`'[)'`），不是一个要记住的约定。

**为什么 `ck_scr_waive` 必须用 `num_nonnulls`，不能"照抄两列写法再加一列"**：两列时可以写 `(a IS NULL) = (b IS NULL)`；三列若顺着写成 `(a = b) = c`，通过集合变成「全空」∪「恰好一个非空」——**全满反而不通过，恰好一个被放行**。而改完的 DDL 与原来长得**一模一样**，这正是它危险的地方。

**为什么 `waived_by <> verdict_owner`**：`verdict_owner` 是"我承诺修"的人，`waived_by` 是"我批准先别修"的人。**同一个人填这两格，等于自己给自己发豁免**，而每一行记录都合规。这条与"申请人 ∩ 审批人 = ∅"同源，但更隐蔽：它发生在同一张表的两列之间，不在两个人之间。

#### `required_since` 与 `basis_start_at` 是两个量，不许共用一列

`required_since` 是**这条判据"从哪起开始要求"**；`03` 的 `basis_start_at` 是**"这份数据从哪起有信息"**。两者性质相反：

| | 回答什么 | 装的是 |
|---|---|---|
| `basis_start_at` | 我从哪起**有**信息 | 事实 |
| `required_since` | 我从哪起**该**有信息 | 标准 |

**共用一列的话，日后把判据做严，会让过去那段时间看起来当时就在违规**——改进检查的动作会追溯性地制造一批从未发生过的历史问题，而处置成本记在业务方头上，他还会以为是数据脏了。

配套两条：

1. **`required_since` 一旦写入不得修改**，修订只能新增一行（或改判据编号）。否则"当年就在违规"可以被一次 `UPDATE` 造出来。
2. 迁移时一次性回填为"该判据首次登记的时刻"，之后 `required_since IS NULL` 的数量必须为 **0**——否则等于每条判据都默认"从今天起才开始要求"，而这句话对已有判据是假的。

它与"制度上界按赋值时点冻结"是同一句的两面：

| 动作 | 追溯后果 | 解药 |
|---|---|---|
| 放宽政策（`max_age_days` 变大） | 历史例外被**赦免** | `sys_exception_kind.kind_valid_from` |
| 收紧检查（新判据生效） | 历史数据被**定罪** | `required_since` |

**同一句解药：把"标准的生效时点"变成列。**

#### `expected_object`：登记表必须装得下"还没建的东西"

`guard_kind` 只有 `CONSTRAINT` / `TRIGGER` / `INDEX`，而 `guard_object` 的语义被注释锁死为"**已有的**结构"。所以一张**还没建的表**填不进去，而 `ck_scr_guard` 又强制 `guard_object` 与 `guard_kind` 同生同灭。

**处置不是给 `guard_kind` 加第四个值 `'TABLE'`。** 理由两条：

1. **加值正是我们在 `sys_resolution` 上刚否掉的形态**——`CHECK (x IN (...))` 是值域的拷贝，加值时改一处漏一处。
2. **"还没建"在这张表里已经有位置**：`ck_scr_debt` 的 `guard_object IS NULL` 分支，本来就要求 `guard_debt_owner` + `guard_debt_due`。七行待建对象天然落在那一支，**不需要新枚举、不需要维度表**。

只加一列 `expected_object` 记"将来要建什么"，**且不配 `expected_kind`**——类型由解析器给（依次试 `to_regclass` / `pg_constraint` / `pg_trigger` / 索引），这样不产生第二处枚举，还能把 `guard_kind` 从**作者声明**变成**解析输出**：

```sql
-- guard_kind 应等于解析结果，不等即红
-- 比 FK 强：FK 只挡拼写，挡不住"我声明 TRIGGER、实际那是个 CONSTRAINT"
SELECT check_code FROM sys_check_registry
 WHERE guard_object IS NOT NULL
   AND guard_kind <> fn_resolve_object(guard_schema, guard_table, guard_object);
```

> **"可解析的值不要存"**——这是"能派生的不存"在分类维度上的同一句话。但要注意它的适用面：`guard_kind` 可以从对象解析，所以不建维度表；`expiry_action`（政策选择）解析不出来，所以必须建值域表；`perm.dimension`（业务定义）也解析不出来，所以用 FK。**三者处置不同，不能互换。**

### 4.5.2 `exercised`：一个不新增列的派生量

```
enabled 但从未 exercised 的 check 数量     ← 必须单独报一个数，不能并入"全部 pass"
```

**理由不是洁癖**：`enabled = true` + `outcome` 全为 `pass` 与"这条检查从来没有跑过"在状态字段上可以**完全一样**（前者是"跑过且绿"，后者是没有任何 `sys_check_run` 行）。把后者算进"绿"里，报表显示的通过率会在**第一次部署就达到 100%**，而那时一条检查都还没运行过。

```sql
-- 执行覆盖面（分母是 enabled 的检查数，不是全部检查数）
CREATE VIEW v_chk_check_coverage AS
SELECT r.check_code, r.domain, r.kind,
       last_run.run_at,
       COALESCE(last_run.outcome, 'never_run') AS last_outcome,
       (r.waived_period @> current_date)       AS waived,   -- ★ 派生，不读列
       EXISTS (SELECT 1 FROM sys_check_run x
                WHERE x.check_code = r.check_code AND x.outcome IS NOT NULL) AS exercised
FROM sys_check_registry r
LEFT JOIN LATERAL (
  SELECT run_at, outcome FROM sys_check_run c
   WHERE c.check_code = r.check_code ORDER BY run_at DESC LIMIT 1
) last_run ON true
WHERE r.enabled;

-- 四行必须分开显示，不许合成一个百分比：
--   ① enabled 且 exercised 且最新为 pass
--   ② enabled 且 exercised 且最新为 fail / error
--   ③ enabled 但 never_run            ← 单独一行，红色
--   ④ enabled 且 waived               ← ★ 单独一行，带 waive 率；**分母仍是 enabled 全量**
```

**为什么 `waived` 必须是第四行、且不能从三行里"排除"**：被 waive 的检查原来是**从三行里消失**的，于是**每豁免一条，通过率涨一格**，而没有人会因为通过率上涨去查。按分母规则，"做全了吗"的分母必须是 `enabled` 全量，`waived` 单独成行并报出比率——**不能靠排除**。这条与 §4.5.2 的 `exercised` 同源：都是"把不该算进分子的东西挪到单独一行"，而不是让它消失。

**`exercised` 用 `outcome IS NOT NULL` 判、不用"有没有行"判**：`skipped` 是一个**已运行但未得出结论**的 outcome。用"有行即算跑过"会把 `skipped` 计成跑过，于是"每天都因前置条件不满足而 skip"的检查永远显示为"已覆盖"。

### 4.5.3 `guards` 四档：判据是**行为**，不是文本

`guards` 问的是：**"这条巡检在替哪条结构做第二道防线，那条结构还在不在。"** 四种状态，**四档不是三档**：

| `guards` 状态 | 含义 | 处置 |
|---|---|---|
| 指向存在的对象 **且 `fixture_reject` 仍被拒** | 它是**第二道**（结构是第一道） | 正常（绿） |
| **为空** | **它是唯一防线** | 不是"无需声明"，是**登记为债**（`guard_debt_owner` + `guard_debt_due` 必填），必须有"转结构"或"移除"的计划 |
| **指向不存在的对象** | **防线已被拆，而巡检还在假装守它** | **`fail`**，不是 `not_applicable` |
| **对象在，但 `fixture_reject` 不再被拒** | **防线还在，已不是当初守的那条** | **`fail`** |

**这四档里，视图只能报前两档和第三档，第四档做不到——必须说清，否则会有人以为视图覆盖了四档：**

```sql
CREATE VIEW v_chk_guard_unbacked AS
SELECT r.check_code, r.domain, r.guard_schema, r.guard_table, r.guard_object, r.guard_kind,
       r.guard_debt_owner, r.guard_debt_due, r.expected_object,
       CASE
         WHEN r.guard_object IS NULL                          THEN 'debt'          -- 第二档：唯一防线
         WHEN to_regclass(format('%I.%I', r.guard_schema, r.guard_table)) IS NULL
                                                              THEN 'guard_table_missing'
         WHEN r.guard_kind = 'CONSTRAINT' AND NOT EXISTS (
                SELECT 1 FROM pg_constraint c
                 WHERE c.conname = r.guard_object
                   AND c.conrelid = to_regclass(format('%I.%I', r.guard_schema, r.guard_table)))
                                                              THEN 'guard_missing'  -- 第三档：fail
         WHEN r.guard_kind = 'TRIGGER' AND NOT EXISTS (
                SELECT 1 FROM pg_trigger t
                 WHERE t.tgname = r.guard_object
                   AND t.tgrelid = to_regclass(format('%I.%I', r.guard_schema, r.guard_table)))
                                                              THEN 'guard_missing'
         WHEN r.guard_kind = 'INDEX' AND NOT EXISTS (
                SELECT 1 FROM pg_class i JOIN pg_namespace n ON n.oid = i.relnamespace
                 WHERE i.relname = r.guard_object AND n.nspname = r.guard_schema
                   AND i.relkind IN ('i','I'))
                                                              THEN 'guard_missing'
         ELSE 'ok'
       END AS guard_state
  FROM sys_check_registry r
 WHERE r.enabled;
```

| 档 | 视图能不能报 | 为什么 |
|---|---|---|
| 一（正常） | 能（`ok`） | 只查对象在不在 |
| 二（为空 = 唯一防线） | 能（`debt`） | 读列 |
| 三（对象被拆） | **能（`guard_missing`）→ fail** | 查目录即可 |
| **四（对象在但不再挡）** | **不能** | **要真跑一次 `fixture_reject`，视图做不到** |

**第四档只能由 runner 在事务里试插一条、回滚、把结论写进 `sys_check_run`。** 这是视图的能力边界，不是遗漏——**但边界必须写出来**，否则"`v_chk_guard_unbacked` 返回零行"会被读成"四档全过"，而它实际只证明了前两档。

配套约束（`03` 的 `expected_object` 就是为这条加的）：`guard_object` 为空且 `expected_object` 也为空的登记行，**既不是"有防线"也不是"欠一个具体对象"**，必须由 `ck_scr_debt` 要求 owner + due 兜住——否则它会以 `debt` 混在第二档里，看起来"已登记"，而没人知道要建什么。

#### 第四档的判据必须是行为——这一版我写错过，记在这里

第一版我用 `definition_hash` 比目录（`pg_get_constraintdef()` 的摘要）。**驳回理由三条**：

1. 那个输出**跨 PG 小版本会变**（多列 `CHECK` 的回显里"带不带 `COALESCE`、表达式展不展开、括号怎么加"都随版本变）→ 每次小版本升级一堆 `guards` 判"定义变了"；
2. 它由**运维动作**（升级）触发，跟"有没有人动过约束"**无关**——报警与事件不相关；
3. 报警一旦不可信，唯一结局是**被整条关掉**。

**正确形态**：把"这条结构挡什么"写成夹具（一条**必须被拒**的 `INSERT`），跑一次看它被不被拒。**语义输入是行为，不是文本。**

```sql
-- 第四档的判据（一次事务内：先试 INSERT，再回滚）
BEGIN;
  INSERT INTO attendance_daily_store (...) VALUES (...);   -- fixture_reject 的字面内容
  -- 若到这里，说明它没被拒 → guards 第四档 fail
ROLLBACK;
```

> **`definition_hash` 降级为"复核提示"，不进 `fail`。** 有人改了定义时提示人看一眼，仅此而已。**判据必须落在"还挡不挡得住"，不能落在"长得一样不一样"。**

**并且提示本身也要从"定期比目录"改成"事件驱动"**——这是本轮的第二处修正：

| 形态 | 触发者 | 问题 |
|---|---|---|
| ~~每夜跑一遍，比对 `md5(pg_get_constraintdef())`~~ | **运维动作**（升级、重启） | 报警与"有没有人动过约束"不相关；一次小版本升级产生几十条假提示 |
| **DDL 事件触发器**（`ddl_command_end`） | **人的动作**（谁执行了 `ALTER`/`DROP`） | 只在真有人改结构时提示，且 DDL 文本与执行者一起落库 |

```sql
-- 复核队列：有人动过受 guards 保护的对象时，落一行（不阻断，只提示人看）
CREATE EVENT TRIGGER etg_guard_ddl_review ON ddl_command_end
  WHEN TAG IN ('ALTER TABLE','DROP TABLE','CREATE INDEX','ALTER INDEX','CREATE TRIGGER')
  EXECUTE FUNCTION fn_guard_ddl_review();
-- fn_guard_ddl_review() 内：读 pg_event_trigger_ddl_commands()，
-- 与 sys_check_registry.guard_object 比对，命中即 INSERT sys_check_run(outcome='skipped', sample=ddl_text)
```

**"事件驱动"比"定期比对"强的地方不是频率，是归因**：定期比对只知道"变了"，事件驱动知道"**谁在什么时候用什么 DDL 改的**"。而定期比对的每一次假提示，都在消耗这个报警的可信度。

#### 但行为判据有一个致命前提：fixture 必须**贴边**

```sql
-- 原：span_hours <= 24     改：span_hours <= 48
-- fixture: span_hours = 100  → 改动前后都被拒绝 → "行为验证通过" → 绿
```

**放宽一倍，判据完全失明。** 而人挑 fixture 时**天然挑"明显违规的那个"**——因为那样一定被拒绝、一定不假红。所以"反正验过了"这句话在 fixture 不贴边时是假的。

**要求：每个 `guards` 项配一对贴边夹具。**

| 夹具 | 位置 | 期望 | 抓什么 |
|---|---|---|---|
| `fixture_accept` | 边界**内侧**，距离一个最小计量单位 | **接受** | 有人把约束**收紧**了（收紧会让正常数据进不来） |
| `fixture_reject` | 边界**外侧**，距离一个最小计量单位 | **拒绝** | 有人把约束**放宽**了 |

- 距离取**一个最小计量单位**，且该单位**从列类型的 scale 派生**（`numeric(8,2)` → `0.01`，从 `information_schema.columns.numeric_scale` 读），**不能由作者写死**——写死就变成另一个会漂的常量。
- **只有 `fixture_reject` 是不够的**：它只抓放宽。收紧到"所有数据都进不来"时，`fixture_reject` 依然绿，而系统已经用不了了。

> **行为判据的灵敏度，等于 fixture 到边界的距离。距离由人挑，验证强度就由人挑——而人会挑一个不会失败的距离。**

#### 两个"被静默关闭"状态，也是 `guards` 的一部分

```sql
-- 对象在、定义正常，但已不执行（DISABLE / session_replication_role = replica 也会绕过）
SELECT tgname FROM pg_trigger WHERE tgenabled NOT IN ('O','A');
-- 约束在，但从未验证过存量（对已有行完全不生效）
SELECT conname, conrelid::regclass FROM pg_constraint WHERE convalidated IS NOT TRUE;
```

**第一类最危险**：`tgenabled='D'` 的触发器在 `pg_trigger` 里**有行、有定义、`pg_get_triggerdef()` 输出完全正常**——任何"查一下触发器在不在"的检查都判绿，而它一次都不会执行。**"它在"与"它在跑"是两件事**，这正是 `guards` 四档要区分的东西。

> **上面这两句扫不到事件触发器。** 事件触发器在 `pg_event_trigger`，列叫 `evtenabled`，取值四档（`O`/`D`/`R`/`A`），**不是 `pg_trigger` 的 `tgenabled`**。所以本节这条扫描必须补第三句（§8.2c 第四节给了完整 SQL 与"为什么 `'R'` 也算关着"）：
>
> ```sql
> SELECT evtname, evtevent, evtenabled FROM pg_event_trigger WHERE evtenabled NOT IN ('O','A');
> ```
>
> **这是同一类错误的第三次出现**：判据写在了一张"看起来装着它"的表上。前两次是 `pg_default_acl` 里"没有配置"表现为无行（§8.2b）、`pg_class.oid` 不是创建时间（§8.2d 第四节）。**病根不是漏了一句 SQL，是"这张表里有没有我要的东西"这件事没人核对过。**

### 4.5.4 命名统一：`ALG-*` ↔ `f_alg_*` 一一对应

```
sys_check_registry.check_code = 'ALG-07'   ⟺   runner = 'f_alg_07'
```

三条硬规则：

1. **一个编号只对应一个函数**。一个函数实现多条断言时，红了不知道是哪条；一条断言散在两个函数时，删掉一个还剩半个绿。
2. **编号不重用**。断言作废时 `enabled = false` + 留行，**不删行、不回收编号**（与 §3.3.8 的 `C` 编号退役登记同理）。
3. **映射必须机检**：CI 遍历 `sys_check_registry.runner`，逐个 `to_regprocedure('public.' || runner || '(...)')` / `to_regclass('public.' || runner)`，**取不到即失败**。这就是"清单不可能比实现长"的实现方式。

`SECURITY DEFINER` 的算法函数必须固定空 `search_path`：

```sql
CREATE FUNCTION f_alg_07(p_from date, p_to date) RETURNS TABLE(...)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''          -- 空，不是 pg_catalog, public（public 可写、可被劫持）
AS $$ ... $$;
```

**空 `search_path` 的价值不是"指向正确的 schema"，而是"让忘记写限定名变成运行时错误"**——从"解析到错误对象"降级为"直接失败"。`pg_catalog` 有隐式搜索路径，`now()` / `count()` / `to_regtype()` 在空路径下照样解析。

**但 `proconfig` 只能证明"声明了"**：

```sql
-- 声明查一遍
SELECT proname, proconfig FROM pg_proc WHERE proconfig IS NULL AND prosecdef;
-- ★ 再扫函数体：声明可被 SET LOCAL search_path / SET ROLE / set_config 覆盖（合法写法）
SELECT proname FROM pg_proc WHERE prosrc ~* '\m(SET\s+(LOCAL\s+)?(search_path|ROLE)|set_config)\M';
```

**两件一起做，缺一件就会被"声明了"骗过去**——这是"能证有、不能证只有"的又一例。

### 4.5.5 `now()` 与 `clock_timestamp()`：记录型时间戳 vs 判定型时间戳

**`now()` 是 `transaction_timestamp()` 的别名**——它返回的是**事务开始**那一刻，不是"现在"。写 `now()` 的人以为在写"现在"，实际写的是"这个事务什么时候开始的"。

| 用途 | 用什么 | 为什么 |
|---|---|---|
| **记录型**（审计行 `created_at`、单据 `submitted_at`） | `now()` / `DEFAULT now()` | **同一事务内所有行必须时间一致**，否则一次批量导入会得到 1 万行各自不同的时间，事后无法按批次归组 |
| **判定型**（"现在是否已超期""距上次运行多久""锁已持有多久"） | **`clock_timestamp()`** | 必须取**真实时钟**，且同一语句/事务内每次调用都应变化 |

**判定型用 `now()` 的后果是双向的，两头都错**：

- 一条在长事务（批量算薪、大导入、`pg_dump` 快照读）里执行的治理检查，用 `now()` 判"是否超期"，会在**跨过阈值的长事务里永远不翻红**——因为"现在"被冻结在事务开始那一刻；
- 反过来，一条在事务开头读数据、事务末尾下结论的检查，用 `now()` 会让"检查时刻"与"数据快照时刻"无法区分，于是**三分钟前已经修好的问题被报成红**。

```sql
-- ✅ 治理检查
CREATE FUNCTION f_alg_12() RETURNS TABLE(...) LANGUAGE sql STABLE AS $$
  SELECT ... FROM sys_check_registry r
   WHERE r.verdict = 'yellow' AND r.verdict_due < clock_timestamp()::date;
$$;
-- ❌ now()::date 在长事务里不前进
```

`sys_check_run.run_at DEFAULT clock_timestamp()` 也是同理：它是**判定时刻**，不是"这一批记录属于哪个事务"。

### 4.5.6 结论状态是**四态**，`yellow` 必须有期限

本册大量使用 `CHECK … NOT VALID → 清存量 → VALIDATE`（§9.5 离线升级），这意味着**"有约束但未生效"是常态中间态**。

```
没有约束                        红
有但未生效（NOT VALID）
    到期前                      黄（在办）
    到期后                      红（逾期）
有且已生效                      绿
```

把它一律判红，存量清理那几周会全红；而**持续超过人耐心的红等价于绿，且更坏——它教会人跳过红色**。

**黄的三个条件，缺一个它就变成永久黄**：

1. 每一行"未生效"必须带**承诺日期 + 承诺人**（`ck_scr_yellow` 已强制）；
2. 该日期受**制度上界**约束（否则自己定一个很远的日期就等于没有期限）；
3. **逾期报"最老一条的天数"，不报平均数**——平均数会被大量新条目稀释：清理推进快的时候新条目多、平均逾期反而下降，而最老那条可能已经 200 天没人动。

> 第 3 条与 §7.4「分母三类人分开」是同一条：**平均是最容易被"做别的事"改善的统计量。**

### 4.5.7 数值四态：`unknown_conflict` 不能并入 `unknown`

参与比较的数值必须是四态，不是三态：

```
known             有唯一值
unknown           不知道
unknown_conflict  知道两个不同的值（两个来源打架）
not_applicable    该量不存在（可以是 0）
```

**`unknown_conflict` 若归入 `unknown`，比较实现会 pick 一个**（通常是先读到的那个）——**冲突消失，剩下的值看起来完全正常**。它比 `unknown` 危险，因为 `unknown` 至少不参与比较。

落法必须在**字段层**，不能靠渲染约定（报表组件默认把 `NULL` 渲成空白或 0）：

```sql
-- 每张测值表上的形态（不是新表，是两列 + 一条 CHECK）
measure_status varchar(20) NOT NULL
  CHECK (measure_status IN ('known','unknown','unknown_conflict','not_applicable')),
measure_value  numeric(18,4),
CONSTRAINT ck_measure_value CHECK ((measure_status = 'known') = (measure_value IS NOT NULL))
```

`not_applicable` 可渲染为 0（"0 个此类员工"），`unknown` / `unknown_conflict` **不可**。

### 4.5.8 要回答「当时是多少」，就存结果，不要存重放

冻结口径的常见做法是记 `query_hash` + `source_data_version`。后者是**弱标识**（同一天内数据被改，版本不变），而"输入可重放"在多写路径下基本做不到。

```sql
CREATE TABLE decision_measurement (
  id               bigint PRIMARY KEY,
  query_hash       char(64) NOT NULL,          -- 绑定 SQL 文本
  result_hash      char(64) NOT NULL,          -- ★ 绑定结果：唯一能证明"这份结果由这段 SQL 产生"
  result_rows      jsonb    NOT NULL,          -- ★ 存结果本身
  result_row_count int      NOT NULL,
  executed_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  due_at           date,                        -- 未跑的测量必须有到期日
  CONSTRAINT ck_dm_rowcount CHECK (result_row_count = jsonb_array_length(result_rows))
);
```

两个问题必须分开：

```
"当时是多少"      →  存结果，直接读
"改口径会怎样"    →  才需要重放
```

配套：`decision_record.measurement_id NOT NULL` —— 于是"没冻结"= **决策记录建不出来**，而不是"有人忘了"。

**未跑的测量必须带 `due_at`**：在"未知"与"未跑"两种坏状态里，**"未跑"看起来更接近解决，因此更不会被催**。

### 4.5.9 五源扫描：业务规则藏在 DDL 里的五个地方

**判据：这段 DDL 文本里出现了"无法从表结构推出的常量或条件"，有则必须登记语义与审批人。**

| 源 | 常藏什么 |
|---|---|
| `pg_indexes.indexdef` | 表达式索引、部分索引的 `WHERE` |
| **`pg_attrdef`** | 生成列、`DEFAULT`——**哨兵值最常藏这里**（`offset_minutes = 0`、`DEFAULT 8` 这种隐含工时） |
| `pg_get_constraintdef()` | `CHECK` 里的业务阈值 |
| `pg_views.definition` | 视图里的过滤条件（等价于一条没人管的业务规则） |
| `pg_proc.prosrc` | 函数体里的分支 |

**为什么单列这一条**：`offset_minutes = 0` 这类哨兵、`DEFAULT 8` 这类隐含工时，**在表结构上完全看不到，而在行为上完全生效**。它们不在一份"配置清单"里，所以在**任何以清单为基础的评审里都不会被问到**。

#### `pg_get_constraintdef()` 有两个用途，必须分开——这是本轮最容易混的一处

| 用途 | 判据形态 | 允许人工确认吗 | 为什么 |
|---|---|---|---|
| **进升级指纹**（§9.5） | 升级前后**逐项比对** | **允许**（升级本来就要改，人看 diff 确认） | 要的是"相对上一版变没变"，需要**稳定基线** |
| **进 `guards` 第四档** | ❌ **禁止** | 不允许（`fail` 就是 `fail`） | 要的是"还挡不挡得住"，需要**行为** |

同一段文本，两个用途，两种判据。**把指纹用的稳定基线拿去当 guards 的判据，会让每次 PG 小版本升级报一片假红；把 guards 的行为判据拿去当指纹，会让"这条约束的定义被改了什么"永远看不见。**

所以：`pg_get_constraintdef()` **是模型的组成部分，必须入指纹**（连同 `pg_indexes.indexdef` / `pg_attrdef` / `pg_views.definition` / `pg_proc.prosrc` / `pg_trigger.tgdef` 一起算 `schema_fingerprint`），**但不得作为 `guards` 的 `pass/fail` 依据**。

### 4.5.10 「谁改的」不可审计：一条必须如实写出的能力边界

多处 PRD 写"审计留痕：操作人"，读者会理解成"能证明是谁改的"。**证明不了。**

| 层 | 能给出 | 不能给出 |
|---|---|---|
| **DB 内部**（`pgaudit` / 触发器 / `txid`） | 什么连接、什么时刻、对哪一行、改了什么 | **是哪个自然人**。它只知道数据库用户 |
| **应用层**（`operator` 字段 / 应用日志） | 声称是谁 | **任何保证**——由应用自己写入，可被改、可被伪造 |

**关键事实：凡"操作人"能落到数据库里的，都是应用层自证的。** 应用通常共用一个 DB 用户（否则连接池管理不了），所以数据库能审计到的"人"根本不等于自然人。

**定稿：两栏分列，永不合并**

```
operator_claimed   应用写入，谁声称的       —— 可展示、可追流程，不可用于追责
operator_verified  由认证上下文派生（token sub + 签名校验），不可由应用随手覆写
```

- 两栏**都要存**：绝大多数场景 `claimed` 就够用（内部流程、绩效沟通）；
- **凡涉及金额、劳动关系、封账、权限变更的追责，只认 `verified`**；
- **`claimed` 为空不是"空着"，是 `fail`**——自证字段一旦允许空，等于允许"无人声称"，而它本来唯一的用途就是被填。

**审计目标要重新定义：从"哪个人"退到"哪次变更"**——`txid` / 审批实例 + 签字人 / `server instance` + 会话。**补偿控制不是"更好的操作人字段"，是"这次变更有批准凭据"**——签字人是在**审批那一刻**被认证的，不依赖事后填的字段。

餐饮门店共用一台收银机、一个班次账号是常态，所以"操作人"在本行业**天然不可靠**。写清不是自曝其短——**是不写清之后，第一次劳动争议里我们会拿一个证明不了的东西去举证。**

### 4.5.11 证据五档：「不需要人」强于「需要两个人」，但强的是五档不是两档

**流程控制不能替代证据可重算，顺序不能反。** 四眼原则只能约束到**账号级**：一人两账号、代填、角色兼任都绕得过去，而**流程控制在没人看的时候等于没有**。

所以顺序是：**先要求证据能独立重算，再谈谁填。** 反过来做（先上四眼 + 证据随手填）会得到最坏的组合——**一个有人签字的、不可验证的结论，比无人签字的更难推翻。**

```
① 结构保证            不成立就写不进去
② 不同算法可重算      两条独立来路，能对撞
③ 同算法可重算        只防手误，不防算错
④ 双人签字            有名字，无内容
⑤ 单人声明
```

**②与③之间的线，判据不是"整体是不是两套代码"，而是分歧点落在哪一段**：两条来路必须在**含分支 / 含舍入 / 含边界判断**的那三段上不同源。共享取数与过滤不扣分；共享那三段里的任何一段，就只能算 ③——否则会出现"两条独立实现"的招牌下核心口径是同一个函数。

**反向配置：越"好"的结论，要求越多证据**

| 结论 | 证据要求 |
|---|---|
| `resolved` | **必须可验证**：当前集合里确实没有它，且 `recorded_version == current` |
| `excluded` | 必须有豁免记录（理由 + 审批人 + 到期日） |
| `unknown` | **不需要证据** |

于是填 `resolved` 比填 `unknown` 费事，而 `unknown` 是真话、且会触发复盘。**`unknown` 的比例才有指标价值**——否则它测的只是"有多少人愿意写不好看的答案"。

### 4.5.12 本节新增表与视图

| 项 | 变化 |
|---|---|
| 新增表 **3 张** | `sys_check_registry` / `sys_check_run` / `decision_measurement` |
| 新增视图 **3 个** | `v_chk_check_coverage`（含 `exercised`）/ `v_chk_guard_unbacked`（`guards` 三、四档）/ `v_chk_range_fake_unbounded` |
| 表总数 | 本节 +3 → 在 §6.0.12.1 的 **108**（= 103 + 审批引擎三张）之上到 **111**；`sys_perm_dim` +1 → 112；`sys_data_classification`（§8.2d）+1 → **113** |

---

# §5 MCP 开放层（核心差异点）

## 5.1 传输方式：两种入口，一个网关（ADR A1 / A2）

```
┌────────────────────────────────┐     ┌────────────────────────────────────────┐
│ AI 客户端（同机）                │     │ AI 客户端（内网其他主机，须显式开启）      │
│ 拉起 stdio 子进程                │     │ HTTP 直连                              │
└───────────┬────────────────────┘     └──────────────┬─────────────────────────┘
            │ stdio (JSON-RPC)                        │ POST /mcp  (Streamable HTTP)
            ▼                                        │ GET  /mcp/sse (兼容)
┌────────────────────────────────┐                  │
│ hr-mcp-stdio-bridge            │──HTTP 127.0.0.1──┤
│ (native image, 启动 <100ms)     │                  │
│ 只做 JSON-RPC 字节流转发          │                  │
│ 无工具定义、无权限判断            │                  ▼
└────────────────────────────────┘     ┌────────────────────────────────────────┐
                                        │ Nginx（TLS；MCP 端口按需反代）           │
                                        └──────────────┬─────────────────────────┘
                                                       ▼
     ┌─────────────────────────────────────────────────────────────────────────┐
     │ hr-mcp-gateway（独立容器，1C1G 起；默认监听 127.0.0.1）                    │
     │  McpAdapter   JSON-RPC 解析 / 会话 / 传输错误映射                         │
     │  ToolRegistry 工具注册表（schema 由 record 自动生成）                     │
     │  ScopeMapper  (client_id, user_id, scope) → 三轴权限                     │
     │  PlanStore    两阶段写：dry-run → plan → execute                         │
     │  ConfirmGate  超阈值 elicitation / 转 Web                                │
     │  QuotaGuard   客户端 60/min 令牌桶 + 熔断                                │
     │  CallAuditor  写 mcp_call_log（含 affected_row_ids）                     │
     │  —— 无业务规则、无 SQL ——                                                │
     └──────────────────────────────────┬──────────────────────────────────────┘
                                        │ 内部 HTTP（/internal/v1/*，服务间 token，
                                        │ 只监听回环/内网，不暴露给浏览器）
                                        ▼
     ┌─────────────────────────────────────────────────────────────────────────┐
     │ 主应用（业务规则唯一居所）：Application → Domain → Persistence             │
     └─────────────────────────────────────────────────────────────────────────┘
```

| 要点 | 说明 |
|---|---|
| 为什么拆网关（A2） | MCP 客户端的长连接（SSE / Streamable HTTP keep-alive）生命周期以分钟计。若与业务同进程，长连接会占满线程/连接预算，**打卡高峰时把业务拖死**。拆出去后多一个 1C1G 容器，成本可忽略，风险隔离彻底 |
| 网关里不写业务 | 网关只做"协议 + 治理"，工具实现是薄壳，直接 HTTP 调主应用 `ApplicationService`。因此**换网关实现不影响业务口径**，仍满足"同源同权"（01 §8.1） |
| 默认只听 127.0.0.1（A1） | 同机 AI 客户端零配置可用（stdio 桥与 HTTP 都指向本地）。要开内网监听必须显式配置 `mcp.listen-address=0.0.0.0`，启动日志 + 自检页红字提示 + 写审计。**默认不对外是安全基线，不是建议** |
| stdio 为何不直接嵌业务 | stdio 子进程由 AI 客户端拉起，不能让它拉起整个服务；桥是 ~5MB native 可执行文件，只转发字节流，**不含任何工具定义与权限逻辑**，因此不构成"第二份实现" |
| stdio 凭证 | 用户在 Web 端点「为本地 AI 授权」→ 生成 `client_token`（30 天，可吊销）写入 `~/.hr-platform/mcp.json`（权限 `0600`），含 `endpoint` + `token` + `refresh_token`。桥读该文件注入 `Authorization` 头 |
| 会话 | Streamable HTTP 支持 `Mcp-Session-Id`；stdio 桥为该子进程维持一个 session，进程退出即失效；空闲 300s 断开 |
| 超时（A2 代价） | 读 10s / 写 **30s** / 批处理 60s 内必须返回 `jobId`。写超时后客户端可带同一 `idempotency_key` 重试（A5 保证不双写） |
| 批处理必须异步 | **批量排班、批量算薪、大批导入、报表导出不得走同步 MCP**。这类工具第一次调用只做参数校验 + 提交作业，立即返回 `jobId`，用 `gov_get_job_status` 轮询。异步化在业务层（`sys_job_instance` + Spring Batch），**不在网关层做** |
| 端口规划 | 客户防火墙只放 Nginx 443；MCP 走 `/mcp` 反代。若要内网直连，才额外开网关端口（默认不开） |

## 5.2 工具设计规范

### 5.2.1 命名规则

```
<domain>_<verb>_<object>
```

| 段 | 取值（封闭词表） |
|---|---|
| domain | `org` `employee` `contract` `cert` `schedule` `attendance` `leave` `payroll` `si` `tax` `perf` `recruit` `learn` `report` `gov` `meta` |
| verb | `list` `get` `search` `create` `update` `submit` `approve` `cancel` `assign` `publish` `run` `calc` `export` `explain` `check` `revert` `describe` |
| object | 业务对象单数名词：`tree` `unit` `profile` `board` `shift` `payslip` `allocation` `balance` |

**强制规则**
- 全小写 + 下划线，长度 ≤ 40 字符
- 名词用**业务语言**而非表名（`payslip` 而不是 `payroll_record_item`）
- 禁止缩写除公认词（`org` `emp` 不用，`employee` 写全；`ot` 允许）
- 一个工具只做一件事：**对标"一个人能做的一件事"**，不对标 REST 接口。因此不存在 `employee_crud`、不存在 `payroll_record_update`，而是 `employee_onboard` / `employee_transfer` / `employee_adjust_salary` / `employee_offboard`
- 读写成对：有 `leave_submit_request` 就有 `leave_get_balance`；不允许只有写没有读（AI 无法自查）

### 5.2.2 输入/输出 schema 风格

**输入**：扁平化，必填优先，禁止嵌套超过 2 层。

```json
{
  "employeeId": 501,            // 业务标识用 ID 或 employeeNo，二者择一必填
  "employeeNo": null,
  "workDate": "2026-11-16",
  "shiftId": 12,
  "dryRun": true,               // 写工具统一有
  "planId": null,               // 二阶段执行时填
  "idempotencyKey": "uuid-v4",  // 写工具统一必填
  "reason": "顾客预订包场"        // 影响他人/钱的写操作必填
}
```

**日期参数命名：三个日期口径必须用三个不同的参数名，禁止都用 `date`**

工时域存在三个互不等价的日期口径（§3.3.8），而 AI 最容易犯的错就是"用 `date` 一把梭"：

| 参数名 | 对应列 | 用于哪些工具 |
|---|---|---|
| `workDate` | `attendance_daily.work_date`（计薪归属日） | 排班（`schedule_*`）、考勤查询与更正（`attendance_*`）、假期扣减（`leave_*`） |
| `businessDate` | `attendance_daily_store.business_date`（成本/营业日） | 门店日报、成本分摊核对（`payroll_get_allocation` 等） |
| `naturalDate` | 合规判定用自然日（视图层） | 合规查询（`attendance_check_compliance`） |

**`report_*` 系列不受此影响，也不新增日期参数**：报表工具只接受 `metricCode` + `periodFrom`/`periodTo` + `scope`，日期口径由 `metric_definition` 承载（§3.8）——**口径写在字典里，不写在调用参数里**。这样改口径只改一处，不需要通知所有调用方（包括已经写死的 Agent）。

**输出**：统一信封，`data` 是业务数据，`summary` 是给模型读的自然语言。
```json
{
  "ok": true,
  "data": { },
  "summary": "已在 11-16 至 11-20 为 3 名员工安排早班，共 15 个班次；发现 1 处健康证即将过期（王某某，11-25 到期），已列入警告。",
  "warnings": [
    {"code": "CERT_EXPIRING_SOON", "message": "王某某健康证 11-25 到期，建议尽快安排体检", "ref": {"employmentId": 507}}
  ],
  "errors": [],
  "meta": {
    "traceId": "8f3c1a...",
    "planId": "plan_9a2b...",         // dry-run 时返回
    "requiresConfirmation": false,
    "confirmationMode": "NONE",        // NONE|ELICITATION|WEB_APPROVAL
    "affectedCount": 15,
    "pagination": {"page": 1, "size": 50, "total": 15},
    "maskedFields": ["netAmount"],
    "dataScope": "STORE_SET(1024,1025)",
    "asyncJobId": null
  }
}
```

**错误码（封闭集合，AI 可据此决定下一步）**

| code | 含义 | AI 应该怎么做 |
|---|---|---|
| `E_PERM_DENIED` | 功能权限不足 | 停止，告知用户缺什么权限 |
| `E_SCOPE_DENIED` | 数据范围不足 | 停止，说明只能看哪些范围 |
| `E_VALIDATION` | 参数不合法（含字段级 `fields`） | 修正参数重试 |
| `E_CONFLICT` | 业务冲突（班次重叠、健康证过期、期间已封账） | 读 `conflicts[]` 换方案 |
| `E_APPROVAL_REQUIRED` | 需人工审批，已生成审批单 | 告知用户去 Web 处理 |
| `E_CONFIRMATION_REQUIRED` | 需用户确认，返回 `confirmationToken` | 发起 elicitation 后带 token 重试 |
| `E_PLAN_EXPIRED` | plan 过期/已用 | 重新 dry-run |
| `E_LOCKED_PERIOD` | 期间已封账 | 改走调整单 |
| `E_RATE_LIMIT` | 超限，带 `retryAfterMs` | 退避重试 |
| `E_DEPENDENCY` | 依赖系统（设备/银行/邮件）不可用 | 告知用户稍后或改人工 |
| `E_INTERNAL` | 未预期错误（带 traceId） | 停止，报 traceId 给管理员 |

### 5.2.3 幂等性要求

| 工具类别 | 幂等要求 | 实现 |
|---|---|---|
| 读 | 天然幂等，**不要求** `idempotency_key` | —（ADR A5：读不强制，避免无谓调用噪音） |
| 办理类（请假/补卡/加班/换班） | **必须** | `idempotency_key` 唯一索引，24h 内重复返回首次结果 |
| 管理类（批量排班/算薪/调薪） | **必须** | `idempotency_key` + `scopeHash/dataVersion` 双保险 |
| 治理类（改配置/改权限/回滚） | **必须** + 版本号乐观锁 | `idempotency_key` + `version` 字段，冲突返回 `E_CONFLICT` |

**ADR A5 是硬校验，不是建议**：写工具缺 `idempotency_key` → **直接返回 `E_VALIDATION`（`fields: ["idempotencyKey"]`）**，不做任何服务端兜底生成。理由：兜底生成等于服务端替客户端"猜意图"，重试时会变成两次写入——这正是幂等键要解决的问题。同理，超时重试必须复用手工传入的同一个 key，网关不自动改写。

```sql
CREATE TABLE sys_idempotency (
  idempotency_key char(36) PRIMARY KEY,
  tool_name varchar(64) NOT NULL,
  args_digest char(64) NOT NULL,
  user_id bigint NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 每日清理 24h 前记录；args_digest 不一致时返回 E_CONFLICT（同一 key 不同参数视为客户端 bug）
```

### 5.2.4 工具文档的内置要求

每个工具必须有：`description`（一句话，含"什么时候用/什么时候不要用"）、`inputSchema`、`outputSchema`、`examples`（至少 1 正 1 反）、`scope`、`write: true/false`、`confirmation: NONE|THRESHOLD|ALWAYS`、`async: true/false`、`relatedTools`。这些由 `@McpTool` 注解一键生成，`tools/list` 返回时按调用方 scope 过滤。

**两个强制命名禁令（ADR A6）**

| 禁令 | 说明 |
|---|---|
| **不得存在 `approve_*` 类工具** | 只允许 `submit_*`（发起）与 `get_approval_status`（查看）。**「审批权不可委托给 AI」是本产品的红线，不是实现细节**——AI 若能批准，人工审批就形同虚设 |
| 工具不得接收"跳过校验 / 已批准 / 强制"类参数 | 入参 DTO 字段白名单，`approved` / `skipApproval` / `force` 一律不存在（ArchUnit 强制） |

**每个写工具必须声明自己走哪条通道**：`approval`（业务审批）/ `plan`（两阶段确认）/ `async`（异步作业），三选一，不允许"没有通道"的写工具存在。

## 5.3 工具清单（共 101 个）

> 图例：**W** = 写；**R** = 读；**确认**列：`—` 不确认 / `阈值` 影响超阈值才确认 / `必` 必须确认 / `审批` 走业务审批流 / `Web` 只能 Web 端完成（MCP 只提供前置校验）

### 5.3.1 组织域 org（10）

| # | 工具名 | 作用 | 读写 | 确认 | 说明 |
|---|---|---|---|---|---|
| 1 | `org_get_tree` | 获取组织树（可按维度/版本/深度） | R | — | 支持 `dimension=COST` 切换徽标口径 |
| 2 | `org_list_units` | 按类型/上级/标签列出组织节点 | R | — | 分页 |
| 3 | `org_get_unit` | 组织节点详情（四维配置、编制、考勤组、成本中心） | R | — | |
| 4 | `org_search_units` | 关键词/编码搜索组织节点 | R | — | 返回 path 便于定位 |
| 5 | `org_get_version_history` | 组织版本历史列表 | R | — | 历史还原入口 |
| 6 | `org_get_headcount_gap` | 编制缺口分析（按节点/区域汇总） | R | — | |
| 7 | `org_create_unit` | 新建组织节点（新店/新部门） | W | 审批 | 生成变更单，不直接落库 |
| 8 | `org_update_unit` | 修改节点属性（名称/成本中心/考勤组） | W | 必 | |
| 9 | `org_move_unit` | 调整节点层级（生成新版本） | W | 必 | 需管理员 |
| 10 | `org_set_headcount` | 设置某期间编制数 | W | 阈值 | 变动 > 10% 需确认 |

### 5.3.2 人员域 employee / contract / cert（13）

| # | 工具名 | 作用 | 读写 | 确认 | 说明 |
|---|---|---|---|---|---|
| 11 | `employee_search` | 多条件搜员工（门店/岗位/用工类型/在职状态） | R | — | 分页，默认脱敏 |
| 12 | `employee_get_profile` | 员工全景档案（任职/合同/证照/异动） | R | — | 身份证/电话掩码 |
| 13 | `employee_get_org_assignments` | 查某人的四维归属 + 汇报线 | R | — | 跨店成本争议排查必用 |
| 14 | `employee_list_probation_overdue` | 试用期超期名单 | R | — | 02 §4 监控项 |
| 15 | `employee_list_health_cert_risk` | 健康证过期/临期人员清单 | R | — | 排班阻断预警 |
| 16 | `employee_create_prehire` | 预入职建档（扫码/批量） | W | 阈值 | 单条直接建，批量需确认 |
| 17 | `employee_onboard` | 办理入职（生成任职+排班归属+合同草稿） | W | 必 | 走审批，落 `hr_change_order` |
| 18 | `employee_transfer` | 调动（跨店/跨法人/改四维归属） | W | 必 | 跨法人必须显式传 `legalEntityPayrollId` |
| 19 | `employee_adjust_salary` | 调薪（生成调薪单，不直接改工资记录） | W | 必 | 影响面 > 5 人转 Web |
| 20 | `employee_confirm_regularization` | 办理转正（写 `regularization_date`） | W | 必 | 与 `probation_end_date` 分开记 |
| 21 | `employee_offboard` | 办理离职（含末班清理、交接清单） | W | 必 | 当日结算按配置 |
| 22 | `employee_rehire` | 复职（续接工龄，年假额度按 02 §11 规则重算） | W | 必 | |
| 23 | `contract_get` | 查合同（状态/期限/续签提醒） | R | — | |

### 5.3.3 排班域 schedule（8）

| # | 工具名 | 作用 | 读写 | 确认 | 说明 |
|---|---|---|---|---|---|
| 24 | `schedule_get_shift_library` | 查班次库（集团/门店） | R | — | |
| 25 | `schedule_create_shift` | 新建门店班次 | W | 必 | |
| 26 | `schedule_get_board` | 取某店某周排班板（含在岗人数分布） | R | — | |
| 27 | `schedule_check_conflicts` | 排班冲突预检（不写库） | R | — | AI 排班前必调 |
| 28 | `schedule_batch_assign` | 批量划线排班 | W | 阈值 | > 200 单元格强制确认 |
| 29 | `schedule_swap` | 换班（发起到对方确认） | W | 审批 | |
| 30 | `schedule_publish` | 发布排班（校验最小提前量） | W | 必 | 02 §15 `schedule_notice_days` |
| 31 | `schedule_suggest_coverage` | 缺口分析 + 补人/调班建议 | R | — | 只给建议，不改数据 |

### 5.3.4 考勤域 attendance（9）

| # | 工具名 | 作用 | 读写 | 确认 | 说明 |
|---|---|---|---|---|---|
| 32 | `attendance_get_daily` | 查某人/某店某日考勤明细 | R | — | |
| 33 | `attendance_get_worktime` | 查工时事实（含双口径天数、加班三类、快照版本） | R | — | 唯一事实源口径；返回含 `confirm_status` |
| 34 | `attendance_list_exceptions` | 考勤异常清单（缺卡/迟到/旷工/超时） | R | — | |
| 35 | `attendance_add_punch_record` | 补录/修正打卡（仅管理员） | W | 必 | 强审计；**不改 `attendance_punch`（append-only）**，而是追加一条带 `MANUAL` 标记的流水再触发重算 |
| 36 | `attendance_fix_card` | 补卡申请（走审批） | W | 审批 | |
| 37 | `attendance_submit_ot` | 加班申请/事后认定 | W | 审批 | 按 `ot_type` 三分列 |
| 38 | `attendance_confirm_worktime` | 门店确认工时（店长日结/周结动作） | W | 阈值 | 确认后进入 `CONFIRMED` |
| 39 | `attendance_check_close_readiness` | 封账前检查（未确认/未处理异常） | R | — | 只检查不封账 |
| 40 | `attendance_prepare_adjustment` | 生成工时调整单草稿 | W | 必 | 封账后唯一更正通道 |

### 5.3.5 假期域 leave（7）

| # | 工具名 | 作用 | 读写 | 确认 | 说明 |
|---|---|---|---|---|---|
| 41 | `leave_list_types` | 假种与规则清单 | R | — | |
| 42 | `leave_get_balance` | 查四态余额（应得/实得/借用/结转） | R | — | 四态分列返回 |
| 43 | `leave_get_ledger` | 额度台账明细 | R | — | 追溯用 |
| 44 | `leave_get_team_calendar` | 团队请假日历（谁在休） | R | — | 排班参考 |
| 45 | `leave_submit_request` | 发起请假 | W | 审批 | 自动校验余额与连休报备 |
| 46 | `leave_cancel_request` | 撤销请假 | W | 必 | 已核销的需走调整 |
| 47 | `leave_grant_quota` | 发放/调整额度（写台账 + 留痕） | W | 必 | **不允许直接改余额**，只能追加台账行 |

### 5.3.6 薪酬域 payroll / si / tax（11）

| # | 工具名 | 作用 | 读写 | 确认 | 说明 |
|---|---|---|---|---|---|
| 48 | `payroll_list_schemes` | 薪资方案清单（含参数） | R | — | |
| 49 | `payroll_get_payslip` | 查工资条（默认脱敏/区间） | R | — | 金额默认 PARTIAL |
| 50 | `payroll_explain_item` | 解释某薪资项如何算出（公式 + 因子取值链） | R | — | 核心 AI 能力 |
| 51 | `payroll_check_run_readiness` | 算薪前置检查（封账/社保基数/个税链） | R | — | 只检查不跑 |
| 52 | `payroll_run_calc` | 发起算薪（异步作业） | W | 必 | 返回 `jobId`，不阻塞 |
| 53 | `payroll_get_calc_result` | 算薪结果概览 + 异常清单 | R | — | |
| 54 | `payroll_recalc` | 指定人员重算（生成新版本） | W | 必 | 已封账拒绝 |
| 55 | `payroll_get_cost_allocation` | 查成本分摊行（门店/成本中心维度） | R | — | 报表与 P&L 用 |
| 56 | `payroll_create_payment_batch` | 生成发放批次草稿 + 银行文件 | W | 必 | **只生成草稿，不执行发放**（§5.9 红线） |
| 57 | `payroll_get_si_plan` | 社保方案与城市政策版本 | R | — | |
| 58 | `payroll_get_tax_accum` | 个税累计预扣明细 | R | — | |

### 5.3.7 绩效域 perf（7）

| # | 工具名 | 作用 | 读写 | 确认 | 说明 |
|---|---|---|---|---|---|
| 59 | `perf_list_units` | 绩效单元清单与归属 | R | — | |
| 60 | `perf_get_template` | 考核模板与指标权重 | R | — | |
| 61 | `perf_list_pending` | 待我评分/待我确认的考核 | R | — | |
| 62 | `perf_submit_score` | 提交评分 | W | 必 | 提交后进校准 |
| 63 | `perf_get_result` | 考核结果（含个人系数与单元系数） | R | — | 两系数分列 |
| 64 | `perf_get_distribution` | 等级分布与校准偏差 | R | — | |
| 65 | `perf_get_bonus_pool` | 单元奖金池与测算 | R | — | |

### 5.3.8 招聘域 recruit（6）

| # | 工具名 | 作用 | 读写 | 确认 | 说明 |
|---|---|---|---|---|---|
| 66 | `recruit_list_requisitions` | 招聘需求清单（含到岗进度） | R | — | |
| 67 | `recruit_create_requisition` | 提招聘需求 | W | 审批 | |
| 68 | `recruit_search_candidates` | 简历/候选人搜索 | R | — | 联系方式脱敏 |
| 69 | `recruit_move_stage` | 推进候选人阶段（初筛/面试/待入职） | W | 必 | |
| 70 | `recruit_get_funnel` | 招聘漏斗与渠道 ROI | R | — | |
| 71 | `recruit_create_offer` | 生成 offer 草稿 | W | 审批 | 薪酬数字需字段权限 |

### 5.3.9 培训域 learn（5）

| # | 工具名 | 作用 | 读写 | 确认 | 说明 |
|---|---|---|---|---|---|
| 72 | `learn_list_courses` | 课程清单 | R | — | |
| 73 | `learn_assign_task` | 派学习/考试任务（按人/组织/岗位） | W | 阈值 | 影响 > 50 人需确认 |
| 74 | `learn_get_exam_result` | 考试成绩与通过情况 | R | — | |
| 75 | `learn_get_compliance_status` | 食安/健康证培训合规状态 | R | — | 与排班阻断联动 |
| 76 | `learn_create_question` | 新增题库题目 | W | 必 | |

### 5.3.10 报表域 report（6）

| # | 工具名 | 作用 | 读写 | 确认 | 说明 |
|---|---|---|---|---|---|
| 77 | `report_get_metric_definition` | 指标口径字典（公式/口径开关/来源） | R | — | **AI 必须先查再用**，禁止自造口径 |
| 78 | `report_run_query` | 按指标编码执行查询（受控） | R | — | 只接受字典内 `metricCode` |
| 79 | `report_compare` | 多门店/多区域/多期间对比 | R | — | |
| 80 | `report_get_dashboard` | 看板数据（管理层视图） | R | — | |
| 81 | `report_export` | 导出报表（异步，返回任务 ID） | W | 阈值 | 含敏感字段的报表**只生成 Web 下载链接** |
| 82 | `report_get_ai_digest` | 生成自然语言经营摘要（人力成本/流失/编制） | R | — | 只读汇总 |

### 5.3.11 治理域 gov / meta（11）

| # | 工具名 | 作用 | 读写 | 确认 | 说明 |
|---|---|---|---|---|---|
| 83 | `meta_get_current_user` | 当前身份、scope、数据范围自述 | R | — | AI 首调，避免瞎试 |
| 84 | `meta_describe_tool` | 工具 schema 与示例详情 | R | — | |
| 85 | `meta_list_tools` | 列出当前 scope 可用的工具 | R | — | |
| 86 | `gov_get_job_status` | 异步作业状态与进度 | R | — | |
| 87 | `gov_list_adjustments` | 调整单列表（谁改了什么） | R | — | 回滚入口 |
| 88 | `gov_revert_adjustment` | 回滚调整单（生成反向调整，不物理覆盖） | W | 必 | 需管理员 |
| 89 | `gov_list_audit_log` | 查审计日志（按人/时间/资源） | R | — | |
| 90 | `gov_list_ai_actions` | 查 AI 操作记录（哪个客户端动了什么） | R | — | §5.8 |
| 91 | `gov_get_config` | 读取租户配置项（白名单，敏感项拒答） | R | — | 白名单排除 `security.*`/`license.*` |
| 92 | `gov_set_config` | 修改租户配置项（需理由 + 审计） | W | 必 | **仅超管**；不可改权限/密钥类 |
| 93 | `gov_request_plaintext` | 申请查看敏感明文（返回受控链接） | W | 必 | **不通过 MCP 返回明文**，见 §5.5 |
| 94 | `gov_get_approval_status` | 查审批单状态与当前节点（**唯一**替代"AI 代为批准"的工具） | R | — | ADR A6：只可查，不可批 |

### 5.3.12 外包协同 / 劳务供应商（7）

> 对外协同面是**劳务公司**，六步链路：需求单发布 → 接单 → 供人名单 → 到岗确认 → 工时回流 → 对账。**工时确认只提供只读 + 申诉两个工具，不给写**——与 `record_owner` 的单边权威一致（§3.3.9）。否则外部系统能改工时，结算依据就没了。

| # | 工具名 | 作用 | 读写 | 确认 | 说明 |
|---|---|---|---|---|---|
| 95 | `vendor_publish_order` | 发布用工需求单（门店/时段/人数/单价） | W | 审批 | 我方门店侧发起 |
| 96 | `vendor_accept_order` | 供应商接单 | W | 必 | 只能接自己可见的需求 |
| 97 | `vendor_submit_worker_list` | 提交供人名单（姓名/证件/健康证） | W | 必 | 证件落库即加密 + 掩码 |
| 98 | `vendor_confirm_arrival` | 到岗确认（对需求单核销名额） | W | 必 | 未到岗自动生成缺口告警 |
| 99 | `vendor_get_worktime` | **工时回流（只读）** | R | — | 只能读 `record_owner=SUPPLIER` 且属于本供应商的记录 |
| 100 | `vendor_appeal_worktime` | 工时申诉（**不改工时**，生成待我方核对的差异单） | W | 必 | 申诉进 `attendance_exception(handle_type='APPEAL')`，我方须处置 |
| 101 | `vendor_get_settlement` | 对账查询（计费工时 / 计费金额 / 差异） | R | — | 金额口径与 `payroll_transfer` 的 `Di` 解释字段一致 |

**覆盖度自检**：组织 10 + 人员/合同 13 + 排班 8 + 考勤 9 + 假期 7 + 薪酬 11 + 绩效 7 + 招聘 6 + 培训 5 + 报表 6 + 治理/元信息 12 + 外包协同 7 = **101 个**（读 60 / 写 41，读写比约 **60:41**，读多写少符合"AI 先查后改"的实际行为）。十三个业务域全部覆盖，其中 §5.9 的 12 条红线已逐条映射到"工具不存在"或"强制拦截"。

## 5.4 鉴权与授权

### 5.4.1 客户端类型与取 token 方式

| 客户端 | 授权方式 | 绑定对象 | 适用 |
|---|---|---|---|
| 交互式 AI 客户端（桌面/IDE 插件） | **OAuth 2.1 Authorization Code + PKCE**，AS 为本系统 `/oauth/authorize` | `user_id`（真实用户） | 用户让 AI 帮自己干活 |
| 服务账号（脚本/定时 Agent） | **OAuth 2.1 Client Credentials** | `service_account`（系统内的虚拟用户，有独立角色与数据范围） | 无人值守的批处理 Agent |
| 同机 stdio | Web 端「为本地 AI 授权」生成 `client_token`（30 天，可吊销） | `user_id` | 本地助手 |
| 已授权客户端的续期 | `refresh_token` 轮换（一次性，重放即吊销全家） | — | |

**为什么不用纯 API Key**：API Key 无法表达"用户授权"这一层，审计里只有"某个 key 做了某事"，无法回答"是哪个人的 AI 在替他操作"。OAuth 的 `sub` 让我们能同时记录 `client_id` 与 `user_id`，这是 §5.9「AI 与人同权不同责」的前提。API Key 仅保留为**兼容模式**（老客户端），且强制绑定 `service_account`。

### 5.4.2 scope 设计与三轴映射

```
scope 命名：{domain}:{action}:{object}
示例：employee:read:profile   schedule:write:assignment   payroll:read:payslip
      payroll:write:calc      report:read:metric         gov:write:plaintext
action 封闭集合：read | write
```

**映射规则（关键：scope 只能缩小，不能放大）**

```
功能轴权限 = 用户角色的 permission_code 集合 ∩ scope 展开后的 permission_code 集合
数据轴范围 = 用户的数据范围 ∩ MCP 客户端的 max_data_scope
字段轴策略 = min(用户角色字段权限, MCP 层默认掩码策略)   // 取更严的那个
```

| 检查项 | 实现 | 防什么 |
|---|---|---|
| scope 不放大功能 | 交集运算 | 客户端拿 `payroll:read` 但用户没薪资权限 → 拒绝 |
| scope 不放大数据 | `sys_mcp_client.max_data_scope` 与用户范围取交 | 绑定 HRD 账号的客户端也能被收窄到某区域 |
| 字段只能更严 | `min(roleMask, mcpDefaultMask)` | 角色有 PLAIN，MCP 仍按 PARTIAL 返回 |
| 角色不可由客户端指定 | token 中无角色声明，服务端按 `user_id` 实时算 | 前端/客户端伪造提权（02 §6） |
| scope 变更需重授权 | token 内 `scope` 与 DB `allowed_scopes` 双校验 | 客户端自行扩大 scope |

**"AI 与人同权不同责"的具体落地**

| 维度 | 人（Web） | AI（MCP） | 是否相同 |
|---|---|---|---|
| 功能权限模型 | 三轴 | 三轴（同一引擎） | ✅ 同 |
| 数据范围模型 | 六种规则 | 六种规则 ∩ 客户端上限 | ✅ 同（更严） |
| 字段权限 | 三档掩码 | 三档掩码（默认更严） | ✅ 同（更严） |
| 写操作前置 | 表单校验 + 二次确认 | **强制 dry-run + plan** | ❌ 更严 |
| 批量影响 | 无硬阈值 | 超阈值强制确认/转 Web | ❌ 更严 |
| 审计粒度 | 记录操作 | 记录每次调用 + 参数指纹 + 影响行 | ❌ 更细 |
| 发薪执行 | 可（双人复核） | **禁止** | ❌ AI 无此能力 |
| 责任归属 | 本人 | 授权人 + 客户端双记 | 双记 |

## 5.5 脱敏策略（MCP 层比 Web 更严）

**核心理念：MCP 层永远不返回薪资/身份证/银行卡明文。**

| 数据类 | Web（有权限） | MCP（默认） | MCP（申请后） |
|---|---|---|---|
| 薪资明细（`netAmount` 等） | 明文 | **区间或掩码**：`8000–9000` / `8,***.00` | 明文也**不通过 MCP 返回** |
| 聚合薪资（门店人力成本总额） | 明文 | 明文（聚合值不构成个人信息风险） | — |
| 身份证号 | 明文 | `310101********1234` | 同上，不返回 |
| 银行卡号 | 明文 | `**** **** **** 7890` | 同上 |
| 手机号 | 明文 | `138****5678` | 明文可返回（联系员工场景需要） |
| 家庭住址 / 紧急联系人 | 明文 | 不返回（HIDDEN） | 不返回 |
| 简历联系方式 | 明文 | 掩码 | 走 `recruit_move_stage` 后在 Web 查看 |

**明文如何获取（`gov_request_plaintext`）**

```
AI: gov_request_plaintext(resourceType="PAYSLIP", resourceId=8842, fields=["netAmount","accountNo"], reason="员工来电核对到账金额")
 → 校验：① 调用者对目标有读权限 ② 字段权限非 HIDDEN ③ reason 非空且 ≥ 10 字
 → 生成一次性 ticket（TTL 10 分钟，绑定 user_id + client_id）
 → 返回 {
     "ticket": "pt_7f2a...",
     "viewUrl": "https://hr.internal/secure-view/pt_7f2a...",
     "expiresInSeconds": 600,
     "note": "明文只能在浏览器受控页面查看，页面含水印与截屏审计，MCP 不返回明文"
   }
 → 同时：写 audit_log（actor_type=AI, action=REQUEST_PLAINTEXT），推送站内信给数据属主与合规
```

**为什么明文只走受控 Web 页面**：
1. MCP 的返回会进入 AI 上下文，可能被转发到模型提供方或写入对话历史 → 一旦出明文，无法收回；
2. 受控页面可以做**水印 + 截屏检测 + 单次可见 + 下载禁止**，风险收敛在浏览器；
3. 一次申请一条审计，合规口径清晰（"谁在什么理由下看了哪个字段"）。

**分层兜底**：即使上游某处漏了脱敏，`FieldMasker` 在 JSON 序列化最外层还有一道 `SensitiveType` 扫描（基于反射遍历 DTO 注解），MCP 通道强制 `maskLevel=MCP_MIN`。

## 5.6 写操作安全

### 5.6.1 两阶段提交（协议强制，不靠 AI 自觉）

```
阶段 1 — 预览
  tools/call { name: "schedule_batch_assign", arguments: {..., "dryRun": true} }
  → 服务端：完整校验（不写业务表）
  → 写 sys_mcp_plan(plan_id, tool_name, args_digest, diff_json, affected_count, plan_ttl_seconds=300, used_at=NULL)
  → 返回 { ok:true, meta:{ planId, affectedCount: 320, requiresConfirmation:true }, data:{ diff:[...], conflicts:[...] } }

阶段 2 — 执行
  tools/call { name: "schedule_batch_assign", arguments: {..., "planId": "plan_9a2b", "idempotencyKey":"..."} }
  → 服务端校验：plan 存在 ∧ 未过期 ∧ 未使用 ∧ tool_name 一致 ∧ args_digest 一致（除 planId 外参数不得变）
  → 仅当 affectedCount ≤ 阈值时允许直接执行
  → 执行：置 used=true（同一事务），写业务表，写审计
```

**为什么用 `planId` 而不是"建议 AI 先调一次 dry-run"**：AI 会跳过建议。把"必须先预览"变成**服务端拒绝无 plan 的执行**，才是真的强制。同时 `args_digest` 保证"预览的和执行的是同一次操作"，防止 AI 预览 10 条、执行 1000 条。

#### `sys_mcp_plan` 的 DDL（v1.10 补：之前只有流程图在写它，全册无建表语句）

```sql
CREATE TABLE sys_mcp_plan (
  plan_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name        varchar(96) NOT NULL,
  args_digest      bytea       NOT NULL,        -- 除 planId 外全部参数规范化后的摘要
  diff_json        jsonb       NOT NULL,
  affected_count   int         NOT NULL CHECK (affected_count >= 0),
  plan_ttl_seconds int         NOT NULL DEFAULT 300
                     CHECK (plan_ttl_seconds BETWEEN 30 AND 900),   -- ★ 时长，不是时点
  created_at       timestamptz NOT NULL DEFAULT now(),              -- 记录型时间戳（§4.5.5）
  used_at          timestamptz,                                     -- ★ 用 used_at，不存 used boolean
  used_by          varchar(64),
  CONSTRAINT ck_mcp_plan_used CHECK ((used_at IS NULL) = (used_by IS NULL))
);
```

**有效期判定**：`clock_timestamp() < created_at + make_interval(secs => plan_ttl_seconds)`。写成时长而不是时点，有三个具体理由：

1. **不产生第二个时点列。** 本册三处明写不建 `expires_at`，理由是"一个概念两个物理位置必有下一次不同步"。`plan_ttl_seconds` 是**时长**，`created_at + ttl` 只在**读的时候**算出来，没有第二个可漂移的存储位置。
2. **时限是可配的策略，不是事实。** 5 分钟改成 10 分钟是对策略的调整，不该改写已经生成的历史计划行。存 `expires_at` 的话，改策略要么不影响存量（于是同一批计划有两套时限，没人分得清）、要么批量改写历史（于是"当时的有效期是多久"永远查不到）。
3. **它和授权的时间性不是一回事，不冲突。** §6.0.9.4 的"时间性只有一套"讲的是**授权**；这里是"一个两阶段写的执行凭证多久内有效"，处置完全不同——计划过期 → 让 AI 重新生成；授权到期 → 拒绝访问。**这个区分必须写在 DDL 注释里**，否则下一个人看到这里有个时长字段，会以为授权也可以这么干。

**为什么用 `used_at` 而不是 `used boolean`**：`used` 是 `used_at IS NOT NULL` 的副本，存两个必然不同步（`used=true` 而 `used_at IS NULL` 是写得进去的）。这是 §4.5.2「能派生的不存」在布尔列上的同一句。同理 `used_by` 与 `used_at` 同生同灭——**"谁用过"不能是自由列**。

> **这一处在今晚的清单里是"零代表"的第三种形态**：不是文档说"落 `04`"而没落（`payslip_ack`），不是只在清单里列了（`employee_job_assignment`），而是**流程图的一个箭头后面写着它**。`grep "CREATE TABLE"` 查不到，按表名查也只查到这一行——**它看起来已经被使用过了，所以没人去问它建在哪里。**

### 5.6.2 二次确认（elicitation）

| 触发条件 | 确认方式 |
|---|---|
| `affectedCount` 超阈值（排班 > 200、调薪 > 5、请假批量 > 20、导出 > 1000 行） | **MCP elicitation**：`elicitation/create` 展示结构化确认（操作摘要 + 影响人数 + 不可逆提示），用户须显式 accept |
| 涉及金额变动 > 10,000 元 / 或影响发薪结果 | elicitation **+ 转 Web 审批单**（MCP 返回 `E_APPROVAL_REQUIRED` + 审批单号） |
| 客户端不支持 elicitation | 返回 `E_CONFIRMATION_REQUIRED` + `confirmationToken`（TTL 30 分钟）；同时生成站内待办，用户 Web 端确认后 token 生效 |
| 治理类（改配置/改权限/回滚/明文申请） | **只能 Web 确认**，MCP 仅生成待确认单 |

**阈值的可配置性**：所有阈值在 `sys_config` 里（`mcp.confirm.threshold.*`），管理员可按客户风险偏好调紧（不能调松到 0 以下）。

### 5.6.3 审批联动

MCP 的写入型工具**内部直接调用审批服务**，不另建一套审批：

```
employee_offboard
  → OffboardApplicationService.submit(order)          // 生成 hr_change_order
  → ApprovalService.submit(bizType='OFFBOARD', bizId)  // 生成 sys_approval_instance
  → 返回 { status:'PENDING_APPROVAL', approvalId: 991, origin:'AI' }
  → 审批通过后：ApprovalCallback 触发 execute(order)（此处才写 employment）
```

`sys_approval_instance.origin='AI'` 让审批人一眼看到"这是 AI 提交的"，并可在审批页看到 AI 客户端的完整调用链（`trace_id` → `mcp_call_log`）。

**AI 不能在参数里传 `approved: true`**：所有入参 DTO 不含审批状态字段；ArchUnit 规则禁止 `..request..` 包出现 `status`/`approved`/`skipApproval` 等字段名。

> ### 🔒 产品红线（ADR A6，写死）
> **审批权不可委托给 AI。**
> 系统不提供任何 `approve_*` 工具，也不接受"以 AI 身份代批"。AI 只能 `submit_*`（发起）与 `get_approval_status`（查看）。原因是：AI 若能批准，人工审批就形同虚设——审批链的全部价值在于"有一个人对结果负责"，而 AI 无法承担责任。

### 5.6.4 回滚（走调整单，不物理覆盖）

| 操作 | 回滚方式 |
|---|---|
| 排班 | `schedule_batch_assign` 的反向操作 = 取消分配（`action=CANCEL`），生成新 plan，旧的 `schedule_assignment` 标 `CANCELLED` 不删 |
| 工时 | 封账前：`attendance_prepare_adjustment`；封账后：只能调整单，原记录保留 |
| 薪酬 | 未封账：重算生成新版本（`is_current` 切换）；已封账：下期补差调整单 |
| 组织 | 发布新版本（回到上一版本的拓扑），不删除任何 `org_unit_history` |
| 请假 | `leave_cancel_request` + 台账追加 `REVERT` 行 |
| 配置 | 版本化，`gov_set_config` 写新行（旧行 `effective_to` 关闭），可回退 |

**统一入口**：`gov_list_adjustments` 查、`gov_revert_adjustment` 回滚。回滚本身也是一次写操作，需要 plan + 确认，并写审计。

## 5.7 限流与配额

| 维度 | 默认值 | 存储 | 超限行为 |
|---|---|---|---|
| **MCP 客户端速率** | **60 次/分钟**（ADR A8；突发 20） | Redis 令牌桶 `mcp:rate:{clientId}` | `E_RATE_LIMIT` + `retryAfterMs` |
| 为什么单独限 MCP | AI 与人类**同权同流**（同一套权限与业务链路），但 AI 是程序，会以人类不可能达到的频率调用。不单独限速，一个跑飞的 Agent 足以在早高峰挤占员工打卡的资源 | | |
| 客户端日调用 | 20,000 | Redis 计数器（按日 key，TTL 48h） | 拒绝，需管理员提额 |
| 用户日写调用 | 500 | Redis 计数器 | 拒绝，防 AI 循环写 |
| 重工具并发 | 2（算薪/导出/批量排班/大批导入） | Redis 信号量 | 返回排队位置，或 `E_RATE_LIMIT` |
| 单次返回行数 | 500（超过需分页） | 服务端裁剪 | 返回 `hasMore` + `nextCursor` |
| 单工具执行超时 | 读 10s / 写 30s / 异步 60s 返回 jobId | — | `E_TIMEOUT` |
| 令牌有效期 | access 30min / refresh 7d（轮换） | — | 401 后客户端自续 |
| 失败熔断 | 同一客户端 5 分钟内 20 次 `E_VALIDATION` | Redis | 短暂封禁 5 分钟（防 AI 死循环） |

**配额与 License 联动**：`员工人数上限` 不影响 MCP 配额；但 License 到期进入只读宽限期时，所有 `:write:` scope 工具统一返回 `E_APPROVAL_REQUIRED`（引导去 Web 续期）。

## 5.8 审计

### 5.8.1 调用日志表

```sql
CREATE TABLE mcp_call_log (               -- 独立表（ADR A7），不混进 sys_audit_log
  id bigint PRIMARY KEY,
  trace_id char(32) NOT NULL,               -- 与业务日志同 trace，可串联
  client_id bigint NOT NULL,
  client_name varchar(64),                  -- 冗余，客户端改名后仍可追溯
  user_id bigint,                           -- 授权人（OAuth sub）
  service_account_id bigint,
  tool_name varchar(64) NOT NULL,
  tool_version varchar(16),
  transport varchar(8) NOT NULL,            -- STDIO|HTTP
  args_digest char(64) NOT NULL,            -- 参数指纹（敏感值不落明文）
  args_masked jsonb,                        -- 参数脱敏副本（薪资/证件已掩码）
  plan_id varchar(40),
  confirmation_mode varchar(16),            -- NONE|ELICITATION|WEB_APPROVAL|NOT_REQUIRED
  scope_granted varchar(512),
  data_scope_effective varchar(512),        -- 'STORE_SET(1024,1025)' / 'ALL'
  affected_tables jsonb,                    -- ["schedule_assignment"]
  affected_row_ids jsonb,                   -- [8842, 8843, ...]（上限 500，超出记 count）
  affected_count int,
  masked_fields jsonb,                      -- ["netAmount","idCardNo"]
  result_code varchar(32) NOT NULL,         -- OK / E_PERM_DENIED / ...
  result_digest char(64),
  duration_ms int,
  ip inet, ua varchar(256),
  created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
-- 按月分区，保留 3 年（ADR A7）
CREATE INDEX ix_mcp_call_client ON mcp_call_log(client_id, created_at);
CREATE INDEX ix_mcp_call_user   ON mcp_call_log(user_id, created_at);
CREATE INDEX ix_mcp_call_trace  ON mcp_call_log(trace_id);
```

**记录原则（ADR A7）**
- **独立表，不混进 `sys_audit_log`**：两者查询模式与保留策略不同，混在一起会让审计页被 AI 调用噪声淹没
- **大字段存摘要 + 哈希**：`args_masked` 只存脱敏后的参数副本（截断到 4KB），完整参数存 `args_digest`（SHA-256）；`before/after` 差异同理。理由是隐私与体积双约束——审计日志本身不能成为泄密源，也不能成为第二个业务库
- `affected_row_ids` 是核心：它让"AI 到底动了哪几条记录"可精确回答，也是回滚的锚点
- 每次调用都记，包括失败与权限拒绝（失败尝试本身就是安全信号）
- **保留期 3 年，按月分区**，超期归档加密冷存储（Parquet 打包）

### 5.8.2 界面上怎么查"哪个 AI 动了什么"

**页面：治理 → AI 操作日志**（权限：`gov:read:aiAction`）

| 区域 | 内容 |
|---|---|
| 筛选 | 客户端 / 授权用户 / 工具 / 时间范围 / 结果码 / 是否写操作 / traceId |
| 列表 | 时间、客户端、用户、工具、影响条数、结果、耗时、确认方式 |
| 详情抽屉 | ① 参数（脱敏）② 影响记录列表（点击跳转到对应业务详情）③ diff 预览（写操作）④ planId 与预览快照 ⑤ 关联审批单 ⑥ 同 traceId 的全链路（Web 请求 → 应用服务 → SQL） |
| 一键动作 | 「查看受影响记录」「申请回滚」（`gov_revert_adjustment`）、「吊销该客户端」 |

**辅助视图**
- **按人汇总**：某人最近 30 天被 AI 操作过哪些数据（员工视角，可用于劳动争议举证）
- **异常看板**：写操作失败率 Top、被 `E_SCOPE_DENIED` 最多的客户端（潜在越权探测）、单客户端日调用 Top

## 5.9 AI 能做什么 / 绝对不能做什么

### ✅ 明确允许（按 scope）

| 类别 | 能力 |
|---|---|
| 查询 | 查组织树、花名册、班表、考勤、工时、假期余额、工资条（脱敏）、绩效结果、编制缺口、指标口径 |
| 分析 | 人力成本率对比、流失预警、招聘漏斗、排班缺口、加班超标门店、试用期超期名单 |
| 办理 | 发起请假/补卡/加班/换班/转正/复职（走审批） |
| 管理 | 批量排班（带确认）、发起算薪（异步）、生成发放批次草稿、调薪（带审批）、派培训任务 |
| 治理（受限） | 查审计与 AI 操作日志、改非危险配置项（需理由）、申请明文（受控查看）、回滚调整单（管理员） |

### ❌ 绝对红线（工具层面不存在，或强制拦截）

| # | 红线 | 实现方式 |
|---|---|---|
| RL1 | **不得直接发薪** | 不存在 `payroll_execute_payment` 工具。`payroll_create_payment_batch` 只能产出 `status=DRAFT`；置为 `CONFIRMED` 只能 Web 端 + 财务复核人 + 操作密码，且需第二人复核（双签） |
| RL2 | **不得绕过审批** | 所有写入型工具内部强制 `ApprovalService.submit()`；入参 DTO 无审批状态字段（ArchUnit 强制）；审批模板不可被 AI 修改 |
| RL3 | **不得解封账期** | 不存在 `payroll_unlock_period` / `attendance_unlock_period` 工具；Web 端也需财务负责人双签 + 理由 + 审计 |
| RL4 | **不得物理删除业务数据** | 所有 Mapper 无 `delete` 方法（ArchUnit 禁止 `..Mapper.delete*`）；只允许 `void_flag` / `status=CANCELLED` |
| RL5 | **不得导出敏感明文** | `report_export` 对含 `is_sensitive` 字段的报表只返回"已生成，请在 Web 端下载"，下载页强制水印 + 二次密码 |
| RL6 | **不得修改权限与角色** | 不存在 `gov_grant_role` / `gov_create_role` 工具。`gov_set_config` 白名单排除 `security.*` / `license.*` |
| RL7 | **不得读系统密钥/配置** | `gov_get_config` 白名单，`security.*`、`datasource.*`、`license.*` 一律返回 `E_PERM_DENIED` |
| RL8 | **不得跨数据范围聚合推断** | 报表工具对 `count < 5` 的分组不返回明细（防"通过小样本反推个人薪资"） |
| RL9 | **不得修改已发布排班而不通知** | `schedule_batch_assign` 命中 `PUBLISHED` 记录时强制走"排班变更单 + 通知员工"分支，不允许静默改 |
| RL10 | **不得自我授权/延长 License** | License 与权限无 MCP 工具；仅 Web 超管 + License 文件替换 |
| RL11 | **不得绕过业务单据直接写底层结果表** | 不存在任何工具能直接写 `attendance_daily` / `attendance_daily_store` / `employee_org_assignment` / `schedule_assignment` / `payroll_record`。写入必须走单据：排班单 / 支援单 / 调动单 / 考勤调整单。校验方式：`ToolRegistry` 白名单只允许 Application 层方法，**仓储层（Mapper）不对网关开放** |
| RL12 | **不得代替人工审批（ADR A6）** | 不存在 `approve_*` 工具；只有 `submit_*` + `gov_get_approval_status` |

**为什么 R11 必须单列**：表结构可以靠约束防错，但 Agent 会以你没想到的组合去调用。直接写结果表会同时绕过三件东西——幂等重算（`snap_calc_rule_version` 快照失效）、封账校验（`period_seal` 前置检查被跳过）、审批链（`origin` 溯源断掉）。所以边界要在**接口层再收一次**，不能只靠 DB 约束。

**红线的工程保障（不是靠文档约定）**

| 手段 | 覆盖 |
|---|---|
| `ToolRegistry` 无对应工具 | RL1 RL3 RL6 RL10 RL12（没有工具就无法调用） |
| 网关只暴露 Application 层，**仓储层不对网关开放** | RL11（编译期不可达） |
| ArchUnit 规则 | RL2 RL4（编译期失败） |
| 参数 DTO 字段白名单 | RL2 RL6 |
| `FieldMasker` + `SensitiveType` | RL5 RL7 |
| 服务层 `@RequiresConfirmation` 切面 | RL9 |
| 报表 `count>=5` 聚合阈值 | RL8 |
| 集成测试基线（每次发版跑） | **全 12 条**：用 service_account 调每个工具，断言红线场景返回预期错误码 |

---

# §6.0 权限与审批体系（数据权限 / 字段权限 / 功能权限 / 审批流）

> **编号说明**：本章编号用 `6.0` 而不是新起 `§7`，是为了**不动 §6–§12 的既有编号**——全文有 40 余处交叉引用（`§4.3` / `§5.5` / `§9.5b` / `§0.2b` 各行…），整体后移一次的代价远大于编号读起来顺不顺。阅读顺序上它属于"平台能力"，与 §4.3 互为表里：**§4.3 讲"怎么算"，本章讲"存什么、冲突怎么裁、边界在哪"**。
>
> **本章只写模型与裁决，不写审批引擎的推进算法**（会签清算、加签、转交、撤回、抄送、代理、催办、在途重路由）。引擎那一半等裁决确认后再写，因为它依赖本章的裁决结论——尤其裁决二（字段两来源）与裁决四（AI 隔离）。

## 6.0.1 分工、输入来源与一条硬约束

| 文档 | 它答什么 | 本章与它的关系 |
|---|---|---|
| `01` / `02` / `02g` | 权限原则、AI 硬边界、断言语义 | **不改**，只引用 |
| `03` 第一册 §2.3 | 业务上"能不能点" | **不改**，本章只给它一个存储与求值形态 |
| `10` 权限点清单与数据范围（草稿） | 权限点名词表 + 四维范围 × 角色映射 | **是本章的输入，不是被本章修改的对象**；本章只负责"这些名词怎么存、怎么判" |
| `§4.3` 权限引擎 | 求值序、数据范围转 SQL、脱敏档 | 本章**替换**其中被单维结构绑死的那部分（见 §6.0.3.1） |

**一条硬约束：权限模型只有三道轴 + 一个"第二来源"，不新增第四轴。**

三轴 = 功能 × 数据 × 字段（ADR A3 / A4）。审批节点是**字段轴的第二个来源**，不是第四条轴。理由不是省事，是**判定顺序的可穷举性**：三轴只有一个求值序（数据→字段→功能，A4 定死）；若把"是否在审批中"做成第四轴，四个轴有 4! = 24 种排法，每一版实现都能给自己找一个说得通的排法，而排法不同会导致**同一张单据在 Web 与导出上看到的字段不一样**。做成"来源"只多一步 `coalesce`，且这一步的位置是可指认的（§6.0.4.3）。

## 6.0.2 权限模型总表：存量改造 6 张 + 新增 7 张

> **本节遵守一条硬规则：不另立 `*_v2` 表。** 存量表就地改造，废弃列留列标 `deprecated`（列名不回收），语义变更写进 §0.2b。两套并存正是 `02g` I17.3 禁止的形态——同一份内容两个物理位置，必有下一次不同步。

| # | 表 | 存量/新增 | 回答的问题 | 落在 |
|---|---|---|---|---|
| 1 | `sys_user` / `sys_user_role` | 存量（扩 4 列） | 谁、以什么角色、在什么范围、到什么时候为止 | §6.0.3.2 |
| 2 | `sys_permission` / `sys_role_permission` | 存量 | 能点哪些动作 | §6.0.9 |
| 3 | `sys_data_scope` | 存量（三列废弃） | 一个"具名范围"的身份 | §6.0.3.2 |
| 4 | **`sys_data_scope_rule`** | **新增** | 这个范围在**哪几个维度**上、各取哪些值、维度之间怎么接 | §6.0.3.2 |
| 5 | **`sys_permission_deny`** | **新增** | 谁**绝对不可以**看什么（压过一切 allow） | §6.0.3.5 |
| 6 | **`sys_perm_resource`** | **新增** | 这个业务对象受哪几个维度管辖、按什么时点判、能不能导出 | §6.0.3.6 |
| 7 | `sys_field_permission` | 存量（扩 3 列 + 加 `scene`） | 角色级：字段在某个出口上的四态 | §6.0.4.5 |
| 8 | **`sys_node_field_policy`** | **新增** | 节点级：在这个审批节点上，字段**只能被收窄** | §6.0.4.5 |
| 9 | `sys_approval_template` | 存量（`node_json`/`condition_json` 废弃） | 流程的**身份** | §6.0.8.1 |
| 10 | **`sys_approval_flow_version`** | **新增** | 流程的**内容**（发布即冻结的一版定义） | §6.0.8.1 |
| 11 | **`sys_approval_node_def`** | **新增** | 某一版里的一个节点 | §6.0.8.1 |
| 12 | `sys_approval_instance` / `sys_approval_task` | 存量（扩 5 列） | 在途单据绑的是哪一版、哪个四维快照 | §6.0.8.3 |
| 13 | **`sys_approval_reroute_log`** | **新增** | 调岗/离职后，这张单为什么转到这个人 | §6.0.8.5 |
| 14 | **`sys_permission_bundle` / `sys_permission_bundle_item`** | **新增（2 张）** | 权限套餐：**授权载体，运行期不求值** | §6.0.9.3 |
| 15 | **`access_decision_log`** | **新增** | 这次操作用了**哪几条**授权（复数） | §6.0.9.4 |

新增 **10 张**。表总数 93 → **103**；视图 15 → **20**（+`v_chk_scope_mixed_combinator` / `v_chk_scope_no_rule` / `v_chk_scope_dangling` / `v_daily_metric_scoped` / `v_chk_expired_but_active`）。审批引擎那一半再 +3（`sys_approval_delegate` / `sys_approval_cc` / `sys_approval_item`），断言运行层 +3（§4.5），`sys_perm_dim` +1（§6.0.3.7），`sys_data_classification` +1（§8.2d），`sys_mcp_plan` +1（§5.6.1），**最终 114 表 / 24 视图**（见 §6.0.12.1；该节同时写明"账面"与"实测"两个口径）。

**权限模型只有三道轴 + 一个"第二来源"，不新增第四轴。** 审批节点是字段轴的第二个来源，不是第四条轴。理由不是省事，是**判定顺序的可穷举性**：三轴只有一个求值序（数据→字段→功能，ADR A4）；若把"是否在审批中"做成第四轴，四个轴有 24 种排法，每版实现都能给自己找个说得通的排法，而排法不同会导致**同一张单据在 Web 与导出上看到的字段不一样**。做成"来源"只多一步比较，位置可指认（§6.0.4.3）。

## 6.0.3 裁决一：数据范围是四维三元组 + 显式 deny

### 6.0.3.1 旧结构的致命处：不是"表达力不够"，是"没有一列能区分"

`sys_data_scope` 现在是 `scope_type + org_ids_json + legal_entity_ids_json`（§3.8.1）。三处硬伤，第三处致命：

| 硬伤 | 后果 |
|---|---|
| ① 只能表达一棵组织树 | 支援、代管、跨店店长（A 店上班、成本记 B 店）写不出来 |
| ② `include_sub` 只能整体开关 | "本部含下级、门店不含"写不出来 |
| ③ **`legal_entity_ids_json` 分不清发薪法人还是参保法人** | **致命** |
| ④ **没有 deny，只能并集** | 与泛微/钉钉同一个病：同一维度只能"给"，不能"明确不给" |

第③条要展开。集团里 A 公司发薪、B 公司参保是常态（跨省用工）。两者不同时，`scope_type='LEGAL_ENTITY'` 的两条范围会给出**不同的可见人集**，而表里没有任何一列能区分。实施时唯一出路是"约定这条范围只能用在发薪法人上"——于是要么区域 HR 看到不该看的社保明细，要么该看的工资看不到，**两种情况都不报错**。

第④条是这一轮补进来的、比③更硬的一条。对外部系统的调研结论一致：**泛微与钉钉的规则叠加都是并集，没有交集机制，也没有 deny**。所以"某门店 HR 绝对不可见薪酬"在这两家**无法用一条规则表达**，只能靠"确保没有任何一条规则命中他"——500 门店规模下必然失守。

这不是假想风险，`10` §2.2 的映射表里同一角色在四维上取值本来就不一样：

| 角色 | 发薪法人 | 参保主体 | 成本组织 | 考勤组织 |
|---|---|---|---|---|
| 集团薪酬 | 全集团 | 全集团 | **不可见** | **不可见** |
| 财务 | 全集团（只读） | 全集团（只读） | 全集团（可写） | 不可见 |
| 店长 | 本店所属法人（只读） | **不可见** | 本店 | 本店 |

单维结构写"集团薪酬：发薪法人全集团、成本组织不可见"，只能写成 `ALL` 范围——然后把成本组织也给成全集团。**多给权限不报错，只不报错**，这是权限模块最不容易被测试发现的位置。

### 6.0.3.2 新结构：一个范围 = 每维度一条三元组

```sql
-- sys_data_scope 是存量表（定义见 §3.8.1），此处只写变更，不重复定义
-- scope_type 保留作"对外五档"的展示名，但**判定逻辑只读规则表，不读 scope_type**
-- （否则又回到"两个地方都能决定权限"）
ALTER TABLE sys_data_scope
  ADD CONSTRAINT ck_ds_type CHECK (scope_type IN
    ('ALL','SELF','EXTERNAL','DIM','DEPT','DEPT_SUB','STORE_SET','LEGAL_ENTITY'));
COMMENT ON COLUMN sys_data_scope.org_ids_json          IS 'DEPRECATED：改用 sys_data_scope_rule；分不清成本组织与考勤组织';
COMMENT ON COLUMN sys_data_scope.legal_entity_ids_json IS 'DEPRECATED：同上；分不清发薪法人与参保法人';
COMMENT ON COLUMN sys_data_scope.include_sub          IS 'DEPRECATED：已并入 sys_data_scope_rule.value_type';
COMMENT ON COLUMN sys_data_scope.scope_type            IS '仅用于展示"对外五档"；权限判定不读此列';

CREATE TABLE sys_data_scope_rule (
  id            bigint PRIMARY KEY,
  data_scope_id bigint NOT NULL REFERENCES sys_data_scope(id) ON DELETE CASCADE,
  dimension     varchar(24) NOT NULL,
  value_type    varchar(16) NOT NULL,     -- all | node | node_subtree | person | self | none
  value_ids     bigint[] NOT NULL DEFAULT '{}',
  combinator    varchar(16) NOT NULL,     -- union | intersection  ★ 按 scope 各配，见 §6.0.3.4
  -- ★ 维度合法性只由 sys_perm_dim 定义（§6.0.3.7），此处不再二次枚举
  CONSTRAINT fk_dsr_dim FOREIGN KEY (dimension) REFERENCES sys_perm_dim(code),
  CONSTRAINT ck_dsr_type CHECK (value_type IN ('all','node','node_subtree','person','self','none')),
  CONSTRAINT ck_dsr_comb CHECK (combinator IN ('union','intersection')),
  -- 空集合只有 all / none / self 三种合法形态；其余必须给值
  CONSTRAINT ck_dsr_ids CHECK (
       value_type IN ('all','none','self') OR cardinality(value_ids) > 0),
  CONSTRAINT ck_dsr_all CHECK (value_type NOT IN ('all','none') OR cardinality(value_ids) = 0),
  CONSTRAINT ck_dsr_person CHECK (value_type <> 'person' OR dimension = 'person'),
  UNIQUE (data_scope_id, dimension)
);

-- 一个 scope 内 combinator 必须统一（理由见 §6.0.3.4，用巡检不用 CHECK：跨行不能进 CHECK）
CREATE VIEW v_chk_scope_mixed_combinator AS       -- 期望：空集
SELECT data_scope_id, count(DISTINCT combinator) AS n
  FROM sys_data_scope_rule GROUP BY data_scope_id HAVING count(DISTINCT combinator) > 1;

CREATE VIEW v_chk_scope_no_rule AS                -- 期望：空集
SELECT s.id AS scope_id, s.name FROM sys_data_scope s
 WHERE s.scope_type = 'DIM'
   AND NOT EXISTS (SELECT 1 FROM sys_data_scope_rule r WHERE r.data_scope_id = s.id);
```

**`value_ids` 里装的是"值"，不是"子树"**：`value_type='node_subtree'` 表示这些节点**及其下级**（运行时按 `org_unit.path` 展开），`node` 表示只要这些节点本身。**同一个维度只能选一种表达**（`UNIQUE(data_scope_id, dimension)`）——若确实需要"A 店含下级、B 店不含"，就配两个具名范围同时授予（多个范围天然是并集，语义更清楚）。

> **已知局限（登记，不擅自改结构）**：`si_entity` 维度的粒度目前**只到法人，不含参保城市**。若客户存在"同一参保主体在两地参保"，这个维度就分不开两地的缴费基数与政策，而两者是不同的钱。扩法是加一列 `value_city varchar(32)`（纯加列，`UNIQUE` 键追加一列），**不改结构、不迁数据**。上线前必须先确认客户有没有这种情形——`tmp_scope_entity` 已预留 `si_city` 列，加与不加都不动临时表。

**为什么要 `combinator`**：集团 HR 要"四维全通"（union 也行），而门店 HR 在跨法人借调场景下，"发薪法人"与"考勤组织"**必须交集**才能把人收窄到"既由本法人发薪、又在本店上班"。**泛微与钉钉都表达不了这件事**——这是差异点，不是锦上添花。

```sql
-- 承接 10 Q2 的"未结单据限期只读"与 10 §1.3.6 的"限时代操作"
-- ★ 授权的时间性**只有一套**：effective_from / effective_to（§6.0.9.4）。这里不再新增 expires_at。
ALTER TABLE sys_user_role
  ADD COLUMN grant_kind    varchar(24) NOT NULL DEFAULT 'ROLE',   -- ROLE|HANDOVER_READONLY|TEMP_ACT_AS
  ADD COLUMN readonly_only boolean NOT NULL DEFAULT false,
  ADD COLUMN grant_reason  varchar(500);
DROP INDEX IF EXISTS sys_user_role_user_id_role_id_data_scope_id_key;
-- ★ 唯一性由 §6.0.9.4 的 ex_ur_no_overlap（EXCLUDE USING gist，部分谓词 superseded_by IS NULL）承担：
--   它同时表达"同一键不得重叠"与"历史行不参与检查"，这是 UNIQUE 索引做不到的。
```

> **为什么这里**不**建 `expires_at` + `UNIQUE (... , coalesce(expires_at,'infinity'))`**（本轮修正）：那是我上一版的写法，三处都错。
> ① **一个概念两个物理位置**：授权的时间性已经由 §6.0.9.4 的 `effective_from`/`effective_to` + `ex_ur_no_overlap` 表达，再来一个 `expires_at` 就是同一件事的两份真相，必有下一次不同步（`02g` I17.3 明令禁止）。
> ② **`coalesce(x,'infinity')` 把"无界"降级成"有限但很大"**：`upper_inf()` 从此永远 false，所有"是否仍在生效"的判据一起错，且**漏掉的恰好是"现行"的那批行**（§3.0b）。
> ③ **键列可空时 `UNIQUE` 是假的**：PG 把每个 `NULL` 视为互不相同，于是"同一键只能有一条"在 `expires_at IS NULL`（不过期）这个最常见的情形上**完全不生效**，而索引看起来完全正常（`02g` §I28）。修法要么 `NULLS NOT DISTINCT`（PG 15+），要么换成 `EXCLUDE`——后者正好还能表达"区间不重叠"。


### 6.0.3.3 三个组合规则——这是裁决一的核心答案

| 问题 | 答案 | 理由 |
|---|---|---|
| 同一维度内多个值（`value_ids`） | **OR（并集）** | 授了 A 店和 B 店就是两家都能看 |
| 不同维度之间 | **由 `combinator` 决定**：`intersection` → `AND`；`union` → `OR` | 见 §6.0.3.4 |
| 多个具名范围（多行 `sys_user_role`） | **OR（并集）** | 一人多角色多范围，能力取并 |
| 维度**不在**该资源的行闸集合里 | **不参与行判定** | 它对这个资源没有语义 |
| 维度**在**行闸集合里但无授予 | **空集 → 一行都看不到（deny）** | 见 §6.0.3.5 |
| **命中 `sys_permission_deny`** | **deny，且压过一切 allow（含节点级放宽）** | 见 §6.0.3.5 |

**行闸维度默认必须 `intersection`**。取 `union` 等于"任一维度放宽就整行放行"——授了考勤组织就等于拿到全集团工资。OR 在这种场景下不是"更宽松"，是**没有权限**。

AND 的代价是"必须四维都配全才看得到"，这是刻意的：**权限配置宁可爱漏配导致看不到（有人投诉、能修），不可多配导致看到（没人投诉、修不了）**。与 §6.0.4.3「可写性只紧不松」是同一条哲学。

**维度集合由资源声明，不由用户的授予清单推导**（本节最容易被写错的一句）

实施时最常见的写法是"遍历用户的所有授予，有几个维度就加几个条件"。这个写法有个致命后果：**用户只被授了一个维度时，其余维度就"没有条件"= 不限制**。于是只授了考勤组织的店长，能看全集团的成本数。

正确写法反过来：先从 `sys_perm_resource` 取出**这个资源受哪几个维度管辖**，再对每个管辖维度去临时表里找授予；找不到就是空集。**用户手里有什么，不能决定系统查什么。**

### 6.0.3.4 `combinator` 为什么必须"按 scope 配"，以及混用为什么必须禁

`combinator` 的含义是**该维度子句与其余维度子句的连接算子**。若允许同一 scope 内混用（一维 `union`、一维 `intersection`），SQL 里就变成 `A AND B OR C`——按 `AND` 优先结合是 `(A AND B) OR C`，一个 `union` 维度**把整段条件吞掉了**。而配置界面上一行 `union` 看起来只是"这一维宽松些"。

| 规则 | 后果 |
|---|---|
| 同一 scope 内必须统一 | 由 `v_chk_scope_mixed_combinator` 巡检（跨行，进不了 `CHECK`） |
| 需要"A∩B 但 C 任取" | **拆成两个具名范围**（一个 A∩B、一个 C）同时授予。一个范围只表达一种收紧方式 |

**"按维度各配"的真正价值在 scope 之间**：集团 HR 一个 `union` 范围（宽）、门店 HR 一个 `intersection` 范围（窄），多范围之间是并集。这既表达了宽窄差异，又保住了"每个范围内部只有一种语义"。

### 6.0.3.5 只授了考勤组织时成本数据怎么办：**deny，不是 mask**

**结论：这一行成本数据根本不返回。不是返回 `8,***.00`，也不是 `null + _masked:true`。**

| # | 理由 | 展开 |
|---|---|---|
| 1 | **掩码的前提是"这行本来就该给你看"** | 掩码的语义是"有值，但你这个角色只能看一部分"（§4.3.3）。而这里用户根本不在 `cost_org` 的授权面内——**行不在授权面，任何字段都没有"该看"的基础**。把"无权"实现成"打了码的有权"，是把两件不同的事塞进同一个返回值 |
| 2 | **成本金额没有可用的掩码形态** | 金额掩码只有两种：`8,***.00`（信息量为零）和区间 `[8000,9000]`（门店只有 3 个人时，区间 + 人数 ≈ 精确值）。**一个"打了码等于没打"的掩码，是自我安慰** |
| 3 | **deny 会把用户导向正确的申请路径** | 打码让人去申请"字段权限"，而他要的是"成本组织这个维度"。deny 让他找对的人要对的授权 |

**那店长要管本店人工成本怎么办？——给聚合出口，但聚合出口不是后门**

店长在 `10` §2.2 里**本来就授了 `cost_org = 本店`**，所以既能看到本店成本数，也能看到本店合计。这是一个**已配置的授权**，不是绕过规则。

反过来说死：**`v_store_monthly_cost` 这类聚合资源的行闸维度也是 `cost_org`**。所以"只有考勤组织授权、没有成本组织授权"的人，**连门店级聚合成本都看不到**。想看到必须显式授予 `cost_org`。

> 这条不写死，"聚合"就会变成万能后门：先做一个不带行闸的汇总视图，再让所有报表走它，最后所有数据权限形同虚设。**聚合是"粒度变粗"，不是"权限变松"**。RL8 的 `count >= 5` 防的是"用小样本反推个人"，它防不了"根本没授权却拿到门店合计"——那要靠这里。

**新增的 deny 表（这是与泛微/钉钉最大的能力差）**

```sql
CREATE TABLE sys_permission_deny (
  id          bigint PRIMARY KEY,
  role_id     bigint NOT NULL REFERENCES sys_role(id),
  dimension   varchar(24),               -- 与 sys_data_scope_rule.dimension 同一词表；NULL = 与维度无关
  value_ids   bigint[] NOT NULL DEFAULT '{}',
  field_path  varchar(64),               -- NULL = 整行 deny；非 NULL = 只 deny 这个字段
  reason      text        NOT NULL,      -- ★ 必填：一条"绝对不给"的规则必须能解释
  granted_by  bigint      NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,               -- 撤销留行，不物理删除（列不回收）
  -- ★ 同上：不再二次枚举，FK 到 sys_perm_dim；NULL 仍允许（NULL = 整行 deny 不限维度）
  CONSTRAINT fk_deny_dim FOREIGN KEY (dimension) REFERENCES sys_perm_dim(code)
);
```

**三条语义，缺一条这条规则就会失效：**

| 语义 | 说明 |
|---|---|
| **deny 压过一切 allow** | 包括：其他角色给的 allow、**审批节点级放宽**、MCP 层、导出 |
| **deny 不分出口** | 没有 `scene` 列，是刻意的。一处 deny 处处 deny；若允许"导出时不 deny"，等于给自己留了一个后门参数 |
| **deny 命中时是 deny，不是 hidden** | 整行不见（行不在结果集里），不是"字段为空"。理由同本节第 1 条 |

> **为什么 deny 必须在模型里、不能靠"别配那条 allow"**：500 门店、人多角色杂，"确保没有任何一条规则命中他"是一件无法验证的事——你只能证明"我配的规则都不命中他"，不能证明"没有别人给他配过"。**能靠"没人配过"保证的安全，不是安全。**

### 6.0.3.6 `sys_perm_resource`：管辖维度由资源说，不由查询说

```sql
CREATE TABLE sys_perm_resource (
  resource_code   varchar(64) PRIMARY KEY,   -- 'employment' | 'payroll_record' | 'attendance_daily' | 'v_store_monthly_cost'
  name            varchar(128) NOT NULL,
  row_gate_dims   text[] NOT NULL,           -- 行闸维度；空数组 = 不受行级数据范围管辖
  temporal_basis  varchar(16) NOT NULL,      -- FACT_SNAPSHOT | CURRENT（裁决五）
  fact_date_column varchar(64),              -- FACT_SNAPSHOT 时按哪一列取时点
  export_permission_code varchar(96),        -- 导出所需权限点；NULL = 该资源结构上不可导出
  default_field_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT ck_pr_dims CHECK (row_gate_dims <@
    ARRAY['payroll_legal_entity','si_entity','cost_org','attendance_org']::text[]),
  CONSTRAINT ck_pr_temporal CHECK (
       temporal_basis = 'CURRENT'
    OR (temporal_basis = 'FACT_SNAPSHOT' AND fact_date_column IS NOT NULL))
);

INSERT INTO sys_perm_resource VALUES
 ('employment','员工任职',              ARRAY['payroll_legal_entity','cost_org','attendance_org'],'FACT_SNAPSHOT','hire_date', 'employee.profile.export','{"id_card_no":"masked","account_no":"masked"}'),
 ('payroll_record','工资明细',          ARRAY['payroll_legal_entity'],                            'FACT_SNAPSHOT','period_month', NULL,                  '{"si_base":"masked","net_amount":"masked","account_no":"masked"}'),
 ('attendance_daily','考勤人日',        ARRAY['attendance_org'],                                  'FACT_SNAPSHOT','work_date',    'attendance.daily.export','{}'),
 ('v_store_monthly_cost','门店月度成本', ARRAY['cost_org'],                                        'FACT_SNAPSHOT','period_month', NULL,                  '{}'),
 ('sys_dict','字典与配置',              ARRAY[]::text[],                                            'CURRENT',     NULL,           NULL,                  '{}');
```

三处值得单说：

| 列 | 为什么是这个设计 |
|---|---|
| `row_gate_dims` 必须**显式**声明，不能默认"四维全管" | 默认全管会让 `payroll_record` 因为"考勤组织无授予"对所有人不可见——一个配错让整个模块空白，且排查方向全跑偏 |
| `default_field_policy` 按资源存，**不设全局一个默认值** | `10` §2.3 明确六个字段默认不可见，而 `§4.3.3` 写的是"默认 PARTIAL"。两者都对，只是**粒度不同**：全局缺省 masked，高敏字段在资源上覆写 |
| `export_permission_code = NULL` **= 结构上不可导出** | 不是"没配权限所以不让导"，是**这个资源没有导出通道**。两者在客诉现场完全不同：前者"你申请就有"，后者"这个功能不存在" |

### 6.0.3.7 落地：维度化临时表 + 每维度一个 `EXISTS`

#### 维度词表的**唯一来源**：`sys_perm_dim`

```sql
-- ★ 全库只有这一处定义"有哪些权限维度"。fk_dsr_dim / fk_deny_dim 一律 REFERENCES 它，
--   函数体按 kind 分支，**不按具体 dimension 字面量分支**。
CREATE TABLE sys_perm_dim (
  code      varchar(24) PRIMARY KEY,      -- payroll_legal_entity | si_entity | cost_org | attendance_org | person
  kind      varchar(8)  NOT NULL CHECK (kind IN ('org','entity','person')),   -- ★ 只有三类，这是分支的依据
  label     varchar(64) NOT NULL,
  is_active boolean     NOT NULL DEFAULT true
);
INSERT INTO sys_perm_dim(code, kind, label) VALUES
  ('payroll_legal_entity','entity','发薪法人'),
  ('si_entity',           'entity','社保主体'),
  ('cost_org',            'org',   '成本组织'),
  ('attendance_org',      'org',   '考勤组织'),
  ('person',              'person','指定人员');
```

**为什么必须收敛成一张表，而不是在三处各写一遍 `IN (...)`**：`dimension` 此前被二次枚举了七处（两个 `CHECK`、allow 的两个 `IF/ELSIF`、deny 的两处分支、两个悬空值巡检），后果是**同一个维度在约束里合法、在函数里不存在**——`payroll_legal_entity` / `si_entity` / `person` 三个维度的 deny **配得进去、界面合法、求值时静默跳过**。而漏的方向永远是**多给权限**。收敛到 `sys_perm_dim` + 按 `kind` 分支之后，**新增一个维度只需要插一行，不需要改函数**——这是唯一能根治"新增维度忘了改函数"的做法。

> **两套词表必须改名分开，且不建映射表。** 组织架构图的 `dimension`（`PRIMARY|SCHEDULE|ATTENDANCE|COST`）只影响 `stats` 取哪一列，**不参与权限**，改名为 `stat_dim`。关系只有两句、写在文档里：`stat_dim='COST' ⇒ 权限维度 cost_org`、`stat_dim='ATTENDANCE' ⇒ 权限维度 attendance_org`；`PRIMARY` / `SCHEDULE` **不参与权限**。**不建映射表**：映射表会变成"没有写入路径的第二份真相"，两侧各自演化、不一致时没有任何东西会红——改名是一次性成本，映射表是永久成本。

#### 四张临时表

```sql
CREATE TEMP TABLE tmp_scope_org (        -- kind='org'    → cost_org / attendance_org
  dim_code varchar(24) NOT NULL, org_id bigint NOT NULL
) ON COMMIT PRESERVE ROWS;
CREATE TEMP TABLE tmp_scope_entity (     -- kind='entity' → payroll_legal_entity / si_entity
  dim_code varchar(24) NOT NULL, entity_id bigint NOT NULL, si_city varchar(32)
) ON COMMIT PRESERVE ROWS;
CREATE TEMP TABLE tmp_scope_emp (        -- kind='person'
  dim_code varchar(24) NOT NULL, emp_id bigint NOT NULL
) ON COMMIT PRESERVE ROWS;
CREATE TEMP TABLE tmp_scope_deny (       -- deny 面：与 allow 面**同粒度**的独立集合，求值时排除
  dim_code varchar(24) NOT NULL,
  org_id bigint, entity_id bigint, emp_id bigint,
  CHECK ((org_id IS NOT NULL)::int + (entity_id IS NOT NULL)::int + (emp_id IS NOT NULL)::int = 1)
) ON COMMIT PRESERVE ROWS;
```

#### 函数（唯一实现；两参数旧版已删除，见 §4.3.2）

```sql
CREATE OR REPLACE FUNCTION app_begin_scope(
  p_user bigint, p_resource varchar,
  p_fact_from date               -- ★ 无默认值，断言要求 pronargdefaults = 0（v1.9 修正，理由见下）
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''              -- ★ 空，不是 pg_catalog, public；因此 temp 表一律写 pg_temp.
AS $$
DECLARE v_temporal varchar(16); v_as_of date; v_unsupported text; r record;
BEGIN
  TRUNCATE pg_temp.tmp_scope_org;   TRUNCATE pg_temp.tmp_scope_entity;
  TRUNCATE pg_temp.tmp_scope_emp;   TRUNCATE pg_temp.tmp_scope_deny;

  SELECT temporal_basis INTO v_temporal FROM public.sys_perm_resource
   WHERE resource_code = p_resource AND is_active;
  -- ★ 未登记的资源直接拒绝：默认放行是权限系统唯一不可接受的默认值
  IF v_temporal IS NULL THEN
    RAISE EXCEPTION 'E_RESOURCE_UNREGISTERED: 资源 % 未在 sys_perm_resource 登记', p_resource;
  END IF;
  -- ★ 按事实时点判定的资源必须传日期；忘了传就静默变成"按当前判定"
  IF v_temporal = 'FACT_SNAPSHOT' AND p_fact_from IS NULL THEN
    RAISE EXCEPTION 'E_FACT_DATE_REQUIRED: 资源 % 按事实时点判定，必须传 p_fact_from', p_resource;
  END IF;
  v_as_of := COALESCE(p_fact_from, current_date);   -- 判定日显式推出，不用 now()（§4.5.5）

  -- ★★ 维度支持性守卫：kind 只有三值，任何越界 kind 必须炸。
  --    不用 CASE ... ELSE NULL 兜底——ELSE 是隐式枚举，下一个新维度会静默落进某条分支，
  --    而"没被允许的配置被当成另一件事执行"与本项目其他隐性失效同形。
  SELECT string_agg(DISTINCT d.code, ',') INTO v_unsupported
    FROM public.sys_perm_dim d
   WHERE d.kind NOT IN ('org','entity','person');
  IF v_unsupported IS NOT NULL THEN
    RAISE EXCEPTION 'E_PERM_DIM_UNSUPPORTED: 维度 % 的 kind 无对应分支', v_unsupported;
  END IF;

  -- ① allow 面：按 kind 分支（不按 dimension 字面量分支 → 新增维度不用改函数）
  FOR r IN
    SELECT ru.dimension, ru.value_type, ru.value_ids, dm.kind
      FROM public.sys_user_role ur
      JOIN public.sys_data_scope_rule ru ON ru.data_scope_id = ur.data_scope_id
      JOIN public.sys_perm_dim dm        ON dm.code = ru.dimension
     WHERE ur.user_id = p_user
       AND ur.superseded_by IS NULL
       AND daterange(ur.effective_from, ur.effective_to, '[)') @> v_as_of   -- 生效类右开（§3.0b）
  LOOP
    IF r.kind = 'entity' THEN
      INSERT INTO pg_temp.tmp_scope_entity(dim_code, entity_id)
      SELECT r.dimension, x FROM unnest(r.value_ids) x;
    ELSIF r.kind = 'org' THEN
      IF r.value_type = 'node_subtree' THEN
        INSERT INTO pg_temp.tmp_scope_org(dim_code, org_id)
        SELECT r.dimension, o.id FROM public.org_unit o
         WHERE EXISTS (SELECT 1 FROM public.org_unit p
                        WHERE p.id = ANY(r.value_ids) AND o.path LIKE p.path || '%');
      ELSE
        INSERT INTO pg_temp.tmp_scope_org(dim_code, org_id)
        SELECT r.dimension, x FROM unnest(r.value_ids) x;
      END IF;
    ELSIF r.kind = 'person' THEN
      INSERT INTO pg_temp.tmp_scope_emp(dim_code, emp_id)
      SELECT r.dimension, x FROM unnest(r.value_ids) x;
    ELSE
      -- 不可达：上面的守卫已把越界 kind 炸掉。留这一支是为了让"新增 kind 忘了加分支"变成运行期异常，
      -- 而不是静默取不到数据（后者表现为"配了什么都看不到"，排查会先怀疑配错）。
      RAISE EXCEPTION 'E_PERM_DIM_UNSUPPORTED: 维度 % kind=%', r.dimension, r.kind;
    END IF;
  END LOOP;

  -- ② deny 面：**与 allow 面同源**（都从 p_user 派生），且**五个 kind 全覆盖**
  --    任何"由调用方提供角色集合"的写法都等于把最严的约束交给最松的输入。
  INSERT INTO pg_temp.tmp_scope_deny(dim_code, org_id, entity_id, emp_id)
  SELECT d.dimension,
         CASE dm.kind WHEN 'org'    THEN x END,
         CASE dm.kind WHEN 'entity' THEN x END,
         CASE dm.kind WHEN 'person' THEN x END
    FROM public.sys_permission_deny d
    JOIN public.sys_user_role ur ON ur.role_id = d.role_id
    JOIN public.sys_perm_dim  dm ON dm.code   = d.dimension
    CROSS JOIN LATERAL unnest(d.value_ids) x
   WHERE ur.user_id = p_user
     AND ur.superseded_by IS NULL
     AND daterange(ur.effective_from, ur.effective_to, '[)') @> v_as_of
     AND d.field_path IS NULL        -- 字段级 deny 由 resolve_field_policy 另判（§6.0.5）
     AND d.revoked_at IS NULL;
END;
$$;
```

**deny 为什么是独立集合 + 求值时 `NOT EXISTS`，而不是"从 allow 集合里删掉"**

上一版的做法是 `DELETE FROM tmp_scope_org t USING tmp_scope_org d …` 自删自连接。它看起来更省事，实际有三个问题：① deny 从"一条规则"退化为"allow 里少了几行"，**事后无法回答"这个人被 deny 了什么"**；② 自连接在 `dim_code + org_id` 上删除，一旦两个维度共享同一个 `org_id`，会跨维度误删；③ `si_entity` / `person` 两个维度没有对应的 allow 行可删，**deny 在这两维上无处落地**。所以改为独立集合，业务 SQL 里 allow 与 deny 各写一个谓词——**两个集合、两条谓词、都可单测**。

**（v1.9 修正：本节原论证已被推翻，`DEFAULT NULL` 已删）**

原来的论证是：留着 `p_fact_from date DEFAULT NULL`，让"两参数旧调用"与旧的 `(bigint,varchar)` 签名产生 `function ... is not unique` 歧义，于是旧调用点会报错——**报错就是普查结果，比 grep 可靠一个量级**。

这段论证成立的前提是**两个函数共存**：

```
旧 (bigint,varchar) + 新 (bigint,varchar,date DEFAULT) → 两参数调用歧义 → 报错（保护生效）
```

**而同一节的断言要求 `count(*) = 1`——只剩一个函数。** 只剩一个时，上面那行的前提消失了：

```
只有一个 (bigint,varchar,date DEFAULT) → app_begin_scope(1,'R') 不歧义、不报错 → 取 NULL → 静默按当前判定
```

于是这两件事互斥，而文档同时写着两件：

| 做法 | `count = 1` 断言 | 旧调用点会怎样 |
|---|---|---|
| 留着默认值（原设计） | **红** | 报歧义错（保护生效） |
| 删掉旧函数（断言要求的纠错动作） | 绿 | **静默取 NULL，保护消失** |

**这条断言用红色指示人去删掉它本来要保护的东西。** 差别在责任落点：如果只是"文档写矛盾了"，改句子；但这里是**纠错路径本身通向反面**——只要还有人为了让断言变绿而删旧函数，保护就一定会被删掉一次。

**所以改为删默认值、断言 `pronargdefaults = 0`。** 旧两参调用报 `function ... does not exist`，比 `not unique` 更直白，且**不依赖两个函数共存**。代价是 `p_fact_from` 对非 `FACT_SNAPSHOT` 资源也要显式传 `NULL`——**而这正是要的效果：每个调用点被迫改写一次，普查靠编译器而不是 grep。**

它同时给出一条可复用的体检判据，适用于本册全部断言（§4.5 注册表）：

> **每条断言都要能回答"它红了之后，最省事的改法是什么"。** 答不出，或者答案会削弱保护，它比没有更危险——因为它还占着"我已经检查过了"这个位置。

所以这条约束落成断言（§4.5 注册表）：

```sql
-- 入口函数五条件断言：必须恰好一行、在 public、无默认值、函数体保留两个拒绝码
SELECT count(*) = 1                                        AS only_one,
       bool_and(n.nspname = 'public')                      AS in_public,
       bool_and(p.pronargdefaults = 0)                     AS no_default,
       bool_and(p.prosecdef = false)                       AS not_definer,
       bool_and(p.prosrc ~ 'RAISE[^;]*E_RESOURCE_UNREGISTERED'
            AND p.prosrc ~ 'RAISE[^;]*E_FACT_DATE_REQUIRED') AS body_intact
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.proname = 'app_begin_scope';
```

> **`prosrc` 那一条只能挡"被换空壳"，挡不住"注释里留了一行"**（`-- 曾会 RAISE E_RESOURCE_UNREGISTERED` 就能骗过 LIKE）。所以必须配一个**动态探针**：`SELECT app_begin_scope(1, 'zz_unregistered_probe', NULL)` 期望抛 `E_RESOURCE_UNREGISTERED`，且**探针要先跑阳性对照**——否则一个把异常吞掉的实现会让探针永远通过，而"永远通过"与"从没检查过"在记录上同形。该函数只写会话临时表，跑探针不动真实数据，可以进 CI。
>
> **`SET search_path = ''` 的理由不是提权，是"打空"**：`TRUNCATE tmp_scope_org` 若解析到另一张同名表，真正的临时表里残留的是**上一次请求**的授权，症状是"某人看到不该看的"，而这次请求在日志里完全正常。空路径让"忘记写限定名"变成**运行时错误**，把"解析到错误对象"降级为"直接失败"。`pg_catalog` 有隐式搜索路径，`now()` / `count()` 照常解析。


> `all` / `none` / `self` / `person` 四种 `value_type` 的处理在上面的主干里省略了（`all` 灌满全量、`none` 不灌、`self`/`person` 写员工级临时表）。**`none` 与 deny 的区别**要写清：`none` 是"这个范围在这一维不授权"，只在 `union` 组合下有意义；`deny` 是"不管谁给了 allow 都不给"，**压过一切**。两者都表达"不给"，但一个可被别的 allow 覆盖、一个不能——所以两个都留着，且必须在配置界面上分开呈现，否则实施会只用一个。

**业务 SQL 的统一写法（每维度一个 `EXISTS`，可机检）**

```sql
-- 考勤人日：受 attendance_org 管辖，按事实时点判（用快照列，不用 snap_org_id）
SELECT d.* FROM attendance_daily d
 WHERE d.work_date BETWEEN #{from} AND #{to}
   -- ① allow：任一班段在范围内 → 整行人日可见
   AND EXISTS (SELECT 1 /* dim:attendance_org */ FROM attendance_daily_store ds
                JOIN pg_temp.tmp_scope_org s
                  ON s.dim_code = 'attendance_org' AND s.org_id = ds.snap_attendance_org_id
               WHERE ds.attendance_daily_id = d.id)
   -- ② deny：任一班段命中 deny → 整行人日不可见（与 ① 同粒度、同列）
   AND NOT EXISTS (SELECT 1 /* deny:attendance_org */ FROM attendance_daily_store ds
                     JOIN pg_temp.tmp_scope_deny n
                       ON n.dim_code = 'attendance_org' AND n.org_id = ds.snap_attendance_org_id
                    WHERE ds.attendance_daily_id = d.id);
```

**deny 命中"任一班段"就整行人日不可见——这是刻意的，后果必须写出来**

`attendance_daily` 是**判定单元**，它没有分段行可给（分段在 `_store` 表），所以"部分可见"在这个粒度上**根本无法表达**。而 deny 的语义是"压过一切 allow"。于是：

> A 店店长（allow A、deny B），员工当天在 A 出勤 4h、在 B 出勤 4h → **查询返回 0 行**，连 A 店的 4h 也看不到。不是 4h，不是 8h。

这条必须配一个负样本进验收清单，**否则实施会以为它是 bug 而去"修"它**——把它"修"成 4h 的那一刻，B 店的 4h 也就跟着变成了可见的 4h 差额。

**deny 侧不得用 `attendance_daily.primary_store_id`**：那一列是"当日工时最大者"的**统计结果**，与 allow 侧的 `snap_attendance_org_id`（班段级归属事实）在**粒度、语义、可空性、稳定性**四层都不同——最硬的是稳定性：`primary_store_id` 随重算而变，用它做权限谓词等于**同一行数据的可见性随重算而变，而两次都"有依据"**。

**可机检判据**：权限谓词里出现的列名，与聚合表（`attendance_daily` 上的汇总列清单）求交，**交集非空即红**。这条能直接扫出来，不依赖人记得。

三处与 §4.3.2 的差异，都是把"可能写错的地方"从人手上拿掉：

| 旧写法（§4.3.2） | 新写法 | 为什么必须改 |
|---|---|---|
| Java 里判断集合空不空，空了就不拼条件 | **SQL 里写死 `EXISTS`，空集自然 0 行** | `AND 1=0` 的兜底仍在，但它依赖"有人记得写"。`EXISTS` 不依赖任何人——**空集就是 0 行，这是 SQL 语义，不是约定** |
| 一个 `tmp_scope_org` 混装四种维度 | **按维度分列** | 混装后业务 SQL 无法表达"我只按成本组织过滤" |
| 拦截器只扫"SQL 里有没有出现临时表名" | **扫 `/* dim:XXX */` 标记是否覆盖资源声明的每个行闸维度**，并单独扫 `/* deny:XXX */` | 旧做法出现一次就算过；一个资源三个行闸维度时，漏了两个照样通过 |

### 6.0.3.7b 一条必须写出来的能力边界（不是自我批评，是给客户的判断依据）

上面整套机制有一个前提：**它约束的是"应用层能查什么"，不约束"谁能连数据库"。**

> 持有数据库 `app_role` 凭据的人，可以自己 `INSERT` 到 `pg_temp.tmp_scope_*`（临时表是他自己会话的，不受授权约束），也可以绕过应用直接 `SELECT` 基表。**这不受三轴权限约束，一行都不受。**

由此三条硬约束（缺一条，上面的机制就有洞）：

1. **`app_role` 凭据不得下发给业务侧**，也不得用于报表工具/BI 直连、ETL 之外的任何用途；
2. **`pg_temp.tmp_scope_*` 只有应用账号能写**——它们本来就是会话临时表，真正的落点是"谁能拿到那个会话"；
3. **所有断言在"应用进程已被攻破"的前提下全部失效。验收报告必须写明这一前提**，否则报告给人的安全感超过它提供的保证。

**这是所有内网 B/S 系统的共性边界**，写出来是为了让客户在"谁能连数据库"这件事上有明确判断依据。不写清之后，第一次出事的归因会落在权限引擎上，而权限引擎是对的。

**顺带补一条不在任何表/列 ACL 清单里的 ACL**（§8.2b 的三张之外）：

```sql
-- database 级 TEMPORARY 权限：默认授予 PUBLIC，不在任何表/列 ACL 报告里
SELECT datname, datacl FROM pg_database WHERE datname = current_database();
-- 它决定"一个只读账号能不能把数据搬进临时表再 COPY TO 出去"
-- 处置：REVOKE TEMPORARY ON DATABASE <db> FROM PUBLIC; GRANT TEMPORARY ON DATABASE <db> TO app_role;
```

**只审计表 ACL 的报告看不到这一条**，而它是"只读账号"这个说法能不能成立的判据。

### 6.0.3.8 ★ 人日行可见 ≠ 人日汇总值可见（补上列还不够，漏还在）

补了 `snap_attendance_org_id` 只是让过滤能对上维度。`attendance_daily_store` 是**一人一天多段**（A 店 4h + B 店 4h），`attendance_daily` 是**判定单元**、只有 `UNIQUE(employee_id, work_date)`。用 `EXISTS` 判人日可见时，只要**任一段**在范围内，整行人日可见——但人日上的时长是**两段之和**，于是 A 店店长看到 8 小时，其中 4 小时不是他店里的。

这不是权限宽严问题，是**把人日行当成了"这个人的一天"，而它其实是"这个人所有段的合计"**。

**三条处置，全部落进实现要求：**

| # | 规则 |
|---|---|
| 1 | **人日行可见判定 = `EXISTS` 任一段在范围内**（保留，否则支援员工在自己店里查不到任何考勤） |
| 2 | **人日上的汇总时长不得由 `attendance_daily` 直接返回**。凡涉及汇总时长/金额的资源，必须 `JOIN attendance_daily_store` **先按可见段过滤、再聚合**，口径是"可见段求和" |
| 3 | 唯一汇总出口是 **`v_daily_metric_scoped`**（见下）。`v_daily_metric` 只供内部重算与断言使用，业务与报表禁止引用 |

```sql
CREATE VIEW v_daily_metric_scoped WITH (security_invoker = true) AS
SELECT d.employee_id, d.work_date,
       sum(s.work_hours)          AS work_hours,
       sum(s.in_attendance_hours) AS in_attendance_hours,
       sum(s.break_on_duty_hours) AS break_on_duty_hours
  FROM attendance_daily d
  JOIN attendance_daily_store s ON s.attendance_daily_id = d.id
 WHERE EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org t
                WHERE t.dim_code = 'attendance_org' AND t.org_id = s.snap_attendance_org_id)
   AND NOT EXISTS (SELECT 1 FROM pg_temp.tmp_scope_deny n
                    WHERE n.dim_code = 'attendance_org' AND n.org_id = s.snap_attendance_org_id)
 GROUP BY d.employee_id, d.work_date;
```

**机检与 `/* dim:xxx */` 共用同一个拦截器**：`ScopedSqlGuard`（MyBatis `Interceptor`，§4.3.2 已引入的同一个类）跑两遍——第一遍查维度标记覆盖，第二遍查"是否直接引用了判定单元表的汇总列"。判据：`@Scoped(resource=...)` 的资源若 `row_gate_dims` 含组织维度，则 SQL 中不得出现 `attendance_daily.{work_hours, ot_*_hours, in_attendance_hours, attendance_days, payroll_days, leave_hours}`，除非同时 JOIN 了 `attendance_daily_store` 并带 `/* dim:attendance_org */`。

**后果边界要写清**：**"看到的数小于真实数"是唯一可接受的错法，"大于"一律算越权。** 所以聚合口径默认取窄，不允许为对账方便取宽。

### 6.0.3.9 巡检视图与迁移

**`sys_data_scope` 是"多行组成的整体"，行级触发器判不了"整体非空"**（先删后插的中间态会误报），所以用巡检视图——与 §3.3.8 对"跨表守恒"的处理手法一致。除 §6.0.3.2 已建的两个，再加：

```sql
CREATE VIEW v_chk_scope_dangling AS        -- 期望：空集（范围指向已撤销的法人/组织）
SELECT ru.id, ru.data_scope_id, ru.dimension, x AS missing_id
  FROM sys_data_scope_rule ru, unnest(ru.value_ids) x
 WHERE ru.dimension IN ('cost_org','attendance_org')
   AND NOT EXISTS (SELECT 1 FROM org_unit o WHERE o.id = x)
UNION ALL
SELECT ru.id, ru.data_scope_id, ru.dimension, x
  FROM sys_data_scope_rule ru, unnest(ru.value_ids) x
 WHERE ru.dimension IN ('payroll_legal_entity','si_entity')
   AND NOT EXISTS (SELECT 1 FROM legal_entity e WHERE e.id = x);
```

> **范围不挂物理外键是刻意的**：组织与法人**会停用不会删除**（03 §3.2），但历史范围指向一个已停用组织是合法的。用巡检视图区分"停用（合法，只提示）"与"悬空（非法，必须修）"，而不是用 FK 把两者一起禁掉。

**迁移三条**（与 §9.5b 同一套做法）：① 先建两张新表、不删旧列；② 迁移脚本把 `org_ids_json` 按原 `scope_type` 拆成 `cost_org` 与 `attendance_org` 两行——**这一步必须人工确认**，旧数据本来没区分，脚本给不出原意，只能给"疑似"清单让人勾；③ 三个废弃列保留并加 `COMMENT ... DEPRECATED`，**不物理删除**（删列会打断回滚路径，与 §9.5 冲突）。

## 6.0.4 裁决二：字段权限的两个来源——**节点只收窄，不许放宽**

### 6.0.4.1 两个来源分别回答什么问题

| 来源 | 表 | 时间界 | 对象界 | 回答 |
|---|---|---|---|---|
| 角色级 | `sys_field_permission` | 永久 | 全域 | "你这个人，长期能看/能改什么" |
| 节点级 | `sys_node_field_policy` | 单据在途期间 | 只有这一张单 | "在这张单的这一步，字段**必须收窄到什么程度**" |

**为什么必须有两个来源**：审批场景里存在一种合法需求——某字段对角色长期不可见，但在这张单的这一步**由这个人填**。只有角色级，就只能给角色开永久权限（开完关不掉）；只有节点级，则任何一张单都能临时放开任何字段（等于没有权限）。

### 6.0.4.2 四态 `action`，以及它刻意牺牲掉的那一格

```sql
action varchar(16) NOT NULL   -- visible | masked | editable | required
```

顺序即格序：`hidden < masked < visible < editable`，`required` 单独一格。

> **这一格是刻意牺牲的**：`visible/readonly/hidden/required` 原本是**三条轴**（可见性 / 可写性 / 必填）的投影，压成一个枚举后，"可见但不可写地必填"这种组合就表达不出来。取舍的理由是**一条可比较、可排序、能进 `CHECK` 的列，比三条各自可空的列更不容易被写错**——而写错的方式几乎总是"只填了一条"。代价由两条约束兜住：
> ① `required` **只允许出现在节点级**（角色级填 `required` 没有意义，`CHECK` 拒绝）；
> ② `required` **隐含 `editable`**，因此同一字段上不允许同时用 `required` 表达"必填"、又用另一列表达"只读"——`sys_node_field_policy` 恒无 `editable`（见 §6.0.4.5）。

配套还有一条从钉钉身上学到的具体差异：钉钉的审批节点字段权限只有三态，**没有 `required`**，这是它被用户投诉最多的一条。我们的 `required` 要区分**发起节点必填**（提交时校验）与**中间节点补录必填**（该节点动作时校验）——同一个词在两张单上校验时机不同，不写清就会实现成"第一步就要求所有节点的必填项齐全"，用户当场卡住。

### 6.0.4.3 判定序（固定，可指认）

```
resolve_field_policy(principal, resource, field, scene):
  1  role    ← 角色级 action（principal 的**全部角色**取最严；无配置 → 资源声明档，缺省 masked）
  2  deny    ← 命中 sys_permission_deny(field_path = field) ? deny
  3  node    ← ctx 有节点上下文 ? 节点级 action : NULL
  4  final   ← deny                        ? hidden                       -- ★ 第 1 裁决点：deny 最先
             : node = NULL                 ? role
             : 更严(role, node)                                            -- ★ 第 2 裁决点：∩ 不是覆盖
  5  final   ← capByScene(final, scene)                                   -- ★ 第 3 裁决点：出口收紧
  6  return final
```

**第 1 裁决点：deny 最先，且压过节点级放宽**

这是 team-lead 给的裁决，也是与泛微/钉钉最大的能力差。**deny 在模型里，不在"别配那条 allow"里**——见 §6.0.3.5 最后一段。

**第 2 裁决点：`∩` 不是覆盖——节点级只能收窄**

```
最终 = role_policy ∩ node_policy      -- 取更严的那一个
```

`∩` 与"覆盖"的差别不是实现细节，是**权限会不会随单据流动**：

| 若用"覆盖"（节点级可放宽） | 用 `∩`（只收窄） |
|---|---|
| 谁被指派到这个节点，谁就在这张单上获得更宽的可见/可写 | 节点只能把明文降成掩码、把可写降成只读 |
| 审批人换人 → 权限跟着人变，且**换人这件事本身不留痕** | 换人不改变字段档 |
| 与钉钉"加签人继承加签者的字段权限"同一形态 | **我们不做继承**：加签人用自己的角色基线 |

**为什么"覆盖"看起来更合理**：直觉是"节点更细所以优先级更高"。但"更细的粒度可以更宽"这个推论只在**授权边界有界**时成立；而节点级的边界是"这张单"——加签、转交、代理都会改变"谁在这张单上"，于是**边界随人流动，等于没有边界**。

**第 3 裁决点：出口收紧（`scene`）**

见 §6.0.5。收紧档**写死在函数里，不可配置**——做成可配置，第一个来找你的人就是"能不能把 MCP 放宽一点"。

**多角色并存：取最严，不取最宽。** 能力取并、暴露取交。这是权限系统的标准非对称，写在这里是为了防止实施期有人"统一成并集"：暴露面的并集意味着"临时项目组只为了看三个人，却把长久的门店 HR 身份也放宽了"。

### 6.0.4.4 矛盾配置必须在发布时拒绝，不留到运行时

| 矛盾 | 何时发现 | 为什么不留到运行时 |
|---|---|---|
| 同一节点同一字段 `readonly` 与 `required` 并存 | **流程发布时静态校验** | 运行时才发现，表现是"这个节点永远过不去、按钮灰着"，排查方向完全跑偏 |
| 节点策略引用的 `resource`/`field_path` 在资源上不存在 | 同上 | 会静默不生效，而配置界面显示"已配置" |

### 6.0.4.5 存量表扩列与新增表

```sql
ALTER TABLE sys_field_permission
  ADD COLUMN scene   varchar(16) NOT NULL DEFAULT 'detail',  -- list|detail|export|mcp  ★ 必填无默认语义
  ADD COLUMN is_ceiling boolean  NOT NULL DEFAULT false,      -- 永久黑名单：deny 之外的第二道硬边界
  ADD COLUMN reason  varchar(200);
ALTER TABLE sys_field_permission
  DROP CONSTRAINT IF EXISTS sys_field_permission_role_id_resource_field_path_key;
CREATE UNIQUE INDEX ux_fp ON sys_field_permission (role_id, resource, field_path, scene);
-- mask_type（FULL|PARTIAL|HIDDEN）保留为兼容列，映射到 action：
--   FULL→visible  PARTIAL→masked  HIDDEN→hidden；迁移完成后 mask_type 标 DEPRECATED
-- 同时新增 action 列（不用 mask_type 的取值，避免两列同时决定同一件事）：
ALTER TABLE sys_field_permission
  ADD COLUMN action varchar(16),        -- list|detail|export|mcp 上的四态
  ADD CONSTRAINT ck_fp_action CHECK (action IN ('visible','masked','hidden','editable','required')),
  -- ★ 角色级不许出现 required（必填只在节点上有意义）
  ADD CONSTRAINT ck_fp_no_required CHECK (action IS DISTINCT FROM 'required'),
  ADD CONSTRAINT ck_fp_ceiling CHECK (NOT is_ceiling OR action = 'hidden');

CREATE TABLE sys_node_field_policy (
  id          bigint PRIMARY KEY,
  node_id     bigint NOT NULL REFERENCES sys_approval_node_def(id) ON DELETE CASCADE,
  resource    varchar(64) NOT NULL,
  field_path  varchar(64) NOT NULL,
  action      varchar(16) NOT NULL,   -- visible | masked | hidden | readonly | required  ★ 无 editable
  required_stage varchar(16),         -- SUBMIT | NODE（action=required 时非空）
  CONSTRAINT ck_nfp_action CHECK (action IN ('visible','masked','hidden','readonly','required')),
  -- ★ 节点不能放宽：没有 editable 这个取值，就是这条约束本身
  CONSTRAINT ck_nfp_stage  CHECK ( (action = 'required') = (required_stage IS NOT NULL) ),
  UNIQUE (node_id, resource, field_path)
);
```

> **`sys_node_field_policy` 里没有 `editable`，这不是遗漏，是裁决二的落地方式。** 要"这个节点能改这个字段"，做法是**角色级本来就有 `editable`、节点不降级**，而不是节点主动授予。少一个枚举值，比多一条"节点不得放宽"的校验规则可靠——后者会被下一个实施顾问当成"可以改的配置"。
>
> 外键指向 §6.0.8 的 `sys_approval_node_def`，**两张表必须同一批上线**。

## 6.0.5 裁决三：一个函数，四个场景

### 6.0.5.1 签名（唯一的字段权限入口）

```
FieldAction resolve_field_policy(Principal p, String resource, String field, Scene scene)

enum Scene { LIST, DETAIL, EXPORT, MCP }
```

`scene` 是**必填入参，不是可选**。没有它，"导出比查询更严"这条就落不了地。

**约束（ArchUnit 强制，不是自觉）**：
- `..field..policy..` 包之外不得出现 `action` / `mask_type` / `is_ceiling` 的读取；
- `FieldMasker` 只能被这个函数调用；`@Sensitive` 的序列化器只能从它的返回值取档；
- 前端不得自己判——任何类不得自行实现 `if (有权限) 明文 else 打码`。这条最容易在导出、报表、Excel 列宽计算里各自写一遍。

### 6.0.5.2 四个场景的差异，全部收敛到一个入参

| 场景 | 额外收紧 | 依据 |
|---|---|---|
| `LIST` | 按 §6.0.4.3 结果 | — |
| `DETAIL` | 按 §6.0.4.3 结果 | — |
| `EXPORT` | **`masked` 一律降为 `hidden`**，除非该角色有独立权限点 `data.export_unmasked`；且必须先取得 `sys_perm_resource.export_permission_code` | `10` §0.4 规则 1 |
| `MCP` | **`editable` 一律降为 `hidden`**（节点可编辑权绝不外露）；`masked` 保持 | §6.0.6.4 |

收紧档是**常量比较，不是再查一张表**——写死在函数里，因为它由架构决策定（§5.5 / RL8 / `10` 规则 1），不是可配置策略。

### 6.0.5.3 为什么导出必须走同一个函数

**导出是唯一把数据带出系统的出口**（`10` §0.4 规则 1）。若导出自己实现一套，失效形态是：

> 页面上看不到身份证号（掩码正确），导出全表有（另一套逻辑，默认取实体全字段）。

三个特点使它必须靠结构而非测试来防：① **页面测试永远是绿的**——测的是页面；② **不报错，只会多给**；③ **发现时机是离职带走花名册之后**。

两份外部调研给了正好一对反例：**泛微**的字段可见性在渲染期决定、脱敏在另一个模块、导出走第三条链——同一字段四处各判一次；**钉钉**是前端脱敏、后端 Excel 全量。这正是我们必须避开的形态。

### 6.0.5.4 结构性保障：导出器只接受已掩码的结构

| 保障 | 手段 | 时机 |
|---|---|---|
| 导出器拿不到实体 | `PoiWriter.write(List<Map<String,Object>> rows, ...)`——入参类型就是已序列化的 Map，**Entity 传不进去** | 编译期 |
| 报表拿不到个人字段 | `report_*` 只走 `MetricQueryService.query(code, params)`（§3.8.3），`metric_definition.formula` 里不含个人字段 | 编译期（无第二个入口） |
| MCP 拿不到明文 | `ToolResponse` 构造器只接受 `MaskedValue` 类型，`_raw` 字段不允许存在 | 编译期 |
| 四场景同一个序列化配置 | Web 与 Export 共用同一个 `ObjectMapper` 实例（同一个 `SerializerModifier`），**不允许各自 `new`** | 启动自检断言同一实例 |

### 6.0.5.5 加第五个场景要改几处

**一处**：`Scene` 枚举加一个值 + §6.0.5.2 加一行。函数体里没有第二个分支。

这是刻意的验收标准：**若实施时发现加一个出口要改三处，说明四出口统一没做成**——那就回到了"每个出口一套逻辑"，只是这次有文档说它是统一的。

## 6.0.6 裁决四：审批流与 AI 的结构性隔离

### 6.0.6.1 先看数字

**101 个 MCP 工具里，`approve_*` 类工具 0 个**（§5.3 全表清点）。本节要补的不是"再确认这个数字"，而是**这个数字靠什么结构长期成立**——因为"清单里没有"不是机制，下一版加工具时没人会记得。

### 6.0.6.2 四层保障，每层都回答"如果上一层失守"

| 层 | 手段 | 失守后的表现 |
|---|---|---|
| 工具注册层 | 动词表（`10` §0.3）里 `approve` 是封闭动词，但**只挂 Web Controller，`ToolRegistry` 不注册**；审批流引擎的入口**不在 `hr-mcp-gateway` 的路由表里**（不是"有工具但拦截"） | 网关侧 404 |
| **类型层** | `ApprovalService.approve(Long taskId, ApproverCapable p, String comment)`；`Principal` 是 sealed interface，**只有 `NaturalPersonPrincipal` 实现 `ApproverCapable`**，`ServiceAccountPrincipal` 不实现 | **编译期不可达**。想从 AI 路径调用，必须让 `ServiceAccountPrincipal` 实现 `ApproverCapable`——那一改会让所有服务账号都能审批，评审立刻看到 |
| 注入层 | 节点字段策略只能由 `NodeEditingContext` 读取，该 bean 不在网关可注入白名单（§5.2） | 即使拿到 Application bean 也拿不到节点上下文 |
| 审计层 | 任何 `actor_type='AI'` 的节点状态迁移在 `sys_audit_log` 里**没有合法写入路径** | 即使前三层被绕过，也留一条无法解释的日志 |

**为什么类型层是第三层而不是第一层**：只在工具注册层做（最常见的做法），一旦出现第二个网关（未来的开放 API、企业内部集成），必须记得"这个网关也不要注册 approve"。"记得"不是机制。`ServiceAccountPrincipal` 不实现 `ApproverCapable` 是**编译期事实**，新增任何网关都自动继承。

顺带这条也解决了 `10` §2.2 的"审批类第二签字不可用服务账号"——不需要一条要人每次评审去查的约定。`principal_type` 必须为 `NATURAL_PERSON` 与 `02g` I11.4 同源。

### 6.0.6.3 AI 能做的三件事（都不产生节点状态迁移）

| 能力 | 对应工具 | 产物 | 为什么安全 |
|---|---|---|---|
| **起草** | `*_draft_*` / `submit_*`（已有） | `sys_approval_instance.status='DRAFT'` | 草稿没有 `sys_approval_task` 行，**没有人的待办因此产生** |
| **预填** | 同上，字段值带来源 | 单据字段 + `formula_trace` | 人工复核时能看出"这数是系统算的还是人改的" |
| **解释驳回** | `gov_get_approval_status`（已有，只读） | 文本 | 读路径 + 生成文本，不写任何状态 |

### 6.0.6.4 节点字段策略绝不能是工具（裁决二与裁决四的交点）

裁决二定了**节点级只能收窄**——那么"能写节点字段策略"的破坏力反而更具体：**不是放宽单张单，而是把某个已存在节点的字段档改宽**，且改动落在流程定义里、不在数据访问日志里。**审计看到的是"设计变更"，不是"数据访问"。**

所以 `sys_node_field_policy` 的写入口只有 Web 流程设计器，**MCP 工具数为 0**。同理 `sys_role_permission` / `sys_data_scope_rule` / `sys_field_permission` / `sys_permission_deny` 也没有任何 MCP 写工具。

**权限配置与 License 同属"不可被 AI 触碰"的一类**（RL10 的范围据此扩展）。理由：权限是判权限的依据，一旦依据本身可被被判定者修改，其余所有红线都只是装饰。

## 6.0.7 裁决五：权限判定的输入是**事件时刻的四维快照**

### 6.0.7.1 一条主句，两条副句

```
判"能不能看到"  = 业务事件发生时刻的四维归属快照      ← 不用任何当前值
判"能不能操作"  = principal 当前授权                  ← 当前值只在这里出现
```

**"能不能操作"单独一条**，是因为它与"看到"是两个动作、两个时间点：交接期的人要能看历史单据才能收尾，但不能改（§6.0.3.2 的 `HANDOVER_READONLY`）。

### 6.0.7.2 为什么档案也按快照——我原先的"档案按当前"被推翻了

上一版我写的是"业务事实按当时、**人事档案按当前**"，判据是"看错误代价是否对称"。这个判据仍然成立，但**我把档案放错了类**：

| 场景 | "档案按当前授权"会得出什么 |
|---|---|
| 员工离职 | 离职后"当前授权"为空 → **原店长看不到自己签过字的东西** |
| 审计举证 | "谁批的、当时看到了什么"答不出来 |
| 交接期 | 新人接手看不到旧单，旧人已经没权限 |

**审计上不成立**——而这比"身份证号多给了一个人"更根本：审批的全部价值就是举证。所以结论改成：**业务事实与档案一律按事件时刻快照，只有"当前能不能操作"按当前授权。**

**那个人隐私的风险怎么兜？**——**时间性决定"行可见"，字段档决定"列可见"，两者正交**。原店长"能看这条档案"，但 `id_card_no` 在他的角色上仍是 `masked`，而 `is_ceiling` 的天花板（身份证全值、银行卡全值）**任何节点、任何时间都不放开**。所以"永久可见"这件事的边界由字段层独立管住，不需要靠收回行权限来管。

### 6.0.7.3 三条具体规则（team-lead 给的三条，逐条落判据）

| 场景 | 判据 |
|---|---|
| 员工 A→B 店，B 店长看 3 月（当时在 A 店）的考勤 | 按 **3 月快照**判 → B 店长**看不到**，A 店长**看得到** |
| 员工离职，原店长看离职前档案 | **看得到**，可见范围冻结在离职日快照，不随离职后任何变化变动 |
| 审批人调岗后看自己审批过的单据 | **看得到**——这是他自己的行为记录，不随其组织归属变化 |

第三条值得单说：它是**"按快照判"这个规则唯一的例外形式，而这个例外不需要特殊逻辑**——审批人识别走 `sys_approval_task.assignee_id`，本来就不经过组织维度。**组织维度管"这群人归谁管"，不管"谁签过字"。**

### 6.0.7.4 边界情形（表必须写，否则每条都会被问一遍）

| 情形 | 结论 | 为什么不是另一个 |
|---|---|---|
| 调动生效日在月中 | 工资按 `cost_org` **月末归属全额归新店**，新经理看到全额 | 与 §3.5.2 成本分摊同口径；按天拆会与分摊表不一致——**两张表对同一个月给出两个归属，是最难解释的一类差异** |
| 已封账期间 | 只读、按冻结快照，不因组织变动重算 | 封账的定义就是"不再变" |
| 未结单据（交接期） | 90 天**只读**（`HANDOVER_READONLY`），到期自动收回 | 只读防"人走了还改数据"；给只读防"交接期单据无人收尾"（`10` Q2 的真实痛点） |
| 审计与专项举证 | 走 `audit.query` **单独申请**，不靠历史管辖开口子 | 一旦"历史管辖"能开举证口子，它就变成常规查数据的入口 |
| 外包供应商 | 派驻期 + 12 个月（参数 `supplier_visibility_months`） | `10` Q3：结算争议几乎都发生在离职后，看不到就无法对账 |
| 组织重编（节点平移） | 按快照列，**不重算历史归属** | 重编是"以后怎么算"的变化，不是"以前算什么"的变化 |

### 6.0.7.5 机制：`temporal_basis` 由资源声明，事实日期必传

- `sys_perm_resource.temporal_basis` 决定用哪个时点解析授权面；
- `FACT_SNAPSHOT` 的资源，`app_begin_scope` 的 `p_fact_from` **必传**，不传抛 `E_FACT_DATE_REQUIRED`。**忘了传就静默变成"按当前判定"，这是最难发现的一类错**——它在测试环境里通常是对的（测试数据没有调动历史）；
- `payroll_record` 这类表**行自身就带冻结列**，它的 `FACT_SNAPSHOT` 不需要 join 任何历史表——这正是 §3.5.2 冻结成本分摊与 §3.3.5 十二个快照列的用处。**若当年没冻结，这里就得回查 `employee_org_assignment` 的历史，而历史回查在"支援/借调/代管"叠加时会给出不确定的答案。**

### 6.0.7.6 明确拒绝：不做"按当前组织回溯重算历史可见性"的开关

理由不是"实现麻烦"，是**它会把口径不一致伪装成权限配置问题**：两个人对同一份封账工资看到不同总额，而系统里**没有任何一处能解释差异**——差异不在数据里，在"谁开了这个开关、对谁开的"。这类问题在权限配置界面里无法自证，只能导出两份报表逐行比。

> 客户确实需要"新人接手要能看历史"时，正确做法是 §6.0.7.4 的交接期只读，**不是**改历史归属的判定基准。前者有到期时间，后者没有。

## 6.0.8 审批流定义模型（版本化 + 在途隔离）

> 本节只定义**表结构**与**版本冻结机制**。推进算法（会签清算、加签、转交、撤回、抄送、代理、催办、在途重路由）见下一批。

### 6.0.8.1 命名裁决：**保留 `sys_approval_template`，不引入 `sys_process_*`**

两份调研报告都用 `process_def` / `process_node` / `process_instance` 这套名字。**不采用**，理由三条，按重要性排：

| # | 理由 |
|---|---|
| 1 | `sys_approval_template` / `sys_approval_instance` / `sys_approval_task` **已经存在于 §3.8.2**，且被 `05` / `10` 引用。新起一套名字 = 同一概念两个物理位置，正是 `02g` I17.3 禁止的形态 |
| 2 | `02g` I15.2：标识一旦分配，语义永久绑死；要新语义就新标识，**旧标识永久占位**。这里是"同一语义、换个名字"，改名成本 4 份文档 + 测试用例，收益是"名字更像调研报告" |
| 3 | `template` / `instance` 这对名字的分工恰好够用：**`template` = 身份**（哪个业务、叫什么、启停），**内容**下放到版本表 |

**处置（写死，防止下一轮又按调研报告建表）**：

| 对象 | 处置 |
|---|---|
| `sys_approval_template` | **保留**。`node_json` / `condition_json` 标 `DEPRECATED`（留列，不回收），内容迁到版本表 |
| 新增版本表 | `sys_approval_flow_version`（内容） |
| 新增节点表 | `sys_approval_node_def`（节点，含节点字段策略挂载点） |
| `sys_process_def` / `sys_process_node` / `sys_process_instance` | **不落库，登记为 `sys_approval_*` 的不采用别名**（写进 §0.2b 第 25 行） |

### 6.0.8.2 三张表的 DDL

```sql
CREATE TABLE sys_approval_flow_version (
  id          bigint PRIMARY KEY,
  template_id bigint NOT NULL REFERENCES sys_approval_template(id),
  version_no  int    NOT NULL,
  status      varchar(16) NOT NULL,       -- DRAFT|PUBLISHED|RETIRED
  condition_json jsonb,                   -- 全局适用条件（按法人/门店/金额区间分支）
  definition_hash char(64) NOT NULL,      -- 冻结时整体摘要，防"发布后又被改"
  published_by bigint, published_at timestamptz, retired_at timestamptz,
  change_note varchar(500) NOT NULL,      -- 为什么改（审计与交接用）
  CONSTRAINT ck_afv_status CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  CONSTRAINT ck_afv_pub CHECK (status <> 'PUBLISHED' OR (published_by IS NOT NULL AND published_at IS NOT NULL)),
  UNIQUE (template_id, version_no)
);
CREATE UNIQUE INDEX ux_afv_one_draft ON sys_approval_flow_version (template_id) WHERE status = 'DRAFT';

CREATE TABLE sys_approval_node_def (
  id           bigint PRIMARY KEY,
  version_id   bigint NOT NULL REFERENCES sys_approval_flow_version(id) ON DELETE CASCADE,
  seq          int    NOT NULL,
  node_name    varchar(64) NOT NULL,
  node_type    varchar(16) NOT NULL,      -- ROLE|REPORT_TO|REPORT_TO_LEVEL|SPECIFIC_USER|INITIATOR_SELF
  sign_mode    varchar(16) NOT NULL,      -- ANY(或签)|ALL(会签)|SEQUENTIAL(顺序会签)
  approve_threshold numeric(4,2),         -- 会签通过比例；ALL 时 = 1.00
  approver_rule jsonb NOT NULL,           -- 只放"谁是审批人"
  role_codes   text[], report_to_levels int,
  condition_json jsonb,                   -- 进入本节点的条件（分支）
  allow_addsign boolean NOT NULL DEFAULT false,
  allow_transfer boolean NOT NULL DEFAULT true,
  allow_withdraw boolean NOT NULL DEFAULT true,
  timeout_hours int,                      -- 催办阈值（不是"超时自动通过"，见 §6.0.11.1）
  timeout_action varchar(16) NOT NULL DEFAULT 'REMIND',   -- REMIND|ESCALATE，★ 无 AUTO_APPROVE
  cc_json      jsonb,                     -- 抄送对象（只读，不产生 task）
  UNIQUE (version_id, seq),
  CONSTRAINT ck_and_type CHECK (node_type IN ('ROLE','REPORT_TO','REPORT_TO_LEVEL','SPECIFIC_USER','INITIATOR_SELF')),
  CONSTRAINT ck_and_sign CHECK (sign_mode IN ('ANY','ALL','SEQUENTIAL')),
  CONSTRAINT ck_and_thr  CHECK ( (sign_mode = 'ANY') = (approve_threshold IS NULL) ),
  CONSTRAINT ck_and_all  CHECK ( sign_mode <> 'ALL' OR approve_threshold = 1.00 ),
  -- ★ 结构上就没有"超时自动通过"这个取值
  CONSTRAINT ck_and_timeout CHECK (timeout_action IN ('REMIND','ESCALATE')),
  CONSTRAINT ck_and_remind  CHECK ( timeout_action IS NULL OR timeout_hours > 0 )
);
```

`ck_and_timeout` 这一行是刻意的：**枚举里没有 `AUTO_APPROVE`**。于是"客户要求超时自动通过"这件事，在数据库层就不可能靠改一行配置实现——必须改 DDL、过评审。

### 6.0.8.3 发布即冻结：用触发器，不用 `REVOKE`

与 §3.3.6 的字典行不可变**同一手法、同一理由**（`REVOKE` 对表属主无效，而迁移脚本正是以属主身份跑的）：

```sql
CREATE FUNCTION fn_flow_version_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('PUBLISHED','RETIRED')
     AND (NEW IS DISTINCT FROM OLD)
     AND (NEW.status, NEW.retired_at) IS NOT DISTINCT FROM (OLD.status, OLD.retired_at) THEN
    RAISE EXCEPTION 'E_FLOW_FROZEN: 版本 % 已发布，定义不可修改；要改请新建版本', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_afv_frozen BEFORE UPDATE ON sys_approval_flow_version
  FOR EACH ROW EXECUTE FUNCTION fn_flow_version_frozen();

CREATE FUNCTION fn_node_def_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status varchar(16);
BEGIN
  SELECT status INTO v_status FROM sys_approval_flow_version
   WHERE id = COALESCE(NEW.version_id, OLD.version_id);
  IF v_status IN ('PUBLISHED','RETIRED') THEN
    RAISE EXCEPTION 'E_FLOW_FROZEN: 所属版本已发布，节点定义不可增删改';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_and_frozen BEFORE INSERT OR UPDATE OR DELETE ON sys_approval_node_def
  FOR EACH ROW EXECUTE FUNCTION fn_node_def_frozen();
```

### 6.0.8.4 在途单据绑定版本与四维快照，不绑模板

```sql
ALTER TABLE sys_approval_instance
  ADD COLUMN flow_version_id  bigint REFERENCES sys_approval_flow_version(id),
  ADD COLUMN org_snapshot_id  bigint NOT NULL,   -- ★ 四维归属快照引用
  ADD COLUMN payload_snapshot jsonb,             -- 提交时的表单值快照（判"必填是否已填"）
  ADD COLUMN biz_key          varchar(128);      -- 业务自然键副本，便于跨版本追溯

ALTER TABLE sys_approval_task
  ADD COLUMN node_id  bigint REFERENCES sys_approval_node_def(id),
  ADD COLUMN act_kind varchar(16) NOT NULL DEFAULT 'APPROVE';  -- APPROVE|REJECT|ADD_SIGN|TRANSFER|WITHDRAW|CC_READ
```

**`org_snapshot_id` 是六处里最容易被省掉的一项。** 一张 3 月的调岗单，若只存"当前挂在哪个成本组织"，**半年后答不出"当时挂在哪个"**。泛微用"共享记录存组织节点 ID 快照"这个笨办法部分实现了历史归属，代价是"人级授权永久、组织级授权随组织实时漂移"——**这是它最难向客户解释的行为**。我们四维全 SCD2，所以绑的是**快照版本号**，不是快照副本。

**`payload_snapshot` 为什么必须有**：节点字段策略里的 `required` 要判"是否已填"。只存业务表的当前值，业务表被后续单据改动后"当时填了什么"就没了。这也是 `10` §C5「字段级审批」能成立的前提。

### 6.0.8.5 在途重路由与 `sys_approval_reroute_log`

外部系统的对应故障是两个真实的反面教材：**钉钉**在审批人离职后，在途单据**静默卡死**，官方只提供手工"流程交接"批量换人；**泛微**的离职三步是手工动作、不是强制卡点，少跑一步就是"人走了权限在"。

```sql
CREATE TABLE sys_approval_reroute_log (
  id                bigint PRIMARY KEY,
  instance_id       bigint NOT NULL REFERENCES sys_approval_instance(id),
  node_id           bigint REFERENCES sys_approval_node_def(id),
  event_type        varchar(16) NOT NULL,   -- termination|transfer|role_revoke|agent_expired|manual
  from_principal    bigint,
  to_principal      bigint,                 -- NULL = 挂起待指派
  rerouted_at       timestamptz NOT NULL DEFAULT now(),
  rerouted_by       bigint,                 -- NULL = 系统事件触发
  reason            varchar(500) NOT NULL,
  CONSTRAINT ck_arl_event CHECK (event_type IN ('termination','transfer','role_revoke','agent_expired','manual')),
  -- ★ 挂起必须留原因；转给人必须有承接人
  CONSTRAINT ck_arl_to   CHECK (to_principal IS NOT NULL OR reason IS NOT NULL)
);
```

三条硬规则：

| 规则 | 为什么 |
|---|---|
| **离职/调岗发生时，同一事务内扫在途实例并重路由**，不是定时任务 | 定时任务意味着中间那段时间的单据是死的，而"人已经走了、单还在他名下"正好是卡死 |
| **算不出承接人 → `to_principal IS NULL` 挂起 + 告警**，**不许自动通过、不许自动跳过** | 钉钉的"审批人为空时自动通过"是我们要明确拒绝的：它与"超时自动通过"是两个不同场景，常被混为一谈，但结果一样——**把"找不到人"变成"有人批准"** |
| **`reroute_log` 必进审批详情页可见** | "单据流转过谁、为什么转到这个人"必须可解释，否则重路由本身就是黑箱 |

> **"算不出人"是权限配置缺失的信号，不是可以兜底的异常。** 静默兜底会把一个配置错误直接变成一个已批准的单据。

### 6.0.8.6 「为什么他能看到这条」反查（审计用，不是调试用）

两条外部调研都指向同一个缺口：**泛微**的排序规则藏在数字里、没有追溯视图，这是它被投诉的一点；**钉钉**的权限是并集且无交集，出问题时无法证明"是某条规则命中了他"。

```sql
-- 输入 principal + 一条记录，输出：命中的规则行 + 命中的 allow/deny + 最终判定
CREATE FUNCTION fn_perm_explain(
  p_user bigint, p_resource varchar, p_record_id bigint
) RETURNS TABLE (
  matched_scope_id   bigint,
  dimension          varchar(24),
  value_type         varchar(16),
  combinator         varchar(16),
  verdict            varchar(16),   -- allowed | denied_by_deny | denied_by_empty_scope
  evidence           text
) AS $$ ... $$ LANGUAGE plpgsql STABLE;
```

**这个视图不是给管理员调试用的，是给审计用的。** "为什么门店 HR 能看到这个人"必须有答案，否则等于把规则藏在代码里。同时它是 §6.0.3.7 那套临时表机制的**反向验证手段**：临时表的灌入结果对不对，只有反查能看出来。

## 6.0.9 功能权限模型：命名、封闭动词、三个"不存在的点"

| 项 | 规定 |
|---|---|
| 命名 | `{域}.{资源}.{动作}`，三段；与 `10` §0.2 完全一致 |
| 域 | 13 个，封闭（`org`/`employee`/`schedule`/`attendance`/`leave`/`payroll`/`recruit`/`perf`/`learn`/`flex`/`report`/`system`/`audit`） |
| 动词 | `10` §0.3 的 12 个，封闭；新增动词要改文档，不许实现期自造 |
| 与 URL 的关系 | **权限点与接口是多对多**：一个权限点可覆盖多个接口（批量/单条），但**一个接口必须恰好声明一个权限点**。声明零个 = 默认放行，这是最危险的一类疏漏，ArchUnit 强制每个 `@RequestMapping` 方法必须有 `@PreAuthorize` |

**三个"在系统里不存在的权限点"**（`10` §1.1–1.2 已列出，这里只登记实现要求）：

| 不存在的点 | 原因 | 实现要求 |
|---|---|---|
| `employee.profile.delete` | 在档人员有劳动关系与举证需求，只能归档 | `ToolRegistry` 与 Controller 均无删除接口；DB 层 `employment` 无 `DELETE` 授权 |
| `employee.cert.delete` | 证照是排班阻断的依据，删了等于解除阻断 | 只能标"已失效"，`attendance` 侧继续读"已失效"做阻断判定 |
| `schedule.rule.override_legal` | 法定上限不许覆盖（03 §3.0.2） | 配置表里没有"法定项"这一类，`sys_config` 的 `config_key` 白名单不含法定参数 |

> 这三个点**必须在文档里写出来**，哪怕它们不存在。原因：不写，实施期一定会有人"加个开关"，而且加的时候觉得自己在解决客户问题。写了之后，加开关需要先推翻一条文档条款。

**权限点总数的口径对齐**：`§4.3.1` 早前写的"66 个权限点"是初版清单，`10` 已出 3 个域、预估 **180–220 个**。以 `10` 为准；`§4.3.1` 已改为**指向 `10` §0.7 交付进度、不填任何数字**（填一个数，下一轮它又变成错的）。超过 250 个必须做"角色套餐"分组（`10` §C2），否则配置界面不可用——这是界面问题，但根因是权限点数量，要在模型层预留 `sys_permission.parent_id` 的分组语义。

### 6.0.9.1 默认姿态：**全部拒绝**（这是与两家的分水岭）

| 默认 | 规定 | 两家是什么 |
|---|---|---|
| 新增角色 | **零权限** | 泛微默认共享；钉钉**默认全公司可查看/导出/删除**（官方帮助原文有警告） |
| 新增字段 | **`hidden`**（不是 `visible`，也不是 `masked`） | 钉钉全局策略一刀切 |
| 新增菜单/权限点 | **不可见**，需显式授予 | 默认可见 |
| 未在 `sys_perm_resource` 登记的资源 | `app_begin_scope` **抛 `E_RESOURCE_UNREGISTERED`** | 默认放行 |

**"默认拒绝"不是一句原则，是四条具体默认值。** 只写原则、不写默认值，实施期一定按框架默认（放行）走——因为那样"配起来快"。

### 6.0.9.2 双端必须各验一遍

钉钉官方明文存在这种情形：**子管理员在电脑端只能看本部门签到，手机端能看全公司**。我们的目标是"同一套策略两端同源"，但**验收必须双端各跑一遍**——目标与验收是两件事，只验一端等于没验。

| 验收项 | 为什么必须双端 |
|---|---|
| 数据范围（列表行数） | H5 是老安卓的主战场（ADR A14），移动端最容易"为了省一次请求"放宽范围 |
| 字段四态 | 移动端常做"精简字段"，容易顺手把 `hidden` 的字段也带出来 |
| 导出（仅 PC） | 确认移动端**没有**导出入口，而不是"隐藏了按钮" |

### 6.0.9.3 权限套餐（`10` §C2 的落地结构）

```sql
CREATE TABLE sys_permission_bundle (
  id bigint PRIMARY KEY, code varchar(64) NOT NULL UNIQUE, name varchar(128) NOT NULL,
  target_role_kind varchar(32) NOT NULL,   -- STORE_HR|AREA_HR|STORE_MANAGER|GROUP_HR|FINANCE|PAYROLL
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE sys_permission_bundle_item (
  id bigint PRIMARY KEY,
  bundle_id bigint NOT NULL REFERENCES sys_permission_bundle(id) ON DELETE CASCADE,
  permission_code varchar(96) NOT NULL REFERENCES sys_permission(code),
  UNIQUE (bundle_id, permission_code)
);
```

**三条硬约束，缺任一条套餐就变成权限点的第二个来源：**

| # | 约束 | 缺了会怎样 |
|---|---|---|
| 1 | **分配时展开落点**：选套餐 → 逐点写 `sys_role_permission`。**运行期不求值套餐** | 运行期求值 = 权限有了两条求值路径，改套餐会静默改掉所有人的现有权限，而"改的是配置还是授权"事后分不清 |
| 2 | **套餐不能反查授权**："为什么他能点这个"的反查链只经过 `sys_role_permission`；`sys_permission_bundle_item` 只出现在"这个角色当初怎么配出来的"这条管理链上 | 反查出现第二入口 = 一条权限有两个来源，冲突时无从判定 |
| 3 | **三者边界**：`sys_permission_bundle` 是**授权载体**（分发机制）、`sys_perm_resource` 是**业务对象**（判定依据）、`sys_data_scope` 是**范围**。两两之间除主外键外不得有耦合，**不新增任何 `Bundle*` 业务实体** | 一个对象同时是"包"和"资源"，权限求值就会有两套入口 |

**「运行期不求值套餐」这句话落在 `PermissionBundleExpander` 类的类注释上**，并用 ArchUnit 兜住：`..security..` / `..field.policy..` 包**不得依赖** `PermissionBundleExpander`（编译期失败）。写在注释里只是声明，写在 ArchUnit 里才是机制。

### 6.0.9.4 授权本身是一段时间 + 决策留痕

**授权是第三张时态表**，与 `employment_segment` / `employee_org_assignment` 同族，但语义不同：同一 `(user_id, role_id, data_scope_id, grant_kind)` **不得有重叠区间**，历史授权**不删**，靠部分排斥约束把已取代的排除在检查之外。

```sql
ALTER TABLE sys_user_role
  ADD COLUMN effective_from date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN effective_to   date,                   -- ★ 右开：effective_to 是"失效的第一天"，NULL = 至今
  ADD COLUMN superseded_by bigint,                  -- 软引用：被哪一行取代
  ADD CONSTRAINT ck_ur_span_nonempty
    CHECK (effective_to IS NULL OR effective_to > effective_from);   -- ★ 防空集，见下

-- ★★ 受限授权的上限（v1.9 新增）：10 Q2「未结单据 90 天只读」、10 §1.3.6「限时 7 天代操作」
--    这两个数字原来没有任何东西承载——TEMP_ACT_AS 可以授十年，插入成功、不报错、不进任何红。
--    而 10 的依据指向 expires_at，本册三处明写不建。所以上限只能落在 effective_to 上。
ALTER TABLE sys_user_role
  ADD CONSTRAINT ck_ur_kind_known
    CHECK (grant_kind IN ('ROLE','HANDOVER_READONLY','TEMP_ACT_AS')),
  ADD CONSTRAINT ck_ur_kind_span CHECK (
        (grant_kind = 'ROLE')
     OR (grant_kind = 'TEMP_ACT_AS'
         AND effective_to IS NOT NULL AND effective_to <= effective_from + 7)    -- [') → 恰好 7 天
     OR (grant_kind = 'HANDOVER_READONLY'
         AND effective_to IS NOT NULL AND effective_to <= effective_from + 90));
ALTER TABLE sys_user_role ADD CONSTRAINT ex_ur_no_overlap
  EXCLUDE USING gist (
    user_id WITH =, role_id WITH =, data_scope_id WITH =, grant_kind WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&   -- ★ 生效类用右开，不用 '[]'
  ) WHERE (superseded_by IS NULL);
```

**为什么这张表必须是 `'[)'` 而不是 `'[]'`**：授权是**生效类**区间（§3.0b），右端是"一个切换点"——"6 月 30 日为止"在业务上意味着 **7 月 1 日起不再有效**，也就是 `effective_to = 2024-07-01`。若用 `'[]'`，同一语义要写 `effective_to = 2024-06-30`，于是**"上一份授权失效"与"下一份授权生效"之间必须正好差一天**，而交接当天的任何一次写错都会让两段重叠一天、`EXCLUDE` 拒绝发布——运维会把它当成系统 bug。

**代价必须写出来**：UI 上"有效期至 2024-06-30"要映射成 `effective_to = 2024-07-01`（+1 天）。**这个 +1 只能出现在一个地方**（表单序列化层），不得散落到查询/报表/导出。散开之后必然有 3 处忘了 +1，而症状是"到期那天还有权限"——一个只差一天、不会报错的权限残留。

#### 为什么 `ck_ur_kind_span` 必须写成"全析取"，且为什么 7 和 90 不能做成参数

**一、必须是全析取，不能靠 `CASE … ELSE` 兜底。**

`CHECK` 里 **NULL 是通过**。所以下面三种写法都"能建"，但只有第一种在下一次加 `grant_kind` 时会红：

```sql
-- ✅ 正确：每个 kind 显式列出，新 kind 两条都不满足 → 插入被拒
CHECK ((grant_kind='ROLE') OR (grant_kind='TEMP_ACT_AS' AND …) OR (grant_kind='HANDOVER_READONLY' AND …))

-- ❌ CASE + ELSE true：新 kind 静默落进 ELSE → 无上限，且没人会看见
CHECK (CASE grant_kind WHEN 'TEMP_ACT_AS' THEN … WHEN 'HANDOVER_READONLY' THEN … ELSE true END)

-- ❌ 不写 ELSE：CASE 无匹配分支返回 NULL → CHECK 通过 → 同样无上限
CHECK (CASE grant_kind WHEN 'TEMP_ACT_AS' THEN … END)
```

**这与 §6.0.3.7 批的 `ELSE` 隐式枚举是同一条**：`ELSE` 是隐式枚举，下一个新维度会静默落进某条分支。`ck_ur_kind_known` 先兜住值域，`ck_ur_kind_span` 再全析取——**两条缺一不可**：只留 span，拼错的 `grant_kind` 会落进"无匹配"而通过；只留 known，加新值时值域放行而跨度无人管。

**二、7 和 90 写死在 `CHECK` 里，不做成配置项。**

参数可以被改，而**改完就是给历史授权发赦免**：`max_age_days` 从 7 改到 365，昨天那条已存在的 200 天授权不会重新校验，它只是"从这一刻起合规了"。**制度上界必须按赋值时点冻结**（`02g` §I36 一族的同一条）。真要改，走迁移 + 显式重算，不走配置。

**三、"到期自动收回"不需要定时任务。**

allow 面的谓词是 `daterange(ur.effective_from, ur.effective_to, '[)') @> v_as_of`，**到期即读时不生效**。所以这里缺的从来不是执行者，是**上限**——而有上限之后，到期也不需要任何人去关。

> **这一条是"有数字没有列"的样本，与 `sys_check_registry` 那处"有列没有人读"互为镜像**（后者已在本册 §4.5.1 修为 `waived_period` 派生）：那边是**有列没有人读**（原 `waived_until` 写了豁免、到期不恢复），这边是**有数字没有列**（写了 7 天/90 天、没人挡得住）。**两个都叫"到期没有执行者"，而修法完全不同**：前者要改成派生、后者要补约束。

**`daterange(d, d, '[)')` 是 EMPTY，不是"一天"**：所以 `ck_ur_span_nonempty` 不是风格约束——没有它，"起止同日"的行会得到一个空区间，空区间与任何区间 `&&` 均为 `false`，**`ex_ur_no_overlap` 对这一行整条失效，且插入成功、不报错**。这不是"少判一天"，是**约束在这一行上不存在**（§3.0b）。

> **`daterange(lower, upper, bounds)` 的 `upper` 传 `NULL` 就是无界上界**，`COALESCE(effective_to,'infinity')` 会把"无界"降级成"有限但很大"——`upper_inf()` 静默漏掉它，所有"是否仍在生效"的判据一起错。**这是全库统一口径，见 §8.2b 四。**

**权限判定必须能回答"事件时刻"**：判定函数签名一律带 `as_of timestamptz`。

```
resolve_data_scope(principal, resource, as_of)        -- 缺 as_of 一律视为"未实现时间性"
```

**不接受 `as_of` 的判定函数，视为未实现时间性**——不是"简化版"，是"这条路径永远按当前判定"，而当前判定在调动场景下就是错的（§6.0.7）。

**决策留痕（`access_decision_log`）：授权匹配是 0 / 1 / 多，不是 0/1**

```sql
CREATE TABLE access_decision_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id bigint NOT NULL, resource_id bigint NOT NULL,
  action varchar(64) NOT NULL,
  decision varchar(8) NOT NULL CHECK (decision IN ('allow','deny')),
  matched_grant_ids bigint[] NOT NULL DEFAULT '{}',   -- ★ 复数：一次操作可能命中多条授权
  primary_grant_id  bigint,                            -- 仅供索引查询，**不是审计答案**
  matched_count int GENERATED ALWAYS AS (cardinality(matched_grant_ids)) STORED,
  rule_version text NOT NULL,
  durability varchar(8) NOT NULL CHECK (durability IN ('sync','txn')),
  trace_id text NOT NULL, decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_adl_allow CHECK (decision = 'deny' OR cardinality(matched_grant_ids) > 0),
  CONSTRAINT ck_adl_deny_sync CHECK (decision <> 'deny' OR durability = 'sync')
);
```

| 设计点 | 为什么 |
|---|---|
| `matched_grant_ids` 是**数组** | 一角色两范围、直授 + 继承都会命中多条。写成单值不是"少个字段"，是**在有多条时随便存一条**——而事后举证时那条可能不是真正生效的那条。**那是编造了一个权威的错答案**，而审计要的恰好就是一个名字 |
| `allow` → `durability='txn'`；`deny` → `'sync'` | 业务回滚时 allow 记录可以一起回滚（授权未被真正使用）；**deny 必须持久**——它是撞库/爬数据的唯一信号，丢了就再也查不到 |
| `matched_count > 1` 时必须列全 | 反查页挑一个显示 = 冤枉人，而被冤枉的人要自证 |

**两条巡检**：① `deny` 行里 `durability='sync'` 占比必须 100%（否则写入方为了省事全用 `txn`，deny 在回滚时丢失）；② 网关记录的鉴权请求数 ≡ 本表行数（否则"鉴权函数忘了写日志"和"deny"在日志里同形——**都没记录**）。

## 6.0.10 与 `hr-mcp-gateway` 的边界：哪些工具携带权限上下文，哪些绝对不带

### 6.0.10.1 携带什么（只携带"是谁"，不携带"能看什么"）

| 工具类别 | 携带 | **绝不携带** |
|---|---|---|
| 查询类 `*_get_*` / `*_list_*` / `*_search_*` / `report_*` | 服务令牌（客户端身份）+ 被代表的自然人（由令牌派生，**不由参数传**）+ 可选 `purpose_code` | `role` / `scope` / `dataScope` / `fieldPolicy` / `maskType` / `nodeDefId` —— **签名里没有这些字段；传了直接 400，不做"忽略"处理** |
| 写入类 `*_create_*` / `*_update_*` / `submit_*` | 同上 + `plan_id` / `args_digest`（两道式，§5.6） | 同上 + **审批节点 id**（AI 不得指定自己走哪个节点） |
| `gov_request_plaintext` | 用户 + 理由 + 目标字段 + 有效期 | **权限判定结果**（它不判权限，只把"已被判定为需要明文的一次访问"记一笔并放行一次） |
| `gov_get_approval_status` | 只读 | — |

**"传了直接 400，不做忽略"这一条要强调**：如果传了 `role` 而被静默忽略，调用方会以为客户端指定的角色生效了，于是在排查"为什么 AI 看不到工资"时，会先怀疑角色配置——**而真实原因是他一直在传一个被忽略的参数**。这类"看起来生效、实际无效"的参数，比报错难查十倍。

### 6.0.10.2 绝对没有工具的三类

| 类别 | 工具数 | 理由 |
|---|---|---|
| 审批动作（`approve_*` / `reject_*` / `add_sign` / `transfer` / `withdraw`） | **0** | 裁决四（§6.0.6），类型层不可达 |
| 权限配置（`sys_role_*` / `sys_perm_*` / `sys_data_scope_*` / `sys_data_scope_rule*` / `sys_permission_deny*` / `sys_field_permission_*` / `sys_node_field_policy_*`） | **0** | 权限是判权限的依据；可被被判定者修改的依据不是依据（RL10 范围据此扩展） |
| 组织归属直写（`employee_org_assignment` 写） | **0** | 已有 RL11：写入必须走调动单/支援单（`employee_transfer` / `support.create`），调度归属靠单据 |

### 6.0.10.3 网关侧不做什么（避免双重判定）

| 网关**不**做 | 谁做 | 为什么不能两边都做 |
|---|---|---|
| 不解析角色、不算数据范围、不判字段档 | 服务端 `SecurityContext` + `resolve_field_policy` | 两处判定必然分叉；且网关能拿到的组织树可能是缓存过的旧版本 |
| 不做"AI 专属的更严策略" | 服务端按 `exit=MCP` 收紧一档（§6.0.5.2） | "AI 更严"做成网关策略，就变成"看请求从哪来"，而真正该区分的是**出口**，不是调用者 |
| 不缓存权限判定结果 | 服务端 Redis 60s + `permVersion`（§4.3.1） | 网关多一层缓存 = 撤权后最长要等两层缓存同时过期 |

网关只做三件事：**认证、限流、把 `client_id` 与令牌里的自然人身份一起传给服务端**。**网关是通道，不是法官。**

## 6.0.11 两处明确拒绝

### 6.0.11.1 拒绝「超时自动通过」——默认关闭，且不推荐

| 项 | 内容 |
|---|---|
| 结论 | **默认关闭；且不推荐开启**。枚举里就没有 `AUTO_APPROVE` 这个取值（§6.0.8.1 `ck_and_timeout`） |
| 依据 | `02g` I10.1：**系统只能提议，不能决定需要有人承担后果的事** |
| 论证 | 审批的全部意义是"有人为后果负责"。超时自动通过等于把"**没人看**"变成"**有人批准**"，而且事后**无法区分**这两种情况——单据上写的是"已批准"，签字人是空的。这不是效率优化，是**责任的蒸发** |
| 客户坚持时的四条 | ① 显式配置 `sys_config: approval.auto_approve_on_timeout = true`（**默认 false**）；② 每张单据写 `auto_approved=true` + `auto_approve_rule_id`，UI 上以不同颜色显示；③ **月度单独报告**（本月有多少张是超时自动通过的、金额合计、业务类型分布），报给集团 HR 负责人签收；④ **业务类型白名单**：金额类（调薪/补差/报销）与劳动关系类（离职/调动/处分）**永远不允许**自动通过，白名单之外的业务默认禁止 |
| 为什么给四条而不是"直接拒绝" | 直接拒绝在售前过不去（客户会说"我们线下就是超时算通过"）。但**线下"超时算通过"是有物理约束的**（纸质单据会被人看到），线上的"超时算通过"没有。四条要求的作用是把线上的无约束还原成线下的有约束：**有痕迹、有汇总、有例外** |

### 6.0.11.2 拒绝「运行期可修改流程定义」

| 项 | 内容 |
|---|---|
| 结论 | **已发布版本不可变**。改流程 = 新建版本；在途单据的 `flow_version_id` 不变（§6.0.8.3） |
| 论证 | 流程定义是**在途单据的判定依据**，不只是"模板"。若可改，一张在途单据的当前节点会在半途换规则，导致 ①同一张单的两个节点用了两套字段权限 ②事后无法复原"当时这个人看到的是哪一版字段策略" ③审批责任的举证链断裂——**而审批的全部价值就是举证** |
| 机制（不是约定） | 两道触发器（`trg_afv_frozen` / `trg_and_frozen`）+ `definition_hash` 摘要（发布时算，读取时校验，防"绕过应用直接改库"）。用触发器而非 `REVOKE`，理由同 §3.3.6：`REVOKE` 对表属主无效，而迁移脚本正是以属主身份跑 |
| 允许的例外 | 只有一个：`DRAFT` 状态的版本可随意改。发布动作本身不可逆（`PUBLISHED` → 只能 `RETIRED`，不能回 `DRAFT`）——**因为"撤回发布"会让已按该版本走的单据失去依据** |

## 6.0.13 三条跨域约定（放本节是因为它们同时约束权限与金额，放任一域都会被另一边漏掉）

### 6.0.13.1 分类判据必须全序、互斥、覆盖（"豁免 / 正常 / 违规"这类三型）

三型**不是某列的枚举取值，而是一行相对另一行的关系**。写成"看这一列的取值判型"的后果是：**型对不上的行不落任何一型，而检查仍绿**（每一型只判自己那部分）。

**要求**：对每一行**恰好产出**一个型，落不出型即 `fail`。不许 `NULL` / `not_applicable` 兜住。

```sql
-- 错误形态：三个独立 CASE 各判一段，中间的行走不到任何一支
-- 正确形态：一个 CASE 覆盖全集，ELSE 走 'unclassified' 并让断言把它判红
```

**判据**：把分类函数的返回值域写进 `CHECK`，并断言 `count(*) = count(typed)`。**这条与"空集不能当结论"是同一条：漏掉的那部分不会报错，只会不出现。**

### 6.0.13.2 金额类参数按生效日拆期：做成配置，**默认不拆**

```sql
-- sys_config
-- period_param_split_policy ∈ { no_split, split_by_effective_date }   默认 no_split
```

| 项 | 规定 |
|---|---|
| 默认 | `no_split`——整期取**期间首日**所在的有效版本 |
| 为什么默认不拆 | 上线前的实际行为就是"变更从下个发薪期开始生效"；拆期会让社保/个税在同一期出现两个费率，**申报表对不上** |
| **必须联动** | `compliance_profile` 与金额类参数**走同一条配置**，不许一个拆一个不拆——否则同一期间出现"费率按旧、合规按新"的组合，而两边都自洽 |
| `no_split` 下必须记录 | **期间级快照列记下本期实际取用的版本**，否则事后无法解释"为什么用了旧费率" |

> `no_split` 不是"不记录版本"，是"整期一个版本"——**版本仍然要冻结到期间上**（与 §3.5 的期间快照同族）。

### 6.0.13.3 可重放的合成断言（一条断言守住三件事）

**任取一个已封账期间，用当时的 `rule_version` + 当时的输入快照重算，必须与已发放金额逐分相等。**

它的价值在于同时守住三条：**事实不可改 / 版本不可变 / 快照取当时**。这三条各自都有单点断言，而**每一条都能在另外两条被破坏时保持绿色**——只有合成重放能同时覆盖。

| 前提 | 缺了会怎样 |
|---|---|
| 规则必须是**可执行对象**（数据/表达式），不是代码 | git 里有旧代码 ≠ 旧规则可执行（依赖当时的库版本、当时的配置、当时的环境）。**一份判断如果不能被重放，它就无法被审计** |
| 版本表不可变（§3.3.5b 末尾） | 版本表能原地改 → 重放用的是"现在的旧版本" → 断言恒真 |
| 输入快照冻结 | 输入是当前值 → 重放算的是今天，不是当时 |

**这条断言的覆盖范围 = 上面三个前提的交集**，所以它红的时候要先看是哪一个前提破了——**直接去查金额逻辑是最后一步，不是第一步。**

## 6.0.12 表数、对账项与遗留

### 6.0.12.1 数量

| 项 | 变化 |
|---|---|
| 表 | 93 → **103**（+10：`sys_data_scope_rule` / `sys_permission_deny` / `sys_perm_resource` / `sys_node_field_policy` / `sys_approval_flow_version` / `sys_approval_node_def` / `sys_approval_reroute_log` / `sys_permission_bundle` / `sys_permission_bundle_item` / `access_decision_log`） |
| 存量表扩列 | 5 张（`sys_user_role` **+6**：`grant_kind`/`readonly_only`/`grant_reason` + `effective_from`/`effective_to`/`superseded_by`；**`expires_at` 不建**，时间性统一走 `effective_from`/`effective_to` + `ex_ur_no_overlap`）、`sys_field_permission` +4（`action`/`scene`/`is_ceiling`/`reason`）、`sys_approval_instance` +4、`sys_approval_task` +2、`sys_approval_template` 的 `node_json`/`condition_json` 废弃） |
| 视图 | 15 → **23**（+`v_chk_scope_mixed_combinator` / `v_chk_scope_no_rule` / `v_chk_scope_dangling` / `v_daily_metric_scoped` / `v_chk_expired_but_active` / `v_chk_check_coverage` / `v_chk_guard_unbacked` / `v_chk_range_fake_unbounded`） |
| 函数 | +`fn_perm_explain`（反查，审计用）、`fn_flow_version_frozen` / `fn_node_def_frozen`（版本冻结触发器）、`f_alg_NN`（与 `sys_check_registry` 的 `ALG-NN` 一一对应，见 §4.5.4） |
| 工具 | **101 不变**（`approve_*` 0；权限配置类 0） |
| 审批引擎那一半 | 再 **+3** 表（`sys_approval_delegate` 代理 / `sys_approval_cc` 抄送 / **`sys_approval_item`** 审批明细含 `new_value`），**落地 108**；加签与转交用 `sys_approval_task.act_kind` + `parent_task_id`，不另建表 |
| 断言运行层（§4.5） | 再 **+3** 表（`sys_check_registry` / `sys_check_run` / `decision_measurement`）→ 111 |
| 维度词表（§6.0.3.7） | 再 **+1** 表（`sys_perm_dim`，取代三处 `IN (...)` 二次枚举）→ 112 |
| RLS 分类（§8.2d） | 再 **+1** 表（`sys_data_classification`，表级个人数据分类；**不新建**，则"哪些表必须被保护"这句话无处落）+1 视图（`v_chk_rls_coverage`）→ 113 |
| MCP 两阶段写（§5.6.1） | 再 **+1** 表（`sys_mcp_plan`，执行凭证）→ **最终 114 表 / 24 视图** |
| **合计** | **表 93 → 114；视图 15 → 24** |

> **这一栏是"账面合计"，不是 `grep '^CREATE TABLE'` 的实测条数——引用表数必须说明取的是哪个口径。**
>
> `as_of` 2026-11-14：账面 **114**、实测 **112**，**差 2 来自存量的 93**——本册对存量表不是逐张给 DDL（那是 `03` / `02f` 的职责），所以反查必然少。
>
> 不写这一句的后果很具体：两个人报两个数、都没数错，而看起来像有人数错了，于是下一步会去"核对"那个根本不存在的错——**今晚已经发生过一次（`unlogged` 那张表到底有没有 4 张），代价是一轮排查。**

### 6.0.12.2 四处对账的裁决结果（team-lead 已裁，此处只记结论与例外）

| # | 项 | 裁决 | 状态 |
|---|---|---|---|
| 1 | 发薪法人列名 | **统一为 `payroll_legal_entity_id`，但范围死限定在 `04` 内部 8 处** | 已改（见下"例外"） |
| 2 | 权限点总数 | 以 `10` 为准；`§4.3.1` **删数字、改指向 `10` §0.7 交付进度**，不填任何数字 | 已改 |
| 3 | `snap_org_id` 的语义 | **`snap_org_id` = 成本组织**（03 §6.1 / 02g I8.4 两处一致，04 原注释「组织归属」才是含糊的一方）→ **补 `snap_attendance_org_id`，12 列 → 13 列** | 已改（`04` §3.3.5 / §3.3.5b / §3.3.5d、`03` §6.1 两处；`02g` I8.4 早已是 13 列） |
| 4 | `sys_data_scope` 三列废弃 | 档位映射保留，内部类型改"四档 + `DIM`"；`10` 不动 | 已改 |

**例外说明（写下来，别让下一个人再问一遍）**：`02` / `02e` / `06` 里出现的 `payroll_legal_entity_id` **不要动**——`02f` D1 已明文声明"其余文档出现的 `person_id` / `payroll_legal_entity_id` 一律视为别名，落库前替换"，那三处是被追认过的历史写法，改了反而与 `02f` 冲突。

### 6.0.12.3 引擎那一半：六项定调 + 本轮新落地的十一条

**（A）审批引擎六项定调**（定义已定，落地在审批那一半的实现阶段）

| # | 项 | 已定的定调 |
|---|---|---|
| 1 | 会签清算 + 加签 | **已完成的节点不重开**；加签只能加在**当前未完成节点**；加签人对已完成节点**不产生补签义务**——补签等于伪造"当时没人反对" |
| 2 | 在途重路由 | 失败兜底默认 `HOLD`（挂起告警），**不许默认跳上级、不许默认通过**（§6.0.8.5 已建 `reroute_log`） |
| 3 | 代理与责任归属 | 审计里**进代理人，同时记 `on_behalf_of`**，两级都要能反查 |
| 4 | 撤回边界 | 下一节点已开始则不可撤回；"已开始"的判据要选一个并说明为什么 |
| 5 | 抄送人是否计入已阅 | **不计入**——抄送是通知不是审阅，混进去会让"应阅人数"失真 |
| 6 | 域管理员模型 | 放薪酬域那一节；**"域管理员不得自审自付"必须是结构性禁止**（本人是制单人或收款人时该节点对其不可见也不可被指派），不能只写进制度 |

**（B）本轮新落地十一条（都有落地位置，不是定调）**

| # | 项 | 落在哪 | 一句话结论 |
|---|---|---|---|
| 1 | **`chk_ads_span` 三件套** | §3.3.5 DDL + §3.3.8 八条表 | ① 补 `chk_ads_span` + `chk_ads_nonneg`；② L0 那行从"否（定义式）"改为"锚定来源=无 → 必须自带"；③ 表列由"要不要上线跑"改为"**锚定来源**"，结论由依据推出 |
| 2 | `ALG-*` / `f_alg_*` 命名统一 | §4.5.4 | `check_code='ALG-07' ⟺ runner='f_alg_07'`，编号不重用，CI 用 `to_regprocedure` 机检 |
| 3 | `pg_get_constraintdef` 的位置 | §4.5.9 | **入升级指纹**（比"和上一版变没变"，允许人看 diff）/ **禁入 `guards` 判据**（要比"还挡不挡得住"） |
| 4 | `operator_verified` 与证据属性 | §4.5.10 / §4.5.11 | `claimed` / `verified` 两栏永不合并；证据排五档，"不同算法可重算"必须真的不共享分支/舍入/边界三段 |
| 5 | 数值四态 + `decision_measurement` | §4.5.7 / §4.5.8 | `unknown_conflict` 不得并入 `unknown`；"当时是多少"存结果不存重放 |
| 6 | `sys_check_registry` 的 `guards` / `exercised` | §4.5.1–4.5.3 | `guards` **四档**，第四档判据是**行为**（夹具真的被拒），`definition_hash` 降级为复核提示；`exercised` 用 `sys_check_run` 派生，不新增列 |
| 7 | `fallback` 段与建单同事务 | §3.3.2 | `ctg_ads_fallback_same_txn` DEFERRABLE 约束触发器，用 `xmin` 判同事务；**`xmin` 禁止进事后巡检**（FREEZE 会抹掉） |
| 8 | `governance_check` 的时间函数 | §4.5.5 | **记录型用 `now()`，判定型用 `clock_timestamp()`**；`now()` 是 `transaction_timestamp()` 的别名，它答的不是"现在" |
| 9 | `approval_item.new_value` | §3.8.2 | `sys_approval_item.new_value NOT NULL`；`old_value` 用于并发冲突检测，`new_value` 由服务读库后填，**不得由调用方传入** |
| 10 | `confirm_status` 单向的结构强制 | §3.3.4 | 补 `trg_daily_confirm_forward`；并写明"只能前进"≠"必须过检查点"，后者靠**撤掉 `app_role` 对 `confirm_status` 的 `UPDATE` 权** |
| 11 | 列级 `REVOKE` 的正确顺序 + `daterange` 定稿 | §8.2b 五 / §3.0b | 先撤表级再授列级白名单，`ALTER DEFAULT PRIVILEGES` 写**同一对**；归属类 `'[]'`、生效类 `'[)'` |

**（C）仍然遗留（不在本轮范围，登记为债）**

| # | 项 | 为什么留下 |
|---|---|---|
| ~~1~~ | ~~`chk_ads_sum` 在 `hourly` 下全表拒绝~~ | **已裁决并落地**：加 `snap_on_duty_break_basis`，`chk_ads_sum` 改快照析取式，精确相等保留；迁移须 `ADD COLUMN … DEFAULT` 后立即 `DROP DEFAULT`（§3.3.5） |
| 2 | `confirm()` 的检查点仍无库内强制力（只有"单向"触发器） | 需要与权限层联调（撤 `UPDATE (confirm_status)` 权限），排到权限那一批 |
| 3 | 十三条"会静默算错钱"之外的口径 | 见 `02g` I22–I30 的未落项，逐条按同样方式归位 |


---

# §6 集成设计

## 6.1 总原则

| 原则 | 说明 |
|---|---|
| 一切进出口走 `IntegrationPort` | 统一 `pull()` / `push()` / `healthCheck()`；业务层只依赖接口 |
| 全部可失败降级 | 集成不可用不得阻塞主链路（打卡、排班、请假、算薪） |
| 每次运行留痕 | `integration_job` 记录：类型、起止、文件、成功/失败行数、错误摘要 |
| 内网现实优先 | **能走文件就走文件**，能定时轮询就不要求 Webhook（内网收不到公网回调） |
| 出网需显式授权 | 默认禁止出网；客户允许时启用 `egress-proxy` 容器（域名白名单 + 全量审计） |

```sql
CREATE TABLE integration_job (
  id bigint PRIMARY KEY,
  job_type varchar(32) NOT NULL,      -- DEVICE_PULL|IM_ORG_SYNC|BANK_FILE_GEN|BANK_RECEIPT_IMPORT|ESIGN_POLL|TAX_EXPORT|FIN_VOUCHER
  direction varchar(8) NOT NULL,      -- IN|OUT
  status varchar(16) NOT NULL,        -- RUNNING|SUCCESS|PARTIAL|FAILED
  started_at timestamptz, finished_at timestamptz,
  file_key varchar(256), file_sha256 char(64),
  total_rows int, success_rows int, failed_rows int,
  error_summary text, triggered_by bigint, origin varchar(8)
);
```

## 6.2 考勤机（人脸 / 指纹 / 闸机）

**现实情况**：餐饮门店设备品牌杂、年代跨度大，常见三种能力：① 主动 HTTP 推送 ② 只提供 SDK（需本地服务） ③ 只能写本地 DB 或 TXT 文件。

```
                    ┌─────────────────────────────────────────┐
设备（HTTP 推送）───►│ /api/device/punch                       │
                    │  签名校验(HMAC + 设备密钥) → 幂等 → 入队 │
                    └──────────────┬──────────────────────────┘
                                   │
设备（SDK/文件/DB）──►┌────────────▼──────────────┐
                    │ device-adapter（独立容器）  │  按品牌各一个实现
                    │  pull(since) → PunchEvent  │  写 attendance_punch
                    └────────────┬──────────────┘
                                 ▼
                    ┌─────────────────────────────────────────┐
                    │ PunchIngestService                      │
                    │ 去重(device_id,ext_id,at,type) → 落库  │
                    │ → 匹配班次/考勤组 → 生成原始工时         │
                    └─────────────────────────────────────────┘
```

| 环节 | 设计 |
|---|---|
| 设备注册 | `device_registry`（设备号、门店、密钥、能力类型、最近心跳）；未注册设备一律拒绝 |
| 签名 | `X-Device-Id` + `X-Timestamp` + `HMAC-SHA256(body, deviceSecret)`；时间漂移 > 5 分钟拒绝 |
| 幂等 | `UNIQUE(device_id, device_punch_id)`；设备重推不影响 |
| 时钟偏差 | 设备时间与服务器时间差 > 阈值时记录 `clock_skew` 并在异常报表提示"设备时间不准"，同时以设备时间为准入库（考勤必须认设备时间，否则可被篡改） |
| 离线补传 | 设备缓存后补传，支持乱序；`biz_date` 由 `punch_time` + 该门店考勤组"日切时间"推导（餐饮常有凌晨 2 点下班，日切点默认 04:00） |
| 照片 | 存 MinIO，`attendance_punch.photo_key`，保留 90 天后清理（合规与存储平衡） |
| 设备适配器部署形态 | 独立 Compose service，与主应用只通过 HTTP + DB staging 表交互；**适配器崩溃不影响打卡主链路** |
| 新增品牌 | 实现 `DeviceAdapter` 接口（约 3 个方法），打包成独立 jar/容器，不改主应用 |

## 6.3 企业 IM 与通讯录平台（组织与消息）

**现实约束**：这类平台是公网 SaaS。客户内网通常两种情况。

| 情况 | 方案 |
|---|---|
| **允许出网（白名单）** | 应用直连开放平台：① 通讯录全量+增量同步 ② 扫码/免密登录（OAuth） ③ 消息推送（审批待办、排班发布、工资条提醒） |
| **完全不出网** | 降级：① 组织用 Excel/CSV 模板导入（含增量比对） ② 消息走内部邮件网关 / 短信网关 / 站内信 ③ 登录只支持账密 + 可选 LDAP/AD |

**组织同步必须遵循 02 §5 三段式**（这是硬要求，不能简化）：

```
1) 全量读取 + 事务替换
   fetchAllDepartments() + 分页 fetchMembers(deptId)
   校验：读取成功 ∧ 分页完整 ∧ 无空组织异常 → 才进入替换
2) 失败不清空
   任一步骤异常 → 整体回滚，保留现有数据，写 integration_job(FAILED) + 告警
3) 离开即停用不删档
   不在本次可见范围的员工 → employment.status=SUSPENDED + sys_user.status=DISABLED
   + 撤销所有会话（Redis session 全清）
   → 档案 / 薪资 / 答卷 / 工龄 / 绩效全部保留
4) 多部门成员按 primary_org_id 合并去重
5) 特殊节点（通讯录存在但接口读不到的系统节点）显式排除，否则整次同步中断
```

```sql
CREATE TABLE ext_identity_map (
  id bigint PRIMARY KEY,
  ext_system varchar(16) NOT NULL,     -- IM 平台代号 | LDAP | AD（禁用真实品牌名，运行时由字典配置）
  ext_type   varchar(8)  NOT NULL,     -- DEPT|USER
  ext_id     varchar(128) NOT NULL,
  internal_id bigint NOT NULL,
  last_synced_at timestamptz,
  UNIQUE (ext_system, ext_type, ext_id)
);
```

**为什么"停用不删档"是关键**：餐饮流动率高，同一个人离职又返岗很常见。删档会丢工龄（影响年假额度与离职补偿）与历史薪资（影响个税累计与劳动争议举证）。而"停用"能立即切断登录（安全），两者不矛盾——这正是 02 §5 的判断。

## 6.4 银行代发

内网无法直连银行，**只能走文件交换**。

```
系统生成银行报文（按银行模板）
  → 加密（若银行要求）/ 加签
  → 财务从 Web 下载（下载行为记审计，文件带水印）
  → 财务上传至企业网银（人工）
  → 网银返回回执文件
  → 财务上传回执 → 系统解析 → 匹配 bank_payment_line → 更新状态
  → 失败行生成"重发清单"，走补发批次
```

| 要点 | 设计 |
|---|---|
| 报文模板 | `bank_file_template` 表配置：列序、分隔符、编码、金额单位（元/分）、定长补位规则、文件头尾行 |
| 金额校验 | 生成后立即核对 `Σ line.amount == batch.total_amount`，不等则拒绝下载 |
| 账号一致性 | 与档案银行卡号比对，不一致进异常清单（防改号攻击） |
| 回执匹配 | 按 `(序号, 账号后四位, 金额)` 三元组匹配，冲突时人工介入 |
| 分批 | 单文件行数上限（各家 500–5000 不等），超限自动拆文件 |
| 凭证归档 | 报文 + 回执 + 银行流水截图统一存 MinIO，按 `batch_no` 归档，保留 10 年 |

## 6.5 电子签

| 情况 | 方案 |
|---|---|
| 允许出网 | 对接电子签开放 API：创建签署任务 → 员工 H5 签署 → **轮询 `querySignStatus`**（内网收不到 Webhook）→ 下载签署后 PDF 存 MinIO |
| 完全不出网 | 降级：系统生成合同 PDF（带防伪二维码 + 页脚哈希）→ 打印 → 纸质签署 → 扫描件上传 → 人工核验标记 `sign_status=SIGNED` |

**轮询设计**：`esign_poll` 定时任务（5 分钟一次，只轮询 `status IN (SENT, SIGNING)` 的任务），指数退避避免打爆对方接口。

## 6.6 税务（个税申报）

不做直连（税务部门提供的个税申报客户端为本地程序，不开放内网接口）。

```
系统按申报期内汇总 tax_accumulation
  → 生成标准申报模板文件（人员信息表 / 收入明细表 / 专项附加扣除表）
  → 财务下载 → 导入税务客户端 → 申报 → 回传申报结果
  → 系统导入结果，标记申报状态，生成差异清单
```

**关键校验**：申报文件生成前强制校验"同月多批次合并为当月收入"（02 §7.1），若发现同一 `(employment, tax_year, tax_month)` 出现两条独立计税记录，拒绝导出并报错。

## 6.7 财务系统

两种方式，按客户能力选：

| 方式 | 说明 |
|---|---|
| 凭证文件导出 | 按 `payroll_cost_allocation` 生成记账凭证（借：人力成本-门店 / 贷：应付职工薪酬），字段含科目、辅助核算（门店/成本中心）、金额、摘要 |
| 中间表/视图 | 在 DB 建只读视图 `v_fin_labor_cost`，财务系统直连抽取；需单独建只读账号 + 网络白名单 |

**口径一致性**：凭证金额必须与 `payroll_cost_allocation` 完全一致（同一张表出来），避免"财务账与人力账对不上"。`metric_definition` 里"人力成本含什么"的开关决定凭证是否包含单位社保与劳务费。

## 6.7b 社保 / 个税政策离线包（私有化部署的必备件，不写清上线第一个月就卡住）

**问题**：社保基数上下限、费率、缴费比例、个税税率表与专项附加扣除，**各地按年（甚至年中）调整**。公网 SaaS 由厂商后台统一更新；本地部署客户完全离线，没有这条通道。

**方案：政策包（Policy Pack）作为独立可分发件**

```
si-policy-pack-{yyyy.MM}.zip
├── manifest.json        {version, regionCodes[], effectiveFrom, sha256, signatures}
├── si/{city}.json       社保方案：险种、单位/个人比例、基数上下限、生效起止
├── tax/{year}.json      个税税率表、速算扣除、专项附加扣除额度
├── holiday/{year}.json  法定节假日与调休（加班倍率边界依赖它）
└── README.md            变更说明与适用范围
```

| 环节 | 设计 |
|---|---|
| 分发 | 随升级包分发（`upgrade/` 内），或客户自行从厂商支持渠道获取；**无需重启**（导入即生效） |
| 导入 | 超管在「政策包管理」上传 → 校验签名与 sha256 → 预览差异（哪些城市/哪些险种/哪些参数变了）→ 确认导入 |
| 版本化 | 落 `si_plan` / `tax_rate_table` / `holiday_calendar`，全部带 `effective_from` / `effective_to` / `policy_pack_version`；**禁覆盖**，只新增版本 |
| 已算薪期间 | **不受影响**：`payroll_record.snapshot_json` 已快照基数与费率，政策包更新不回溯历史（§0.4） |
| 生效时机 | 导入时选择"从下个薪资期生效"还是"按政策生效日生效（可能落入已封账期间 → 强制转化为下期补差）" |
| 兜底 | **未导入新政策包时，系统必须能告警而不是静默用旧值**：`policy_pack` 过期（`effective_to` 已过且无新版本）→ 算薪前置检查阻断 + 自检页红字提示"XX 城市社保政策已过期，请在政策包管理导入" |
| 应急 | 允许"手工补录单城市参数"（走 `gov_set_config` + 审计），但必须在政策包到位后回归（避免长期手工值与政策包冲突） |

**为什么必须做成"包"而不是"后台配置页"**
配置页每改一次都是一次高风险手工操作，且无法核对"我这个客户到底用的是哪版政策"。做成包后有明确的版本号、签名、差异预览与回滚点，出问题能回答"当时用的是哪版、谁导的、什么时候"。

**上线前置检查清单必含**：客户覆盖的全部城市的社保方案 + 当年个税税率表 + 当年法定节假日日历，缺一项不允许进入算薪。

## 6.8 集成层的运维可见性

| 页面 | 内容 |
|---|---|
| 集成任务看板 | 每个 `job_type` 的最近运行状态、成功率、最后成功时间、积压量 |
| 失败重试 | 手动重试按钮 + 自动重试（指数退避，最多 5 次） |
| 文件交换区 | 待下载（银行报文、税务申报）/ 待上传（回执）/ 历史归档 |
| 设备健康 | 每台设备最近心跳、离线时长、时钟偏差 |

**告警规则**：任一集成任务连续 2 次失败 / 设备离线 > 2 小时 / 打卡入队积压 > 1000 条 → 写入"系统告警"页 + 邮件 + （出网时）IM 推送。

---

# §7 性能与容量

## 7.1 打卡高峰

**流量估算**

| 项 | 值 |
|---|---|
| 员工 | 10,000 |
| 每人每日打卡次数 | 2（上班 1 + 下班 1），部分含中途外出 4 次 |
| 日总打卡 | 20,000 – 30,000 |
| 早高峰占比 | 40% → 8,000 – 12,000 次 / 小时 |
| 平均 QPS | ~3 |
| **瞬时 TPS（08:55–09:05 十峰）** | **50 – 120** |
| 并发用户（含查班表、请假、审批） | 300 – 500 |

**设计：先入队，后落库**

```
POST /api/device/punch
 ① JWT/设备签名校验              本地 CPU，无 IO          ~2ms
 ② 幂等检查   SETNX punch:{dev}:{punchId}  TTL 600s      ~1ms（Redis）
 ③ 组装事件 + XADD 到 Redis Stream                       ~1ms
 ④ 立即返回 200 {"received":true}
                                    ────────────────────
                                    P99 目标 < 80ms（含网络）
后台消费者（线程池 4）：
 每 200ms 或积 500 条 → 批量 INSERT attendance_punch（JDBC batch）
 → 触发工时匹配（异步，可再延迟）
```

| 指标 | 目标 |
|---|---|
| 打卡接口 P99 | < 300ms（设计值 < 80ms） |
| 峰值吞吐承载 | 500 TPS（4 倍余量） |
| 队列积压告警 | > 1000 条 |
| 落库延迟 | < 2s（99 分位） |

**为什么可以"先入队后落库"**：打卡是**只追加的时序事件**，没有"必须立即可查"的业务要求（员工看到"已记录"即可，工时计算是分钟级）。用 Redis Stream（AOF `everysec`）持久化，进程崩溃后消费者从 last-delivered 续读；极端情况丢 1 秒数据，可通过设备侧补传恢复（设备保留 7 天缓存）。

**降级路径**：Redis 不可用 → `PunchIngestService` 捕获后同步写 DB（慢，但正确），并告警"Redis 降级运行"。

**索引与分区**

| 表 | 分区 | 索引 | 说明 |
|---|---|---|---|
| `attendance_punch` | 按月 RANGE(`punch_at`) | `UNIQUE(device_id, employee_ext_id, punch_at, punch_type)`、`(employee_id, punch_at)`、`(store_org_id, punch_at)` | 只留必要索引，写入每多一个索引就多一次 B-Tree 更新 |
| `attendance_daily` | 不分区（万人 × 365 ≈ 365 万行/年） | `UNIQUE(employee_id, work_date)`、`(work_date, confirm_status)`、`(employee_id, period_month)` | |
| `attendance_daily_store` | 按月 RANGE(`work_date`) | `(store_org_id, business_date)`、`(employee_id, work_date)`、`EXCLUDE` 区间约束 | |

**连接池**：单副本 `maxPoolSize=40`；小集群 2 副本各 40，库 `max_connections=200`（留 60 给运维与批处理）。

**虚拟线程**：JDK 21 开启 `spring.threads.virtual.enabled=true`，打卡高峰的阻塞 IO（Redis/DB）不再占用平台线程，避免线程池打满。

## 7.2 批量算薪

见 §4.1.6。补充工程要点：

| 要点 | 做法 |
|---|---|
| 异步 | HTTP/MCP 触发后立即返回 `jobId`，前端轮询进度（`sys_job_instance.progress`） |
| 进度粒度 | 按分片更新（每片完成 +1），避免每行更新一次进度表 |
| 可中断 | `sys_job_instance.status=CANCELLED` → 分片循环检查标志位，安全退出（已提交分片不回滚） |
| 内存 | 500 人/片 × (记录 + 30 项明细) ≈ 15MB/线程；4 线程 ≈ 60MB，JVM `-Xmx2g` 足够 |
| 避免大事务 | 分片独立提交（每片一个事务）；最终校验与汇总单独事务 |
| 数据库参数 | 算薪期间临时调大 `work_mem`（会话级 `SET LOCAL work_mem='256MB'`）给排序与聚合用 |
| 幂等 | `(period, scope_hash, data_version)` 唯一，重复触发直接返回已有 run |

## 7.3 大批量导入

| 阶段 | 设计 | 目标 |
|---|---|---|
| 模板 | 提供带校验规则的 xlsx 模板（数据验证 + 说明页） | 减少脏数据 |
| 分片上传 | 前端按 5,000 行切片，逐片上传（每片独立请求，可断点续传） | 避开 Nginx 请求体上限与超时 |
| 流式解析 | 服务端 SAX 流式读（不把整个 workbook 载入内存），直接写 `import_staging` 临时表 | 10 万行内存 < 200MB |
| 两段式 | ① 解析+格式校验（只写 staging）② 用户看校验报告后确认提交（业务校验 + 落库） | 避免"导入一半发现第 8000 行错" |
| 集合式校验 | 全量 staging 表用 SQL 做唯一性/外键/范围校验，不做逐行 Java 校验 | 10 万行校验 < 20s |
| 提交 | `INSERT ... SELECT ... ON CONFLICT` 批量落库 | 10 万行 < 30s |
| 错误报告 | `import_row_error` 表 + 导出 xlsx（原行号 + 错误原因） | 可修可重导 |

### 7.3b 历史数据迁移范围（P0 只导三样，ADR A12）

上线迁移最容易失控的一步是"什么都想导"。P0 明确**只导三类主数据**，其余给只读归档：

| 对象 | P0 是否导入 | 理由 |
|---|---|---|
| 花名册（人员 + 任职 + 四维归属 + 合同） | ✅ 导入 | 没有它系统跑不起来 |
| 薪资档案（月薪/时薪/日薪/计件单价 + 社保基数 + 个税累计起算值） | ✅ 导入 | 首月就要发薪 |
| 假期余额（四态初值，以 `GRANT`/`CARRYOVER` 台账行导入，不直接写余额） | ✅ 导入 | 首月请假就要扣 |
| 考勤历史（打卡流水、日汇总） | ❌ **不导** | 清洗成本极高（设备口径、班次版本、时区、跨零点各客户不同），查询价值低 |
| 工资历史（往期工资记录与明细） | ❌ **不导** | 同上；且历史工资的口径与新版必然不同，导进来会污染"一人一期间一条"红线 |

**不导的那两类怎么满足"员工要看历史"**：
- 建**只读归档库**（独立 schema `archive`，或独立小库），按客户给的历史数据原样落表 + 提供"历史查询"页面；
- **归档库不进主库查询链路**：不参与任何计算、不参与指标字典、不加外键、不与主库 JOIN；
- 员工查历史工资条 = 查归档库；离职证明打印同理；
- 归档数据加显著标识"历史归档，口径与现行系统不同，仅供查阅"。

**为什么用只读归档而不是"清洗后并入"**：清洗规则一旦出错，主库数据就被污染且不可逆；而归档库即使有脏数据，也只影响"查阅"这一件事。这是典型的"用隔离换风险"。

```sql
CREATE TABLE import_staging (
  batch_id bigint NOT NULL, row_no int NOT NULL,
  payload jsonb NOT NULL, error_json jsonb,
  PRIMARY KEY (batch_id, row_no)
);
```

**总目标**：10 万行端到端 < 3 分钟（解析 60s + 校验 20s + 落库 30s + 缓冲）。

## 7.4 报表查询

**三层手段，全部在单库内解决（ADR A9 / A13）**

| 层 | 手段 | 适用 |
|---|---|---|
| L1 | **普通视图** `v_*`（§3.9，非物化）+ 基础表覆盖索引 | 看板与高频报表 |
| L2 | **指标字典 + 固定 SQL 模板** | 保证口径一致且 SQL 可优化、可加索引 |
| L3 | **结果缓存**（Redis，key = `metricCode + params hash + scopeHash + 数据版本`） | 同一门店同一期间重复查询，TTL 5–30 分钟 |

**是否要读写分离：不做（ADR A13）。** 1 万员工 / 500 店 / 5 万考勤日/月的量级，读写分离的收益（降低主库读压力）远小于代价（多一个备库、多一套延迟不一致、多一个运维对象、客户机房多一台机器）。

**不做读写分离，性能靠什么保证**

| 手段 | 说明 |
|---|---|
| 基数天然小 | 报表维度落在"门店 × 月"（500 × 12 = 6,000 行/年）、"人 × 月"（1 万 × 12 = 12 万行/年），单表索引查询毫秒级 |
| 重查询异步化 | 明细导出、万行报表一律走 `sys_job_instance` 异步作业，**不占在线查询的连接与时间** |
| 分区表范围扫描 | 打卡/班段按月分区，按期间查询只扫 1–2 个分区 |
| 查询预算硬约束 | `statement_timeout=30s`；超时返回"请改用导出任务"，而不是把主库拖死 |
| 连接池隔离 | 报表模块用独立连接池（`report-pool` max 10），避免报表把 OLTP 的 40 个连接吃光 |

**强制约束**
- 所有报表 SQL 必须带 `LIMIT`（明细导出除外，走异步）
- 禁止 `SELECT *`、禁止在报表里 `JOIN` 超过 4 张表（用视图或加冗余列代替）
- 视图不得嵌套超过 2 层、不得在视图里 `ORDER BY`

**若真的扛不住（不进 A13 的范围，但要有出口）**：先加覆盖索引 → 再收窄查询维度/强制分页 → 最后才重新提 ADR 讨论备库。**不允许运维现场自行开启流复制备库**，因为这会引入"报表读到滞后数据"的口径争议。

## 7.5 容量与存储估算（5 年）

| 表 | 年增行数 | 5 年 | 单行估算 | 5 年体积（含索引 ×2） |
|---|---|---|---|---|
| `attendance_punch` | 730 万 | 3,650 万 | ~200B | ~15 GB（保留 24 个月 → 实际 ~6 GB） |
| `attendance_daily` | 365 万 | 1,825 万 | ~300B | ~10 GB |
| `attendance_daily_store` | 73 万 | 365 万 | ~600B（含 6 列快照） | ~5 GB |
| `payroll_record` | 12 万 | 60 万 | ~600B | < 1 GB |
| `payroll_record_item` | 360 万 | 1,800 万 | ~150B | ~5 GB |
| `payroll_cost_allocation` | 60 万 | 300 万 | ~250B | ~1.5 GB |
| `sys_audit_log` + `mcp_call_log` | 200 万 | 1,000 万 | ~500B | ~10 GB |
| 附件（MinIO） | — | — | 合同/扫描件/工资条 PDF | 50 – 200 GB |
| **合计数据库** | | | | **< 60 GB（5 年）** |

**结论**：单机 NVMe 500GB 可支撑 5 年。超过 5 年做归档（`attendance_punch` 冷分区转 Parquet 存 MinIO，DB 只留汇总）。

## 7.6 前端性能（H5 弱网是老安卓的主战场，ADR A14）

**终端形态定死**：PC Web（后台）+ **手机 H5**（一线员工），并支持内嵌到企业 IM / 协同平台的工作台里打开。**不做原生 App**（ADR A14）。理由：本地部署客户的应用商店分发、签名、升级全都不受控，原生 App 是长期负债；而打卡、查班表、请假、看工资条这四件事在 H5 上完全可做，只需专项优化。

| 一线高频场景 | H5 专项优化 |
|---|---|
| 打卡 | 单独分包（< 150KB gzip）+ Service Worker 缓存壳 + 定位预取 + 失败重试队列（IndexedDB） |
| 查班表 | 周视图虚拟化 + 本地缓存当周数据 + 离线可看 |
| 请假 | 表单预渲染 + 余额本地缓存（进页面即有数） |
| 工资条 | PDF 由服务端生成，H5 只做预览与下载（水印在服务端打） |


| 指标 | 目标 | 手段 |
|---|---|---|
| H5 首屏（4G） | < 2s | 路由级代码分割、打卡页单独分包（< 150KB gzip）、图片字体内联小图 |
| 花名册列表 1 万行 | 滚动 60fps | `el-table-v2` 虚拟滚动 + 服务端分页（默认 50/页） |
| 组织架构图 5,000 节点 | 首屏 < 1s，交互不卡 | 懒加载 2 层 + Canvas + Worker 布局（§4.4.2） |
| 排班板（30 人 × 4 周） | 拖拽 60fps | 虚拟化 + 局部重绘 + 乐观更新（失败回滚） |
| 离线能力 | 打卡页可离线缓存 | Service Worker 缓存壳 + 失败重试队列（IndexedDB） |

---

# §8 安全与审计

## 8.1 认证与会话

| 项 | 设计 | 理由 |
|---|---|---|
| 密码存储 | Argon2id（`m=64MB, t=3, p=4`） | 抗 GPU 暴力破解；比 bcrypt 更现代 |
| 密码策略 | 长度 ≥ 10、含 3 类字符、不得含用户名、历史 5 次不重复、首次登录强制改 | 等保要求 |
| 登录失败 | 5 次锁 30 分钟（按账号 + 按 IP 双维度），第 3 次起加图形验证码 | 防撞库 |
| MFA | TOTP，**管理员与财务角色强制开启**，其他角色可自愿 | 高危角色必须 MFA |
| Token | access JWT（30 分钟，RS256，含 `sub`/`client_id`/`scope`/`permVersion`）+ refresh（7 天，轮换，DB 存储可吊销） | JWT 无状态但可吊销 |
| 会话表 | `sys_session`（user_id, token_id, ip, ua, last_active, revoked） | 「停用即撤销会话」（02 §5）与「立即踢下线」需服务端可控 |
| 单点登录数 | 同一账号最多 3 个活跃会话（可配） | |
| 强制下线 | 撤权/停用/License 到期 → 按 `user_id` 批量 `revoked=true` + 清 Redis session cache | |
| 内网也要 HTTPS | 部署脚本自动生成自签 CA + 证书（也可导入客户内部 CA 签发）；HTTP 端口仅用于 301 跳转 | 内网嗅探与中间人是真实威胁 |
| CSRF | 非 JWT 场景（cookie）用 `SameSite=Strict` + CSRF token | |

## 8.2 授权（详见 §4.3）

三轴 + 静态超管 + 乐观锁 + 防自授。补充：

| 项 | 设计 |
|---|---|
| 接口级 | `@PreAuthorize("hasPermission('employee:read:profile')")`，权限码与 `sys_permission` 对齐 |
| 行级 | **四张**：`pg_temp.tmp_scope_org`（kind=org）/ `tmp_scope_entity`（kind=entity）/ `tmp_scope_emp`（kind=person）/ `tmp_scope_deny`（同粒度独立 deny 集合，§6.0.3.7） |
| 字段级 | `@Sensitive` + `FieldMasker`（§4.3.3） |
| 缺省拒绝 | 未声明 `@PreAuthorize` 的 Controller 方法由 `GlobalMethodSecurity` 拒绝（白名单仅登录/健康检查） |

## 8.2b 数据库权限基线：四张 ACL 都要写，少一张等于没写

> 这一节的由来：`REVOKE` 家族的 ACL 有**三张**，前面几轮只写了两张（逐函数 `REVOKE ALL ON FUNCTION`、`REVOKE ALL ON SCHEMA public`），**独缺 `ALTER DEFAULT PRIVILEGES`**。而在早期检查里那批函数全部显示"已收回"——因为检查的是"已部署的那批"，而**漏掉的是"以后新建的每一个"**。

```sql
-- ① 逐函数收回（已部署的那批）
REVOKE ALL ON FUNCTION fn_x(...) FROM PUBLIC, role_app;
-- ② schema 层（关闭 public schema 的默认建表/使用）
REVOKE ALL ON SCHEMA public FROM PUBLIC;
-- ③ ★ 默认权限（以后新建的每一个）—— 前两轮漏的就是这一张
ALTER DEFAULT PRIVILEGES FOR ROLE role_migration IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, role_app;
ALTER DEFAULT PRIVILEGES FOR ROLE role_migration IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, role_app;
-- ④ ★ 第四张 ACL：database 级 TEMPORARY（默认授 PUBLIC，不在任何表/列 ACL 报告里）
REVOKE TEMPORARY ON DATABASE hr_platform FROM PUBLIC;
GRANT  TEMPORARY ON DATABASE hr_platform TO app_role;
```

**为什么必须有第④张**：前三张都在 schema 与对象上，而 `TEMPORARY` 在 **database** 级。它决定"一个只读账号能不能把数据搬进临时表再 `COPY TO` 出去"——**只审计表 ACL 的报告看不到它**，而它是"只读账号"这个说法能不能成立的判据。它同时是 §6.0.3.7b 那条能力边界的技术落点。

**为什么第③张最容易漏**：`pg_default_acl` 里"没有配置"的表示是**无行**，不是某列为空。所以朴素的判据 `IS NOT NULL` 会把"全开"判成"没配置"，写成一条永远绿的检查。判据必须反过来：**期望有行，没有行就是缺配置**。

### 三、权限检查的对象名必须 schema 限定 + 用精确签名

```sql
-- ❌ 依赖 search_path 的简写：同一个检查在两处可能得到相反结论
SELECT has_function_privilege('current_grants(uuid)', 'EXECUTE');
-- ✅ schema 限定 + 精确签名
SELECT has_function_privilege('role_app', to_regprocedure('public.current_grants(uuid)'), 'EXECUTE');
```

**简写为什么会在 `SECURITY DEFINER` 上翻转**：`SECURITY DEFINER` 函数必须钉死 `search_path`，而钉法不同 → 同名函数的解析结果不同 → **同一句检查在 A 处判"有权限"、在 B 处判"无权限"**。这类不一致不会报错，只会让两个都说"我做完了"的人各对一半。

`to_regprocedure` 返回 `NULL` 表示"找不到这个函数"——**`NULL` 必须即判 `fail`，不许 `COALESCE` 成 `false` 或 `true`**。`COALESCE` 会把"对象不存在"伪装成"检查通过了"。

### 四、时段判据：两个方向都要给，`upper_inf` 必须先判

| 错误写法 | 为什么错 |
|---|---|
| `upper(r) > now()` | `upper_inf(r)` 为真时 `upper(r)` 可能是 `NULL`（`daterange(x, NULL, ...)`）或 `'infinity'`（`daterange(x,'infinity',...)`），**两种"无上界"写法漏一种** |
| 只判 `effective_from <= current_date` | 只看一侧 → **已到期但没清理的授权仍是活的** |

```sql
-- 统一判据（任选一种，但全库只能有一种）
NOT upper_inf(r) AND upper(r) > now()      -- 显式
r @> now()                                  -- 隐式（推荐，无上界自然成立）
```

**过期行必须能被断言为零**（这是"两侧都判"之外的第二道）：

```sql
CREATE VIEW v_chk_expired_but_active AS      -- 期望：空集
-- ★ 授权类（生效类，右开 '[)'）：effective_to 是"失效的第一天"，所以判据是 effective_to <= today
SELECT 'sys_user_role' AS obj, ur.id
  FROM sys_user_role ur
 WHERE ur.effective_to IS NOT NULL AND ur.effective_to <= current_date
   AND ur.superseded_by IS NULL
UNION ALL
-- ★ 配置类（生效类，右开）：两侧都要判，只看 effective_from 会把"尚未生效"当活的
SELECT 'sys_config', c.id
  FROM sys_config c
 WHERE NOT (daterange(c.effective_from, c.effective_to, '[)') @> current_date);
```

**判据为什么用 `current_date` 而不是 `now()`**：两者的比较都是对的（`daterange @> timestamptz` 会先转），但**判"有效期"是一个业务日判定，不是时刻判定**——用 `now()` 会让同一天在不同时刻得出不同结论（`effective_to = today` 在 00:00 判"过期"、在 23:59 判"过期"，看似一致，但配合 `'[]'`/`'[)'` 混用时边界会漂）。**全库统一：日期区间一律用 `current_date`，时刻区间一律用 `clock_timestamp()`。** 混用 `now()` 是这两类判定里最常见的错误来源（见 §4.5.5）。

> **凡新增"带生效区间"的表，必须同时进这个视图。** 漏一张的表现是：那张表的过期行永远不会被清、也不会报错，而它每天都在参与判定。清单本身要落成断言（`sys_check_registry`，见 §4.5.1）——**没有清单，"每张表都要进"就是一句无法执行的要求。**

> **"已到期但还标着有效"不会自己消失**，因为没有任何进程负责清它——所以必须有断言把它变成"每天红一次"。这类行的危害不是"多了权限"，是**审计时无法解释"这条授权什么时候失效的"**。

### 五、列级 `REVOKE` 在存在表级 `GRANT` 时是**无效的**——顺序错了等于没写

这是本节第二个"看起来做了、其实没做"的形态，比漏写 `ALTER DEFAULT PRIVILEGES` 更难发现，因为**代码里明明有一行 `REVOKE`，它的执行也没报错**。

```sql
-- ❌ 完全无效：表级 GRANT 仍在，PG 的权限是可累加的
GRANT  SELECT, UPDATE ON attendance_daily_store TO role_app;
REVOKE UPDATE (snap_unit_price) ON attendance_daily_store FROM role_app;   -- 不起作用！
```

**为什么**：PostgreSQL 的表级权限与列级权限是**并集**关系。表级 `GRANT UPDATE` 授予了**所有列**的更新权，列级 `REVOKE` 只能收回"单独授予过的那一项"，无法从表级授权里"抠掉"一列。所以上面那段执行后，`role_app` 仍然能 `UPDATE snap_unit_price`，而 `v_chk_immutable_grants`（§3.3.8 的 V8）会**正确报红**——但没人会去看，因为"我已经 REVOKE 过了"。

**正确顺序（三步，顺序不能动）**：

```sql
-- ① 先撤掉表级授权（连列级一起失效）
REVOKE UPDATE ON attendance_daily_store FROM role_app;
-- ② 再按白名单逐列授回（不在白名单里的列从此不可写）
GRANT UPDATE (id, work_date, business_date, shift_start_at, shift_end_at,
              span_hours, work_hours, break_on_duty_hours, break_off_duty_hours,
              in_attendance_hours, confirm_status, version, updated_at, updated_by)
  ON attendance_daily_store TO role_app;
-- ③ 默认权限里写**同一对**（否则以后新建的同名表又回到"表级全开"）
ALTER DEFAULT PRIVILEGES FOR ROLE role_migration IN SCHEMA public
  REVOKE UPDATE ON TABLES FROM role_app;          -- 先撤表级
ALTER DEFAULT PRIVILEGES FOR ROLE role_migration IN SCHEMA public
  GRANT  UPDATE ON TABLES TO role_app;            -- 再按同一份白名单授列级（逐表列清单在迁移脚本里）
```

**第 ③ 步最容易漏、也最容易写反**：只写 `REVOKE` 不写配对的 `GRANT`，会让以后新建的每张表对 `role_app` **完全不可写**——应用一上线就全线报错，然后有人加一条"临时"的 `GRANT ALL ON ALL TABLES`，**把整套基线一次性抹掉**。所以 `ALTER DEFAULT PRIVILEGES` 里必须**成对写**：撤表级 + 授列级白名单。

**判据（可扫目录，不依赖自查）**：`immutable_after_write = 'Y'` 的列，**只要该表对 `role_app` 有表级 `UPDATE` 权限，就一定判红**——不需要去查这一列有没有被单独 `REVOKE`，因为那件事本来就做不到。

```sql
-- 直接扫目录：表级 UPDATE 授权 + 存在标为不可改的列 → 红（V8 的根因版）
SELECT c.relname, a.attname
  FROM app_field_semantics fs
  JOIN pg_class c      ON c.relname = fs.table_name
  JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attname = fs.column_name
 WHERE fs.immutable_after_write = 'Y'
   AND has_table_privilege('role_app', c.oid, 'UPDATE')      -- ★ 表级 UPDATE 在 → 列级 REVOKE 是摆设
   AND NOT EXISTS (                                          -- 除非走的是 fn_xxx SECURITY DEFINER 单点写入
     SELECT 1 FROM sys_check_registry r
      WHERE r.kind = 'ACL' AND r.guard_table = c.relname AND r.verdict = 'green');
```


## 8.2c 事件触发器没有 ACL：能收回的不是它，是它的函数和它指向的对象

**先纠正一句要写进迁移脚本的错**：

```sql
-- ❌ 语法不存在。PG 的 GRANT/REVOKE 对象类型里没有 EVENT TRIGGER
REVOKE ALL ON EVENT TRIGGER etg_force_rls FROM PUBLIC, role_app;
```

`GRANT` / `REVOKE` 的对象类型是封闭的一串：`TABLE` / `SEQUENCE` / `DATABASE` / `DOMAIN` / `FOREIGN DATA WRAPPER` / `FOREIGN SERVER` / `FUNCTION`·`PROCEDURE`·`ROUTINE` / `LANGUAGE` / `LARGE OBJECT` / `PARAMETER` / `SCHEMA` / `TABLESPACE` / `TYPE`。**事件触发器不在里面**〔**推断·文档**：按 PG 16 `GRANT` 语法的对象类型清单判；本地无 PG，未执行验证〕。

**五秒自查（任何人、任何一台有 `psql` 的机器，不需要建任何对象）**：

```bash
psql -c 'REVOKE ALL ON EVENT TRIGGER x FROM PUBLIC'
# 期望：ERROR:  syntax error at or near "EVENT"
# 若返回 ERROR: event trigger "x" does not exist —— 那说明我这个判断错了，请立刻退回本节
```

**用语法错与对象不存在的差别做判据**：语法错说明这个对象类型不支持；对象不存在说明支持，只是没建。**这两条报错的区别，就是本节的整个结论。**

这不是"少写了一个关键字"，是**概念上放错了位置**：事件触发器的建、改、删**只有 superuser 能做**，它没有 ACL 可授可撤，归属靠 `ALTER EVENT TRIGGER … OWNER TO`。**一句 `REVOKE` 写在迁移脚本里，会以语法错的形式在升级窗口第一分钟失败**——这反而是好消息，比"执行成功但没效果"好得多（后者是 §8.2b 第③张 ACL 和列级 `REVOKE` 那两种形态）。

### 一、那它靠什么管：**记录，不是拦截**

| 想做的事 | 能不能靠事件触发器 | 为什么 |
|---|---|---|
| 让新建的表自动进入保护 | **能**，这是它的本职 | `ddl_command_end` 能拿到刚建的每张表，逐张补 `FORCE ROW LEVEL SECURITY` |
| 阻止越权的人改结构 | **不能** | 能建它的人也能 `ALTER EVENT TRIGGER … DISABLE`；能 `DISABLE` 的人也就能 `DROP` |
| 知道"谁在什么时候用什么 DDL 改的" | **能** | 函数里能拿到 `pg_event_trigger_ddl_commands()` + `current_user` + `current_query()` |

所以事件触发器在本设计里只有**两个职责**：**补默认保护**（第 2 条机制，见 §8.2d）与**归因**。把它当访问控制用，会在第一次真需要它拦人的时候发现它已经被关了，而"它被关了"这件事没有任何报警——因为它本来是报警的来源。

### 二、归属与授权：三个能落地的动作

```sql
-- ① 事件触发器本身：只有 superuser 能建，建完把 owner 交给 NOLOGIN 的迁移角色
--    （owner 的意义不在"防谁操作"，在"不挂在一个会被人删除的登录账号上"）
ALTER EVENT TRIGGER etg_force_rls OWNER TO role_migration;

-- ② 它的函数有 ACL，而且这张 ACL 是真的能撤的
REVOKE ALL ON FUNCTION fn_force_rls_on_new_table() FROM PUBLIC, role_app;
-- 应用账号连"手动调一遍这个函数"都不需要，所以是收回全部，不是只收 EXECUTE

-- ③ 函数必须 SECURITY DEFINER + 空 search_path（否则它在执行 DDL 的人的身份下跑，
--    补 FORCE RLS 会因为没有表所有权而失败——失败还被 EXCEPTION 吞掉，见下）
ALTER FUNCTION fn_force_rls_on_new_table() SECURITY DEFINER;
ALTER FUNCTION fn_force_rls_on_new_table() SET search_path = '';
```

### 三、豁免判据：不能把"谁是 DBA"写进字符串

第一版写的是 `current_user IN ('role_migration','postgres')`。**这个写法在两个方向上都错**：

| 场景 | `current_user` 实际是 | 白名单判据的结论 | 应不应该豁免 |
|---|---|---|---|
| DBA 用 `psql -U postgres` 手工改结构 | `postgres` | 豁免 | **应该**（但见第四行） |
| superuser 名叫 `dba_zhang`（客户自己建的） | `dba_zhang` | **不豁免** → 函数报错 → **阻断客户的结构变更** | 应该 |
| 应用账号被临时授了 `role_migration` 的 membership | `role_app` | 不豁免 → 报错 | 不应该（正确） |
| `SET ROLE postgres` 之后由应用连接执行 | `postgres` | 豁免 | **不应该** |

- **第三行**说明白名单**不是没用**——membership 判据在它上面是对的；
- **第二行**说明按名字判会**误伤**：客户环境里 superuser 叫什么完全由客户定，`postgres` 只是默认名；
- **第四行**说明豁免本身不是安全边界：任何能 `SET ROLE` 到 `postgres` 的连接都拿到豁免，而"能 `SET ROLE` 到 postgres"通常意味着"应用账号与超级用户共用连接池"——那已经是更大的问题。

**改法：判"能不能 `SET ROLE`"，不判"叫什么名字"。**

```sql
-- fn_force_rls_on_new_table() 内的豁免判定
DECLARE
  v_super   boolean;
  v_migrate boolean;
BEGIN
  SELECT r.rolsuper INTO v_super
    FROM pg_roles r WHERE r.rolname = current_user;          -- ★ 读属性，不读名字
  v_migrate := pg_has_role(current_user, 'role_migration', 'MEMBER');

  IF NOT (coalesce(v_super, false) OR coalesce(v_migrate, false)) THEN
    -- 不豁免的人：仍然补 FORCE RLS，但落一行"非受控结构变更"
    INSERT INTO sys_check_run(check_code, outcome, sample, ran_at)
    VALUES ('ETG-01', 'yellow',
            jsonb_build_object('who', current_user, 'ddl', current_query()), clock_timestamp());
  END IF;
  ...
```

**`rolsuper` 必须读属性**：`pg_has_role(current_user,'postgres','MEMBER')` 在"超级用户改了名"的环境里恒为 `false`，而 `rolsuper` 与角色名无关。同理不能写 `coalesce(v_super, false) OR ...` 就完事——`pg_roles` 里查不到 `current_user` 是**不该发生**的状态，`coalesce` 把它变成"不豁免"是对的，但要在 `sys_check_run` 里留痕，别让它静默。

### 四、一个必须补的巡检盲区：`evtenabled` 不在 `pg_trigger` 里

§4.5.3 那条"两个被静默关闭状态"扫的是 `pg_trigger.tgenabled`。**事件触发器不在 `pg_trigger` 里，它在 `pg_event_trigger`，列叫 `evtenabled`**——写在同一句 SQL 里扫不到，扫不到就永远绿。

```sql
-- 补进 §4.5.3 的第二类"被静默关闭"：普通触发器一张表，事件触发器另一张表
SELECT evtname, evtevent, evtenabled, evtowner::regrole
  FROM pg_event_trigger
 WHERE evtenabled NOT IN ('O','A');       -- D=disabled  R=replica（只在 session_replication_role=replica 时触发）
```

**`'R'` 为什么也算关着**：`evtenabled='R'` 表示"只在 `session_replication_role = replica` 时执行"——正常业务连接上它**一次都不会跑**。而在从库回放或 `pg_restore` 场景下它是跑的。**判据写成 `= 'O'` 而不是 `<> 'D'`**，因为这个列有四个值，`<> 'D'` 会把 `'R'` 判成正常。

### 五、如实写出来的边界

> **`etg_force_rls` 的存在，证明的是"我们想过新增表的漏"，不是"新增表的漏被堵住了"。**
> 堵住它的动作是"每天扫一遍 `pg_class` 与 `sys_data_classification` 的差集"（§8.2d 第 5 条）——事件触发器只是让这个差集**通常为空**，从而让那条断言在绝大多数日子里是绿的、在真出事的当天是红的。
> **一个永远绿的断言和一个偶尔红的断言，后者才有信息量。** 事件触发器的作用就是把"每天红"降成"偶尔红"，代价是它自己也成了需要被巡检的第四样东西（`ETG-01`/`ETG-02`/`ETG-03` 三行登记进 `sys_check_registry`，`kind='ETG'`）。

## 8.2d RLS 的默认保护：五条机制，逐条给落点

原来的判据是三条**单点状态断言**：

```sql
-- ❌ 三条全对，且对"之后新建的表"一条都不管
SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = 'employee';
SELECT count(*) > 0 FROM pg_policy WHERE polrelid = 'employee'::regclass;
```

三条全是"对**当前存在**的表成立"。而 RLS 的风险恰恰在新建的表上——**新建一张表忘了开 RLS，上面三条检查全部照旧为绿**，因为被检查的那张表没变。这与 §8.2b 第③张 ACL 是同一个病：**判据覆盖的是"我已部署的那批"，漏掉的是"以后新建的每一个"**。

下面五条机制与六个小节不是一一对应：第三节（两个机制互为前提）是**落第二条机制的前置条件**，不是第六个机制。

| 机制 | 落在哪一节 | 一句话 |
|---|---|---|
| ① 集合元断言 + 默认保护方向 | 一 | 先有"哪些表必须被保护"的清单，缺省归最严档 |
| ② 新增即适用 | 二 + 三 | 只能靠 DDL 事件触发器；它要求 `relowner` 是迁移角色 |
| ③ 绕过 RLS 的两个开关 | 四 | `rolsuper` / `rolbypassrls`，含继承路径 |
| ④ 第四个出口在 owner 上 | 五 | `role_app` 不得拥有任何对象 |
| ⑤ 非存在性断言改扫目录 | 六 | 把"没有"变成"不存在一行" |

### 一、集合元断言 + 默认保护方向：先有"哪些表必须被保护"的清单

没有清单，"每张表都要开 RLS"是一句无法执行的要求。清单必须是**表级的、人登记的**，不能从字段级语义推导：

```sql
CREATE TABLE sys_data_classification (
  table_name    varchar(64) PRIMARY KEY,
  data_class    varchar(16) NOT NULL
                CHECK (data_class IN ('public','internal','personal','sensitive')),
  added_because varchar(64) NOT NULL,     -- 为什么归到这一档（一句话，必填）
  added_at      timestamptz NOT NULL DEFAULT now(),   -- ★ 记录型，用 now()；判定型才用 clock_timestamp()（§4.5.5）
  added_by      varchar(32) NOT NULL
);
-- ★ 默认保护方向：新表管理界面上的缺省值是 'personal'，不是 'public'
--   "证明它不需要保护"是一个动作，需要人签字；"它需要保护"是缺省
```

**为什么不用 `app_field_semantics` 推**（那张表已经有字段级语义，看起来能聚合出来）：

| 理由 | 具体后果 |
|---|---|
| 聚合方向错 | "所有列都不敏感"的表可能是 `payroll_record`（它的敏感性来自**行**——这行是谁的工资——不来自任何单列） |
| 它本身是派生值 | `app_field_semantics` 由迁移脚本生成，"生成物当判据"= 判据可以被生成逻辑改掉而不留痕（§4.5.8 同一条道理） |
| RLS 的粒度是表 | 断言必须能按表写：`data_class IN ('personal','sensitive')` 的表 ⊆ 已启用 RLS 的表 |

**集合元断言（两个方向都写，缺一个就有一半漏）**：

```sql
CREATE VIEW v_chk_rls_coverage AS
-- 方向 A：标了要保护的表，必须真的开了 RLS（漏的方向：忘开）
SELECT c.relname AS table_name, 'missing_rls' AS problem
  FROM sys_data_classification dc
  JOIN pg_class c ON c.relname = dc.table_name AND c.relkind = 'r'
 WHERE dc.data_class IN ('personal','sensitive')
   AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
UNION ALL
-- 方向 B：开了 RLS 的表，必须在清单里（漏的方向：清单过期，改名/删表后残留判断）
SELECT c.relname, 'unregistered'
  FROM pg_class c
 WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
   AND (c.relrowsecurity OR c.relforcerowsecurity)
   AND NOT EXISTS (SELECT 1 FROM sys_data_classification dc WHERE dc.table_name = c.relname);
```

**方向 B 容易被当成"多余的严格"**——它不是：一张开了 RLS 但不在清单里的表，说明有人手工加过保护而没登记，那么**下次有人重建这张表时，清单不会提醒他开**。清单的价值不在"记得谁开了"，在"记得谁必须开"。

### 二、新增即适用只能靠 DDL 事件触发器

集合元断言是**事后**的（每天扫一次），中间有一天的窗口。补窗口的机制只有事件触发器——这是它是 `ddl_command_end` 而不是定时任务的理由（§4.5.3 同一条）。

```sql
CREATE OR REPLACE FUNCTION fn_force_rls_on_new_table()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname
      FROM pg_event_trigger_ddl_commands() e
      JOIN pg_class c ON c.oid = e.objid
     WHERE e.command_tag IN ('CREATE TABLE','CREATE TABLE AS')
       AND c.relkind = 'r'
       AND c.relnamespace = 'public'::regnamespace
  LOOP
    BEGIN
      -- 新建表默认按最严档保护；人可以在登记时把它调到 internal（必须写 added_because）
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
      EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', r.relname);
      INSERT INTO public.sys_data_classification(table_name, data_class, added_because, added_by)
      VALUES (r.relname, 'personal', 'etg_force_rls 自动登记，待人工复核', current_user)
      ON CONFLICT (table_name) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      -- ★ 不阻断 DDL：阻断会让"一条与本次变更无关的失败"回滚整个迁移，
      --   然后运维会 DROP 掉这个事件触发器 —— 这是这类机制最常见的死法
      BEGIN
        INSERT INTO public.sys_check_run(check_code, outcome, sample, ran_at)
        VALUES ('ETG-01','yellow',
                jsonb_build_object('table', r.relname, 'err', SQLERRM), clock_timestamp());
      EXCEPTION WHEN OTHERS THEN
        -- ★ 落库本身也失败：这是唯一还能留下痕迹的地方
        RAISE WARNING 'etg_force_rls: 登记失败 table=% err=%', r.relname, SQLERRM;
      END;
    END;
  END LOOP;
END $$;

CREATE EVENT TRIGGER etg_force_rls ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE','CREATE TABLE AS')
  EXECUTE FUNCTION fn_force_rls_on_new_table();

ALTER EVENT TRIGGER etg_force_rls OWNER TO role_migration;
REVOKE ALL ON FUNCTION fn_force_rls_on_new_table() FROM PUBLIC, role_app;
```

**`EXCEPTION` 包裹是这类机制的生死线**：不包 → 一次失败阻断整支迁移 → 运维 `DROP EVENT TRIGGER` 了事 → **从此连归因记录也没了**。包了 → 失败变成一行 `yellow`，机制活着，问题可见。**"宁可漏一次保护，不可丢掉发现漏的能力"**，这是这条机制唯一能持续的写法。

**但 `EXCEPTION` 块里的 `INSERT` 自己也可能失败**（表被锁、RLS 把它挡住、`role_migration` 没有该表权限）——而**最需要记录失败的那一刻，往往正是记不进去的那一刻**。所以那一层必须再包一层，保底用 `RAISE WARNING`：它进 PG 日志、不阻断事务，是这条链上最后一条不会失效的通道（日志轮转与 `log_min_messages` 是它的前提，见 §9.7）。

### 三、两个机制互为前提：`SECURITY DEFINER` 要求 `relowner` 是迁移角色

`fn_force_rls_on_new_table()` 是 `SECURITY DEFINER`，所以它以**函数 owner**（`role_migration`）的身份执行 `ALTER TABLE … FORCE ROW LEVEL SECURITY`。而 `ALTER TABLE` 需要**表的所有权**——

| 如果 `relowner` 是 | 结果 |
|---|---|
| `role_migration`（正确） | 能改，机制正常 |
| `role_app` | `role_migration` 不是 owner → `EXCEPTION` 捕获 → 每次建表都落一行 `yellow` → **机制变成噪音源，然后被关掉** |
| `postgres` | 同上（`role_migration` 也不是 owner），只是失败原因不显眼 |

所以 §8.2d 第四节那条"`role_app` 不得拥有任何对象"**不只是 RLS 的第四条出口，它同时是这个事件触发器能不能工作的前提**。两个机制互为前提这件事必须写出来——否则实施时有人为了"省事"把表建在应用账号下，RLS 与事件触发器会同时失效，而**两边的巡检都还没红**（RLS 那条看起来是绿的：`relrowsecurity = true` 了，因为 `ALTER` 那一句在 `EXCEPTION` 之前成功、之后失败……这类"半成功"是最难查的）。

### 四、绕过 RLS 是**两个开关**，且都在角色属性上

"表都开了 RLS"这句话，在应用连的角色带 `BYPASSRLS` 时**完全无意义**——RLS 对它是透明的，而 `pg_class` 里那张表仍然是 `relrowsecurity = true`。

```sql
-- ❌ 只看表
SELECT count(*) FROM pg_class WHERE relkind='r' AND NOT (relrowsecurity AND relforcerowsecurity);
-- ✅ 加上开关：任何一个应用角色带这两个属性之一，前面所有断言作废
SELECT rolname, rolsuper, rolbypassrls
  FROM pg_roles
 WHERE rolname LIKE 'app\_%' ESCAPE '\' OR rolname IN ('role_app')
   AND (rolsuper OR rolbypassrls);
```

**注意运算符优先级**：上面这句是错的示范（`AND` 比 `OR` 紧，`rolsuper OR role_app` 那支没经过 `rolsuper OR rolbypassrls` 过滤）。**这类"括号少一对、结果恒为空集"的 SQL 是最危险的绿色**，所以判据一律写成 `WHERE rolname IN (...) AND (rolsuper OR rolbypassrls)`，把角色集先收成子查询：

```sql
WITH app_roles AS (
  SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
   WHERE rolname = 'role_app' OR rolname LIKE 'app\_%' ESCAPE '\'
)
SELECT rolname FROM app_roles WHERE rolsuper OR rolbypassrls;   -- 期望：空集
```

**还要判"继承路径"**：`app_role` 自己两列都是 `false`，但它是某个 `rolbypassrls = true` 角色的成员——`BYPASSRLS` 会随 membership 继承。

```sql
-- 期望：空集。应用角色不得经由任何路径继承到这两个属性
SELECT m.roleid::regrole AS app_role, m.member::regrole, r.rolname AS via
  FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.roleid
 WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'role_app')
   AND (r.rolsuper OR r.rolbypassrls);
```

### 五、第四个出口在**表的所有者**上：`relowner` 必须 NOLOGIN

这是最容易漏的一条，因为它不在"权限"的任何清单里：**表的所有者天然绕过 RLS**（`FORCE ROW LEVEL SECURITY` 会对 owner 生效，但前提是 owner 不是 `BYPASSRLS`/superuser；而且 owner 能随时 `ALTER TABLE … NO FORCE`）。所以：

| 对象 | 谁拥有 | 为什么 |
|---|---|---|
| 表 / 视图 / 函数 | `role_migration`（`NOLOGIN`） | owner 能改结构 → 能关掉 RLS → 必须不可登录 |
| schema `public` | `role_migration`（`nspowner` 也查） | schema owner 能 `CREATE`/`DROP` 其下对象，等于间接改了所有表 |
| 应用连接用 | `role_app`（`NOLOGIN` 也不需要，但**绝不可是任何对象的 owner**） | 见下 |

```sql
-- 期望：空集。role_app 不得拥有任何对象（表/视图/序列/函数/schema）
SELECT 'table' AS kind, c.relname::text AS obj
  FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'role_app'
UNION ALL SELECT 'function', p.proname::text
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE r.rolname = 'role_app'
UNION ALL SELECT 'schema', n.nspname::text
  FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE r.rolname = 'role_app';
```

> **这条断言同时替掉了被否掉的 `DROP … CASCADE` 检测。** 原思路是"看有没有人删过东西"，而 `CASCADE` 的作用正是让目录自洽——**它把证据一起删了**。而"`role_app` 不得拥有任何对象"是一条**能扫、且不依赖历史**的判据：不管对象是怎么没的，只要它现在归 `role_app`，就是错的。**判据要落在当前状态上，不要落在历史事件上——历史事件是能查不到的。**

### 六、非存在性断言改扫目录：把"没有"变成"不存在一行"

| 写不出来的断言 | 能写出来的等价物 |
|---|---|
| "没有一张该保护的表忘了开 RLS" | `v_chk_rls_coverage` 返回**零行**（两个方向都扫目录） |
| "没有人手工关过 RLS" | 现状是 `relrowsecurity = true`（**不看历史**——历史查不到，且"一直如此"与"昨天改回来"同形） |
| "事件触发器一直活着" | `pg_event_trigger.evtenabled = 'O'`（**分开扫，见 §8.2c 第四节**） |
| "没有绕过 RLS 的账号" | 三张判据全空：角色自身两列、继承路径、`relowner`/`nspowner` |

**`sys_check_registry` 里这四条各占一行**（`kind='RLS'`），并且**这四条的 `guards` 必须为空**——它们是唯一防线，没有第二道。按 §4.5.3，`guards` 为空不是"无需声明"，是**登记为债**：`guard_debt_owner` 与 `guard_debt_due` 必填，计划是"转结构"（把能进 DDL 的那部分移进 `CREATE POLICY` 与 `CHECK`）或"接受并写明"。

> **注意这不是"实现了五条机制"，是"把五条判据写成了四条能扫的 SQL"。** 差别在：判据能扫 ≠ 机制成立。机制成立的标志是 §8.2d 第六节第一行那一句——`v_chk_rls_coverage` 在**每次迁移之后**返回零行，而这件事只在真跑过一次空库建表之后才知道（§9.5b 第 0 步）。

## 8.3 数据加密

| 层 | 方式 |
|---|---|
| 传输 | TLS 1.2+（禁用 1.0/1.1、弱套件），HSTS |
| 存储-字段级 | `id_card_no`、`mobile`、`bank account`、`address`、`emergency_contact`、`mfa_secret`、`password_hash`：AES-256-GCM（随机 IV 前缀存储）；等值查询用 HMAC-SHA256 的 `_hash` 列 |
| 存储-文件 | MinIO 服务端加密（SSE-S3 兼容模式，密钥来自本地 keystore）；备份文件另用 `age` 加密 |
| 存储-备份 | `pg_dump` → gzip → age 加密 → 存 MinIO + 异地拷贝（客户自备） |
| 密钥管理 | 本地 `keystore/` 目录（`chmod 600`，属主为运行用户）；支持对接客户 HSM/KMS（`KeyProvider` 接口）；**密钥不落 DB、不进代码、不进镜像** |
| 密钥轮换 | `KeyProvider` 支持多版本密钥（`key_id` 前缀进密文），轮换时后台任务重加密；轮换记录进审计 |
| 剩余信息保护 | 附件删除时同时删除 MinIO 对象与 DB 记录（等保"剩余信息保护"）；DB 逻辑删除的敏感字段在 30 天后由清理任务物理置 NULL |

## 8.4 敏感操作治理

| 操作 | 要求 |
|---|---|
| 导出（任何含敏感字段） | ① 重新输入登录密码 ② 填导出用途（≥ 10 字） ③ 文件加动态水印（用户名 + 时间 + IP） ④ 下载记录审计 ⑤ 单日导出次数上限（默认 20 次） |
| 批量改薪 | ① 先 dry-run 看 diff ② 二次密码 ③ 影响 > 5 人需第二人复核 ④ 生成调整单 |
| 删除/作废考勤记录 | ① 二次密码 ② 必填理由 ③ 保留原记录（`void_flag`） ④ 通知被影响员工 |
| 修改权限/角色 | ① 静态超管才可改角色定义 ② 乐观锁防并发 ③ 全量 before/after 审计 |
| 替换 License | ① 超管 ② 上传文件校验签名 ③ 记录旧/新 License 摘要 |
| 解封账期 | ① 财务负责人 + HR 负责人双签 ② 填理由 ③ 强制通知 ④ 审计标红 |

**水印规格**：PDF 用斜向重复半透明文字（`用户名 2026-11-14 10:23 10.20.1.35`）；Excel 加首行 + 每 50 行重复的隐藏行（含导出批次号）；页面预览用 CSS 叠加层（可被截屏绕过，故仅作威慑，真正防护靠下载审计）。

## 8.5 审计日志

| 项 | 设计 |
|---|---|
| 覆盖面 | 登录/登出/失败登录、权限变更、数据增删改（关键表）、导出、明文查看、MCP 每次调用、配置变更、License 变更、集成任务启停 |
| 内容 | trace_id、actor（人/AI/系统）、action、resource、resource_id、before/after JSON、结果、IP、UA、时间 |
| 防篡改 | 哈希链：`row_hash = SHA256(prev_hash + 本行规范化内容)`；每小时生成 `segment_hash` 并写入独立的 `audit_anchor` 表（只追加）；提供"校验完整性"工具 |
| 保留 | 在线 3 年（分区），之后归档加密留存 3 年（等保三级建议 ≥ 6 个月，本产品取更长以备劳动争议） |
| 查询 | 界面 + `gov_list_audit_log` 工具；按人/时间/资源/动作筛选；支持 traceId 全链路还原 |
| 不可删 | 无删除接口；只有分区 `DETACH` + 归档（保留可查） |

## 8.6 等保 2.0 三级要点对照

| 控制项 | 本设计落点 |
|---|---|
| 身份鉴别 | 唯一用户名、复杂度策略、失败锁定、MFA（高危角色）、会话超时 |
| 访问控制 | 三轴权限、缺省拒绝、最小权限、职责分离（发薪双人复核） |
| **访问控制（数据层，不是应用层）** | 应用层的三轴权限**必须有一道数据层的兜底**——否则"某天有个新接口忘了加 `@PreAuthorize`"就直达全量数据。落点：`sys_data_classification` 表级分类 + RLS `FORCE` + `etg_force_rls`（新增即适用）+ 应用角色无 `rolsuper`/`rolbypassrls`/无对象所有权（§8.2d）。**这条单列的理由**：等保测评问的是"有没有技术手段限制越权访问"，答案不能只是"我们的代码里有判断" |
| 安全审计 | 全量审计 + 哈希链 + 3 年留存 + 审计日志只读 |
| 入侵防范 | 输入校验、参数化 SQL、最小化端口、错误信息不外泄堆栈、`X-Frame-Options`/CSP |
| 恶意代码防范 | 上传文件类型白名单 + 大小限制 + 病毒扫描（可选对接本地杀毒 CLI）+ 存储与执行分离（附件不可执行） |
| 数据完整性与保密性 | 传输 TLS、字段级加密、备份加密、校验和（附件 sha256） |
| 数据备份恢复 | 每日全备 + WAL 归档、异地副本、季度恢复演练（脚本化） |
| 剩余信息保护 | 删除即清（对象 + DB 敏感字段） |
| 个人信息保护 | 最小必要、脱敏展示、明文需申请 + 审计、导出水印 + 限额 |

## 8.7 应用安全编码基线

| 风险 | 对策 |
|---|---|
| SQL 注入 | 全参数化（MyBatis `#{}`）；ArchUnit 禁止 `..Mapper..` 出现 `${}` |
| XSS | 输出转义（Vue 默认）、CSP、富文本白名单（仅培训内容） |
| 越权（IDOR） | 所有按 ID 查询必须过 `tmp_scope_*`（拦截器兜底校验） |
| 反序列化 | 不用 Java 原生序列化；JSON 用白名单字段绑定 |
| 文件上传 | 类型/大小/内容嗅探三重校验；存储路径不可预测；不落 Web 根目录 |
| 依赖漏洞 | 构建期 SCA 扫描（离线漏洞库），发版前高危必须清零 |
| 日志泄露 | 日志脱敏插件（正则 + 注解），禁止打印明文证件/薪资 |

---

# §9 部署、升级与运维

## 9.1 单机 Docker Compose 编排

```yaml
# /opt/hr-platform/docker-compose.yml（简化示意）
services:
  postgres:
    image: postgres:16.4
    environment: [POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD_FILE]
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
      - ./certs:/certs:ro
    command: >
      postgres -c max_connections=200 -c shared_buffers=2GB
               -c effective_cache_size=6GB -c work_mem=16MB
               -c wal_level=replica -c archive_mode=on
               -c archive_command='test ! -f /backup/wal/%f && cp %p /backup/wal/%f'
               -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key
    restart: unless-stopped
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER"], interval: 10s }

  redis:
    image: redis:7.2
    command: ["redis-server","--appendonly","yes","--appendfsync","everysec","--maxmemory","1gb","--maxmemory-policy","allkeys-lru"]
    volumes: ["./data/redis:/data"]
    restart: unless-stopped

  minio:
    image: minio/minio:RELEASE.2024-xx
    command: server /data --console-address ":9001"
    volumes: ["./data/minio:/data"]
    restart: unless-stopped

  app:
    image: hr-platform/app:${APP_VERSION}
    depends_on: [postgres, redis, minio]
    environment:
      - SPRING_PROFILES_ACTIVE=prod
      - DB_URL=jdbc:postgresql://postgres:5432/hr
      - REDIS_HOST=redis
      - STORAGE_ENDPOINT=http://minio:9000
      - KEYSTORE_PATH=/keystore/master.key
      - LICENSE_PATH=/config/license.lic
      - JAVA_OPTS=-Xms1g -Xmx2g -XX:+UseG1GC
    volumes:
      - ./keystore:/keystore:ro
      - ./config:/config:ro
      - ./logs:/logs
    restart: unless-stopped
    deploy: { resources: { limits: { memory: 3g } } }

  mcp-gateway:                       # ADR A2：独立容器，同机不同进程
    image: hr-platform/mcp-gateway:${APP_VERSION}
    depends_on: [app]
    environment:
      - APP_INTERNAL_URL=http://app:8080/internal/v1
      - MCP_LISTEN_ADDRESS=127.0.0.1   # ADR A1 默认只听回环；开内网须显式改
      - MCP_CLIENT_RATE_PER_MIN=60     # ADR A8
      - JAVA_OPTS=-Xms256m -Xmx512m
    # 若需同机 AI 客户端经 stdio 访问，把 127.0.0.1 端口的 宿主映射打开；
    # 若要内网直连，才映射端口并对 MCP_LISTEN_ADDRESS 显式改为 0.0.0.0（须写审计）
    expose: ["8090"]
    restart: unless-stopped
    deploy: { resources: { limits: { memory: 1g } } }

  web:
    image: hr-platform/web:${APP_VERSION}   # Nginx + 静态产物
    ports: ["443:443","80:80"]
    depends_on: [app, mcp-gateway]
    volumes: ["./certs:/etc/nginx/certs:ro"]
    restart: unless-stopped

  device-adapter:      # 可选
    image: hr-platform/device-adapter:${APP_VERSION}
    profiles: ["device"]
    environment: [APP_BASE_URL=http://app:8080]
    restart: unless-stopped

  egress-proxy:        # 可选：仅当客户允许出网
    image: hr-platform/egress-proxy:${APP_VERSION}
    profiles: ["egress"]
    restart: unless-stopped

  backup:
    image: hr-platform/backup:${APP_VERSION}
    profiles: ["ops"]
    volumes: ["./backup:/backup","./data:/data:ro"]
    entrypoint: ["/bin/sh","-c","while true; do /opt/backup/daily.sh; sleep 86400; done"]
```

## 9.2 目录规划

```
/opt/hr-platform/
├── docker-compose.yml
├── .env                        # 版本、端口、密码文件路径（chmod 600）
├── secrets/                    # DB 密码、MinIO 密钥（chmod 600，不进镜像）
├── certs/                      # server.crt / server.key / ca.crt
├── keystore/                   # master.key（字段加密主密钥）+ key 版本目录
├── config/                     # license.lic、application-prod.yml（客户定制项）
├── policy-packs/               # 社保/个税/节假日政策包（§6.7b）
│   ├── inbox/                  # 待导入
│   └── applied/                # 已导入记录（版本、时间、操作人、校验和）
├── data/
│   ├── postgres/  redis/  minio/
├── logs/                       # 应用日志（按天滚动）、nginx / gateway 日志
├── backup/
│   ├── daily/                  # 每日全备（加密）
│   ├── wal/                    # WAL 归档
│   └── monthly/                # 月度全备（异地拷贝前暂存）
├── upgrade/
│   ├── inbox/                  # 待安装升级包
│   └── history/                # 已安装记录（版本、时间、操作人、校验和）
└── scripts/
    ├── install.sh  start.sh  stop.sh  status.sh
    ├── backup.sh   restore.sh
    ├── upgrade.sh  rollback.sh
    ├── policy-import.sh        # 政策包导入（校验签名 + 差异预览）
    ├── preflight.sh            # 上线前置检查（见 §9.2b）
    └── healthcheck.sh
```

## 9.2b 首次安装向导与上线前置检查（ADR A15）

**安装向导（`install.sh --wizard`）：建集团 → 建首个法人 → 建超管，三步，不做自助注册。**

| 步骤 | 输入 | 系统动作 |
|---|---|---|
| 1 集团 | 集团名称、简称、时区（默认 `Asia/Shanghai`）、币种 | 创建唯一 `org_type='GROUP'` 根节点（§3.1.1 单根约束） |
| 2 首个法人 | 法人名称、统一社会信用代码、发薪日、参保城市 | 创建 `org_type='LEGAL_ENTITY'` 节点 + `policy_set` 参数集 + 首个成本中心 |
| 3 超管 | 用户名、初始密码（强制首次登录修改）、TOTP 绑定（可跳过但红字提示） | 创建 `sys_user` + 写入**静态超管名单**（同时写 `security.static-super-users` 配置，防自锁，02 §6） |

**ADR A15 明确不做的事**：没有自助注册、没有租户自助开通、没有试用环境。单实例单集团（§0.1），一个实例只服务一个集团，注册逻辑没有存在意义，反而会成为攻击面。

**上线前置检查清单（`preflight.sh`，缺一项不许开始算薪）**

| 检查项 | 不通过的表现 |
|---|---|
| `CREATE EXTENSION btree_gist` 已启用 | 六条 `EXCLUDE` 区间约束建不出来 → 迁移直接失败（这是"空库建一遍"第 0 步能抓到的最早一个失败点） |
| PostgreSQL 版本 ≥ 16、`max_connections` ≥ 200 | — |
| 客户覆盖**全部城市**的社保方案已导入（政策包） | 首月社保基数调整就卡住（§6.7b） |
| 当年个税税率表 + 专项附加扣除额度已导入 | 首月个税算错 |
| 当年法定节假日与调休日历已导入 | 加班倍率边界错（平日/休息日/法定） |
| 政策包未过期（全部城市 `effective_to` 覆盖到未来 6 个月） | 静默用旧值 → 算薪结果错 |
| License 已导入且模块覆盖、人数/门店/法人上限未超 | 启动即降级 |
| 密钥（`keystore/master.key`）已生成且备份 | 丢密钥 = 全部敏感字段不可解密 |
| 证书未过期（≥ 90 天） | 浏览器告警 |
| 备份任务已跑通一次 + 已做一次恢复演练 | 出事无法回退 |
| 门店时区已配置（`org_unit.timezone_name` 全量非空） | `work_date` / `business_date` 差一天（§3.3.5 / §3.3.8） |
| 字典初始化完成：`hour_type` 6 行、`attendance_status` 5 行、`compliance_profile` 已建且全员 `employee_compliance_profile` 覆盖率为 100% | 出勤天数/加班合计静默漏算；合规判定走兜底档（§3.3.11） |
| 考勤机对接准入：设备出厂序列号 + 固件版本 + 通信协议已登记并签收 | 同一批设备重刷固件后 `device_id` 漂移 → 打卡去重失效、重复计数 |

## 9.3 资源规格建议

| 规模 | 应用 | 数据库 | 其他 | 磁盘 |
|---|---|---|---|---|
| 500 人 / 30 店 | 4C8G | 同机 | 同机 | 500GB SSD |
| 3,000 人 / 150 店 | 8C16G | 同机（给 8G） | 同机 | 1TB NVMe |
| 10,000 人 / 500 店（单机） | 8C16G | 同机（给 8G） | 同机 | 2TB NVMe |
| 10,000 人 / 500 店（小集群） | app 2 × 4C8G | PG 主 8C32G + 备 8C32G | Redis 2C4G、MinIO 4C8G | 各 2TB NVMe |

**小集群用 Compose 而不是 K8s**：3 台机器上用 `docker compose` + 外部 DB + Nginx 双机 keepalived 足够。K8s 在一个没有专职运维的客户机房是负债（§10 R1）。

## 9.4 备份与恢复

| 项 | 策略 |
|---|---|
| 全量备份 | 每日 02:00 `pg_dump -Fc`（或 `pg_basebackup`）→ 加密 → MinIO `backup/daily/` + 本地目录；保留 30 天 |
| 增量备份 | WAL 归档持续；保留 7 天（可做 PITR 到任意时刻） |
| 文件备份 | MinIO 每日 `mc mirror` 到 `backup/files/`；附件与 DB 记录的一致性靠"备份时间点对齐"（先 DB 后文件，恢复时以 DB 为准做孤儿清理） |
| 配置备份 | `config/`、`keystore/`、`certs/`、`.env` 一起打包（密钥单独加密） |
| 异地副本 | 客户自备（NAS/USB）；提供 `export-backup.sh` 打包脚本 |
| 恢复演练 | 提供 `restore.sh --target=临时实例`，季度演练；演练记录进运维台账 |
| RPO / RTO | 单机：RPO ≤ 15 分钟（WAL 归档频率），RTO ≤ 2 小时；有备库：RPO ≤ 5 分钟，RTO ≤ 30 分钟 |

## 9.5 离线升级与回滚

**升级包结构**

```
hr-platform-upgrade-1.4.2.tar.gz
├── manifest.json
│   {
│     "version": "1.4.2",
│     "fromVersions": ["1.3.0","1.4.0","1.4.1"],
│     "minLicenseVersion": "1.2",
│     "requiresDowntime": true,
│     "estimatedMinutes": 15,
│     "dbMigrations": ["V1_4_2__add_mcp_plan.sql"],
│     "images": [{"name":"app","file":"images/app-1.4.2.tar","sha256":"..."}, ...],
│     "preChecks": ["disk>=20GB","dbVersion==1.4.1","license.valid"],
│     "postChecks": ["health.ok","migration.success"]
│   }
├── images/            # docker save 的 tar
├── migrate/           # Flyway SQL
└── checksums.txt
```

**升级流程 `upgrade.sh`**

```
1. 校验包完整性（checksums.txt + manifest sha256）
2. 前置检查：磁盘 ≥ 20GB、当前版本 ∈ fromVersions、License 覆盖新版本、DB 连通
3. **强制备份**：backup.sh --tag=pre-upgrade-1.4.2（失败即中止）
4. docker load 新镜像（旧镜像保留，tag 带版本号）
5. 停 app（web 保持，返回"系统升级中"维护页）
6. 运行 migrate 容器执行 Flyway（失败 → 自动回滚步骤见下）
7. 启动 app，等待 /actuator/health = UP（超时 5 分钟）
8. 冒烟检查：登录、组织树、打卡接口、MCP tools/list
9. 成功 → 写 upgrade/history/1.4.2.json，启动 web 正常服务
```

**回滚流程 `rollback.sh`**

```
1. 停 app
2. docker tag 旧镜像 → :current，改 .env APP_VERSION
3. 若本次升级含"不兼容迁移"（manifest.incompatibleMigrations 非空）：
     从 pre-upgrade 备份恢复 DB（RTO 较长，需明确告知客户数据回退范围）
   否则：
     只执行 Flyway 反向脚本（仅当提供了 undo 脚本）
     —— 本项目要求"迁移必须向前兼容"，正常情况下不需要恢复 DB
4. 启动 app + 健康检查 + 冒烟
5. 写 upgrade/history/rollback-<version>.json
```

**向前兼容迁移规范（关键设计原则）**

| 规则 | 说明 |
|---|---|
| 只加不删 | 删除列/表至少滞后一个小版本，且先改代码不再使用 |
| 新列必须可空或有默认值 | 老版本代码不写新列也能运行 |
| 不重命名列 | 用"新增列 + 双写 + 后删"三步走 |
| 不改变列语义 | 需要变语义就加新列 |
| 索引与约束后加 | 大表加索引用 `CONCURRENTLY`，且放在升级最后 |
| 数据回填与应用发布解耦 | 回填放独立任务，可重复执行 |

满足以上规则时，`rollback.sh` 只需换镜像 tag，30 秒完成，**不丢数据**。这是本地交付最关键的运维能力——客户机房没有 DBA，回滚必须傻瓜化。

**schema 指纹：升级前后必须逐项比对（`pg_get_constraintdef` 是模型的一部分）**

升级包里必须带一份 `schema_fingerprint.json`，由**升级前**的库算出，与**目标版本随包发布**的基准指纹比对。**指纹比的是"相对上一版变没变"，不是"对不对"**——它允许变化，但要求变化被看见。

```sql
-- 六源合成一个指纹（缺一源就会漏掉一整类"规则藏在 DDL 里"的情况，见 §4.5.9）
WITH src AS (
  SELECT 'constraint' AS kind, conrelid::regclass || '.' || conname AS obj, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
  UNION ALL SELECT 'index',    schemaname||'.'||indexname, indexdef   FROM pg_indexes  WHERE schemaname = 'public'
  UNION ALL SELECT 'attrdef',  adrelid::regclass||'.'||attnum, pg_get_expr(adbin, adrelid) FROM pg_attrdef
  UNION ALL SELECT 'view',     schemaname||'.'||viewname, definition FROM pg_views    WHERE schemaname = 'public'
  UNION ALL SELECT 'proc',     p.oid::regprocedure::text, prosrc     FROM pg_proc p WHERE pronamespace = 'public'::regnamespace
  UNION ALL SELECT 'trigger',  tgrelid::regclass||'.'||tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal
)
SELECT kind, obj, md5(def) AS def_md5 FROM src ORDER BY kind, obj;
```

**这份指纹的三个使用规则**：

| 规则 | 说明 |
|---|---|
| **差异必须逐条确认，不许"全部接受"** | 每条差异附一句"为什么变"（来自迁移脚本注释），没有注释的差异判**升级失败** |
| **指纹 ≠ `guards` 判据** | `pg_get_constraintdef()` 的**回显跨 PG 小版本会变**（多列 `CHECK` 带不带 `COALESCE`、表达式展不展开）。用它做 `guards` 的 `pass/fail`，会让每次小版本升级报一片假红，然后整套报警被关掉（§4.5.3）。**它的位置是"变更可见性"，不是"正确性判定"** |
| **指纹算不出来时判失败，不判"跳过"** | 目标是客户库，权限可能不足（`pg_proc.prosrc` 对非属主不可见）。**看不到就判 `unknown` 并阻断**——"缺证据取不在"只对保护性断言成立，对"我有没有能力看到"这件事必须报未知（§3.3.8 元规则③） |


### 9.5b 新增阻断型校验的上线方式（六步：第 −1 步 + 0–4 步；两步都不能省）

本节新增的一批约束**有意设计成会真的失败**（§3.3.8 的恒等式、§3.3.2 的 `ck_sa_d10_service`、§3.3.5 的 14 列 `NOT NULL` 快照 + `chk_ads_span` + `chk_ads_nonneg`、`chk_ads_sum`（析取式）、`ex_ads_no_overlap`、`ctg_ads_fallback_same_txn`、复合外键等）。**其中 `snap_on_duty_break_basis` 的回填必须在同一支迁移里完成**——它是 `NOT NULL` 且 `chk_ads_sum` 依赖它，存量行没有值就 `VALIDATE` 不过。在客户已有数据的库上直接 `ALTER TABLE ... ADD CONSTRAINT` 会**在升级窗口里失败**，而且失败信息只指向一行，运维不知道还有几万行。

**五步上线法（0–4，写进迁移脚本模板，不允许直接 `ADD CONSTRAINT`）**

> 下面五步适用于**绝大多数**收紧类约束。有一类例外——**当"要回填的键"由这条约束所禁止的那个东西决定时**，五步之外还要先做一步，见本节末尾「第 −1 步」。

| 步 | 动作 | 产物 | 能否回退 |
|---|---|---|---|
| **0** | **只读试算存量**（`SELECT` 出所有会违规的行，不写任何 DDL） | **两个数**：会红多少行 / 集中在哪些门店·哪些日·哪些规则版本 | 天然无副作用 |
| 1 | `ADD CONSTRAINT ... NOT VALID`（只对新写入生效，不扫存量，秒级） | 新数据已被挡住 | `DROP CONSTRAINT` |
| 2 | 把试算清单导出给业务清洗（走业务单据：撤销排班 / 改人员类型 / 补段） | 清单文件 + 清单表，可反复导出、可 diff | — |
| 3 | 清洗完成（**必须是"修正数据"，不是"放宽约束"**） | 违规行清零 | — |
| 4 | `VALIDATE CONSTRAINT`（扫全表、持锁，只在这一步，且此时已无违规行） | 约束转正 | — |

**第 0 步为什么不能省（这是本轮最容易出事故的一条）**

「从求和式升级为结构式」这类收紧是**严格加强**——线上跑了两年的数据里，必然存在"洞与重叠相抵"的行（例如 `20:00–22:00` + `22:30–24:00`，求和恰好等于 240，但中间有 30 分钟洞）。

对这类存量，直接加约束不是"有一些红"，是**DDL 加不上、当天全店班段录不进来**——升级窗口里业务直接停摆。而试算只需要一条 `SELECT`，成本和风险都不在一个量级。

```sql
-- 第 0 步示例：先数出来，不动结构
SELECT store_org_id, work_date, count(*) AS bad_rows
FROM (
  SELECT ds.store_org_id, ds.work_date,
         abs(ds.span_hours
             - (ds.work_hours + ds.break_on_duty_hours + ds.break_off_duty_hours)) AS diff
  FROM attendance_daily_store ds
) t
WHERE t.diff >= 0.01
GROUP BY store_org_id, work_date
ORDER BY bad_rows DESC;
```

**试算结果要进季度质量报告。** 它反映的不是"客户数据脏"，而是**切分引擎自己的历史质量**：红行集中在哪几个规则版本、哪几类班型、哪几个月——这是引擎缺陷的第一手证据，比任何验收用例都真实。

**四条配套规则**

| 规则 | 原因 |
|---|---|
| 存量清单必须**先给客户看**再清洗 | 清单里通常混着"历史脏数据"和"业务真实情况"，后者要改约束不改数据 |
| 清洗期间约束处于 `NOT VALID` | 新数据已被挡住，存量在收敛，不存在"边清边进" |
| `VALIDATE CONSTRAINT` 单独一个迁移文件 | 它扫全表、持锁，必须能和前面的清洗步骤分开重试 |
| `NOT VALID` 状态的约束**必须进巡检** | 否则半年后没人记得这条约束其实没生效：`SELECT conname FROM pg_constraint WHERE NOT convalidated`，非空即视为上线遗留项 |

**这条同时是"存量数据迁移"与"口径收紧"两种场景的统一做法**：先数、再声明、后收敛、最后转正——**不因为存量脏就放弃约束，也不因为要加约束就阻塞升级窗口。**

**排序：谁必须先做**

同一批迁移里若既有"新建列/表"又有"收紧约束"，顺序固定为：**加列（可空）→ 回填 → 加约束（`NOT VALID`）→ 清洗 → `VALIDATE`**。反过来会出现"约束已生效但数据还没回填"，第 0 步的试算结果直接等于全表行数。

### 第 −1 步：当"回填的键"由约束要禁止的那个东西决定时，顺序是反的

上面那条排序有一个前提：**回填与约束是两个独立的动作，谁先谁后只是效率问题。** 有一类情况不是——`employment_segment.seq` 就是，本节把它单列成第 −1 步，因为**顺序错了迁移跑不完，而且错法不是报错，是静默排错序**。

```sql
-- employment_segment 现状（§3.2.5）
seq int NOT NULL,  UNIQUE (employment_id, seq)
valid_from date NOT NULL, valid_to date,
CONSTRAINT ex_seg_no_overlap EXCLUDE USING gist (employment_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
```

**问题在这里**：`seq` 的含义是"这一段是这个人的第几段"，所以它的**语义定义**就是"按 `valid_from` 排序的名次"：

```sql
-- 回填 seq 的唯一正确写法
UPDATE employment_segment s
   SET seq = t.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY employment_id ORDER BY valid_from) AS rn
          FROM employment_segment) t
 WHERE s.id = t.id;
```

而 `row_number() OVER (... ORDER BY valid_from)` 在**同一个人两段 `valid_from` 相同时给出不唯一的结果**——PG 不保证相同排序键的行之间谁先谁后，换个执行计划（并行度、表的物理顺序、`work_mem`）就可能换一个顺序。**而 `valid_from` 相同、区间重叠，正是 `ex_seg_no_overlap` 要禁止的形态。**

所以：

| 顺序 | 会发生什么 |
|---|---|
| ~~先加 `ex_seg_no_overlap`，再回填 `seq`~~ | 存量有重叠 → `ADD CONSTRAINT` 直接失败，迁移中止。**这条至少是响的** |
| **先回填 `seq`，再清重叠，再加 `ex_seg_no_overlap`** | 回填时 `seq` 的排序在重叠行上不唯一 → **回填出的 `seq` 取决于物理顺序** → 清理时删掉"后面的"那一段，**删哪一段由 `seq` 决定 → 删错段**。这条**不响** |
| **正确顺序**：第 0 步试算重叠 → 清重叠（业务确认） → 回填 `seq`（此时排序唯一） → 加 `UNIQUE` → 加 `EXCLUDE` | 每一步的前提都成立 |

**`seq` 回填必须带一条"幂等断言"**（这是 research-org 的 `current(key)` 同值断言落在本表上的形态）：

```sql
-- 回填跑第二遍必须什么都不改。期望：updated = 0
WITH r AS (SELECT id, row_number() OVER (PARTITION BY employment_id ORDER BY valid_from) AS rn
             FROM employment_segment)
SELECT count(*) AS would_change
  FROM employment_segment s JOIN r ON r.id = s.id
 WHERE s.seq IS DISTINCT FROM r.rn;
```

**为什么这条断言比"回填跑通了"重要**：回填跑通只证明"这次成功"，幂等断言证明"**这个 `seq` 是数据本身的函数，不是这次执行计划的函数**"。前者换个环境就跑一次新的，后者一次成立以后一直成立。**一条不可重放的迁移，它的结果不是数据，是那次执行的快照。**

**还有一件容易忽略的**：`UNIQUE (employment_id, seq)` 如果是逐行 `UPDATE` 回填的，中间态会短暂出现两行同 `seq`——`UNIQUE` 是**行级立即检查**（不是 `DEFERRABLE`），所以逐行回填会在中途撞上它。上面那句 `UPDATE ... FROM (row_number())` 是一次性集合更新，但**PG 的 `UNIQUE` 检查仍然逐行进行**，不保证整批更新的中间态不冲突。所以：

```sql
-- 若存量 seq 需要重排（不只是填空），UNIQUE 必须是 DEFERRABLE 或用两段式
ALTER TABLE employment_segment ALTER CONSTRAINT uk_seg_seq DEFERRABLE INITIALLY DEFERRED;
-- 或者：先 UPDATE 到负数临时值 → 再 UPDATE 到目标值（两段式，不用改约束）
```

**选两段式的理由**：`DEFERRABLE` 约束会让**所有**写入都推迟到提交时检查，等于把这条唯一性从"立即失败"降级为"提交时失败"——而提交时失败的那条 INSERT 已经跑完了全部业务逻辑，报错信息与出错位置已经隔了一层。**为了一次迁移把一条永久约束改松，是拿长期换短期。**

## 9.6 License 校验

```json
// license.lic（JSON + RSA-PSS 签名）
{
  "licenseVersion": "1.2",
  "customerName": "某某餐饮集团",
  "productEdition": "ENTERPRISE",
  "modules": ["ORG","HR","SCHEDULE","ATTENDANCE","LEAVE","PAYROLL","SI","TAX",
              "PERF","RECRUIT","LEARN","FLEX","HRO","REPORT","MCP"],
  "limits": { "employeeMax": 10000, "storeMax": 500, "legalEntityMax": 50,
              "mcpClientMax": 20, "concurrentUserMax": 500 },
  "issuedAt": "2026-11-01", "expireAt": "2027-10-31",
  "machineBinding": { "mode": "NONE|MAC|CPU_SERIAL", "value": "..." },
  "signature": "base64..."
}
```

| 机制 | 设计 |
|---|---|
| 校验时机 | 启动 + 每日 03:00 定时 + 每次登录（仅校验缓存）+ 关键操作前（发薪、新增员工） |
| 签名 | RSA-PSS + 内置公钥（公钥硬编码在代码，私钥在厂商侧离线保管） |
| 机器绑定 | 默认 `NONE`（餐饮客户换机频繁，绑定会变成运维负担）；可选 `MAC` 指纹（允许 ±1 个网卡变化容错） |
| 人数超限 | 不锁数据、不删功能，只**拒绝新增**：新增员工/门店/法人被拒并提示"已超 License 上限，请联系商务"；页面顶部常驻横幅 |
| 到期 | T-30 天开始提示 → 到期后进入 **30 天只读宽限期**（禁写、可查、可导出）→ 宽限期后仅超管可登录（License 管理页） |
| 模块未授权 | 菜单隐藏 + 接口 403 + MCP 工具不注册 |
| 不联网 | 完全不依赖外网；可选 `phone-home`（客户允许出网时上报心跳，用于厂商统计，非校验必需） |
| 替换 | 超管上传新文件 → 校验签名与生效期 → 记审计（旧/新摘要）→ 无需重启（热加载 + 刷新缓存） |

## 9.7 日志与监控（本地可观测的最小集）

**原则：不引入 ELK / SkyWalking 这类重设施。只要"出事时能在 5 分钟内定位"。**

| 项 | 方案 |
|---|---|
| 应用日志 | JSON 结构化（`logstash-encoder`），按天滚动，保留 30 天；字段含 `traceId`、`userId`、`clientId` |
| 访问日志 | Nginx access log（含 `traceId` 回传头）+ 慢请求（> 1s）单独文件 |
| 错误聚合 | `sys_error_log` 表：异常类型 + 堆栈 Top N + 首次/最近时间 + 出现次数；页面可查（避免翻日志文件） |
| 指标 | 应用自带 `/actuator/prometheus`；**内置轻量监控页**（不依赖额外组件）：JVM 堆、GC、线程、DB 连接池、慢查询 Top 20、Redis 命中率、队列积压、作业耗时 |
| 可选 Prometheus + Grafana | 提供预置 dashboard JSON，客户愿意多跑两个容器时启用 `--profile=metrics` |
| 链路追踪 | 不引 APM。用 `traceId` + 结构化日志 + `mcp_call_log.affected_row_ids` 做手工串联（单机场景足够） |
| 健康检查 | `/actuator/health` + **自检页**（DB/Redis/MinIO 连通、磁盘余量、证书到期天数、License 剩余天数、备份最后成功时间、设备在线数、集成任务积压） |
| 告警 | 写 `sys_alert` 表 + 站内横幅；出网时推 IM/邮件。内置规则：磁盘 < 20%、备份失败 2 次、打卡积压 > 1000、集成任务连续失败、证书 30 天内到期、License 30 天内到期、慢查询 > 3s 出现 10 次 |
| 日志脱敏 | 全局脱敏插件（证件/银行卡/手机/金额按配置掩码），防止日志成为泄密源 |

**运维手册必含的 12 条操作**：启停、状态检查、备份、恢复、扩容磁盘、日志定位、慢查询排查、卡住的作业处理、设备离线排查、License 替换、升级、回滚。

---

# §10 风险与取舍

| # | 风险/取舍 | 明确的选择 | 代价 | 缓解 |
|---|---|---|---|---|
| **R1** | **不上微服务** | 单体模块化（Maven 多模块 + ArchUnit 强边界），一个进程 | 单进程故障面大；模块边界会随交付压力腐化；无法按模块独立扩容 | ArchUnit 编译期拦截跨模块直接访问 Mapper/Entity；每个域只暴露 `api` 包（service 接口 + DTO）；单进程也做**优雅降级**（集成层、MCP 层、报表模块可独立熔断）；若未来真要拆，模块边界已经是拆分边界 |
| **R2** | **不做多租户隔离** | 单实例单集团，不做租户中间件、不做分库分表 | 未来若要做 SaaS，需要补租户上下文与隔离 | 所有表保留 `group_id`（默认 1）+ 全局 `TenantInterceptor` **预留但不启用**；唯一索引全部带 `group_id` 前缀（当前值恒 1，无副作用），未来开拦截器即可；数据导出/导入支持按 `group_id` 过滤 |
| **R3** | **打卡"先入队后落库"** | 用 Redis Stream 承接峰值，异步批量落库 | 极端情况下（Redis 崩溃且未落盘）可能丢 1–2 秒数据 | AOF `everysec` + 队列积压告警 + 设备侧保留 7 天缓存可补传；Redis 不可用时自动降级为同步写 DB（慢但正确）；提供"打卡补录"工具作最后兜底 |
| **R4** | **已发布排班锁班次快照** | 集团班次改版**不回溯**已发布排班 | 集团想统一修正某班次时，只能逐店走"排班变更单"，运维成本高 | 提供"批量排班变更单"入口（一次框选多门店生成一张单，但每条变更仍通知员工）；这一取舍换来的是**员工知情权与劳动争议举证链完整**，不可让 |
| **R5** | **公式 DSL 受限** | 不允许用户上传代码，只能用白名单因子 + 内置函数 | 极个别客户规则（复杂阶梯提成、跨主体分成）表达不出来 | 预留 `PayrollExtensionPoint` Java SPI，定制逻辑编译成 jar 随**升级包**分发（需签名校验），客户不能后台上传；定制包纳入版本管理与回归测试 |
| **R6** | **不引消息中间件** | Redis Stream + DB outbox 表 | 没有"削峰 10 万 TPS"的能力；跨副本事件投递依赖轮询（延迟秒级） | 本项目峰值 TPS 一二百，Redis 完全够；outbox 轮询 1s 一次，秒级延迟对 HR 场景无感；少一个中间件 = 客户机房少一个故障点与学习成本 |
| **R7** | **内网 + 第三方 SaaS 能力受限** | 以"完全离线可用"为基线，联网能力全部为增强项 | 电子签需轮询而非回调（延迟分钟级）；IM 消息推送需出网；银行代发必须人工传文件 | 每个集成点都实现"离线降级路径"（§6）；把"是否需要出网"写进部署前置检查清单，让客户一次性决策 |
| **R8** | **单机数据库单点** | 默认无 HA（客户机房无 DBA，主从切换本身就是风险） | DB 故障时全系统不可用 | 每日全备 + WAL 归档（RPO 15 分钟）+ 恢复脚本傻瓜化 + 季度演练；愿意上小集群的客户提供"1 主 1 备 + 手动切换脚本"（不做自动 failover，避免脑裂） |
| **R9** | **四维归属 + 三轴权限使 SQL 复杂度高** | 坚持四维不合并（这是能算对钱的前提） | 每个查询都要 JOIN 权限临时表；写法有约定，新人易漏 | 拦截器兜底（漏 `tmp_scope_*` 直接抛异常）；`@Scoped` 注解 + 集成测试覆盖；性能上预聚合 + 临时表 hash join，实测影响 < 5% |
| **R10** | **万级组织节点 + 组织架构图交互** | Canvas + 懒加载 + 预聚合徽标 | 万级节点下"全展开"不可行（产品上限制默认 3 层） | 搜索定位 + 路径展开；节点聚合计数；性能预算写进验收标准（首屏 < 1s，5000 节点交互 60fps） |
| **R11** | **AI 能力随模型波动** | MCP 工具设计为"结构化 + 自然语言摘要"双输出 | 同一问题不同模型表现差异大；AI 可能调用顺序不合理 | 提供 `meta_list_tools` / `meta_get_current_user` 让 AI 先自查；错误码封闭集合引导 AI 正确重试；**关键结论要求 AI 引用数据来源**（工具返回含 `metricCode`、`dataAsOf`、`confirm_status`），避免编造 |
| **R12** | **MCP 拆独立网关（A2）** | 同机不同容器，网关不含业务规则 | 多一个容器与一套内部 HTTP 契约；工具调用多一跳（~2ms）；排查问题要看两个进程的日志 | 内部 HTTP 走回环 + 服务间 token；`traceId` 贯穿两进程（网关注入、主应用透传、日志都带）；网关只做薄壳，工具实现直接调 Application 接口，不做"网关自己的业务分支"；网关崩溃不影响 Web 与打卡 |
| **R13** | **不引 MQ，MCP 写操作走同步 HTTP（A2 代价）** | 30s 超时 + 幂等键可重试；批处理改异步 | 同步调用会占连接；网络抖动下"到底成没成功"要客户端自己判 | 写工具全部带 `idempotency_key`（A5），重试安全；批处理一律 `jobId + 轮询`（业务层异步），**不同步等**；30s 超时是硬上限，长任务不许设计成同步工具（工具评审强制项） |
| **R14** | **不做读写分离（A13）** | 全部读写走主库 | 报表高峰会与 OLTP 争 CPU/IO | 重查询一律异步化；报表用独立小连接池（max 10）；`statement_timeout=30s`；视图 + 覆盖索引；若真扛不住按 §7.4 的升级路径走，不许运维自行加备库 |
| **R15** | **P0 不导考勤与工资历史（A12）** | 只导花名册 / 薪资档案 / 假期余额；历史进只读归档库 | 员工在系统里看不到系统上线前的工资条（要跳归档页）；两套界面 | 归档库独立 schema、醒目提示"历史归档，口径与现行不同"；主库零污染；如客户强要求"一个入口看全历史"，做联合查询页但**不做 JOIN、不做计算** |
| **R16** | **工时结果层不可变 + 14 列快照（§3.3.5）** | `attendance_daily_store` 每行 13 个快照列 + 1 个时区偏移，重算必须留痕、快照列禁止 `GENERATED` | 存储略增（~5 GB/5 年，可忽略）；重算逻辑更复杂（必须先查封账、必须整段替换） | 快照体积实测可忽略；重算接口统一走 `AttendanceRecalcService`，强制前置 `period_seal` 检查；`punch → segment` 解析按人日全量重算整段替换，不做增量补丁（增量补丁重跑会重复计） |
| **R17** | **两级工时上限（法定 + 考勤组）** | 法定上限挂 `legal_employment_form`，考勤组只能收紧 | 参数从一处变两处，配置与排查更绕 | 校验结果统一在冲突清单里标明"触发了哪一级上限"；参数页把两级阈值并排展示；`preflight.sh` 校验法定阈值已配置 |
| **R18** | **`work_date` 用普通列 + 触发器，不用生成列（§3.3.5c）** | 恢复后原值照搬、与环境无关；配套 `CHECK` + 复合外键 + 列级 `REVOKE` | 写入防错从"结构保证"降为"三道机制叠加"：**触发器可被表 owner 绕过，`CHECK` 又不防表达式本身算错**（同一条 `fn_work_date` 跑两遍，同错即同过） | ① `REVOKE` 列级写权限，只有触发器与迁移脚本能写；② 复合外键保留，防"挂错到隔壁那天"（这类错所有逐行校验全绿）；③ 表达式正确性由**离线独立重算**兜（§3.3.12，纯 SQL 另写一遍、不复用 `fn_work_date`）；④ `fn_work_date` 禁改，CI 断言"函数体变化必须伴随版本常量变化" |
| **R19** | **阻断型约束用 `NOT VALID` 上线（§9.5b）** | 先只读试算 → `NOT VALID` → 清存量 → `VALIDATE` | ① `NOT VALID` 状态对新数据生效、对旧数据不生效，半年后没人记得它其实没兜住；② **漏掉第 0 步试算，收紧类约束（如求和式→结构式）会 DDL 加不上、当天全店班段录不进来** | ① 巡检查 `SELECT conname FROM pg_constraint WHERE NOT convalidated`，非空即上线遗留项，`preflight.sh` 列为"不许开始算薪"；② 第 0 步的两个数（会红多少行 / 集中在哪）必须进交付报告，它反映切分引擎的历史质量 |

**三件事必须让客户书面确认（写进交付合同附件）**

1. 打卡异步落库的 RPO（≤ 2 秒）是否可接受；
2. 已发布排班不随集团班次改版回溯，是否需要额外的"批量变更"增值服务；
3. 是否需要出网（决定 IM / 电子签 / 银行 / 税务的对接方式与体验）。

**另外两件要在交付前对齐（不写清会变成验收争议）**

4. **历史工资条只提供只读归档查询**（ADR A12），不并入主库、不参与任何统计——员工若要求"在工资条页面无缝翻到 2024 年"，需另立需求；
5. **MCP 默认只听本机 127.0.0.1**（ADR A1）。客户若要"让内网任意电脑的 AI 客户端都能接"，属于**需要显式审批的安全决策**，需客户 IT 书面确认并由我方开启 + 记审计。

---

# §11 附录 A：工程结构与任务拆分

## 11.1 后端工程结构

```
hr-platform/
├── pom.xml                          # 聚合 + 依赖版本管理
├── hr-common/                       # 统一响应、异常、枚举、脱敏注解、traceId、雪花ID
├── hr-security/                     # 认证、三轴权限、ScopeResolver、AuditAspect、FieldMasker
├── hr-domain-org/                   # 组织域：org_unit / version / headcount / attendance_group
├── hr-domain-person/                # 人员域：person / employment / contract / certificate / change_order
├── hr-domain-worktime/              # 工时域：shift / schedule / attendance_punch / attendance_daily / _store / _segment / exception
├── hr-domain-leave/                 # 假期域：leave_type / quota_ledger / balance / request
├── hr-domain-payroll/               # 薪酬域：scheme / item / period / record / allocation / batch / si / tax
│   ├── engine/                      #   算薪引擎：FormulaCompiler / Graph / ShardExecutor / SnapshotService
│   └── validator/                   #   FormulaValidator / BalanceValidator / AnomalyDetector
├── hr-domain-perf/                  # 绩效域
├── hr-domain-recruit/               # 招聘域
├── hr-domain-learn/                 # 培训域
├── hr-domain-flex/                  # 灵活用工与外包协同
├── hr-report/                       # 指标字典、预聚合刷新、报表模板
├── hr-integration/                  # IntegrationPort + 各适配器（device/im/bank/esign/tax/fin）
├── hr-mcp-gateway/                  # 独立容器：@McpTool 定义、ToolRegistry、ScopeMapper、PlanStore、ConfirmGate、QuotaGuard、CallAuditor（无业务规则）
├── hr-mcp-stdio-bridge/             # stdio ⇄ HTTP 桥（GraalVM native image）
├── hr-job/                          # Spring Batch 作业（算薪、导入、汇总刷新）+ Quartz 任务
└── hr-boot/                         # 启动类、配置、Flyway 迁移、Dockerfile
    └── src/main/resources/db/migration/
```

## 11.2 前端工程结构

```
web/
├── package.json  vite.config.ts  tsconfig.json
├── src/
│   ├── main.ts  App.vue  router/
│   ├── api/                 # 按域拆分的 API client（与后端 DTO 对齐）
│   ├── stores/              # Pinia：auth / org / dict / ui
│   ├── layouts/             # PC 后台布局 / H5 布局
│   ├── views/
│   │   ├── org/             # 组织树、架构图（Canvas）、编制
│   │   ├── employee/        # 花名册、档案、入离调转
│   │   ├── schedule/        # 划线排班板（核心交互）
│   │   ├── attendance/      # 异常处理、工时确认、封账
│   │   ├── leave/           # 请假、余额、台账
│   │   ├── payroll/         # 方案、算薪、工资条、分摊
│   │   ├── perf/  recruit/  learn/
│   │   ├── report/          # 看板、自定义报表
│   │   └── gov/             # 权限、审计、AI 操作日志、配置、集成监控
│   ├── components/          # 通用组件（虚拟表格、区间选择、金额输入、掩码展示）
│   ├── mobile/              # Vant 页面：打卡、查班表、请假、工资条、学习
│   ├── workers/             # org-layout.worker.ts（tidy tree 布局）
│   └── utils/               # 权限指令、水印、脱敏、日期
```

## 11.3 任务拆分（供工程排期参考，本轮不实施）

> 按"能独立验证的垂直切片"切分，每个任务 ≤ 5 天，且都能跑出可演示的界面。**共 5 个任务**，后续每任务内部再拆子任务。

| ID | 任务 | 主要文件/模块 | 依赖 | 优先级 | 验收 |
|---|---|---|---|---|---|
| **T01** | 工程骨架 + 平台域（认证/权限/审计/配置/作业） | `hr-common` `hr-security` `hr-boot` `hr-job`（框架） `web` 骨架、Flyway 初始迁移、Docker Compose | — | P0 | 能登录、能建角色分配三轴权限、审计日志可查、健康检查通过 |
| **T02** | 组织域 + 人员域 | `hr-domain-org` `hr-domain-person` + 前端组织树/架构图/花名册/入离调转 | T01 | P0 | 四维归属落库正确；组织版本可切换；健康证可查；跨法人调动生成两条工资主体 |
| **T03** | 工时域（班次/排班/考勤/封账） | `hr-domain-worktime` `hr-integration`（device） + 划线排班板、异常处理、封账 | T02 | P0 | 划线排班 5000 格 < 1.5s；冲突校验三类全覆盖；健康证过期硬阻断；跨店工时合并判加班 |
| **T04** | 假期域 + 薪酬域（含算薪引擎） | `hr-domain-leave` `hr-domain-payroll` `hr-job`（算薪 Batch） + 请假/余额/方案/算薪/工资条/分摊 | T03 | P0 | 四态余额与台账一致；1 万人算薪 < 8 分钟；一人一期间一条记录红线通过；分摊平衡校验生效 |
| **T05** | MCP 开放层（独立网关）+ 外包协同 + 绩效/招聘/培训 + 报表与集成 | `hr-mcp-gateway` `hr-mcp-stdio-bridge` `hr-domain-flex` `hr-domain-perf` `hr-domain-recruit` `hr-domain-learn` `hr-report` `hr-integration`（其余适配器） | T04 | P0 / P1 | 101 个工具可 `tools/list`；两阶段写生效；**红线 12 条**集成测试全绿；网关默认只听 127.0.0.1；批处理工具返回 jobId 而非同步等待；指标字典口径统一 |

**跨任务共享约定**：见 §12。

**T01 开工前必须先做的一个冒烟测试（30 分钟，结果写进 ADR 附录，不允许"先写着看"）**

> **S1'：`work_date` 的三道机制同时存在时不打架。**
>
> 前提：`BEFORE` 触发器（`fn_work_date`）+ `CHECK ck_ads_work_date` + 复合外键 `(employee_id, work_date)` + 列级 `REVOKE` 四件同时生效。
>
> | 测点 | 期望 |
> |---|---|
> | 单行 `INSERT` 班段 | 成功，`work_date` 由触发器写入且与母行人日一致 |
> | `UPDATE` 改 `shift_start_at`（跨零点） | 成功，`work_date` 随之重算，复合外键仍成立 |
> | 批量补录（`COPY` 或批量 `INSERT`） | 成功，触发器逐行生效不报错 |
> | 手工 `UPDATE ... SET work_date = '2026-01-01'` | **被 `REVOKE` 挡住**（`permission denied for column`） |
> | 用表 owner 身份绕过 `REVOKE` 写一个错的 `work_date` | **被 `CHECK` 挡住** |
> | 把一个班段挂到"隔壁那天"的人日上 | **被复合外键挡住** |
>
> 这条测的是"四道东西不会互相打架"，比"某个函数是不是 IMMUTABLE"更有价值。任一测点不符 → 方案回退顺序：先去掉触发器改由应用写入（保留 `CHECK` + 复合外键），再不行只剩 `CHECK` + 应用层保障。**但复合外键在任何回退方案里都保留**——它是唯一能防"挂错到隔壁那天"的结构保证。

**已作废的两个测试项（留档，别再加回来）**

| 曾计划 | 作废原因 |
|---|---|
| S1：生成列能否被复合外键引用 | `work_date` **不再是生成列**，没有测试对象（§3.3.5c）。留成"待测项"会让半年后的人以为生成列方案还在 |
| S2：生成列表达式里每个函数是否 `IMMUTABLE` | 生成列方案整体撤销，前提消失。改为 S1'（触发器 + `CHECK` + 复合外键 + `REVOKE` 共存） |

**跨任务共享约定**：见 §12。

---

# §12 附录 B：共享约定（Shared Knowledge）

工程实现时以下约定全局生效，不得各自另立标准。

## 12.1 接口与响应

| 约定 | 内容 |
|---|---|
| Web REST | `POST/GET /api/{domain}/{action}`，响应统一 `{ code, message, data, traceId }`；`code=0` 成功，其余见错误码表 |
| 分页 | 入参 `page`（从 1 开始）、`size`（默认 20，上限 200）；出参 `{ list, total, page, size }` |
| 排序 | `sort=field,asc`；白名单字段，禁止任意列排序 |
| 时间 | 全部 ISO 8601；日期用 `yyyy-MM-dd`；时刻用带时区 `2026-11-14T09:30:00+08:00` |
| 期间 | `period_month` 统一 `yyyy-MM` 字符串；`biz_year` 为四位年份 |
| 错误码 | Web 用 HTTP 状态码 + 业务 `code`；MCP 用 §5.2.2 的 `E_*` 封闭集合 |
| traceId | 入口生成，写入 MDC 与响应；跨服务通过 header `X-Trace-Id` |

## 12.2 数据约定

| 约定 | 内容 |
|---|---|
| 主键 | 雪花 ID（`bigint`），应用生成；DB 不用序列 |
| 金额 | `BigDecimal` + `numeric(18,2)`；禁止 `double`/`float`；统一 `RoundingMode.HALF_UP` |
| 工时 | `numeric(8,2)`；最小 0.5 小时；分钟转小时保留 2 位 |
| 系数/费率 | `numeric(9,6)` |
| 时间存储 | `timestamptz`（UTC 存储，展示转 Asia/Shanghai）；业务日期用 `date` |
| 空值 | 日期未发生 → `NULL`，禁 `''`/`'1970-01-01'`/`'0'`；DB CHECK 强制 |
| 逻辑删除 | 业务数据禁物理删除；配置表用 `is_deleted`；作废用 `status` / `void_flag` |
| 区间约束 | 一切"同一时点只能有一条"的规则用 `EXCLUDE USING gist` + `daterange`/`tstzrange`；**部署必须 `CREATE EXTENSION btree_gist`** |
| 时区 | `org_unit.timezone`（门店级，默认 `Asia/Shanghai`）；日期派生一律 `AT TIME ZONE` 门店时区；**禁止用 JVM 默认时区推导业务日期** |
| 单据 | 所有业务变更必须经单据（入职/调动/调薪/离职/排班变更/支援/考勤调整），**禁止直写结果表**（红线 RL11） |
| 乐观锁 | 所有可编辑表带 `version`，更新 `WHERE version=?`，冲突返回 409 |
| 审计列 | `created_at/by`、`updated_at/by` 全表必备，由 MyBatis 拦截器自动填充 |

## 12.3 关键口径（不得重新定义）

| 口径 | 唯一出处 |
|---|---|
| 一人 + 一期间 + 一法人 = 一条工资记录 | `payroll_record` 部分唯一索引 `WHERE is_current` |
| 成本分摊不回写工资记录 | `payroll_cost_allocation` 子表；`payroll_record.cost_org_id` 只反映主档 |
| 四态假期余额是台账派生值 | `leave_quota_ledger` 唯一事实源；`leave_balance_snapshot` 可全量重算 |
| 组织四维 + 两标记 + 两关系线 | 发薪法人 / 社保主体+城市 / 编制组织 在 `employment`（长期稳定）；**排班组织 / 考勤组织 在 `employee_org_assignment` 时序表**（按天可变，禁止做成字段）；成本组织不落表、结账固化到 `payroll_cost_allocation`；`report_to_id` / `dotted_line_ids` 两条关系线（§3.2.2 / §3.2.4） |
| **日期归属三段** | 计薪 → `attendance_daily.work_date`；成本/毛利/日报表 → `attendance_daily_store.business_date`；加班倍率 → 实际 `shift_start_at` 时刻。**三者不一致是正确的，禁止合并成一个"归属日期"**（§3.2.4） |
| **工时归属日 = 班段开始日** | `attendance_daily_store.work_date` 是**普通列**，由 `BEFORE` 触发器按 `fn_work_date(shift_start_at, snap_utc_offset_minutes)` 写入，配 `CHECK` 复验 + 列级 `REVOKE` + 复合外键 `(employee_id, work_date)`；表达式**先转无时区再加偏移**；跨零点不拆行；**每个员工按自己班段的开始日**（顶班员工与正常员工可不同），因此无需例外分支；**禁存时区名，只存偏移分钟**；**禁改 `fn_work_date`**（§3.3.5c） |
| 工时唯一事实源 | `attendance_daily`（人 × 日 判定单元）+ `attendance_daily_store`（班段计量单元）+ `attendance_punch`（原始流水，append-only）；**不建 `worktime_fact` / `work_hour` 表** |
| **14 列快照** | `attendance_daily_store` 13 个快照列 + `snap_utc_offset_minutes`，全部 `NOT NULL`：`snap_unit_price` / `snap_skill_code` / `snap_org_id`（成本组织）/ **`snap_attendance_org_id`（考勤组织——权限的考勤维度过滤依据，不能用成本组织列代替）** / `snap_payroll_legal_entity_id` / `snap_billing_mode` / `snap_employment_type` / `snap_pay_basis` / `snap_pay_profile_ver` / `snap_calc_rule_version`（锁"算法"）/ **`snap_on_duty_break_basis`（在岗休息口径——`chk_ads_sum` 选哪一支的唯一依据；迁移后必须 `DROP DEFAULT`）** / `snap_ownership_type` / `snap_legal_employment_form` / `snap_utc_offset_minutes`。**放列，不实时 JOIN 主数据；禁止 `GENERATED ALWAYS`**（生成列永远算"现在"，快照要的是"当时"，§3.3.5b） |
| **人员分类三正交 + 计薪方式** | `ownership_type` / `legal_employment_form` / `employment_type` / `pay_mode` 四个字段，**禁止合并成一个枚举，禁止由前两维推导第三维**（§3.2.3） |
| **加班费承担方三值** | `employment.ot_pay_bearer` = `SELF`/`AGENCY`/`NONE`；`ot_hours` 对**全部现场作业人员照记**（含派遣/外包，那是劳务对账的计费依据），**禁止把非 FT 的工时置 0**（§3.2.3b） |
| **成本分摊是恒等式** | `ΣCi ≡ S`：外部计价主体 `Ci = Pi`，其余取残差 `S − ΣPi`；**禁止写成 `管理账合计 = 实发合计 + 差异`**（§3.5.2b） |
| 借调计价差 `Di` | `payroll_transfer.diff_amount`，`ΣDi ≡ 0`，**不进任何合计**；同 `transfer_id` 行金额之和 ≠ 0 即阻断提交；`from_cost_org ≠ to_cost_org` 且禁止只写一行 |
| 供应商单边权威 | `attendance_daily.record_owner` 取 `OWN` 或 `SUPPLIER`，**实体列、应用层写入、不做 GENERATED、绝不按天人工覆盖**；派生逻辑（`DISPATCH`/`OUTSOURCE`→`SUPPLIER`）只在考勤服务一处；供应商侧只读 + 可申诉，**补卡入口不渲染**（§3.3.9） |
| 承揽不进工时模型 | `legal_employment_form='SERVICE'` 不建 daily/daily_store、不产生工时、不进人效与成本（在场登记见 `contractor_presence`） |
| 双口径天数（出勤 / 计薪） | `attendance_daily.attendance_days` / `payroll_days` |
| **人日状态 5 值 + 计划外标记** | `attendance_daily.attendance_status`（`normal`/`absent`/`on_leave`/`holiday`/`rest`，字典表带属性）；**计划外出勤是标记 `is_off_plan` 不是枚举值**（要计入出勤与工时，做枚举就得在每处统计补条件，漏一处静默少算） |
| **段类型 6 值，无 `unclassified`** | `hour_type`（`normal`/`break_on_duty`/`break_off_duty`/`ot_weekday`/`ot_restday`/`ot_statutory`）+ 属性列；分类失败**不产生段行**，L1 校验卡住并报错，不静默归档 |
| **`hour_type` 禁止字面量列表** | 全库禁止 `hour_type IN ('...')`；汇总一律 JOIN `hour_type` 按 `counts_as_work` / `on_duty` / `is_ot` 判定（新增类型自动进统计） |
| **排班来源 3 值** | `snap_assignment_source` = `manual`/`ai`/`import`；**「AI 只出草稿、发布权在店长」的唯一数据依据**，与 `snap_assignment_type`（谁的班）是两个问题，不得合并（§3.3.5） |
| **班段依据 4 值** | `snap_assignment_type` = `planned`/`substitute`/`support`/**`fallback`**（无排班依据按打卡兜底）；`assignment_id` 可空，`CHECK ((type='fallback') = (assignment_id IS NULL))`。不给 `fallback`，"没有排班"会默认被填成 `planned` |
| **五个时长列 + 八条恒等式** | `span_hours`/`work_hours`/`break_on_duty_hours`/`break_off_duty_hours`/`in_attendance_hours` 全部**实体列**（PG 生成列不能跨表聚合）；恒等式编号**以 `02g` I8.2 / I8.13 为准**：L0 / L1 / L2 / C2a / C2b / L3 / L4 / L5（`L2b` 已退役），实现位置见 §3.3.8；**旧 `C1`/`C3`/`C4a`/`C4b`/`C5`/`C6` 已标 deprecated，编号永久占用不复用**。**凡 daily 与 store 两级都有的计算列，必须配一条 L4 分支** |
| **三态替代布尔** | `*_veto_status`（`triggered`/`not_triggered`/`not_collected`）+ `*_amount_status`（`not_applicable`/`zero`/`unknown`）；**禁用 `DEFAULT false`**——它让"没查"等于"没触发" |
| **数据成熟度与业务状态分离** | `confirm_status`（`raw`/`confirmed`/`locked`，只能单向前进）与 `attendance_status` 是两件事；**下游消费一律 `WHERE confirm_status='locked'`**（`confirmed` 只表示能看，`locked` 才表示能算钱） |
| **四个期不得合并** | `payroll_record`：`attribution_period`（归属期）/ `pay_period` + `pay_date`（发放期）/ `tax_declaration_period`（申报期 = 实际发放月）/ `si_payment_period`（缴费期）。一列兼表两期，次年汇算清缴必对不上 |
| **成本恒等式按月成立** | `payroll_cost_allocation.cost_business_date` 让 `ΣCi ≡ S` 在**每个 `period_month` 内**成立；**不建 `payroll_period_bridge`**，跨月只加标签不搬行（§3.5.2） |
| **合规判定走画像，不堆 IF** | `compliance_profile`（按什么算）+ `employee_compliance_profile`（该用哪个，`source ∈ matched/default_fallback/manual`）；关联缺失**兜底取最严档并进巡检**，不得静默合规；`compliance_gap` 必须跨门店查（§3.3.11） |
| 加班三类分列 + 法定上班天数 | `attendance_daily.ot_weekday_hours` / `ot_restday_hours` / `ot_statutory_hours` / `statutory_worked_days` |
| 双级工时校验 | 一级：`MIN(法定上限(legal_employment_form), 考勤组上限)`；二级：`attendance_daily.work_hours`（人日已跨店合并） |
| 发薪批次 ≠ 薪资期间 | `pay_batch.payroll_period_id`（多批挂一个期间） |
| 计薪基准月工时 174（仅加班换算） | `pay_scheme.payroll_monthly_standard_hours`；禁写 216；禁与 `proration_basis` 复用 |
| 转正双日期 | `probation_end_date`（应然）+ `regularization_date`（实然） |
| 制度两层（集团模板 + 主体参数） | `policy_set_id` 引用参数集；法人层只存差异 |
| 指标口径唯一 | `metric_definition`；禁止模块内联公式 |
| 健康证过期硬阻断排班 | `certificate` + `ScheduleValidator` |
| **外部锚不可省** | `attendance_daily_store.chk_ads_span`（`span_hours` ≡ `round(EPOCH(shift_end − shift_start)/3600, 2)`）+ `chk_ads_nonneg`。**五列是两条方程、五个未知数的封闭体系，没有外部锚就能写进任意自洽的一组数，而 `C2a/C2b/L3/L4` 一条都不会红**。清单里"锚定来源"为空的那一条，必须自带校验（§3.3.8） |
| **时间区间两套开闭** | **归属类 `'[]'`**（`employment_segment` / `employee_org_assignment`，右端是一个日子）；**生效类 `'[)'`**（`sys_config` / `sys_user_role` / `pay_profile` 版本，右端是一个切换点）。`daterange(d, d, '[)')` 是 **EMPTY**，`&&` 恒 `false` → 约束整条失效；生效类必须配 `CHECK (effective_to > effective_from)`。**无上界只有 `upper` 传 `NULL` 一种写法**，`COALESCE(x,'infinity')` 会让 `upper_inf()` 静默漏掉全部现行版本（§3.0b） |
| **记录型 / 判定型时间戳分开** | 记录型（审计 `created_at`、单据 `submitted_at`）用 `now()`——同一事务内必须一致；**判定型（是否超期、距上次多久）用 `clock_timestamp()`**，`now()` 是 `transaction_timestamp()` 的别名，在长事务里它不前进。日期区间判定统一用 `current_date`（§4.5.5） |
| **"单向"要触发器，"过检查点"要撤权限** | `confirm_status` 的 `raw→confirmed→locked` 由 `trg_daily_confirm_forward` 强制；但"只能前进"不蕴含"必须过检查点"，后者靠**撤掉 `app_role` 对 `confirm_status` 的 `UPDATE` 权** + `SECURITY DEFINER` 的 `fn_daily_confirm()` 单点（§3.3.4） |
| **断言注册唯一出处** | `sys_check_registry`（§4.5.1）。`ALG-NN ⟺ f_alg_NN`；`guards` **四档**，第四档判据是**行为（贴边夹具真的被拒）不是文本**；`enabled` 但从未 `exercised` 必须单独报数；`definition_hash` 只作复核提示、不进 `fail`（§4.5.3 / §4.5.4） |
| **数值四态** | `known` / `unknown` / `unknown_conflict` / `not_applicable`；**`unknown_conflict` 不得并入 `unknown`**（合并后实现会 pick 一个，冲突消失）；`not_applicable` 可渲染 0，另两者不可（§4.5.7） |
| 参数化默认值 | 按 `02_口径裁决定稿.md` §15 参数化清单 |

## 12.4 安全与审计约定

| 约定 | 内容 |
|---|---|
| 敏感字段 | DB 列名后缀 `_enc`/`_hash`；DTO 字段加 `@Sensitive`；日志自动脱敏 |
| 权限声明 | 每个 Controller 方法必须有 `@PreAuthorize`；无声明的拒绝（白名单仅 health/login） |
| 数据范围 | 所有查询必须**逐维度**覆盖 `sys_perm_resource.row_gate_dims` 声明的每个维度：allow 写 `EXISTS (… /* dim:XXX */)`、deny 写 `NOT EXISTS (… /* deny:XXX */)`，四个临时表一律 `pg_temp.` 限定（§6.0.3.7）；`ScopedSqlGuard` **按维度计数**机检，不是「出现过临时表名」就算过 |
| 写操作 | 必须经 `ApprovalService`（办理类）或 `PlanStore`（MCP 管理类）；禁止直接改已封账数据 |
| 审计 | 关键表变更由 `AuditAspect` 自动写 `sys_audit_log`；含 before/after 全量 JSON |
| **操作人两栏，永不合并** | `operator_claimed`（应用自证，可展示不可追责）/ `operator_verified`（由认证上下文派生，`token sub` + 签名校验）。**涉及金额、劳动关系、封账、权限变更的追责只认 `verified`**；`claimed` 为空判 `fail`（不是"空着"）。DB 层审计只能给出"哪个连接、哪个事务、改了哪行"，给不出自然人——这一点必须在 PRD 里如实写（§4.5.10） |
| **列级 `REVOKE` 必须先撤表级** | 表级 `GRANT UPDATE` 存在时，列级 `REVOKE` **完全无效**（PG 权限是并集）。顺序固定：`REVOKE UPDATE ON t` → `GRANT UPDATE (白名单列)`；`ALTER DEFAULT PRIVILEGES` 里写**同一对**（撤表级 + 授列级），只写撤不写授会让新表全线不可写，然后有人加一条 `GRANT ALL ON ALL TABLES` 把整套基线抹掉（§8.2b 五） |
| 导出 | 必带水印 + 二次密码 + 用途说明 + 次数限制 |
| **RLS 的判据必须覆盖"以后新建的表"** | 三条单点状态断言（`relrowsecurity` / `relforcerowsecurity` / `policy` 存在）对**新建表**一条都不管，而漏就漏在新建表上。五条机制：① 集合元断言 `sys_data_classification`（表级，**新表缺省 `personal`**，"不需要保护"要人签字）② 新增即适用靠 `etg_force_rls` 事件触发器 ③ 绕过 RLS 是**两个角色属性** `rolsuper`/`rolbypassrls`（含 `pg_auth_members` 继承路径）④ 第四个出口在 `relowner`/`nspowner` 上，`role_app` **不得拥有任何对象** ⑤ 非存在性断言一律改扫目录（§8.2d） |
| **事件触发器没有 ACL** | `GRANT`/`REVOKE` 的对象类型清单里**没有 `EVENT TRIGGER`**，`REVOKE ALL ON EVENT TRIGGER …` 是语法错（会在升级窗口第一分钟失败——比"执行成功但没效果"好）。它只能 `ALTER EVENT TRIGGER … OWNER TO` + `REVOKE ALL ON FUNCTION <其函数>`；**它的职责是"补默认保护 + 归因"，不是访问控制**（能建它的人也能关它）。巡检必须扫 `pg_event_trigger.evtenabled NOT IN ('O','A')`——**`pg_trigger.tgenabled` 扫不到它**（§8.2c） |
| **豁免判据不得写角色名字符串** | `current_user IN ('role_migration','postgres')` 在两个方向都错：客户自建的 superuser 叫别的名字会**误伤**（阻断客户的结构变更），而 `SET ROLE postgres` 之后的应用连接会**误放**。改判属性：`rolsuper` + `pg_has_role(current_user,'role_migration','MEMBER')`（§8.2c 三） |

## 12.5 MCP 约定

| 约定 | 内容 |
|---|---|
| 工具命名 | `<domain>_<verb>_<object>`，封闭词表 |
| 写工具 | 必须支持 `dryRun` + `planId` 两阶段；必须带 `idempotency_key`（缺失直接 `E_VALIDATION`，A5）；必须返回 `affectedCount` |
| 确认 | 超阈值强制 elicitation 或转 Web；治理类只能 Web |
| 审批 | **不存在 `approve_*` 工具**；只有 `submit_*` + `gov_get_approval_status`（A6，产品红线） |
| 批处理 | 批量排班/算薪/导入/导出**必须异步**：返回 `jobId` + 轮询，不同步等待（A2） |
| 限流 | MCP 客户端独立 **60 次/分钟**（A8），与人类用户分开计数 |
| 字段 | MCP 层掩码比 Web 更严；明文只能通过 `gov_request_plaintext` 的受控链接 |
| 审计 | 每次调用写 `mcp_call_log`，含 `traceId`、`affected_row_ids`、`args_digest` |
| 红线 | §5.9 的 10 条，工具层面不存在或强制拦截；发版前集成测试必跑 |

## 12.6 部署与运维约定

| 约定 | 内容 |
|---|---|
| 配置 | 全部环境变量或挂载文件，禁止硬编码；`config/application-prod.yml` 为客户定制项 |
| 密钥 | 只在 `keystore/`，不进镜像、不进 Git、不进 DB |
| 迁移 | Flyway 命名 `V{major}_{minor}_{patch}__{desc}.sql`；必须向前兼容（只加不删） |
| 日志 | JSON 结构化，含 `traceId`；按天滚动保留 30 天 |
| 备份 | 升级前强制备份；备份失败中止升级 |
| 健康 | 所有新增外部依赖必须接入 `/actuator/health` 与自检页 |

---

## 附：文档产出清单

| 文件 | 内容 |
|---|---|
| `docs/04_技术架构与MCP设计.md` | 本文档（§0–§12） |
| `docs/sequence-diagram.mermaid` | MCP 两阶段写 + elicitation 完整时序 |
| `docs/class-diagram.mermaid` | 核心领域模型与服务类关系 |

**待负责人拍板（影响后续实现，不影响本文档架构结论）**
1. 打卡"先入队后落库"的 RPO（≤ 2 秒）是否可接受；
2. 是否需要出网（决定 IM / 电子签 / 银行 / 税务的对接方式）；
3. 信创是否为必选（决定是否从第一天就做方言适配的全量验证）；
4. **MCP 是否需要开内网监听**（ADR A1 默认只听 127.0.0.1；开放内网属安全决策，需客户 IT 书面确认）；
5. **历史工资条是否接受只读归档查询**（ADR A12；若要"无缝翻历史"需另立需求与预算）。
