# 招聘来源接入收口（231）

2026-11-17。本组把平台投递和文件简历作为有据来源，接入已有原生招聘管理；候选、面试、Offer、永久人员和正式入职继续由既有HR模块办理。

## 已核协议与真实连接边界

已实现飞书招聘只读投递适配：内部企业应用取得tenant access token后，按已核职位和毫秒更新时间窗口读取投递ID列表，再请求投递详情及人才信息；分页使用平台返回的page_token。投递ID、职位ID、人才ID、modify_time、活跃状态及姓名、联系方式严格按公开结构验证，不猜测字段、不发送应聘资料、不调用职位发布或候选创建接口。[官方投递列表](https://open.feishu.cn/document/ukTMukTMukTM/uMzM1YjLzMTN24yMzUjN/hire-v1/application/list)、[官方投递详情](https://open.feishu.cn/document/ukTMukTMukTM/uMzM1YjLzMTN24yMzUjN/hire-v1/application/get_detail)、[官方SDK资源定义](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/hire/v1/resource.go)、[官方SDK字段模型](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/hire/v1/model.go)。核验日期2026-11-17。

钉钉官方目录可核到导入简历创建候选人的能力，但这不证明当前企业已获得读取授权；本组不启用其向外写入接口。[钉钉官方能力目录](https://open.dingtalk.com/document/ability/map)。本轮未核到可采用的猎聘、智联企业读取协议，界面明确待企业授权核验，保留Excel/PDF原件导入；不声称上述招聘站已经接通。飞书协议经本地HTTP fixture和真实应用验证，未使用真实企业凭据实连。

## 业务路径与当前权限

1. HR把来源企业、外部职位、同公司已核招聘需求、处理授权依据和截止日关联成草稿；不同人员独立核准。同一连接的企业标识必须一致，不能改绑已有来源。
2. 外部采集仅由固定官方host的受限租约worker执行。当前经办人、核准人、招聘功能/范围/完整字段及加密连接版本在采集前和响应落库前重核；HTTP在事务外，禁止跳转和任意URL。
3. 来源以企业职位命名空间内的稳定应聘ID建根，人才ID不可换人；加密保存版本、原件SHA和来源时间。重复不重复造候选，旧版不盖新版，同时间不同内容隔离。平台inactive只是投递不活跃；列表缺席不推断撤回。
4. 另一有权HR人工核对当前来源，调用已有candidate.create登记原生候选。无同名自动合并，无自动建员工、发账号或入职；外包和供应商服务身份不能办理企业招聘来源。
5. PDF原件归属同一候选，但仍须既有简历复核。多行Excel或平台摘要只作来源证据，不冒充完整、已审简历。面试、Offer核准、送达登记、接受、到岗入职保持分步。

姓名和联系方式是218既有候选的不可改快照。相同身份的新简历可人工采用为新来源版本并清除旧简历复核状态；身份或联系方式改变时阻断采用，须处置旧应聘后登记明确的新应聘来源。不会为消除冲突覆写既有身份。来源更新、撤回、授权到期或连接变化会阻断继续办理旧版Offer/入职，允许撤回处置有效Offer；已有人事事实不随外部变化倒改。

原件下载和来源操作每次都要求当前同一完整招聘授权覆盖source_channel、source_ref、full_name、contact、attachments，另核文件content/filename/mime权限。不同字段grant不拼接。列表在授权投影后检索、统计、分页；原件不留浏览器存储，不执行PDF、公式、宏或外链。Excel最多200行，PDF或XLSX原件最多3MB。

## 正式ABI

| 类型 | 名称 | 实际函数/用途 |
|---|---|---|
| Query | hr.recruiting.workspace | queryWorkspace；channels/sources/jobs，授权后搜索分页 |
| Query | hr.recruiting.template | sourceTemplate；当前来源的Excel模板 |
| Query | hr.recruiting.download | sourceDownload；指定来源与历史版本的受控原件下载 |
| Command | hr.recruiting.channel.create / approve / disable | 建来源、独立核准、停用 |
| Command | hr.recruiting.job.enqueue / cancel | 采集及续页排队、取消未执行采集 |
| Command | hr.recruiting.file.import | 有原件的PDF字段核对或Excel逐行导入；body limit 12MB |
| Command | hr.recruiting.source.accept / update / reject / acknowledge | 人工接收、采用同身份新简历、驳回、登记不活跃/撤回核查 |
| Internal | assertNativeRecruitingSource | 原生招聘dispatchCommand中h.commandFor前的一行守卫 |
| Internal | recruitingTick / startRecruitingWorker | 同一Node进程的受限worker；stop后再关闭DB |

所有命令由服务端会话赋userId和operationId，前端不能覆盖。job.enqueue的continuation_of仅接受同一来源、同一窗口、已完成且确有next_cursor的上页；界面“继续采集下一页”仍提交此命令，不另开放万能协议。

## 数据库与普通源

SQL231新增ty_rc_channel、ty_rc_job、ty_rc_root、ty_rc_version、ty_rc_review共5表；fn_ty_rc_scope_guard、fn_ty_rc_review_proof、fn_ty_rc_immutable、fn_ty_rc_offer_guard共4函数、9触发器。不可改来源和人工凭据，跨公司引用、伪造平台来源、换人、无人工凭据即接收及绕开原生Offer来源检查均由数据库守住。不修改001–230字节。

普通源为三个recruiting服务、一个worker、两个测试、一个显式seed工具、RecruitingSourceInbox JSX/CSS，另有原生HR、cloud-api及招聘页的最小接缝。依赖仅使用项目已有模块，不新增外部运行服务或前端进程。

## 验证与演示

当前独立PGlite 35项、随机空PostgreSQL 35项通过，0失败0跳过。覆盖真实HTTP协议、重复/更新/同时间冲突/不活跃、原件密封与精确下载、同名分离、完整字段权限、不同人员核对、当前凭据/核准人撤权、来源分页、原生简历→面试→Offer→显式入职。正式main registry、真实登录、Node HTTP及主前端完整构建的PC/393px手机React验收11项通过，0未处理JS错误。

seedRecruitingSourcesDemo(db,{confirmSynthetic:true})仅接受有完整标记的天意集团62人77账号演示帐套。11场景12来源根，含待核、已接收待审、已审简历、驳回、新版待核、明确撤回、两个同名、冲突、旧版迟到及Excel原件。随机V6克隆首次+精确重放9项通过；不改源V6、不新增永久人员/账号、不改密码/工资/旧候选，不调用外部网络。页面和原件使用自然中文姓名，演示属性只在审计和本说明保留。
