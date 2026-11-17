// Notices translate current business facts only; reading never changes facts.
const labels={expiring:'即将到期',expired:'已到期',valid:'有效',missing:'待补齐',not_required:'不适用',draft:'草稿',pending:'待办理',pending_review:'待复核',running:'审批中',approved:'已批准',rejected:'已驳回',cancelled:'已取消',blocked:'待核处理',recorded:'已记录',internal_only:'站内已记录',not_configured:'未配置',not_verified:'待核验',not_sent:'未发出',sending:'投递中',sent:'已发送',delivered:'已送达',accepted:'平台已受理',failed:'投递失败',unknown:'结果待核',read:'已读',unread:'未读',confirmed:'已确认',active:'启用',disabled:'已停用',closed:'已关闭',applied:'已生效',not_applicable:'无需业务入账'};
export const portalNoticeState=value=>labels[value]||'待核对';
export const portalNoticeBusiness=row=>portalNoticeState(row.business_status||row.status);
export function portalNoticeDelivery(row){return row.issued_state==='recorded'&&!row.delivery_status?'站内已记录':portalNoticeState(row.delivery_status);}
