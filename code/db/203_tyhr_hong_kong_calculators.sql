-- Hong Kong reference calculations on explicit, verified inputs.
-- Official sources are returned with the result. No customer records are seeded.
CREATE FUNCTION fn_ty_hk_hours_condition(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE h jsonb; w jsonb; weeks jsonb:='[]'; issues jsonb:='[]'; row_issues jsonb;
 start_d date; as_of_d date; hired date; previous_start date; employer text; first_employer text;
 hours numeric; rolling numeric; threshold numeric; meets boolean; final_met boolean; i integer:=0;
 entry jsonb; final_issues jsonb:='[]'; n integer; policy text;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'weekly_hours') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='请提供1至104个连续完整周的已核验工时';
 END IF;
 IF jsonb_array_length(p->'weekly_hours') NOT BETWEEN 1 AND 104 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='周记录数量超出范围';END IF;
 hired:=(p->>'employment_start')::date;as_of_d:=(p->>'as_of')::date;
 IF hired IS NULL OR as_of_d IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='请明确入职日与观察周末';END IF;
 FOR h IN SELECT value FROM jsonb_array_elements(p->'weekly_hours') ORDER BY value->>'week_start' LOOP
  start_d:=(h->>'week_start')::date;row_issues:='[]';meets:=NULL;
  IF start_d IS NULL OR start_d<hired OR (previous_start IS NOT NULL AND start_d<>previous_start+7)
   OR start_d+6>as_of_d THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='每周必须连续7天、处于受雇期内并以观察周末结束';END IF;
  employer:=h->>'employer_key';
  IF coalesce(btrim(employer),'')='' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='请明确同一法定雇主标识，不能用集团或门店名称替代';END IF;
  IF first_employer IS NULL THEN first_employer:=employer;END IF;
  IF employer<>first_employer THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工时窗口包含不同法定雇主，请按雇主分别核验';END IF;
  IF h->>'qualifying_hours' IS NULL OR h->>'qualifying_hours' !~ '^[0-9]+(\.[0-9]+)?$' THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='计入判定的每周工时必须明确为非负数';END IF;
  hours:=(h->>'qualifying_hours')::numeric;
  IF hours>168 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='每周计入工时不能超过168小时';END IF;
  policy:=CASE WHEN start_d+6<'2026-01-18'::date THEN 'PRE_2026_418' ELSE 'HK_2026_468' END;
  threshold:=CASE WHEN policy='PRE_2026_418' THEN 18 ELSE 17 END;
  IF h->>'verified' IS DISTINCT FROM 'true' THEN row_issues:=row_issues||jsonb_build_array('工时及依法计入的缺勤时数尚未核验');
  ELSIF start_d<'2026-01-18'::date AND start_d+6>='2026-01-18'::date THEN row_issues:=row_issues||jsonb_build_array('该周跨规则生效日，需要单独核对过渡期');
  ELSIF hours>=threshold THEN meets:=true;
  ELSIF policy='PRE_2026_418' THEN meets:=false;
  ELSIF start_d<hired+21 THEN meets:=false;
  ELSIF i<3 THEN row_issues:=row_issues||jsonb_build_array('缺少该周之前三个完整周的工时');
  ELSE
   rolling:=hours+(weeks->(i-1)->>'hours')::numeric+(weeks->(i-2)->>'hours')::numeric+(weeks->(i-3)->>'hours')::numeric;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(weeks) v WHERE (v->>'index')::integer BETWEEN i-3 AND i-1 AND v->>'verified' IS DISTINCT FROM 'true') THEN
    row_issues:=row_issues||jsonb_build_array('此前三周工时尚未全部核验');
   ELSE meets:=rolling>=68;END IF;
  END IF;
  weeks:=weeks||jsonb_build_array(jsonb_build_object('index',i,'week_start',start_d,'week_end',start_d+6,'hours',hours,
   'verified',h->'verified','policy',policy,'weekly_threshold',threshold,'rolling_four_week_hours',rolling,'meets_hours',meets,'issues',row_issues));
  i:=i+1;previous_start:=start_d;rolling:=NULL;
 END LOOP;
 n:=jsonb_array_length(weeks);
 IF previous_start+6<>as_of_d THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='观察日期须等于最后一周的结束日';END IF;
 IF p->>'continuous_service_verified' IS DISTINCT FROM 'true' THEN final_issues:=final_issues||jsonb_build_array('同一雇主持续受雇情况尚未核验');END IF;
 IF n<4 OR as_of_d-hired+1<28 THEN final_met:=false;final_issues:=final_issues||jsonb_build_array('尚不足四周持续受雇及完整工时记录');
 ELSE
  final_met:=true;
  FOR entry IN SELECT value FROM jsonb_array_elements(weeks) WHERE (value->>'index')::integer>=n-4 LOOP
   IF entry->>'meets_hours'='false' THEN final_met:=false;
   ELSIF entry->>'meets_hours' IS NULL AND final_met IS TRUE THEN final_met:=NULL;END IF;
   final_issues:=final_issues||COALESCE(entry->'issues','[]');
  END LOOP;
 END IF;
 IF p->>'continuous_service_verified' IS DISTINCT FROM 'true' THEN final_met:=NULL;END IF;
 RETURN jsonb_build_object('ready',jsonb_array_length(final_issues)=0,'weeks',weeks,'hours_condition_met',final_met,
  'current_week_meets',(weeks->(n-1))->'meets_hours','issues',final_issues,'employer_key',first_employer,
  'basis','仅核验所提供的同一雇主持续受雇及工时条件；各假种资格另行判断',
  'source_url','https://www.labour.gov.hk/eng/labour/Continuous_Contract_EduTool.htm');
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='日期格式无效，请使用有效的YYYY-MM-DD';
END; $$;

CREATE FUNCTION fn_ty_hk_average_daily_wage(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE entitlement date; hired date; stop_d date; from_d date; m date; service_from date; days numeric;
 row_data jsonb; found_count integer; total_wages numeric:=0; total_days numeric:=0; wages numeric; excluded_wages numeric; excluded_days numeric;
 issues jsonb:='[]'; details jsonb:='[]'; avg_daily numeric; paid_days numeric; benefit numeric; rate numeric; kind text; ready boolean;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'history') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='请提供最多36个月工资及不计入期间的明细';END IF;
 IF jsonb_array_length(p->'history')>36 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资历史超过36个月';END IF;
 entitlement:=(p->>'entitlement_date')::date;hired:=(p->>'hire_date')::date;
 IF entitlement IS NULL OR hired IS NULL OR hired>entitlement THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='请明确有效入职日与权益指定日期';END IF;
 stop_d:=date_trunc('month',entitlement)::date;from_d:=greatest((stop_d-interval '12 months')::date,hired);
 IF from_d>=stop_d THEN issues:=issues||jsonb_build_array('尚无指定日之前已完成历月的工资记录');END IF;
 FOR row_data IN SELECT * FROM jsonb_array_elements(p->'history') LOOP
  IF row_data->>'period' IS NULL OR row_data->>'period' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资月份须为YYYY-MM';END IF;
 END LOOP;
 m:=date_trunc('month',from_d)::date;
 WHILE m<stop_d LOOP
  SELECT count(*),jsonb_agg(v)->0 INTO found_count,row_data FROM jsonb_array_elements(p->'history') v WHERE v->>'period'=to_char(m,'YYYY-MM');
  IF found_count<>1 THEN issues:=issues||jsonb_build_array(to_char(m,'YYYY-MM')||CASE WHEN found_count=0 THEN '缺少工资记录' ELSE '工资记录重复' END);m:=(m+interval '1 month')::date;CONTINUE;END IF;
  IF row_data->>'verified' IS DISTINCT FROM 'true' THEN issues:=issues||jsonb_build_array(to_char(m,'YYYY-MM')||'工资及不计入期间尚未核验');END IF;
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['wages','excluded_days','excluded_wages']) k WHERE row_data->>k IS NULL OR row_data->>k !~ '^[0-9]+(\.[0-9]+)?$') THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资、不计入天数及相应金额须明确填写；无则填写0';END IF;
  wages:=(row_data->>'wages')::numeric;excluded_days:=(row_data->>'excluded_days')::numeric;excluded_wages:=(row_data->>'excluded_wages')::numeric;
  service_from:=greatest(m,from_d);days:=((m+interval '1 month')::date-service_from);
  IF excluded_days>days OR excluded_wages>wages THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='不计入天数/工资不能超过该月受雇天数/工资';END IF;
  total_wages:=total_wages+wages-excluded_wages;total_days:=total_days+days-excluded_days;
  details:=details||jsonb_build_array(jsonb_build_object('period',to_char(m,'YYYY-MM'),'service_days',days,'wages',wages,'excluded_days',excluded_days,
   'excluded_wages',excluded_wages,'eligible_days',days-excluded_days,'eligible_wages',wages-excluded_wages));
  m:=(m+interval '1 month')::date;
 END LOOP;
 IF total_days<=0 THEN issues:=issues||jsonb_build_array('可计入天数为0，不能计算平均日薪');END IF;
 ready:=jsonb_array_length(issues)=0;
 IF ready THEN avg_daily:=total_wages/total_days;END IF;
 kind:=p->>'benefit_type';rate:=CASE WHEN kind IN ('statutory_holiday','annual_leave') THEN 1 WHEN kind='sickness' THEN 0.8 ELSE NULL END;
 IF p->>'paid_days' IS NOT NULL AND p->>'paid_days' ~ '^[0-9]+(\.[0-9]+)?$' THEN paid_days:=(p->>'paid_days')::numeric;END IF;
 IF ready AND p->>'eligibility_verified'='true' AND paid_days IS NOT NULL AND rate IS NOT NULL THEN benefit:=round(total_wages/total_days*paid_days*rate,2);END IF;
 RETURN jsonb_build_object('ready',ready,'issues',issues,'window_from',from_d,'window_to_exclusive',stop_d,'months',details,
  'eligible_wages',total_wages,'eligible_days',total_days,'average_daily_wage',CASE WHEN avg_daily IS NOT NULL THEN round(avg_daily,8) ELSE NULL END,
  'benefit_type',kind,'paid_days',paid_days,'payment_rate',rate,'benefit_amount',benefit,'benefit_ready',benefit IS NOT NULL,
  'benefit_issue',CASE WHEN p->>'eligibility_verified' IS DISTINCT FROM 'true' THEN '请先核验该假种资格及有薪天数' WHEN rate IS NULL THEN '请选择法定假日、年假或疾病津贴' WHEN paid_days IS NULL THEN '请明确有薪天数' ELSE NULL END,
  'basis','前12个完整历月；受雇不足12个月取较短期间；不计入期间与相应工资同时排除；工资使用扣MPF前口径',
  'source_url','https://www.labour.gov.hk/eng/labour/avgMonthSalaryCalculator.htm',
  'sickness_source_url','https://www.labour.gov.hk/eng/faq/cap57g_whole.htm');
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='日期格式无效，请使用有效的YYYY-MM-DD';
END; $$;

DO $$ BEGIN IF to_regclass('public.sys_check_registry') IS NOT NULL THEN
 INSERT INTO public.sys_check_registry(check_code,name,domain,kind,guard_object,guard_schema,guard_table,guard_kind,runner,assertion_sql)
 VALUES('TYHR.HK-CALC','香港连续工时与平均日薪：历月、排除及资格分离','PAYROLL','ALGORITHM','fn_ty_hk_average_daily_wage','public',NULL,'FUNCTION',
 'node test/hk-tools.test.mjs','node test/hk-tools.test.mjs') ON CONFLICT(check_code) DO NOTHING;
END IF; END; $$;
