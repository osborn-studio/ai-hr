-- Forward-only payroll identity and semantic integrity.217/219/220 are unchanged.
-- Directory comparison groups are not evidence that two payable facts are the same.
CREATE FUNCTION fn_ty_pay_income_scope(d jsonb)RETURNS void LANGUAGE plpgsql STABLE SET search_path=''AS $$
DECLARE k text;v jsonb;i public.ty_pay_item_catalog%ROWTYPE;
BEGIN
 IF d->>'type'NOT IN('CN_IIT','CN_SOCIAL','HK_MPF_REGULAR')OR jsonb_typeof(d->'scope_by_item')IS DISTINCT FROM 'object'THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪税收入范围须为明确适配模板与逐项映射';END IF;
 FOR k,v IN SELECT*FROM jsonb_each(d->'scope_by_item')LOOP
  SELECT*INTO i FROM public.ty_pay_item_catalog WHERE code=k;
  IF i.code IS NULL OR v NOT IN('"include"'::jsonb,'"exclude"'::jsonb)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪税范围须逐目录项目明确计入或排除';END IF;
  IF v='"include"'::jsonb AND((i.category NOT IN('cash_earnings','reimbursement','noncash_shadow')AND coalesce(i.metadata->>'employee_cash_wage_effect','none')<>'decrease_gross')OR d->>'type'='HK_MPF_REGULAR'AND i.category='noncash_shadow')THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='代扣、雇主成本、统计基数、资金或采购不能自反计入薪税收入，非现金须适配专门口径';END IF;
 END LOOP;
END;$$;

CREATE FUNCTION fn_ty_pay_component_key(g bigint,co bigint,em bigint,pe bigint,rel text,period_key date,item text,purpose_key text)RETURNS text LANGUAGE plpgsql STABLE SET search_path=''AS $$
DECLARE keys text[];legacy_key text;components integer;catalog public.ty_pay_item_catalog%ROWTYPE;
BEGIN
 SELECT*INTO catalog FROM public.ty_pay_item_catalog WHERE code=item;
 IF catalog.code IS NULL OR NOT EXISTS(SELECT 1 FROM public.ty_employment e WHERE e.id=em AND e.group_id=g AND e.company_id=co AND e.person_id=pe)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资组件须引用真实人员雇佣与目录项目';END IF;
 -- Only actual prior item lineage is a legitimate alias. A generic catalogue
 -- comparison group never supplies identity for a new employee-month component.
 SELECT array_agg(DISTINCT ob.economic_key)INTO keys FROM public.ty_pay_obligation ob JOIN public.ty_pay_adoption a ON a.obligation_id=ob.id JOIN public.ty_pay_item i ON i.adoption_id=a.id JOIN public.ty_pay_row r ON r.id=i.row_id JOIN public.ty_pay_config rc ON rc.id=r.relationship_config_id JOIN public.ty_pay_batch b ON b.id=r.batch_id
 WHERE ob.group_id=g AND ob.company_id=co AND ob.employment_id=em AND ob.person_id=pe AND ob.purpose=purpose_key AND b.period=period_key AND a.source_domain='payroll_calculation'AND a.state IN('reserved','confirmed')AND i.code=item AND rc.data->>'actual_relationship_key'=rel;
 IF coalesce(array_length(keys,1),0)>1 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='同一组件已有多个历史经济根，须有据核对，不自动拆款或再付';END IF;
 IF array_length(keys,1)=1 THEN
  legacy_key:=keys[1];
  SELECT count(DISTINCT i.code)INTO components FROM public.ty_pay_obligation ob JOIN public.ty_pay_adoption a ON a.obligation_id=ob.id JOIN public.ty_pay_item i ON i.adoption_id=a.id WHERE ob.group_id=g AND ob.economic_key=legacy_key AND ob.purpose=purpose_key AND a.source_domain='payroll_calculation'AND a.state IN('reserved','confirmed');
  IF components>1 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='旧经济根曾混合不同薪项，须人工有据分配历史，不自动认作同一义务';END IF;
  RETURN legacy_key;
 END IF;
 RETURN 'payroll:'||rel||':'||to_char(period_key,'YYYY-MM-DD')||':'||CASE WHEN catalog.metadata->>'exclusion_group'='base_pay_basis_per_segment'THEN 'base_pay_basis_per_segment'ELSE item END;
END;$$;

CREATE FUNCTION fn_ty_pay_semantic_config_guard()RETURNS trigger LANGUAGE plpgsql SET search_path=''AS $$
DECLARE previous_record record;r jsonb;groups text[]:='{}';component text;
BEGIN
 PERFORM id FROM public.ty_group WHERE id=NEW.group_id FOR UPDATE;
 IF TG_OP='UPDATE'AND ROW(NEW.group_id,NEW.company_id,NEW.person_id,NEW.employment_id,NEW.kind,NEW.stable_key,NEW.system)IS DISTINCT FROM ROW(OLD.group_id,OLD.company_id,OLD.person_id,OLD.employment_id,OLD.kind,OLD.stable_key,OLD.system)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='配置版本身份和主体不可修改，须沿原根修订或核定新根';END IF;
 IF TG_TABLE_NAME='ty_pay_stat_config'THEN
  SELECT c.*INTO previous_record FROM public.ty_pay_stat_config c WHERE c.group_id=NEW.group_id AND c.kind=NEW.kind AND c.stable_key=NEW.stable_key AND c.id<>NEW.id ORDER BY c.revision DESC LIMIT 1;
 ELSE
  SELECT c.*INTO previous_record FROM public.ty_pay_config c WHERE c.company_id=NEW.company_id AND c.kind=NEW.kind AND c.stable_key=NEW.stable_key AND c.id<>NEW.id ORDER BY c.revision DESC LIMIT 1;
 END IF;
 IF previous_record.id IS NOT NULL AND ROW(NEW.group_id,NEW.company_id,NEW.person_id,NEW.employment_id,NEW.system)IS DISTINCT FROM ROW(previous_record.group_id,previous_record.company_id,previous_record.person_id,previous_record.employment_id,previous_record.system)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='同一配置版本根不可换人、换公司、换雇佣或换体系';END IF;
 IF TG_TABLE_NAME='ty_pay_stat_config'AND NEW.kind='policy'THEN PERFORM public.fn_ty_pay_income_scope(NEW.data);END IF;
 IF TG_TABLE_NAME='ty_pay_config'AND NEW.kind='rulebook'THEN
  FOR r IN SELECT value FROM jsonb_array_elements(NEW.data->'rules')LOOP
   IF NEW.data->>'native_statutory'='true'AND r->>'code'=ANY(ARRAY['CN_IIT_WITHHOLD','CN_EMP_PENSION','CN_ER_PENSION','CN_EMP_MEDICAL','CN_ER_MEDICAL','CN_EMP_UNEMPLOYMENT','CN_ER_UNEMPLOYMENT','CN_ER_WORK_INJURY','CN_ER_MATERNITY','CN_EMP_HOUSING_FUND','CN_ER_HOUSING_FUND','HK_EMP_MPF_MANDATORY','HK_ER_MPF_MANDATORY'])THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='原生税供款不能同时由工资公式重复输出';END IF;
   SELECT metadata->>'exclusion_group'INTO component FROM public.ty_pay_item_catalog WHERE code=r->>'code';
   IF component='base_pay_basis_per_segment'THEN IF component=ANY(groups)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='同一基本计薪范围的替代基准须明确选择';END IF;groups:=array_append(groups,component);END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER ty_pay_semantic_config_guard BEFORE INSERT OR UPDATE ON ty_pay_config FOR EACH ROW EXECUTE FUNCTION fn_ty_pay_semantic_config_guard();
CREATE TRIGGER ty_pay_stat_semantic_config_guard BEFORE INSERT OR UPDATE ON ty_pay_stat_config FOR EACH ROW EXECUTE FUNCTION fn_ty_pay_semantic_config_guard();

-- Preserve220 native and legacy performance reverse-provenance branches.
CREATE OR REPLACE FUNCTION fn_ty_pay_reverse_provenance()RETURNS trigger LANGUAGE plpgsql SET search_path=''AS $$
DECLARE x record;s record;k text;item_code text;rc public.ty_pay_config%ROWTYPE;
BEGIN
 IF NEW.status<>'confirmed'OR OLD.status='confirmed'THEN RETURN NEW;END IF;
 FOR x IN SELECT a.*,i.code,i.cash_wage_effect,i.cost_atom,r.person_id,r.employment_id,r.relationship_config_id,o.economic_key,o.purpose FROM public.ty_pay_adoption a JOIN public.ty_pay_item i ON i.adoption_id=a.id JOIN public.ty_pay_row r ON r.id=i.row_id JOIN public.ty_pay_obligation o ON o.id=a.obligation_id WHERE a.batch_id=NEW.id LOOP
  SELECT * INTO rc FROM public.ty_pay_config WHERE id=x.relationship_config_id;
  IF x.employment_id IS NOT NULL AND(rc.id IS NULL OR rc.kind<>'relationship'OR rc.status<>'approved'OR rc.person_id<>x.person_id OR rc.employment_id<>x.employment_id OR rc.group_id<>NEW.group_id OR rc.company_id<>NEW.company_id OR rc.system<>NEW.system OR rc.data->>'pay_subject_key'IS DISTINCT FROM NEW.pay_subject_key OR rc.data->>'tax_subject_key'IS DISTINCT FROM NEW.tax_subject_key OR rc.data->>'contribution_subject_key'IS DISTINCT FROM NEW.contribution_subject_key)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资实际关系与发薪/税务/供款主体必须反向一致';END IF;
  IF x.source_domain='payroll_calculation'THEN
   SELECT * INTO s FROM public.ty_pay_config WHERE id=(x.source_snapshot->>'profile_id')::bigint;
   IF s.group_id<>NEW.group_id OR s.company_id<>NEW.company_id OR s.person_id<>x.person_id OR s.employment_id<>x.employment_id THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资档案来源不能借用其他主体或人员';END IF;
   k:=public.fn_ty_pay_component_key(NEW.group_id,NEW.company_id,x.employment_id,x.person_id,rc.data->>'actual_relationship_key',NEW.period,x.code,x.purpose);
  ELSIF x.source_domain='leave_cash'THEN
   SELECT o.*,r.id rel_id,r.group_id,r.person_id INTO s FROM public.ty_leave_lifecycle_cash_obligation o JOIN public.ty_leave_account a ON a.id=o.account_id JOIN public.ty_leave_relationship r ON r.id=a.relationship_id WHERE o.id=x.source_id::bigint;
   IF s.group_id<>NEW.group_id OR s.person_id<>x.person_id OR NOT EXISTS(SELECT 1 FROM public.ty_leave_relationship_employment WHERE relationship_id=s.rel_id AND employment_id=x.employment_id)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='假期现金来源须属于同集团同人真实关系';END IF;k:='leave:'||s.rel_id||':'||s.root_key;
  ELSIF x.source_domain='people_candidate'THEN
   SELECT * INTO s FROM public.ty_ps_candidate WHERE id=x.source_id::bigint;
   IF s.group_id<>NEW.group_id OR s.company_id<>NEW.company_id OR s.person_id IS DISTINCT FROM x.person_id OR s.employment_id IS DISTINCT FROM x.employment_id THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='配套来源不可搬人搬主体';END IF;
   k:='people:'||s.module||':'||s.parent_key||':'||s.kind;
   IF s.kind='employee_charge'THEN
    IF s.source_ref IS DISTINCT FROM 'dorm_charge:'||(x.source_snapshot->>'charge_id')OR NOT EXISTS(SELECT 1 FROM public.ty_dorm_charge c WHERE c.id=(x.source_snapshot->>'charge_id')::bigint AND c.person_id=x.person_id AND c.employment_id=x.employment_id AND c.group_id=NEW.group_id)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='费用采用须反查同一真实个人费用';END IF;
   ELSIF s.kind='noncash_benefit'THEN k:='people:noncash:'||s.employment_id||':'||to_char(NEW.period,'YYYY-MM-DD')||':'||x.code;
   ELSIF s.kind='company_cost'AND s.cost_basis='allocation'THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='已含成本分摊只能保留引用，不得伪造新增应付或成本';END IF;
  ELSIF x.source_domain='performance_result'THEN
   IF EXISTS(SELECT 1 FROM public.ty_perf_result hist_pr WHERE hist_pr.id=x.source_id::bigint AND public.fn_ty_pr_legacy_replaced(hist_pr.cycle_id,hist_pr.employment_id))THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='旧绩效来源已显式桥接并由原生核准版接管';END IF;
   SELECT r.*,c.group_id,c.start_date,c.end_date INTO s FROM public.ty_perf_result r JOIN public.ty_perf_cycle c ON c.id=r.cycle_id WHERE r.id=x.source_id::bigint;
   IF s.group_id<>NEW.group_id OR s.person_id<>x.person_id OR s.employment_id<>x.employment_id OR s.company_id<>NEW.company_id THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='绩效采用必须反查同一永久人员及真实雇佣';END IF;
   k:='performance:'||(rc.data->>'actual_relationship_key')||':'||to_char(s.start_date,'YYYY-MM-DD')||':'||to_char(s.end_date,'YYYY-MM-DD')||':'||to_char(s.period,'YYYY-MM-DD');
  ELSIF x.source_domain IN('statutory_calculation','performance_award')THEN k:=public.fn_ty_pay_extension_key(NEW.id,x.id);
  ELSE RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='来源反向适配尚未实现';END IF;
  IF k IS NULL OR x.economic_key IS DISTINCT FROM k THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资经济根必须由权威来源反查，不能用规则或路径别名新造义务';END IF;
 END LOOP;RETURN NEW;END;$$;

-- Final statutory reconstruction rechecks even policy versions created before221.
CREATE OR REPLACE FUNCTION fn_ty_pay_stat_context(p_batch bigint,p_employment bigint,p_enrollment bigint,p_lines jsonb)RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE b public.ty_pay_batch%ROWTYPE;e public.ty_employment%ROWTYPE;n public.ty_pay_stat_config%ROWTYPE;p public.ty_pay_stat_config%ROWTYPE;o public.ty_pay_stat_config%ROWTYPE;bp public.ty_pay_stat_config%ROWTYPE;rel public.ty_pay_config%ROWTYPE;
 x record;j jsonb;policy jsonb;vals jsonb:='[]'::jsonb;seen text[]:='{}';periods text[]:='{}';income numeric:=0;deductible numeric:=0;basic numeric:=0;special numeric:=0;other numeric:=0;v numeric;scope text;on_period date;cutoff date;subject text;typ text;pp jsonb;
BEGIN
 SELECT * INTO b FROM public.ty_pay_batch WHERE id=p_batch;SELECT * INTO e FROM public.ty_employment WHERE id=p_employment;SELECT * INTO n FROM public.ty_pay_stat_config WHERE id=p_enrollment;
 IF b.id IS NULL OR e.group_id<>b.group_id OR e.company_id<>b.company_id OR n.kind<>'enrollment'OR n.status<>'approved'OR n.group_id<>b.group_id OR n.person_id<>e.person_id OR n.system<>b.system THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪税资格须属于本集团永久人员及本体系真实雇佣';END IF;
 SELECT * INTO p FROM public.ty_pay_stat_config WHERE id=(n.data->>'policy_id')::bigint;SELECT * INTO o FROM public.ty_pay_stat_config WHERE id=(n.data->>'opening_id')::bigint;
 IF p.kind<>'policy'OR p.status<>'approved'OR p.group_id<>b.group_id OR p.system<>b.system OR o.kind<>'opening'OR o.status<>'approved'OR o.person_id<>e.person_id OR o.group_id<>b.group_id OR o.system<>b.system THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪税政策或期初未独立核准/不属于同一永久人员';END IF;
 SELECT * INTO bp FROM public.ty_pay_stat_config WHERE kind='batch_period'AND status='approved'AND(data->>'batch_id')::bigint=b.id ORDER BY revision DESC,id DESC LIMIT 1;
 IF bp.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资归属月、预计支付日、税款月和供款月须分别核定';END IF;
 typ:=p.data->>'type';on_period:=CASE WHEN typ='CN_IIT'THEN(bp.data->>'tax_period')::date ELSE(bp.data->>'contribution_period')::date END;cutoff:=(o.data->>'cutoff_period')::date;
 subject:=CASE WHEN typ='CN_IIT'THEN b.tax_subject_key ELSE b.contribution_subject_key END;
 IF n.data->>'subject_key' IS DISTINCT FROM subject OR o.data->>'subject_key' IS DISTINCT FROM subject OR n.valid_from>on_period OR n.valid_to<=on_period OR p.valid_from>on_period OR p.valid_to<=on_period OR o.valid_from>on_period OR o.valid_to<=on_period OR on_period<cutoff OR typ<>'CN_IIT'AND on_period<>cutoff OR typ='CN_IIT'AND extract(year FROM cutoff)<>extract(year FROM on_period)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪税主体、期初截止或适用有效期不符';END IF;
 SELECT * INTO rel FROM public.ty_pay_config WHERE id=(SELECT relationship_config_id FROM public.ty_pay_row WHERE batch_id=b.id AND employment_id=e.id LIMIT 1);
 IF rel.id IS NULL THEN SELECT * INTO rel FROM public.ty_pay_config WHERE kind='relationship'AND status='approved'AND employment_id=e.id AND system=b.system AND valid_from<=b.period AND(valid_to IS NULL OR valid_to>=b.period+interval '1 month')ORDER BY revision DESC,id DESC LIMIT 1;END IF;
 IF rel.data->>'actual_employer_key' IS DISTINCT FROM n.data->>'actual_employer_key' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪税资格不能借用另一实际法律雇主';END IF;
 IF EXISTS(SELECT 1 FROM public.ty_pay_stat_config newer WHERE newer.group_id=n.group_id AND newer.kind=n.kind AND newer.stable_key=n.stable_key AND newer.company_id=n.company_id AND newer.person_id IS NOT DISTINCT FROM n.person_id AND newer.employment_id IS NOT DISTINCT FROM n.employment_id AND newer.system=n.system AND newer.status='approved'AND newer.revision>n.revision AND newer.valid_from<=on_period AND(newer.valid_to IS NULL OR newer.valid_to>on_period))THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪税资格已有新生效版本';END IF;
 IF EXISTS(SELECT 1 FROM public.ty_pay_stat_config newer WHERE newer.group_id=p.group_id AND newer.kind=p.kind AND newer.stable_key=p.stable_key AND newer.company_id=p.company_id AND newer.person_id IS NOT DISTINCT FROM p.person_id AND newer.employment_id IS NOT DISTINCT FROM p.employment_id AND newer.system=p.system AND newer.status='approved'AND newer.revision>p.revision AND newer.valid_from<=on_period AND(newer.valid_to IS NULL OR newer.valid_to>on_period))THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='政策已有新生效版本，须重核人员参保纳税映射';END IF;
 policy:=p.data;PERFORM public.fn_ty_pay_income_scope(policy);pp:=n.data->'periods'->to_char(on_period,'YYYY-MM');IF pp IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='本税款/供款期间人员参数未知，不能按零计算';END IF;
 -- Cash/tax/contribution recognition is by confirmed delta tranche and assigned
 -- period; earned-period ultimate targets remain separate for ADW.
 FOR j IN SELECT value FROM jsonb_array_elements(p_lines)WHERE(value->'scope'->>'person_id')::bigint=e.person_id AND EXISTS(SELECT 1 FROM public.ty_pay_config rc WHERE rc.id=coalesce((value->>'relationship_config_id')::bigint,(value->'source_snapshot'->>'relationship_config_id')::bigint)AND rc.kind='relationship'AND rc.status='approved'AND rc.employment_id=(value->'scope'->>'employment_id')::bigint AND rc.data->>'actual_employer_key'=n.data->>'actual_employer_key')LOOP
  SELECT(j->>'target')::numeric-coalesce(sum(a.delta),0)INTO v FROM public.ty_pay_adoption a JOIN public.ty_pay_obligation ob ON ob.id=a.obligation_id WHERE ob.group_id=b.group_id AND ob.economic_key=j->>'economic_key'AND a.state='confirmed'AND a.batch_id<>b.id;
  vals:=vals||jsonb_build_array(j||jsonb_build_object('stat_period',on_period,'target',v::text));
 END LOOP;
 FOR x IN SELECT a.id source_adoption_id,a.delta target,i.code,i.category,i.cash_wage_effect,i.wage_tags,ob.economic_key,oldb.id batch_id,oldb.period wage_period,oldb.tax_subject_key,oldb.contribution_subject_key,
   oldp.data period_data FROM public.ty_pay_adoption a JOIN public.ty_pay_obligation ob ON ob.id=a.obligation_id JOIN public.ty_pay_item i ON i.adoption_id=a.id JOIN public.ty_pay_row pr ON pr.id=i.row_id JOIN public.ty_pay_config rc ON rc.id=pr.relationship_config_id JOIN public.ty_pay_batch oldb ON oldb.id=a.batch_id
   LEFT JOIN LATERAL(SELECT data FROM public.ty_pay_stat_config WHERE kind='batch_period'AND status='approved'AND(data->>'batch_id')::bigint=oldb.id ORDER BY revision DESC,id DESC LIMIT 1)oldp ON true
   WHERE ob.group_id=b.group_id AND ob.person_id=e.person_id AND oldb.system=b.system AND oldb.status='confirmed'AND a.state='confirmed'AND oldb.id<>b.id 
   AND(CASE WHEN typ='CN_IIT'THEN oldb.tax_subject_key ELSE oldb.contribution_subject_key END)=subject
   AND rc.data->>'actual_employer_key'=n.data->>'actual_employer_key'
   ORDER BY a.id LOOP
  IF x.period_data IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='同一主体已有工资尚未核对支付/税供款期间，不得忽略或重复算期初';END IF;
  v:=NULL;IF typ='CN_IIT'THEN scope:=x.period_data->>'tax_period';ELSE scope:=x.period_data->>'contribution_period';END IF;
  IF scope::date<cutoff OR scope::date>on_period OR typ<>'CN_IIT'AND scope::date<>on_period THEN CONTINUE;END IF;
  vals:=vals||jsonb_build_array(jsonb_build_object('code',x.code,'target',x.target,'category',x.category,'cash_wage_effect',x.cash_wage_effect,'stat_period',scope,'economic_key',x.economic_key,'source_adoption_id',x.source_adoption_id));
 END LOOP;
 FOR j IN SELECT value FROM jsonb_array_elements(vals)LOOP
  scope:=policy->'scope_by_item'->>(j->>'code');
  IF scope IS NULL AND(j->>'category'='cash_earnings'OR j->>'cash_wage_effect'='decrease_gross')THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪税项目计入/排除范围未核定，不能把全部现金项目泛化或默认为零';END IF;
  IF scope='include'THEN v:=(j->>'target')::numeric;IF j->>'cash_wage_effect'='decrease_gross'THEN v:=-v;END IF;income:=income+v;END IF;
  IF typ='CN_IIT'AND policy->'deductible_codes' ? (j->>'code')THEN deductible:=deductible+(j->>'target')::numeric;END IF;
  IF NOT(j->>'stat_period'=ANY(periods))THEN periods:=array_append(periods,j->>'stat_period');END IF;
 END LOOP;
 IF NOT(to_char(on_period,'YYYY-MM-DD')=ANY(periods))THEN periods:=array_append(periods,to_char(on_period,'YYYY-MM-DD'));END IF;
 IF typ='CN_IIT'THEN
  IF n.data->>'cumulative_start_period'IS NULL OR(n.data->>'cumulative_start_period')::date<cutoff OR(n.data->>'cumulative_start_period')::date>on_period THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='累计费用资格起始月须明确核定，未知月份不能按零';END IF;
  SELECT array_agg(to_char(d,'YYYY-MM-DD')ORDER BY d)INTO periods FROM generate_series((n.data->>'cumulative_start_period')::date,on_period,interval '1 month')d;
  FOREACH scope IN ARRAY periods LOOP
  j:=n.data->'periods'->to_char(scope::date,'YYYY-MM');IF j IS NULL OR j->>'basic'IS NULL OR j->>'special'IS NULL OR j->>'other'IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='累计月份的基本费用/专项扣除参数缺失，不能反复按当月全额或补零';END IF;
  basic:=basic+(j->>'basic')::numeric;special:=special+(j->>'special')::numeric;other:=other+(j->>'other')::numeric;
 END LOOP;END IF;
 IF income<0 OR deductible<0 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪税累计收入/扣除不能为负';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('economic_key',entry.value->>'economic_key','source_adoption_id',entry.value->>'source_adoption_id','code',entry.value->>'code','target',round((entry.value->>'target')::numeric,2)::text,'category',entry.value->>'category','cash_wage_effect',entry.value->>'cash_wage_effect','stat_period',entry.value->>'stat_period')ORDER BY entry.value->>'code',entry.value->>'economic_key',entry.value->>'stat_period',entry.value->>'source_adoption_id'),'[]'::jsonb)INTO vals FROM jsonb_array_elements(vals)entry;
 RETURN jsonb_build_object('type',typ,'policy',to_jsonb(p),'enrollment',to_jsonb(n),'opening',to_jsonb(o),'batch_period',to_jsonb(bp),'employment_id',e.id,'person_id',e.person_id,'group_id',b.group_id,'subject_key',subject,'legal_employer_key',n.data->>'actual_employer_key','period',on_period,'plan_key',n.data->>'plan_key','native_income',income::text,'native_deductible',deductible::text,'native_basic',basic::text,'native_special',special::text,'native_other',other::text,'period_parameters',pp,'wage_basis',vals);
END;$$;
