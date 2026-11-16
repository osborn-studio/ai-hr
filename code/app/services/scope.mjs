// ============================================================================
// app/services/scope.mjs · 档口范围（182）：这一屏到底该给我看多少人
// ----------------------------------------------------------------------------
// 厨师长/档口长只看**自己档口**的人。判据全在库里：
//   fn_station_scope(p_user, p_as_of)        → 我落在哪个档口（或为什么落不上）
//   fn_scope_people_station(p_user, p_as_of) → 我该看到的人（认不出档口 = 0 行）
//
// 这一层只做两件事，都是"三处读面不许各写一遍"的那部分：
//   ① `inStationScope()` —— 行闸 WHERE 片段的**唯一写法**；
//      SQL 逻辑在库里，这里绝不重复实现；它存在只是为了三个调用点长得一样，
//      否则"漏改一处"这种事故根本看不出来（170 文件头就是这么来的）。
//   ② `stationScope()` —— 把 state 抬进响应。
//
// ★ 为什么响应里必须带 state，而不是只在库里 0 行就算了：
//   安全失败的后果是"0 行"，而"0 行"与"这家本来没人"在页面上长得一模一样。
//   厨师长看到空列表，第一反应是"系统坏了/没数据"，不会想到"我还没被编到某个档口"。
//   state 是那两件事唯一的区别。
// ============================================================================

/**
 * 行闸片段：某列必须落在"我的档口范围"里。
 * @param col      要过滤的列（如 `x.employee_id`）
 * @param userExpr 用户 id 的 SQL 占位符（如 `$1`）
 * @param dateExpr 判定日的 SQL 表达式（如 `$2::date`；写 `NULL` = 按今天）
 */
export const inStationScope = (col, userExpr, dateExpr) =>
  `${col} IN (SELECT employee_id FROM fn_scope_people_station(${userExpr}::bigint, ${dateExpr}))`;

/**
 * 我落在哪个档口。返回一行，永远不会抛"没配"。
 * @returns {Promise<{state:string, store_id:number|null, store_station_id:number|null,
 *                    station_code:string|null, station_name:string|null}>}
 *   state: off（能力位没开，看全店）/ ok / no_person / no_station / ambiguous
 */
export async function stationScope(tx, { userId, asOf = null }) {
  const r = (await tx.query(
    'SELECT state, store_id, store_station_id, station_code, station_name'
    + '  FROM fn_station_scope($1::bigint, $2::date)', [userId, asOf])).rows[0];
  // 函数保证恰好一行；真拿不到时按"最保守"的一种报：认不出档口。
  // 不写 'off' —— 'off' 的意思是"看全店"，而"我不知道"不该被读成"全给"。
  return r || { state: 'no_station', store_id: null, store_station_id: null,
                station_code: null, station_name: null };
}
