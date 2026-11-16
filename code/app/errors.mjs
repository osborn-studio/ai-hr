// ============================================================================
// app/errors.mjs · 从「数据库说了什么」到「接口该回什么」
// ----------------------------------------------------------------------------
// 没有这一层的时候，所有失败都被 catch 成 500 + e.message。
// 后果有三个，都很具体：
//
//   ① **业务拒绝看起来像服务故障。** 额度不够本该是 409，却回了 500，
//      前端于是弹"系统错误，请联系管理员"——而它其实只要改个天数。
//   ② **500 里带 SQL 原文。** `e.message` 经常包含表名、约束名、甚至值片段，
//      直接吐给前端等于把 schema 送出去。
//   ③ **同一个失败在不同路由上回不同码。** 因为每个 catch 各写各的。
//
// 所以映射只在一处：先看 SQLSTATE，再看业务码前缀 `E_XXX:`。
// 认不出来的一律 500，且**不回显 message**，只给一个可检索的 ref。
// ============================================================================

// SQLSTATE → HTTP。只列会影响业务语义的那些，其余落到 500。
const SQLSTATE = {
  '23505': [409, 'CONFLICT'],           // 唯一约束
  '23514': [422, 'CHECK_VIOLATION'],    // CHECK / 域约束
  '23503': [422, 'FK_VIOLATION'],       // 外键
  '23P01': [409, 'EXCLUSION_VIOLATION'],// 排斥约束（区间重叠）
  '42501': [403, 'FORBIDDEN'],          // 权限不足
  '40001': [409, 'RETRYABLE'],          // 序列化冲突，可重试
  '40P01': [409, 'RETRYABLE'],          // 死锁，可重试
  '3F000': [500, 'SCHEMA_MISSING'],     // 临时表没建 —— 会话没初始化
};

// 业务码 → HTTP。业务码由函数里的 RAISE 产生，形如 'E_LEAVE_OVER_QUOTA: ...'
const BIZ = {
  E_TY_FORBIDDEN: 403, E_TY_NOT_FOUND: 404, E_TY_ARGUMENT: 422, E_TY_CONFLICT: 409,
  E_LEAVE_OVER_QUOTA:     409,
  E_LEAVE_ALREADY_DECIDED: 409,
  E_LEAVE_NO_REQUEST:     404,
  E_LEAVE_SELF_APPROVE:   409,
  // 制度要求多步：单签入口被拒，并指向 /api/approval/*
  E_LEAVE_USE_APPROVAL:   409,
  E_ATT_CLOSED:           409,
  E_ATT_NOT_CLOSED:       409,
  E_PERF_NOT_SEALED:      409,
  E_PERF_SEALED:          409,
  E_HC_FULL:              409,
  E_HC_OVER_ALLOCATED:    422,
  E_HC_NOT_CASCADED:      422,
  E_OFFER_OVER_RQ:        409,
  E_OFFER_OVER_HC:        409,
  E_MCP_NO_PLAN:          409,
  E_MCP_UNKNOWN_TOOL:     404,
  E_MCP_OVER_THRESHOLD:   403,
  E_RPT_BASIS_REQUIRED:   400,
  // 导出（055）：空文件、没有摘要、期间写错、留痕被改 —— 四个都必须有名字。
  // 未登记的业务码会落进 500，而 500 的意思是"服务坏了"，不是"这个请求不对"。
  E_EXPORT_EMPTY:         422,
  E_EXPORT_NO_DIGEST:     422,
  E_PERIOD_INVALID:       400,
  // 离职时的额度结算（057）：配置值不认识、还有待批的假
  E_LEAVE_TERM_MODE:      422,
  E_LOGIN_THROTTLED:      429,
  // 岗位权限（064）：这个角色不碰这类资源。与 E_OUT_OF_SCOPE 是两层：
  // 前者"这类事不该你做"，后者"这些行不该你看"。
  E_RESOURCE_FORBIDDEN:   403,
  E_ROLE_ACTION:          422,
  // 建帐（065）：帐套 / 组织 / 账号。冲突类 409，参数类 422。
  E_LEDGER_EXISTS:        409,
  E_LEDGER_NO_DRAFT:      409,
  E_LEDGER_PERIOD:        422,
  E_LEDGER_NAME:          422,
  E_LEDGER_NO_ORG:        422,
  E_ORG_KIND:             422,
  E_ORG_NAME:             422,
  E_ORG_ROOT:             422,
  E_ORG_ROOT_EXISTS:      409,
  E_ORG_NO_PARENT:        404,
  E_ORG_DEPTH:            422,
  // 组织维护（086）：改名撞名 → 409；防环/层级/停用前置条件 → 422；找不到 → 404
  E_ORG_NOT_FOUND:        404,
  E_ORG_DUP_NAME:         409,
  E_ORG_CYCLE:            422,
  E_ORG_HAS_PEOPLE:       409,
  E_ORG_HAS_CHILDREN:     409,
  E_ORG_PARENT_INACTIVE:  409,
  E_ACCOUNT_ROLE:         422,
  // 多帐套（069/070）：编码不认识、实例里没帐套、单库模式不能在线开库
  E_LEDGER_UNKNOWN:       404,
  E_LEDGER_NONE:          409,
  E_LEDGER_SINGLE:        409,
  E_LEDGER_PROVISION:     500,
  E_LEDGER_DBNAME:        422,
  // 外部对接（072）：外部系统未登记、打卡缺幂等键、来源不认识
  E_EXT_SYSTEM:           422,
  E_EXT_NO_KEY:           422,
  E_EXT_CALL:             502,
  E_EXT_RANGE:            422,
  E_EXT_DEPTH:            422,
  E_PUNCH_SOURCE:         422,
  // 副职代理（073）
  E_ACTING_ROLE:          422,
  E_ACTING_SELF:          422,
  E_ACTING_NOT_PRINCIPAL: 403,
  E_ACTING_ROLE_NOT_HELD: 403,
  E_ACTING_SUPER:         403,
  E_ACTING_NOT_FOUND:     404,
  E_ACTING_NOT_PARTY:     403,
  E_ACTING_OVERLAP:       409,
  // 制度与时区（079）：时区名写错、非系统级制度项
  E_TZ_UNKNOWN:           422,
  E_POLICY_NOT_SYSTEM:    403,
  // 岗位（083）：名称不合法
  E_POS_NAME:             422,
  // 打卡（065）
  E_PUNCH_KIND:           422,
  E_PUNCH_NO_EMPLOYEE:    404,
  E_PUNCH_APPEND_ONLY:    409,
  // 排班看板（067）
  E_ROSTER_SHIFT:         422,
  E_ROSTER_SCOPE:         403,
  // 排班写入（145）：状态冲突 409、参数与缺原因 422。
  // ★ 这一组不登记就会落 400 兜底，调用方拿不到"是重排还是先退回"的区别。
  E_ROSTER_OVERLAP:       409,   // 同人相邻日时段重叠（两段并存 = 两倍工时）
  E_ROSTER_LOCKED:        409,   // 已锁定，改班要先退回
  E_ROSTER_CONFIRMED:     409,   // 门店已确认，同上
  E_ROSTER_BAD_STATE:     409,   // 状态机不允许（没推就确认 / 有争议就锁 / 没可转的单）
  E_ROSTER_EMPTY:         409,   // 没有可推的确认单 —— 空表不许推给门店
  E_ROSTER_CROSS_REASON:  422,   // 跨店支援没写原因
  E_ROSTER_NO_NOTE:       422,   // 争议没写意见
  // 考勤文件导入（066）
  E_IMPORT_EMPTY:         422,
  E_DISPUTED_IMPORT:      409,
  E_HEAD_IMPORT:          422,
  E_DEDUCT_IMPORT:        422,
  // 工号规则（061）：前缀为空、位数越界 —— 都是配置错，不是数据错
  E_EMP_NO_RULE:          422,
  E_LEAVE_PENDING_ON_EXIT: 409,
  E_RE_NO_UPDATE:         409,
  E_RE_NO_DELETE:         409,
  E_PAYSLIP_FROZEN:       409,
  E_PAYRUN_REOPEN:        409,
  // 工资单批量打包（171）：三个错必须各有名字，因为**下一步该做什么不同** ——
  //   期间写错 → 改参数；这一期没算过薪 → 去算薪；算过但我的范围里没门店 → 去配权限/门店。
  //   合成一个码，"去算薪"的人会去改权限，而两边都不会报错。
  E_PACK_PERIOD:          422,
  E_PACK_NO_RUN:          409,
  E_PACK_EMPTY:           409,
  // 发放回单（140）
  E_RUN_NOT_SEALED:       409,
  E_RUN_ALREADY_PAID:     409,
  E_PAY_METHOD:           422,
  E_PAY_TOTAL_MISMATCH:   422,
  E_PAY_EMPTY:            409,
  E_PROVISIONAL_TOO_LONG: 422,
  E_ATT_ALREADY_CLOSED:   409,
  E_ATT_CLOSE_EMPTY:      422,
  E_ATT_CLOSE_ROW_DELETED:409,
  E_ATT_REOPEN:           409,
  E_RUN_SEALED:           409,
  E_RUN_NOT_FOUND:        404,
  E_PAYROLL_NO_ELIGIBLE:  422,
  E_SI_POLICY_MISSING:    422,
  // 工资表（087/088）：结构拆分与月薪总额不一致 422；拆了不该拆的项 422；没有月薪标准 409
  E_SS_EMPTY:             422,
  E_SS_ITEM:              422,
  E_SS_SUM:               422,
  E_SS_NO_STANDARD:       409,
  // 岗位（083/086）：停用一个还有人在岗的岗位 → 409
  E_POS_NOT_FOUND:        404,
  E_POS_HAS_HOLDERS:      409,
  // 工资项与公式（089–093）：参数类 422；没这个项目/批次 404
  E_ITEM_CODE:            422,
  E_ITEM_NAME:            422,
  E_FORMULA:              422,
  // 公式语言（092/096）：字符/括号/变量/函数/参数/求值 —— 全是参数类
  E_FORMULA_EMPTY:        422,
  E_FORMULA_CHAR:         422,
  E_FORMULA_PAREN:        422,
  E_FORMULA_VAR:          422,
  E_FORMULA_FUNC:         422,
  E_FORMULA_ARGS:         422,
  E_FORMULA_EVAL:         422,
  // 脚本与规则（097/099）：脚本语法/无结果/变量重名 422；规则拦截 409
  E_SCRIPT_SYNTAX:        422,
  E_SCRIPT_NO_RESULT:     422,
  E_SCRIPT_NAME:          422,
  E_RULE_BLOCK:           409,
  // 调整单（106/107）：不是草稿不能应用/作废 → 409
  E_ADJ_NOT_DRAFT:        409,
  // 年终奖（108）：批次类型不对 → 422
  E_RUN_KIND:             422,
  // 提成规则（109）：同层多条启用规则 → 409（配置冲突，要人来定）
  E_COMM_RULE_AMBIGUOUS:  409,
  E_NOT_FOUND:            404,
  // 导入（089/093）：表头/编码/行内错误都是 422，重复应用 409
  E_IMPORT_EMPTY:         422,
  E_IMPORT_ENCODING:      422,
  E_IMPORT_HEADER:        422,
  E_IMPORT_HAS_ERROR:     409,
  E_ALREADY_APPLIED:      409,
  // 考勤月报与审批（114–120）
  E_ATT_REPORT_NOT_FOUND: 404,
  E_ATT_NO_REPORT:        404,
  E_ATT_NO_ROW:           404,
  E_ATT_REPORT_CONFIRMED: 409,   // 已确认不许改/覆盖：要改先重开
  E_ATT_ALREADY_CONFIRMED:409,
  E_ATT_ALREADY_PENDING:  409,
  E_ATT_NOT_PENDING:      409,
  E_ATT_HAS_PAYSLIP:      409,   // 已出工资条不许重开（发了的钱与库里的数会对不上）
  E_ATT_NO_APPROVER:      409,   // 找不到审批人：配置缺失，要人来定，不是自动通过
  E_ATT_NOT_APPROVER:     403,
  E_ATT_SELF_APPROVE:     403,   // 改数的人不能同时是"同意这个数"的人
  E_ATT_FIELD:            422,   // 字段不在可调白名单
  E_ATT_TOO_LONG:         422,
  E_IMPORT_KIND:          422,
  E_IMPORT_PERIOD:        422,
  E_OT_RATE_LOW:          422,
  // 假种（127）：官方预置不可删/不可改 code → 409（配置冲突，要人来处理）
  E_LEAVE_TYPE_SYSTEM:    409,
  E_LEAVE_TYPE_DUP:       409,
  // 补休抵扣（128）：法定/平日不能补休、补超过加班工时 → 422（参数类，能改对）
  E_OT_COMP_ILLEGAL:      422,
  E_OT_COMP_OVER:         422,
  // 未休年假折现（129）
  //   off 是制度没开、折算后不足 1 天、基数算不出 → 422（改配置或换日期就能过）
  //   同年已折过 → 409（要先作废原单，属于状态冲突不是参数错）
  //   已进工资条 → 409（钱发了，只能红冲，不许改历史）
  E_ALC_OFF:              422,
  E_ALC_NO_UNUSED:        422,
  E_ALC_NO_WAGE:          422,
  E_ALC_MODE:             422,
  E_ALC_NO_REASON:        422,
  E_ALC_VOID_REASON:      422,
  E_ALC_EXISTS:           409,
  E_ALC_PAID:             409,
  E_ALC_NOT_FOUND:        404,
  E_AL_TIER_LOW:          422,
  // 节假日年度维护（130）：年份不合理 → 422
  E_HOL_YEAR:             422,
  // 社保申报基数（133）
  E_SI_YEAR:              422,
  E_SI_NO_POLICY:         409,   // 该城市该时点没有社保政策 → 要先录政策
  E_SI_NO_REASON:         422,
  E_SI_BASE_INVALID:      422,
  E_SI_BASE_RANGE:        422,   // 手工报的基数越界（不是静默夹掉）
  // 离职结算（134）
  E_SEV_NO_EMP:           404,
  E_SEV_BEFORE_HIRE:      422,
  E_SEV_REASON:           422,
  E_SEV_NO_AVG_WAGE:      409,   // 没社平工资就算不出三倍封顶与免税额度
  E_SEV_NO_NOTE:          422,
  E_SEV_NOT_FOUND:        404,
  E_SEV_VOID:             409,
  E_SEV_CONFIRMED:        409,
  // 算薪预演（137）
  E_PAY_PREVIEW_SEALED:   409,
  // 申报表（141）
  //   期间/法人写错 → 422（改对就能过）；这一期没算过薪 → 409（要去算薪）
  //   没封账 → 409（要去封账，不是参数错 —— 报错语里必须说清是"等你去封账"）
  //   留痕不可改删 → 409（与 055 的 E_RE_NO_* 同一类）
  E_DECLARE_PERIOD:       422,
  E_DECLARE_ENTITY:       422,
  E_DECLARE_NO_RUN:       409,
  E_DECLARE_NOT_SEALED:   409,
  E_DECLARE_EMPTY:        409,
  E_TDE_NO_UPDATE:        409,
  E_TDE_NO_DELETE:        409,
  // 险种键归一（142）：别名撞上规范键 → 409（两条费率可能不同，要人来定）；
  // 空键 → 422（录的时候漏了，改对就行）
  E_SI_ITEM_DUP:          409,
  E_SI_ITEM_EMPTY:        422,
  // 累计预扣链条（143）
  //   前期未封账 → 409（不是参数错，是"还差一个动作"：去把前期封了）
  //   重算会让下游失真 → 409（钱已经按那个数发了，只能走调整单）
  E_SEAL_UPSTREAM_DRAFT:      409,
  E_SEAL_CHAIN_STALE:         409,   // 默认拒、确认放行（accept=1）
  E_PAYROLL_DOWNSTREAM_SEALED: 409,
  // 培训（144）
  //   不存在 → 404（单号打错了）；取消/重复/满员/已结业 → 409（状态冲突，要人处理）
  //   学时类 → 422（写错了数，改对就能过）
  E_TR_NO_SESSION:            404,
  E_TR_NOT_FOUND:             404,
  E_TR_SESSION_CLOSED:        409,
  E_TR_DUP:                   409,
  E_TR_CAPACITY:              409,
  E_TR_HOURS:                 422,
  E_TR_COMPLETED:             409,
  // 排班写入（145）：排一个不在职的人 → 404（那个人在库里不存在/不在职）
  E_ROSTER_NO_EMPLOYEE:       404,
  E_ROSTER_OVERRULE:          409,   // 超出排班规则上限（硬拦）
  // 假期规则（152）：参数类 422；假种不存在 404；假种停用 409
  E_LEAVE_YEAR:               422,
  E_LEAVE_DATE_RANGE:         422,
  E_LEAVE_HOURS_INVALID:      422,
  E_LEAVE_GRANT_NO_TOTAL:     422,
  E_LEAVE_MAX_HOURS:          422,   // 超过"每次最大请假时长"
  E_LEAVE_PROOF_REQUIRED:     422,   // 超过门槛必须交证明
  E_LEAVE_TYPE_NOT_FOUND:     404,
  E_LEAVE_TYPE_INACTIVE:      409,
  // 划线（148）参数类 422
  E_ROSTER_LINE_ARGS:         422,
  E_ROSTER_TOO_SHORT:         422,
  E_ROSTER_TOO_LONG:          422,
  E_ROSTER_BREAK:             422,
  // 批量导入（151）逐行错误：参数类 422；撞车/锁定 409
  E_ROW_PERSON:               422,
  E_ROW_DATE:                 422,
  E_ROW_SHIFT:                422,
  E_ROW_STORE:                422,
  E_ROW_OVERLAP:              409,
  E_ROW_LOCKED:               409,
  E_ROW_RULE:                 409,
  // 借调（153）：不存在 404；状态冲突 409；参数类 422
  E_DISPATCH_NOT_FOUND:       404,
  E_DISPATCH_NO_EMPLOYEE:     404,
  E_DISPATCH_ORG_NOT_FOUND:   404,
  E_DISPATCH_BAD_STATE:       409,
  E_DISPATCH_OVERLAP:         409,
  E_DISPATCH_ORG_BUSY:        409,
  E_DISPATCH_ORG_INACTIVE:    409,
  E_DISPATCH_NO_ORG:          409,
  E_DISPATCH_ORG_KIND:        422,
  E_DISPATCH_SAME_ORG:        422,
  E_DISPATCH_DATE_RANGE:      422,
  E_DISPATCH_NO_REASON:       422,
  E_DISPATCH_NO_NOTE:         422,
  E_PERIOD_INVALID:           422,
  // 换班审批（154）：不存在 404；状态冲突 409；参数类 422
  E_SWAP_NO_EMPLOYEE:         404,
  E_SWAP_NO_PERSON:           404,
  E_SWAP_APPLIED:             409,
  E_SWAP_NOT_AGREED:          409,
  E_SWAP_STATE:               409,
  E_SWAP_OVERLAP:             409,
  E_SWAP_NOT_YOURS:           403,
  E_SWAP_KIND:                422,
  E_SWAP_NO_SEG:              422,
  E_SWAP_NO_SHIFT:            422,
  E_SWAP_NO_SWAP:             422,
  E_SWAP_NO_REASON:           422,
  // 考试（147）：不存在 404；状态冲突 409；形状/内容错 422
  E_EXAM_NO_PAPER:            404,
  E_EXAM_NO_ATTEMPT:          404,
  E_EXAM_PAPER_INACTIVE:      409,
  E_EXAM_SUBMITTED:           409,
  E_EXAM_NOT_SUBMITTED:       409,
  E_EXAM_NO_QUESTION:         422,
  E_EXAM_BAD_ANSWER:          422,
  E_TR_EXAM_REQUIRED:         409,   // 学时够了但没考过 → 不结业
  E_EXAM_NO_ATTEMPT_LEFT:     409,   // 次数用完（只数已交卷的）
  // 考试任务与防作弊（157）：时间窗两道闸 + 证据只增不改
  E_EXAM_TASK_WINDOW:         422,   // 关闭时间早于开始时间（写反了）
  E_EXAM_TASK_CLOSED:         409,   // 现在不在任何考试任务的时间窗内
  E_EXAM_CHEAT_APPEND_ONLY:   409,   // 切屏事件是证据，不许改也不许删
  // 评分人与改分台账（158）
  E_PERF_NO_SCORER:           422,   // 有分数没评分人 / 改分没留在台账上
  E_PERF_LOG_APPEND_ONLY:     409,   // 改分台账只增不改
  // 绩效指标库与加权汇总（159）
  E_PERF_ITEM_ARG:            400,   // 考核项参数不合法（缺 weight、权重越界…）
  E_PERF_ITEM_EMPTY:          422,   // 方案一个考核项都没有（权重和 0 永远不等于 1）
  E_PERF_ITEMS_IN_USE:        409,   // 方案已被打分引用，改口径要新开一版
  E_PERF_ITEM_FORMULA:        422,   // 公式算不出来
  E_PERF_ITEM_NOT_IN_SCHEME:  422,   // 考核项不在该周期生效的方案里
  E_PERF_METRIC_INACTIVE:     422,   // 指标已停用
  E_PERF_DUP_METRIC:          422,   // 同一指标在方案里出现两次（权重会被算两遍）
  E_PERF_WEIGHT_SUM:          422,   // 权重合计 ≠ 1
  E_PERF_NO_RESULT:           404,
  E_PERF_RESULT_EXCLUDED:     422,   // "不参与考核"的结果不该有分
  E_PERF_NO_ACTUAL:           422,   // 公式项也要给实际值
  E_PERF_SCORE_RANGE:         422,   // 得分越界且没写说明
  E_PERF_NO_ITEMS:            422,   // 没有考核项，汇总不了
  // ★ 下面两个库里是 RAISE WARNING（只告警不阻断），正常情况下不会变成响应。
  //   登记它们的理由：AE1 扫的是"库里出现过的码"，告警也算；而且告警迟早会被
  //   某个调用方升级成异常，那时状态码已经在这里了，不会再落一次 500 兜底。
  E_PERF_TOTAL_CAP:           422,   // 加权总分超过 100 按 100 封顶
  E_PERF_ITEM_MISSING:        409,   // 还有考核项没打分，按 0 计
  // 工资表会签（139）
  E_SIGNOFF_NOT_STARTED:  409,
  E_SIGNOFF_PENDING:      409,
  E_SIGNOFF_NOT_YOURS:    403,
  E_SIGNOFF_CLOSED:       409,
  E_SIGNOFF_NOT_FOUND:    404,
  E_SIGNOFF_NO_NOTE:      422,
  E_SIGNOFF_NO_ASSIGNEE:  422,
  E_SIGNOFF_NO_USER:      422,
  E_SIGNOFF_EMPTY:        409,
  E_SEAL_EMPTY:           409,
  E_PAYRUN_REOPEN:        409,
  E_OT_NO_ROW:            404,   // 加班倍数低于法定下限（少付是违法）
  E_BODY_TOO_LARGE:       413,
  E_RQ_OVER_HEADCOUNT:    409,
  E_RQ_NOT_LEAF:          422,
  E_RQ_CLOSED:            409,
  E_RQ_NOT_FOUND:         404,
  E_OFFER_EXPIRED:        409,
  E_OFFER_NOT_LIVE:       409,
  E_OFFER_ONBOARDED:      409,
  E_OFFER_NOT_FOUND:      404,
  E_PERF_ALREADY_SEALED:  409,
  E_PERF_NO_SCHEME:       422,
  E_PERF_SCORE_OUT_OF_RANGE: 422,
  E_SETTLE_HAS_DIFF:      409,
  E_SETTLE_ALREADY:       409,
  E_SETTLE_NOT_FOUND:     404,
  E_SETTLE_REOPEN:        409,
  E_HC_OVER_NO_APPROVAL:  422,
  E_HC_NEGATIVE:          422,
  E_HC_APPEND_ONLY:       409,
  E_POLICY_NO_VALUE:      422,
  E_POLICY_UNDEFINED:     422,
  E_MCP_PLAN_EXPIRED:     409,
  E_MCP_PLAN_USED:        409,
  E_MCP_ARGS_CHANGED:     409,
  E_MCP_TOOL_MISMATCH:    400,
  E_RPT_FIELD:            400,
  // 多期趋势（146）：期间格式 / 起止写反 / 跨度超限 —— 都是参数错，进 SQL 前挡住
  E_RPT_PERIOD:           400,
  E_RPT_RANGE:            400,
  E_RPT_TOO_LONG:         400,
  E_CHK_UNREGISTERED:     500,
  E_RESOURCE_UNREGISTERED:403,
  E_EMPLOYEE_NO_REUSED:   409,
  E_SUPPLIER_RATE_MISSING:422,
  E_OUT_OF_SCOPE:         403,
  E_NO_EMPLOYMENT:        409,
  E_UNAUTHENTICATED:      401,

  // ---- 以下 23 个是「库里已经在 raise、但映射表里没有」的码 ----
  // AE1 原来只要求"未登记的码不许落 500"，于是它们以 400 兜着 ——
  // 那是**通过了的失败**：调用方拿不到准确的语义，只是不至于看到 500。
  // 登记全之后，AE1 改成"未登记数必须为 0"，兜底路径仍在，但不再被依赖。
  E_FACT_DATE_REQUIRED:   400,
  E_OFFER_APPEND_ONLY:    409,
  E_ORG_ALREADY_PUBLISHED:409,
  E_ORG_DATE_FROZEN:      409,
  E_ORG_NO_VERSION:       404,
  E_ORG_NO_VERSION_ROW:   404,
  E_ORG_SNAPSHOT_FROZEN:  409,
  E_ORG_UNPUBLISH:        409,
  E_ORG_VERSION_DELETED:  404,
  E_ORG_VERSION_INCOMPLETE:422,
  E_PAYRUN_KEY_IMMUTABLE: 409,
  E_PAYRUN_NOT_FOUND:     404,   // 打印工资单时批次号打错（不是"没有数据"：前者要改单号）
  // 人事合同（160）：block 是"违法条款"，与"参数写错"不是同一类错
  E_CT_NOT_FOUND:         404,
  E_CT_BLOCKED:           409,   // 校验出 block（违法条款），整份不落库
  E_CT_NO_TEMPLATE:       422,
  E_CT_SIGNED:            409,   // 已签不许改（要变更就签新的）
  E_CT_FIELD_MISSING:     422,   // 关键字段为空，不许渲染（否则印出带 {{}} 的废合同）
  E_CT_PLACEHOLDER:       422,   // 模板里有未定义的占位符
  E_CT_NO_START:          422,
  E_CT_NO_END:            422,
  E_CT_OPEN_HAS_END:      422,
  E_CT_BAD_SPAN:          422,
  E_CT_PROB_NOT_ALLOWED:  422,   // 这种合同不得约定试用期
  E_CT_PROB_TOO_LONG:     422,   // 试用期超法定上限
  E_CT_PROB_AGAIN:        422,   // 同一主体只能一次试用期
  E_CT_PROB_OUT:          422,   // 试用期必须含在合同期内
  E_CT_NO_WAGE:           422,   // offer 没有月薪版本，合同工资无从带出
  // 员工异动（163）
  E_CHG_BLOCKED:          409,   // 校验出 block（没有合同 / 生效日早于合同起始 / 无目标门店）
  E_CHG_NOT_FOUND:        404,
  E_CHG_APPLIED:          409,   // 已生效的单子不能再生效一次
  E_CHG_NO_DATE:          422,
  E_CHG_NO_CONTRACT:      409,   // 生效日没有已签合同在履行
  E_CHG_BEFORE_START:     422,   // 生效日不晚于合同起始日（那是签合同不是变更）
  E_CHG_NO_ORG:           422,
  // 假勤资格（164）
  E_LVG_NO_RANGE:         422,
  E_LVG_NO_TYPE:          404,
  E_LVG_NOT_QUALIFIED:    409,   // 未满 12 个月（法定门槛）
  E_LVG_NO_ENTITLEMENT:   409,   // 折算后应为 0 天
  E_LVG_PROBATION:        409,   // 配置为"转正后才可休年假"
  E_LVG_NO_CONTRACT:      409,   // 婚假/产假等要求有已签合同在履行
  // ---- 离职交接（165）----
  E_EXIT_NOT_FOUND:       404,
  E_EXIT_NO_EMPLOYEE:     404,
  E_EXIT_NO_EMPLOYMENT:   404,
  E_EXIT_NO_IDCARD:       409,   // 离职证明要证件号，档案里没有
  E_EXIT_DUP_OPEN:        409,   // 同一人不能有两张未完成的离职单
  E_EXIT_ALREADY_LEFT:    409,
  E_EXIT_BEFORE_HIRE:     422,   // 最后工作日早于入职日
  E_EXIT_NO_DATE:         422,
  E_EXIT_NO_REASON:       422,   // 离职原因必填（≥4 字）
  E_EXIT_KIND:            422,   // 离职类型不合法
  E_EXIT_DONE:            409,   // 已办结，不能重复
  E_EXIT_CANCELLED:       409,
  E_EXIT_NOT_DONE:        409,   // 未办结就要出证明
  E_EXIT_NO_HANDOVER:     422,   // 交接人缺失或是本人
  E_EXIT_SELF_HANDOVER:   422,
  E_EXIT_ARG:             400,   // 离职单参数形状错
  E_EXIT_BLOCKED:         422,   // 校验出 block（早于入职日/重复开单）
  E_NC_NO_EXIT:           404,   // 竞业限制要挂在离职单上
  E_NC_MONTHS:            422,   // 竞业期限超过 24 个月
  E_NC_NOT_AGREED:        422,   // 未约定却要补偿
  E_NC_ARG:               400,
  // ---- 社保参保台账（166）----
  E_SIL_BAD_ARG:          422,
  E_SIL_NO_EMPLOYEE:      404,
  E_SIL_NO_POLICY:        409,   // 该城该险种在该月前没有政策（配置缺失，要人来录）
  E_SIL_BEFORE_HIRE:      422,
  E_SIL_AFTER_LEAVE:      422,
  E_SIL_NO_BASE:          409,   // 无申报基数也无月薪标准，基数算不出
  E_SIL_NOT_ENROLLED:     409,   // 没有在缴段
  E_SIL_STOP_BEFORE_START: 422,
  E_SIL_ADJUST_BEFORE_START: 422,
  E_SIL_BASE_RANGE:       422,   // 手工基数越界（不静默夹）
  E_SIL_NO_REASON:        422,
  E_SIL_HISTORY_APPEND_ONLY: 409,
  // ---- 招聘后半段（167）----
  E_RCI_ROUND_GAP:        422,   // 面试轮次跳号
  E_RCI_SELF:             422,   // 面试人是候选人本人
  E_BG_NO_CONSENT:        409,   // 背调没有书面授权（差一份签字，不是参数错）
  E_OA_STEP:              422,
  E_OA_DECISION:          422,
  E_OA_STEP_DONE:         409,   // 该环节已签字，不可覆盖
  E_OA_NOT_LIVE:          409,
  E_OA_NO_NOTE:           422,   // 驳回必须写理由
  // ---- 考勤异常与补卡（168）----
  E_ATX_NOT_FOUND:        404,
  E_ATX_PERIOD:           422,
  E_ATX_ACTION:           422,
  E_ATX_SKIP_STEP:        422,   // 状态机跳步（open→resolved 不经过 explained）
  E_ATX_CLOSED:           409,
  E_ATX_APPEND_ONLY:      409,   // 处理留痕只增不改
  E_ATX_NO_NOTE:          422,
  E_ATX_GRACE:            422,   // 迟到宽限分钟数越界（参数错，不是状态冲突）
  E_PFX_NOT_FOUND:        404,
  E_PFX_DUP:              409,   // 同人同日同类型只能有一张未拒绝的补卡单
  E_PFX_NO_EMPLOYEE:      404,
  E_PFX_NO_DATE:          422,
  E_PFX_NO_TIME:          422,
  E_PFX_TIME_DAY:         422,   // 补卡时间与补卡日对不上
  E_PFX_TYPE:             422,
  E_PFX_REASON:           422,
  E_PFX_INCOMPLETE:       422,
  E_PFX_NOT_APPROVED:     409,
  E_PFX_ALREADY_APPLIED:  409,   // 补卡已写进考勤，不能重复写
  E_PFX_DECISION:         422,
  E_PFX_DECIDED:          409,
  E_PFX_CLOSED:           409,
  E_PFX_NO_DAILY:         409,   // 没有对应的考勤人日，补卡无处可写
  E_PERSON_NOT_FOUND:     404,   // 档案补充要挂在一个真实存在的人上
  E_PERF_FACTOR_MISSING:  422,
  E_PERF_NO_CYCLE:        404,
  E_PERF_REOPEN:          409,
  // 打分（051）：三种"存了以后才发现"的错，各自有名字
  E_PERF_NOT_EMPLOYED:    422,
  E_PERF_NO_GRADE:        422,
  E_PERF_EXCLUDE_REASON:  422,
  // 补账（052）：五种"走错了路"的拒绝，各自有名字
  E_ATT_ADJ_DELTA:        422,
  E_ATT_ADJ_REASON:       422,
  E_ATT_ADJ_NOT_FORWARD:  422,
  E_ATT_ADJ_NOT_CLOSED:   409,
  E_ATT_ADJ_NO_BASE:      422,
  // 入职（052）
  E_PERSON_NO_NAME:       422,
  // 详情页用 404 而不是 403：403 等于承认"这个人存在，但你没权看"
  E_EMPLOYEE_NOT_FOUND:   404,
  // 离职（054）
  E_TERM_NO_DATE:         422,
  E_TERM_NO_REASON:       422,
  E_TERM_BEFORE_HIRE:     422,
  E_TERM_ALREADY_LEFT:    409,
  E_TERM_NO_EMPLOYMENT:   404,
  E_ET_NO_UPDATE:         409,
  E_ET_NO_DELETE:         409,
  E_HIRE_NO_DATE:         422,
  E_PERM_DIM_UNSUPPORTED: 400,
  E_SETTLE_AMOUNT_FROZEN: 409,
  E_SETTLE_CONFIRMED_DELETED: 409,
  E_STATUS_REGRESS:       409,
  E_TRANSFER_ALREADY:     409,
  E_TRANSFER_NO_ORDER:    404,
  E_VERSION_FROZEN:       409,
  E_VERSION_KEY_IMMUTABLE:409,
  E_VERSION_LOCKED:       409,

  // 服务层自有码（库里不 raise，因为库管不到"HTTP 参数长什么样"）
  E_ARG_INVALID:          400,
  E_NOT_WIRED:            500,

  // 会话（030）。★ 过期与吊销**都是 401，但码不同**：
  //   前者"你该重新登录"，后者"这个 token 被人作废了，去问管理员"。
  //   合成一个 401 E_UNAUTHENTICATED，前端只能弹同一句话。
  E_SESSION_EXPIRED:      401,
  E_SESSION_REVOKED:      401,
  E_SESSION_WEAK:         400,
  E_SESSION_TAINTED:      409,
  E_SESSION_EXTEND:       409,
  E_SESSION_REVIVE:       409,
  E_SESSION_REVOKE_INCOMPLETE: 422,
  E_SESSION_NOT_FOUND:    404,

  // 审批（032）
  E_APPR_NO_TEMPLATE:     404,
  E_APPR_NO_VERSION:      422,
  E_APPR_DEF_INVALID:     422,
  E_APPR_NO_EFFECTIVE:    422,
  E_APPR_NO_BIZ:          404,
  E_APPR_NO_ORG:          422,
  E_APPR_NO_INSTANCE:     404,
  E_APPR_FINISHED:        409,
  E_APPR_NO_TASK:         409,
  // ★ "不是你的待办"是**授权**问题，不是状态冲突：403 而不是 409。
  //   409 会让前端提示"这单状态变了"，而真相是"你不是该审的人"。
  E_APPR_NOT_YOURS:       403,
  E_APPROVAL_NO_APPROVER: 422,
  E_APPR_NO_BIZ_SYNC:     500,
  E_MCP_UNKNOWN_TOOL:     404,

  // 认证（035）
  // ★ 口令错误与「没有这个账号」回同一个码：分开就等于提供「账号是否存在」的查询接口。
  E_AUTH_BAD_CREDENTIAL:  401,
  // 锁定用 423（Locked）：401 会让前端反复弹登录框，而这时正确的动作是等
  E_AUTH_LOCKED:          423,
  E_CRED_WEAK:            422,
  E_CRED_ALGO:            422,
  E_CRED_SAME:            422,
  // 428 Precondition Required：不是"没登录"，是"登录了但必须先改口令"。
  // 用 403 会让前端以为权限不够，于是去找管理员 —— 而他并不需要管理员。
  E_PWD_CHANGE_REQUIRED:  428,
  // 429：是「慢一点」，不是「没权限」。前端该退避重试，而不是弹"联系管理员"。
  E_RATE_LIMITED:         429,

  // ---- 补登记：以下 19 个码库里已经在 raise，但映射表里漏了 ----
  // ★ 漏登记不会报错：未登记的码会落到 400 兜底，于是它看起来"能跑"。
  //   这类"通过了的失败"攒够 19 个才被发现 —— 现在 AE1 改成要求**未登记数 = 0**。
  E_APPR_LOG_APPEND_ONLY:        409,
  E_APPR_NOT_CURRENT_STEP:       409,
  E_APPR_TASK_DONE:              409,
  E_APPR_TRANSFER_DUPLICATE:     409,
  E_APPR_TRANSFER_NO_REASON:     422,
  E_APPR_TRANSFER_SELF:          422,
  E_APPR_TRANSFER_TO_APPLICANT:  422,
  E_DELEGATE_NO_REASON:          422,
  E_DELEGATE_SELF:               422,
  E_DELEGATE_TOO_LONG:           422,
  E_EX_ALREADY_CLOSED:           409,
  E_EX_KIND:                     422,
  E_EX_NOT_FOUND:                404,
  E_EX_NO_DELETE:                409,
  E_EX_NO_OWNER:                 422,
  E_EX_TTL:                      422,
  E_EX_TTL_TOO_LONG:             422,
  E_POLICY_INVALID:              422,
  // 工资条查阅留痕（185）：append-only 被违反。
  //   ★ 归 409，不归 422：这不是「参数不对」，是「这个动作在语义上不允许」——
  //     与 E_EX_NO_DELETE 同类（有些记录就是不能删）。归 422 会让人以为改个参数就行。
  E_PVL_READONLY:                409,
  // 工资条签收回执（186）：回执不可改 —— 改掉一条回执等于"这个员工从来没签过"。
  E_ACK_READONLY:                409,
  // 签收撤回（187）：三种拒绝，**下一步该做什么各不相同**，所以必须是三个码 ——
  //   · 没有这条回执 → 404：单号/工资条选错了，去对一下；
  //   · 已经撤过 → 409：状态冲突（不是参数错），要改理由得走更正流程，不是再点一次；
  //   · 理由太短 → 422：改对就能过。
  //   ★ 与 E_ACK_READONLY 分开：那是"回执本身不许改"，这是"撤回这件事本身不成立"。
  E_ACK_NOT_FOUND:               404,
  E_ACK_ALREADY_REVOKED:         409,
  E_ACK_REASON:                  422,
  // 撤销记录自身 append-only（187）：删掉一条撤回记录等于"这次撤回没发生过"，
  //   而员工的签收已经被它作废了 —— 与 E_ACK_READONLY 同类（有些记录就是不能改删）。
  E_ACKRV_READONLY:              409,
  // 外包归属档口（189）：派工门店与档口所属门店不一致 → 422（配置写错了，改对就行）。
  //   ★ 不用 E_OA_ 前缀：那是 167 的入职审批（E_OA_STEP / E_OA_DECISION）。
  //     混在日志里，排查的人会先去看审批流。
  E_STN_OS_STORE:                422,
  E_SESSION_NOT_HASHED:          400,
  E_APPR_ADDSIGN_APPLICANT:      422,
  E_APPR_ADDSIGN_CLOSED:         409,
  E_APPR_ADDSIGN_DUPLICATE:      409,
  E_APPR_ADDSIGN_NO_REASON:      422,
  E_APPR_CC_NOT_FOUND:           404,
  // 门店档口与编制（172）：
  //   · E_STN_* = 门店 × 档口（store station）。★ 不用 E_SS_ 前缀 ——
  //     那是 087/088 工资表结构（salary structure）的，混在日志里会指错方向。
  //   · E_SP_*  = 档口 × 岗位 × 编制（station position）。
  // 归类原则与 171 一致：**下一步该做什么不同，就必须是两个码。**
  //   岗位在本店已属别的档口 → 改配置（422）；
  //   档口还有人站着就要关 → 先调人（409）；
  //   外包岗配进编制 → 选错岗位了（422）；
  //   Σ档口编 > 门店编 → 先调门店编或别的档口（422）。
  E_STATION_NAME:                422,
  E_STATION_CODE:                422,
  E_STATION_NO_STORE:            400,
  E_STN_NO_STORE:                404,
  E_STN_NOT_STORE:               422,   // 挂在区域/集团上：档口的"门店"这个词没意义
  E_STN_STORE_INACTIVE:          409,
  E_STN_NO_DEF:                  404,   // 档口编码不在词表里
  E_STN_NOT_FOUND:               404,
  E_STN_SPAN:                    422,
  E_STN_IN_USE:                  409,   // 还有人在岗，先调人
  // ★ 这条是 ex_ss_no_overlap（23P01）的人话版。23P01 落到兜底映射会变成
  //   {"error":"EXCLUSION_VIOLATION","sqlstate":"23P01"} —— 把 Postgres 的约束名
  //   原样吐给用户，没有业务码、没有 message，前端只能当"系统错误"，而它其实是
  //   一条**很常见的业务拒绝**：想改起始日的人一定会撞上。
  E_STN_OVERLAP:                 409,
  E_SP_NO_STATION:               404,
  E_SP_OUTSOURCED:               422,   // 外包岗不进内部编制
  E_SP_CROSS_STATION:            422,   // 同店内一个岗位只能属一个档口
  E_SP_OVER_STORE:               422,   // Σ档口编 ≤ 门店编
  E_SP_NEGATIVE:                 422,
  E_SP_PERIOD:                   422,
  E_SP_REASON:                   422,
  E_SP_APPEND_ONLY:              409,

  // PDF（服务端打印件）：
  //   · E_PDF_NO_CHROME 归 **501 Not Implemented**，不归 500 ——
  //     "这台机器没装 Chrome"不是服务坏了，换台机器/装个浏览器就好了；
  //     落 500 会让人去翻日志找 bug，而根因一句话就能说清。
  //   · E_PDF_FAILED 才是 500：Chrome 在、但渲染失败/超时/产出坏文件。
  E_PDF_NO_CHROME:               501,
  E_PDF_FAILED:                  500,
};

/**
 * 在**服务层**抛业务码。
 * 能由库里判的一律让库判（库不会被绕过）；这个函数只给"库管不了"的那几件事用：
 * 权限范围（要读 pg_temp，库函数不总是有上下文）、参数形状、会话身份。
 */
export function bizErr(code, message) {
  const e = new Error(`${code}: ${message}`);
  e.code = 'P0001';
  return e;
}

/** 已登记的业务码清单。测试会拿它跟库里 raise 的码做差集。 */
export const BIZ_CODES = Object.keys(BIZ);

/** 从 message 里抽业务码（`E_XXX: 说明`） */
function bizCode(msg) {
  const m = /^(E_[A-Z0-9_]+)\s*:/.exec(msg || '');
  return m ? m[1] : null;
}

/** 业务说明是给"人"看的，去掉错误码前缀，保留后面的中文 */
function bizMessage(msg, code) {
  if (!msg) return '';
  const s = msg.split('\n')[0];
  return code ? s.slice(code.length).replace(/^[:\s]+/, '') : s;
}

let seq = 0;

/**
 * 把任意异常映射成 { status, body }。
 * body 里永不出现原始 SQL / 表名 / 约束值 —— 除非它是业务码那一条的说明。
 */
export function toHttp(err) {
  const sqlstate = err?.code;
  const raw = err?.message || String(err);
  const code = bizCode(raw);

  // ① 业务码优先：它是我们主动 raise 的，说明就是写给调用方看的
  if (code && BIZ[code]) {
    return {
      status: BIZ[code],
      body: { error: code, message: bizMessage(raw, code) },
    };
  }

  // ② 未登记的业务码：不要回 500，它确实是业务拒绝，只是我们忘了登记
  if (code) {
    return {
      status: 400,
      body: { error: code, message: bizMessage(raw, code) },
    };
  }

  // ③ 数据库语义错误：只回类别，不回原文
  if (sqlstate && SQLSTATE[sqlstate]) {
    const [status, kind] = SQLSTATE[sqlstate];
    return { status, body: { error: kind, sqlstate } };
  }

  // ④ 其余一律 500，且**不回显原文**。
  //    ref 是为了让用户报障时有个可检索的东西，
  //    而原文只写进服务端日志——那条日志里有表名，不该出现在浏览器里。
  const ref = `R${Date.now().toString(36)}${(++seq).toString(36)}`;
  return { status: 500, body: { error: 'INTERNAL', ref } };
}

/**
 * 是否可重试（序列化冲突 / 死锁）。
 * 调用方可以据此重跑一次，但**不要自动重试多次**——
 * 反复重试会把一次死锁放大成一次雪崩。
 */
export function isRetryable(err) {
  return err?.code === '40001' || err?.code === '40P01';
}
