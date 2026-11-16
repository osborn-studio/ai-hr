// ============================================================================
// app/services/approval.mjs · 审批：发起 / 待办 / 审批
// ----------------------------------------------------------------------------
// 引擎在库里（032），这一层只做三件事：
//   ① 身份换算：登录账号 → 审批人 user_id（引擎要的是人的 id）
//   ② 参数形状：biz_type 只允许已实现回写的业务（leave），
//      不认识的业务**明确拒绝**，而不是"发起成功了但永远走不到回写"
//   ③ 待办列表：只列"该我处理"的，不是"所有单"
//
// 不属于这一层：几步、谁审、会签怎么算、能不能跳过。那些都在库里，
// 因为服务层可以被绕过（运维脚本、MCP 工具、另一个客户端）。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

// ★ 064 起不再复用 'requisition'：审批是"这类事"，招聘也是"这类事"，
//   复用会让"能看招聘需求"自动等于"能审批"，而店员要看待办就得给他招聘授权。
export const RESOURCES = { approval: 'approval' };

const BIZ_TYPES = ['leave'];

/** 发起审批（业务单据必须已存在） */
export async function start(tx, { userId, bizType, bizId, on }) {
  if (!BIZ_TYPES.includes(bizType)) {
    throw bizErr('E_APPR_NO_BIZ_SYNC', `业务类型 ${bizType} 没有回写实现，不允许发起审批`);
  }
  if (!Number.isInteger(bizId) || bizId <= 0) throw bizErr('E_ARG_INVALID', 'biz_id 必须是正整数');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(on || ''))) throw bizErr('E_ARG_INVALID', 'on 必须是 YYYY-MM-DD');

  await requireSession(tx, { userId, resource: RESOURCES.approval });

  // 模板码在服务层只做映射（一个业务一个模板），不在请求参数里暴露 ——
  // 否则调用方可以给请假单指定"离职审批模板"，而引擎会照做。
  const code = bizType === 'leave' ? 'LEAVE' : null;
  const id = (await tx.query('SELECT fn_appr_start($1,$2,$3,$4::date) id',
    [code, bizType, bizId, on])).rows[0].id;
  return { instance_id: Number(id), biz_type: bizType, biz_id: bizId };
}

/** 我的待办：只列当前步、且该我处理的 */
export async function myTasks(tx, { userId }) {
  await requireSession(tx, { userId, resource: RESOURCES.approval });
  return (await tx.query(
    `SELECT t.id, t.instance_id, t.seq, i.biz_type, i.biz_id, i.started_at,
            i.template_version_id
       FROM approval_task t
       JOIN approval_instance i ON i.id = t.instance_id
      WHERE t.approver_id = $1
        AND t.status = 'pending'
        AND i.status = 'running'
        -- 只列**当前步**：后面步骤的任务已经落行，但还不是该办的事
        AND t.seq = (SELECT min(t2.seq) FROM approval_task t2
                      WHERE t2.instance_id = t.instance_id AND t2.status = 'pending')
      ORDER BY i.started_at, t.seq`, [userId])).rows;
}

/** 审批一步。身份从会话取，不从参数取。 */
export async function act(tx, { userId, instanceId, approve }) {
  if (!Number.isInteger(instanceId) || instanceId <= 0) throw bizErr('E_ARG_INVALID', 'instance 必须是正整数');
  await requireSession(tx, { userId, resource: RESOURCES.approval });
  const r = (await tx.query('SELECT fn_appr_act($1,$2,$3,NULL) r',
    [instanceId, userId, !!approve])).rows[0].r;
  return { instance_id: instanceId, status: r };
}

/** 一张单的审批轨迹（谁说、哪天、结论） */
export async function trace(tx, { userId, instanceId }) {
  await requireSession(tx, { userId, resource: RESOURCES.approval });
  const inst = (await tx.query(
    `SELECT id, biz_type, biz_id, status, started_at, finished_at, template_version_id
       FROM approval_instance WHERE id = $1`, [instanceId])).rows[0];
  if (!inst) throw bizErr('E_APPR_NO_INSTANCE', `审批实例 ${instanceId} 不存在`);
  const tasks = (await tx.query(
    `SELECT seq, approver_id, act_kind, status, acted_at
       FROM approval_task WHERE instance_id = $1 ORDER BY seq, approver_id`, [instanceId])).rows;
  return { instance: inst, tasks };
}

/**
 * 转签：把当前步的待办转给另一个人。
 * ★ 为什么必须有这个接口：审批人在**启动时**就解析成行了（032），
 *   而他可能休假/离职。三条出路里只有转签能留痕 —— 直接改行没有痕迹，
 *   让申请人重提则前面批过的人白批。
 */
export async function transfer(tx, { userId, taskId, toUser, reason }) {
  if (!Number.isInteger(taskId) || taskId <= 0) throw bizErr('E_ARG_INVALID', 'task 必须是正整数');
  if (!Number.isInteger(toUser) || toUser <= 0) throw bizErr('E_ARG_INVALID', 'to 必须是正整数');
  await requireSession(tx, { userId, resource: RESOURCES.approval });
  await tx.query('SELECT fn_appr_transfer($1,$2,$3,$4)',
    [taskId, toUser, userId, reason]);
  return { transferred: true, task_id: taskId, to_user: toUser };
}

/** 设置代理：from 固定为当前登录人（不能替别人设代理） */
export async function setDelegate(tx, { userId, toUser, fromDate, toDate, reason }) {
  if (!Number.isInteger(toUser) || toUser <= 0) throw bizErr('E_ARG_INVALID', 'to 必须是正整数');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate || ''))) throw bizErr('E_ARG_INVALID', 'from_date 必须是 YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(toDate || ''))) throw bizErr('E_ARG_INVALID', 'to_date 必须是 YYYY-MM-DD');

  await requireSession(tx, { userId, resource: RESOURCES.approval });
  const id = (await tx.query('SELECT fn_delegate_add($1,$2,$3::date,$4::date,$5,$6) id',
    [userId, toUser, fromDate, toDate, reason, String(userId)])).rows[0].id;
  return { delegate_id: Number(id), from_user: userId, to_user: toUser };
}

/** 我的代理（我托谁代、谁托我代） */
export async function myDelegates(tx, { userId }) {
  await requireSession(tx, { userId, resource: RESOURCES.approval });
  return (await tx.query(
    `SELECT id, from_user, to_user, from_date, to_date, reason, revoked_at
       FROM approval_delegate
      WHERE from_user = $1 OR to_user = $1
      ORDER BY from_date DESC`, [userId])).rows;
}

/**
 * 加签：给当前步加一个**必须签**的人。
 * ★ 与抄送的区别不是参数，是表：这里插的是 approval_task（会推进流程），
 *   抄送插的是 approval_cc（不推进）。混成一张表，或签步骤就会永远差一个人。
 */
export async function addSign(tx, { userId, taskId, toUser, reason }) {
  if (!Number.isInteger(taskId) || taskId <= 0) throw bizErr('E_ARG_INVALID', 'task 必须是正整数');
  if (!Number.isInteger(toUser) || toUser <= 0) throw bizErr('E_ARG_INVALID', 'to 必须是正整数');
  await requireSession(tx, { userId, resource: RESOURCES.approval });

  const id = (await tx.query('SELECT fn_appr_addsign($1,$2,$3,$4) id',
    [taskId, toUser, userId, reason])).rows[0].id;
  return { task_id: Number(id), instance_task: taskId, to_user: toUser };
}

/** 抄送：只通知，不推进。可以抄给任何人（包括申请人——抄给他本人是有意义的） */
export async function addCc(tx, { userId, instanceId, toUser }) {
  if (!Number.isInteger(instanceId) || instanceId <= 0) throw bizErr('E_ARG_INVALID', 'instance 必须是正整数');
  if (!Number.isInteger(toUser) || toUser <= 0) throw bizErr('E_ARG_INVALID', 'to 必须是正整数');
  await requireSession(tx, { userId, resource: RESOURCES.approval });

  const added = (await tx.query('SELECT fn_appr_cc_add($1,$2,$3) r',
    [instanceId, toUser, userId])).rows[0].r;
  return { instance_id: instanceId, to_user: toUser, added };
}

/** 抄送我的（默认只给未读；read=all 给全部，用于复盘） */
export async function myCc(tx, { userId, all = false }) {
  await requireSession(tx, { userId, resource: RESOURCES.approval });
  return (await tx.query(
    `SELECT c.id, c.instance_id, c.added_at, c.seen_at,
            a.biz_type, a.biz_id, a.status AS instance_status
       FROM approval_cc c JOIN approval_instance a ON a.id = c.instance_id
      WHERE c.user_id = $1 ${all ? '' : 'AND c.seen_at IS NULL'}
      ORDER BY c.added_at DESC LIMIT 50`, [userId])).rows;
}

export async function markCcSeen(tx, { userId, ccId }) {
  if (!Number.isInteger(ccId) || ccId <= 0) throw bizErr('E_ARG_INVALID', 'id 必须是正整数');
  await requireSession(tx, { userId, resource: RESOURCES.approval });
  await tx.query('SELECT fn_appr_cc_seen($1,$2)', [ccId, userId]);
  return { cc_id: ccId, seen: true };
}
