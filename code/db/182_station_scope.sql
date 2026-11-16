-- ============================================================================
-- 182_station_scope.sql · 厨师长/档口长：只看**自己档口**的人
-- ----------------------------------------------------------------------------
-- 用户原话："要不要让厨师长只看到自己档口的人（现在是能看到整家店）？"
--          → "现在就做"。
--
-- 改之前：档口长的 `cost_org` 范围就是**整家店**，而 170 的行闸、053/161 的
-- 花名册、考勤的两个 EXISTS，全部只到"门店"这一层。于是他能看到整店的人 ——
-- 而他的职责只管一个档口。这是"行闸粒度 = 组织树粒度"的必然结果：
-- 档口不是组织节点（172 §2 已明确否掉），所以组织维度的行闸**永远**到不了档口。
--
-- ★ 为什么不用"把档口加进四维"这条看起来更正统的路（docs/48 §13.6 的待办）：
--   那要动 `sys_perm_dim` 的 kind 守卫（001:216-222）、`app_begin_scope` 的三个
--   分支、以及 `sys_data_scope_rule.value_ids` 的语义（人挂档口后
--   `a.org_id = 档口id` 就匹配不上门店，170 会 fail-closed 到 0 行 —— 见 172 §头部
--   第 ④ 条踩过的那次）。一次改动同时碰权限中枢和既有 8 个调用方，
--   影响面远超本次能安全验证的范围。
--
--   这次的落法是**在行闸之上再叠一层收窄**，不碰四维：
--     ① 能力位 `people_station_scope`（资源码，与 180 的 `payroll_slips_read_all` 同法）；
--     ② `fn_station_scope`   回答"我这个人今天是哪个档口"，答不出就**说答不出**；
--     ③ `fn_scope_people_station` = fn_scope_people ∩ 我的档口的人，认不出档口时 **0 行**。
--   三个读面（花名册 / 考勤 / 排班）只调 ③，不各写一遍口径。
--
-- ★★ 本次最要紧的一条：**安全失败**。
--   "厨师长看不到人"是可以解释的；"厨师长突然看到全店"是越权，而且不会有任何报错。
--   所以认不出档口（没绑人 / 当期不在任何档口编制上 / 跨两个档口）时，
--   ③ 返回 **0 行**，绝不退回 fn_scope_people 的全店口径。
--   退回全店在代码上只差一个 IF，在验收上却是"这类功能从来没人发现配错了"。
--
-- ★ 一个必须写下来的坑：**fn_role_can 对超级角色恒真**（063:117-121 先判 is_super
--   就直接 return true，根本不看 sys_role_resource）。180 那个能力位是"放宽"，
--   恒真无害；本文件这个能力位是"收窄"，恒真就会**给超级管理员悄悄上一把锁**
--   —— 而他从没被授过这条。所以 `fn_station_scope` 第一步先把 super 显式排除
--   （state='off'）。任何**收窄型**能力位都必须做这一步。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 能力位：只看本档口
-- ---------------------------------------------------------------------------
INSERT INTO sys_perm_resource (resource_code, label, temporal_basis)
VALUES ('people_station_scope', '人员范围：只看本档口（花名册/考勤/排班）', 'CURRENT')
ON CONFLICT (resource_code) DO NOTHING;

COMMENT ON TABLE sys_perm_resource IS
  '资源码字典。people_station_scope = 只看**本档口**的人（182）；'
  'payroll_slips_read_all = 能看**他人**的工资条（180）。'
  '★ 本表里有两类能力位，方向相反：180 那条是**放宽**（有它才看得到更多），'
  '182 这条是**收窄**（有它才看得更少）。收窄型的必须显式排除超级角色 ——'
  '因为 fn_role_can 对 super 恒真，否则等于偷偷给管理员上锁。';

-- ---------------------------------------------------------------------------
-- 2. 「我今天是哪个档口」——答不出要说答不出，不许猜
-- ---------------------------------------------------------------------------
-- 返回**恰好一行**，state 五选一：
--   off       能力位没开（或超级角色）→ 调用方应退回 170 的全店口径，行为与改动前一致
--   no_person 账号没绑人（sys_account.person_id IS NULL）
--   no_station 绑了人，但当期推不出档口（没授岗 / 那个岗位当期没档口编制 / 归属不在那家店）
--   ambiguous 推出多于一个（一人兼两岗跨两档口）★ 不取"主档口"，见下方注释
--   ok        恰好一个
--
-- ★ 认档口的路径与 `fn_station_fill` 的**到岗**完全同源（172:752-770 那四个条件）：
--   同一个 `person_position` → `station_position`，同样要求
--   `station_position.period` = 当期、档口当日在营、本人 cost_org 归这家店。
--   换一条路径（比如"从排班推"）会让"我看到的名单"与"页面上那个到岗数"
--   用的不是同一批人 —— 而这两个数会出现在同一屏里。
--
-- ★ 为什么 ambiguous 不取 max/min：同一个人在 WOK 与 GARNISH 都有编制是常态
--   （一人两岗，172 §6：档口数岗次、门店数人头）。取"第一个"等于替客户决定
--   他是哪个档口的人，而错了不会有任何报错 —— 他会在两个档口各看到半批人，
--   或者在一批人里看到别档口的人。答不出就答不出，让他去补一条唯一的授岗。
CREATE OR REPLACE FUNCTION public.fn_station_scope(p_user bigint, p_as_of date DEFAULT NULL)
RETURNS TABLE (state varchar, store_id bigint, store_station_id bigint,
               station_code varchar, station_name varchar)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_on     date   := COALESCE(p_as_of, public.app_today());
  v_person bigint := public.fn_my_person(p_user);
BEGIN
  -- ★ 超级角色先排除：fn_role_can 对 super 恒真，不排除就变成"给管理员上锁"。
  IF EXISTS (SELECT 1 FROM public.fn_effective_roles(p_user, current_date) e
               JOIN public.sys_role r ON r.id = e.role_id
              WHERE r.is_super AND r.is_active)
     OR NOT public.fn_role_can(p_user, 'people_station_scope', 'read')
  THEN
    RETURN QUERY SELECT 'off'::varchar, NULL::bigint, NULL::bigint,
                        NULL::varchar, NULL::varchar;
    RETURN;
  END IF;

  IF v_person IS NULL THEN
    RETURN QUERY SELECT 'no_person'::varchar, NULL::bigint, NULL::bigint,
                        NULL::varchar, NULL::varchar;
    RETURN;
  END IF;

  -- 恰好一行：0 个 → no_station；1 个 → ok（带档口）；多个 → ambiguous（不带档口）
  RETURN QUERY
  WITH cand AS (
    SELECT DISTINCT ss.id AS ssid, ss.store_id AS sid,
           st.code::varchar AS scode, st.name::varchar AS sname
      FROM public.person_position pp
      JOIN public.station_position sp
        ON sp.position_id = pp.position_id
       AND sp.period = to_char(v_on, 'YYYY-MM')
      JOIN public.store_station ss ON ss.id = sp.store_station_id
      JOIN public.station st ON st.id = ss.station_id
     WHERE pp.person_id = v_person
       AND daterange(pp.valid_from, pp.valid_to, '[]') @> v_on
       AND daterange(ss.opened_at, ss.closed_at, '[]') @> v_on
       -- 归属必须是**这家店**：等值，不是 path LIKE（跨店支援天天发生，
       -- 与 172:764 同一条理由）。少了它，在 A 店挂岗、成本归 B 店的人
       -- 会把 A 店的档口长也认到 B 店去。
       AND EXISTS (SELECT 1 FROM public.employee_org_assignment a
                    WHERE a.employee_id = v_person
                      AND a.dim_code = 'cost_org'
                      AND a.org_id = ss.store_id
                      AND daterange(a.valid_from, a.valid_to, '[]') @> v_on)
  )
  SELECT 'ok'::varchar, c.sid, c.ssid, c.scode, c.sname
    FROM cand c
   WHERE (SELECT count(*) FROM cand) = 1
  UNION ALL
  SELECT CASE WHEN count(*) = 0 THEN 'no_station' ELSE 'ambiguous' END::varchar,
         NULL::bigint, NULL::bigint, NULL::varchar, NULL::varchar
    FROM cand
  HAVING count(*) <> 1;
END;
$$;

COMMENT ON FUNCTION fn_station_scope IS
  '当前账号（按 p_as_of）落在哪个档口。★ 返回恰好一行，state ∈ '
  'off / no_person / no_station / ambiguous / ok。'
  '★ 只有 ok 才给得出档口；ambiguous（一人兼两岗跨两档口）**不猜**主档口。'
  '★ off = 能力位没开或超级角色 → 调用方退回 170 的全店口径（行为与 182 之前一致）。';

-- ---------------------------------------------------------------------------
-- 3. 人员行闸：170 ∩ 我的档口（★ 认不出档口 = 0 行）
-- ---------------------------------------------------------------------------
-- 三个读面（花名册 / 考勤 / 排班）共用它。**不各写一遍**：写成三份的那天，
-- 漏掉的那一处不会报错，只会让某个角色的列表里多几个人 —— 170 文件头
-- 就是这么踩出来的（四个接口各抄一遍 EXISTS，抄漏一个就是一个越权面）。
--
-- ★ 调用前提与 fn_scope_people 相同：本请求已经 app_begin_scope 过
--   （requireSession / prepareRead 会做）。没有 scope → fn_scope_people 0 行
--   → 本函数也 0 行，两处一致。
CREATE OR REPLACE FUNCTION public.fn_scope_people_station(
  p_user   bigint,
  p_as_of  date DEFAULT NULL
) RETURNS TABLE (employee_id bigint)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_on    date    := COALESCE(p_as_of, public.app_today());
  v_state varchar(16);
  v_ss    bigint;
  v_store bigint;
BEGIN
  SELECT s.state, s.store_station_id, s.store_id
    INTO v_state, v_ss, v_store
    FROM public.fn_station_scope(p_user, v_on) s;

  -- ① 能力位没开：**与 170 逐字相同**（集团 HR / 薪酬专员 / 总经理 / 超级角色走这支）
  IF v_state = 'off' THEN
    RETURN QUERY SELECT x.employee_id FROM public.fn_scope_people(v_on) x;
    RETURN;
  END IF;

  -- ② ★ 安全失败：认不出档口 → 0 行。**不许**在这里写 RETURN QUERY ... fn_scope_people
  --    做兜底 —— 那行代码就是"厨师长看不到人"变成"厨师长看到全店"的地方，
  --    而它跑起来不报错，测试里也只会表现为"行数和改之前一样"。
  IF v_state IS DISTINCT FROM 'ok' THEN
    RETURN;
  END IF;

  -- ③ 我的档口当期在岗的人（与 fn_station_fill 的到岗同源），再与 170 求交
  RETURN QUERY
  SELECT DISTINCT q.employee_id
    FROM public.fn_scope_people(v_on) q
   WHERE q.employee_id IN (
     SELECT pp.person_id
       FROM public.station_position sp
       JOIN public.person_position pp
         ON pp.position_id = sp.position_id
        AND daterange(pp.valid_from, pp.valid_to, '[]') @> v_on
       JOIN public.employment e
         ON e.person_id = pp.person_id
        AND daterange(e.hire_date, e.leave_date, '[]') @> v_on
       JOIN public.employee_org_assignment a
         ON a.employee_id = pp.person_id
        AND a.dim_code = 'cost_org'
        AND daterange(a.valid_from, a.valid_to, '[]') @> v_on
        AND a.org_id = v_store
      WHERE sp.store_station_id = v_ss
        AND sp.period = to_char(v_on, 'YYYY-MM')
   );
END;
$$;

COMMENT ON FUNCTION fn_scope_people_station IS
  '人员行闸（182）= fn_scope_people ∩ 我的档口的人。花名册/考勤/排班三处共用它。'
  '★ 认不出档口（no_person / no_station / ambiguous）时返回 **0 行**，'
  '绝不退回全店口径 —— 安全失败是这条函数的全部意义。'
  '★ 能力位没开（或超级角色）时与 fn_scope_people **逐字等价**，'
  '所以"关掉开关就回到全店"不是另写一条分支，而是同一支代码。';

-- ---------------------------------------------------------------------------
-- 4. 角色：档口长（厨师长）
-- ---------------------------------------------------------------------------
-- 为什么必须有一个角色：能力位没有归属时，这套东西就是"接了线但没通电"
-- （与 020 的教训同型：授权只登记成一行记录，不改变任何查询结果）。
-- ★ 只给 read：他会看人、看考勤、看排班周表，但**不能**封账/补账/改排班
--   （那三件事与 `attendance_daily` 的 write 位是同一个资源码，063 没有细分）。
--   要让他能排班，就再授 `attendance_daily` 的 write —— 那是一次显式决定，
--   不是这次顺手给的。写在这里，是为了下一个人知道这是**有意**的缺口。
-- ★ 角色 id 用 19 而不是 18，**这是被咬过一次才写的**：
--   18 号在本仓已经被 `store_deputy`（副店长，063 之后某条迁移加的）占了。
--   第一次写这个文件时用的是 `INSERT ... VALUES (18,'station_chef',...) ON CONFLICT DO NOTHING`
--   —— 于是那行被**静默吃掉**，角色根本没建出来，而权限矩阵看起来一切正常，
--   只有"档口长永远看到整店"这一个症状（没有报错、没有日志）。
--   所以下面加了一个 DO 块：id 被别人占 → 当场 RAISE，绝不静默跳过。
DO $$
DECLARE v_code varchar(32);
BEGIN
  SELECT code INTO v_code FROM public.sys_role WHERE id = 19;
  IF v_code IS NOT NULL AND v_code <> 'station_chef' THEN
    RAISE EXCEPTION 'E_ROLE_ID_TAKEN: 角色 id 19 已被 % 占用，182 需要一个空号', v_code;
  END IF;
END $$;

-- 幂等按 **code** 判（code 上有唯一约束），不按 id：重跑这条迁移时
-- 角色已在 → 什么都不做；id 冲突则由上面那个 DO 块负责喊出来。
INSERT INTO sys_role (id, code, name, description)
VALUES (19, 'station_chef', '档口长（厨师长）',
        '只看自己档口的人：花名册/考勤/排班三处按档口收窄（182）')
ON CONFLICT (code) DO NOTHING;

INSERT INTO sys_role_resource (role_id, resource_code, can_read, can_write)
SELECT r.id, v.resource_code, v.can_read, v.can_write
  FROM sys_role r
 CROSS JOIN (VALUES ('employee_roster',      true, false),
                    ('attendance_daily',     true, false),
                    ('people_station_scope', true, false)
            ) AS v(resource_code, can_read, can_write)
 WHERE r.code = 'station_chef'
ON CONFLICT (role_id, resource_code) DO NOTHING;

COMMENT ON TABLE sys_role IS
  '权限角色（能碰哪类资源）。19 = station_chef 档口长：'
  '带 people_station_scope 这个**收窄型**能力位（182）。'
  '★ 开关怎么关：DELETE FROM sys_role_resource '
  'WHERE resource_code=''people_station_scope'' —— 下一个请求即回到全店口径，'
  '不需要改代码、不需要重启（能力位是每次请求现查的）。';

-- ---------------------------------------------------------------------------
-- 5. 判据登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.STS',
   '档口范围：开能力位后花名册/考勤/排班只看本档口（行数变少），'
   '认不出档口时 0 行而不是全店，关掉即回全店',
   'PERM','ACL','fn_scope_people_station','public','store_station','FUNCTION',
   'team-lead','2027-06-30','node test/station-scope.mjs','node test/station-scope.mjs')
ON CONFLICT (check_code) DO NOTHING;
