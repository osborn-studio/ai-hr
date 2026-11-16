-- Existing roles retain their previous capabilities. New demonstration roles
-- are defined explicitly in 205 and must not inherit roster-write privileges.
INSERT INTO sys_perm_resource(resource_code,label,temporal_basis) VALUES
 ('training_manage','培训考试管理','CURRENT'),('training_self','个人学习自助','CURRENT'),
 ('employment_manage','人员合同与异动管理','CURRENT'),
 ('people_self','本人基础档案','CURRENT'),('people_read_all','授权范围人员目录','CURRENT')
ON CONFLICT(resource_code) DO NOTHING;

INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)
SELECT rr.role_id,n.resource_code,rr.can_read,rr.can_write
FROM sys_role_resource rr JOIN sys_role r ON r.id=rr.role_id
CROSS JOIN (VALUES('training_manage'::varchar),('employment_manage'::varchar)) n(resource_code)
WHERE rr.resource_code='employee_roster' AND r.code NOT LIKE 'ty_demo_%'
ON CONFLICT(role_id,resource_code) DO NOTHING;

INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)
SELECT rr.role_id,'people_read_all',rr.can_read,false
FROM sys_role_resource rr JOIN sys_role r ON r.id=rr.role_id
WHERE rr.resource_code='employee_roster' AND r.code NOT LIKE 'ty_demo_%'
ON CONFLICT(role_id,resource_code) DO NOTHING;

INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)
SELECT r.id,n.resource_code,true,true FROM sys_role r
CROSS JOIN (VALUES('training_self'::varchar),('people_self'::varchar)) n(resource_code)
WHERE r.code IN ('store_staff','store_mgr')
ON CONFLICT(role_id,resource_code) DO NOTHING;

INSERT INTO sys_check_registry(check_code,name,domain,kind,guard_object,guard_schema,guard_table,guard_kind,runner,assertion_sql)
VALUES('TYHR.PERSONA','演示岗位与个人数据权限分隔','PERM','ACL','sys_role_resource_pkey','public','sys_role_resource','CONSTRAINT',
 'node test/persona-permissions.test.mjs','node test/persona-permissions.test.mjs') ON CONFLICT(check_code) DO NOTHING;

-- Authoritative row predicate for opt-in persona training reports. Historic
-- accounts retain their established scope contracts; new personas use dated
-- cost/station and employer scope in addition to resource permissions.
CREATE FUNCTION fn_ty_training_person_visible(p_user bigint,p_person bigint,p_on date)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path='' AS $$
BEGIN
 RETURN NOT EXISTS(SELECT 1 FROM public.ty_test_account_profile WHERE account_id=p_user)
 OR (p_person IN(SELECT employee_id FROM public.fn_scope_people_station(p_user,COALESCE(p_on,public.app_today())))
 AND EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person
   AND daterange(e.hire_date,e.leave_date,'[]') @> COALESCE(p_on,public.app_today())
   AND EXISTS(SELECT 1 FROM pg_temp.tmp_scope_entity s WHERE s.dim_code='payroll_legal_entity' AND s.entity_id=e.legal_entity_id)
   AND NOT EXISTS(SELECT 1 FROM pg_temp.tmp_scope_deny d WHERE d.dim_code='payroll_legal_entity' AND d.entity_id=e.legal_entity_id)));
END $$;

CREATE FUNCTION fn_ty_exam_stat_scope(p_user bigint,p_paper bigint,p_org bigint DEFAULT NULL)
RETURNS TABLE(bucket varchar,person_count int,avg_score numeric,pass_count int,pass_rate numeric)
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v_pass numeric;
BEGIN
 SELECT pass_score INTO v_pass FROM public.exam_paper WHERE id=p_paper;
 IF v_pass IS NULL THEN RAISE EXCEPTION 'E_EXAM_NO_PAPER: 试卷不存在'; END IF;
 IF p_org IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.org_unit WHERE id=p_org) THEN RAISE EXCEPTION 'E_ORG_NOT_FOUND: 组织不存在'; END IF;
 RETURN QUERY WITH best AS (
  SELECT a.employee_id,max(a.score) score FROM public.exam_attempt a
  WHERE a.paper_id=p_paper AND a.submitted_at IS NOT NULL
    AND public.fn_ty_training_person_visible(p_user,a.employee_id,(a.started_at AT TIME ZONE public.app_tz())::date)
  GROUP BY a.employee_id
 ),pop AS (
  SELECT b.*,(b.score>=v_pass) passed FROM best b WHERE p_org IS NULL OR EXISTS(
   SELECT 1 FROM public.employee_org_assignment a JOIN public.org_unit o ON o.id=a.org_id JOIN public.org_unit s ON s.id=p_org
   WHERE a.employee_id=b.employee_id AND a.dim_code IN('attendance_org','cost_org')
    AND daterange(a.valid_from,a.valid_to,'[]') @> public.app_today() AND o.path LIKE s.path||'%')
 ),band AS (
  SELECT * FROM(VALUES(0,'all'::varchar,NULL::numeric,NULL::numeric),(1,'90-100',90::numeric,NULL::numeric),
   (2,'80-89',80::numeric,90::numeric),(3,'70-79',70::numeric,80::numeric),
   (4,'60-69',60::numeric,70::numeric),(5,'<60',NULL::numeric,60::numeric))v(o,bucket,lo,hi)
 ) SELECT bd.bucket,count(pop.employee_id)::int,round(avg(pop.score),2),count(pop.employee_id) FILTER(WHERE pop.passed)::int,
  CASE WHEN count(pop.employee_id)=0 THEN NULL ELSE round((count(pop.employee_id) FILTER(WHERE pop.passed))::numeric/count(pop.employee_id),4) END
 FROM band bd LEFT JOIN pop ON(bd.lo IS NULL OR pop.score>=bd.lo) AND(bd.hi IS NULL OR pop.score<bd.hi)
 GROUP BY bd.o,bd.bucket ORDER BY bd.o;
END $$;
