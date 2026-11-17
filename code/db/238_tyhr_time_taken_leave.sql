--238: immutable taken-leave evidence for NEW attendance versions. No historical rewrite.
CREATE TABLE ty_time_leave_pre238_report(report_id bigint PRIMARY KEY REFERENCES ty_time_report_version(id));
INSERT INTO ty_time_leave_pre238_report SELECT id FROM ty_time_report_version;
CREATE TRIGGER ty_time_leave_pre238_keep BEFORE INSERT OR UPDATE OR DELETE ON ty_time_leave_pre238_report FOR EACH ROW EXECUTE FUNCTION fn_ty_time216_keep();

CREATE FUNCTION fn_ty_time_leave_manifest(eid bigint,month_key date)RETURNS jsonb LANGUAGE sql VOLATILE SET search_path='' AS $$
 SELECT jsonb_build_object('version',238,'employment',jsonb_build_object('id',e.id,'group_id',e.group_id,'person_id',e.person_id,'company_id',e.company_id,'cancelled',e.status='cancelled','valid_from',greatest(e.hire_date,month_key),'valid_to',least(coalesce(e.leave_date+1,(month_key+interval'1 month')::date),(month_key+interval'1 month')::date)),'period',month_key,
 'requests',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'account_id',r.account_id,'employment_id',r.employment_id,'scheme_id',r.scheme_id,'status',r.status,'starts_at',r.starts_at,'ends_at',r.ends_at,'quantity',r.quantity,'facts',r.facts,
 'scheme',jsonb_build_object('status',s.status,'version',s.version,'statutory',s.statutory,'code',s.code,'jurisdiction',s.jurisdiction,'rules',s.rules),'fact_heads',coalesce((SELECT jsonb_agg(jsonb_build_object('parent_id',p.id,'period',p.period,'head_revision',p.head_revision,'current_approved_id',p.current_approved_id,'fact',to_jsonb(f),'policy',to_jsonb(pol),'current',CASE WHEN f.id IS NOT NULL THEN public.fn_ty_lp_current(f.id)ELSE false END)ORDER BY p.period,p.id)FROM public.ty_lp_parent p LEFT JOIN public.ty_lp_fact f ON f.id=p.current_approved_id LEFT JOIN public.ty_lp_policy pol ON pol.id=f.policy_id WHERE p.request_id=r.id AND(p.period=month_key OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(r.facts->'roster_source'->'days','[]'))d WHERE(d->>'work_date')::date>=month_key AND(d->>'work_date')::date<(month_key+interval'1 month')::date AND public.fn_ty_leave_roster_minutes(public.fn_ty_leave_roster_exclude(d->'intervals',ARRAY(SELECT jsonb_array_elements_text(r.facts->'roster_calendar_excluded_dates')::date)),greatest(r.starts_at,p.period::timestamp AT TIME ZONE'Asia/Shanghai'),least(r.ends_at,(p.period+interval'1 month')AT TIME ZONE'Asia/Shanghai'))>0))),'[]'::jsonb))ORDER BY r.id)
 FROM public.ty_leave_request r JOIN public.ty_leave_scheme s ON s.id=r.scheme_id WHERE r.employment_id=e.id AND r.status='taken' AND r.starts_at<((month_key+interval'1 month 2 days')AT TIME ZONE'Asia/Shanghai')AND r.ends_at>((month_key-2)::timestamp AT TIME ZONE'Asia/Shanghai')AND(CASE WHEN(r.facts->'roster_source'->>'version')::integer=237 THEN EXISTS(SELECT 1 FROM jsonb_array_elements(r.facts->'roster_source'->'days')d WHERE(d->>'work_date')::date>=month_key AND(d->>'work_date')::date<(month_key+interval'1 month')::date AND public.fn_ty_leave_roster_minutes(public.fn_ty_leave_roster_exclude(d->'intervals',ARRAY(SELECT jsonb_array_elements_text(r.facts->'roster_calendar_excluded_dates')::date)),r.starts_at,r.ends_at)>0)ELSE r.starts_at<((month_key+interval'1 month')AT TIME ZONE'Asia/Shanghai')AND r.ends_at>(month_key::timestamp AT TIME ZONE'Asia/Shanghai')END)),'[]'::jsonb))
 FROM public.ty_employment e WHERE e.id=eid;
$$;
CREATE TABLE ty_time_leave_report_source(
 report_id bigint NOT NULL REFERENCES ty_time_report_version(id),employment_id bigint NOT NULL REFERENCES ty_employment(id),
 group_id bigint NOT NULL REFERENCES ty_group(id),person_id bigint NOT NULL REFERENCES ty_person(id),company_id bigint NOT NULL REFERENCES ty_company(id),period date NOT NULL,
 mode text NOT NULL CHECK(mode IN('automatic','inherited','manual')),source_report_id bigint REFERENCES ty_time_report_version(id),manual_basis jsonb NOT NULL DEFAULT'{}',
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),geometry jsonb NOT NULL,source_hash text NOT NULL CHECK(length(source_hash)=64),
 PRIMARY KEY(report_id,employment_id));
CREATE TABLE ty_time_leave_report_line(
 report_id bigint NOT NULL REFERENCES ty_time_report_version(id),line_id bigint NOT NULL REFERENCES ty_time_report_line(id),request_id bigint NOT NULL REFERENCES ty_leave_request(id),
 fact_id bigint REFERENCES ty_lp_fact(id),classification text NOT NULL CHECK(classification IN('paid','unpaid','unknown','baseline_retained','mixed')),
 minutes integer CHECK(minutes>=0),baseline_overlap integer NOT NULL CHECK(baseline_overlap>=0 AND(minutes IS NULL OR baseline_overlap<=minutes)),
 intervals jsonb NOT NULL CHECK(jsonb_typeof(intervals)='array'),components jsonb NOT NULL CHECK(jsonb_typeof(components)='array'),basis text NOT NULL,source_hash text NOT NULL CHECK(length(source_hash)=64),
 PRIMARY KEY(line_id,request_id));

CREATE FUNCTION fn_ty_time_leave_geometry(report_key bigint,eid bigint)RETURNS jsonb LANGUAGE sql STABLE SET search_path=''AS $$
 SELECT CASE WHEN r.source_plan_id IS NOT NULL THEN coalesce((SELECT jsonb_agg(to_jsonb(s)ORDER BY s.id)FROM public.ty_time_plan_segment s WHERE s.plan_id=r.source_plan_id AND s.employment_id=eid),'[]'::jsonb)ELSE 'null'::jsonb END FROM public.ty_time_report_version r WHERE r.id=report_key;
$$;

-- Reuse237 net intervals. This is source reconciliation, not a second punch or
-- leave engine. One result describes the COMPLETE intersection for one line.
CREATE FUNCTION fn_ty_time_leave_expected(line_key_id bigint,request_key_id bigint)RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=''AS $$
DECLARE l public.ty_time_report_line%ROWTYPE;r public.ty_time_report_version%ROWTYPE;s public.ty_time_leave_report_source%ROWTYPE;v public.ty_leave_request%ROWTYPE;scheme public.ty_leave_scheme%ROWTYPE;head public.ty_lp_fact%ROWTYPE;
 segments jsonb;net jsonb;frozen jsonb;legacy jsonb;intervals jsonb;parts jsonb:='[]';m tstzmultirange;piece tstzrange;part tstzrange;retained tstzmultirange;remaining tstzmultirange;cursor_at timestamptz;end_at timestamptz;cls text;fid bigint;ids bigint[];classes text[];total numeric;overlap numeric;old_line bigint;related boolean;
BEGIN
 SELECT*INTO l FROM public.ty_time_report_line WHERE id=line_key_id;SELECT*INTO r FROM public.ty_time_report_version WHERE id=l.report_id;SELECT*INTO s FROM public.ty_time_leave_report_source WHERE report_id=r.id AND employment_id=l.employment_id;SELECT*INTO v FROM public.ty_leave_request WHERE id=request_key_id;
 IF s.report_id IS NULL OR v.id IS NULL OR v.employment_id<>l.employment_id OR v.status<>'taken'THEN RETURN NULL;END IF;
 IF s.mode='manual'THEN
  related:=l.work_date IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v.facts->'roster_source'->'days','[]'))d WHERE(d->>'work_date')::date=l.work_date AND(d->>'request_minutes')::numeric>0)OR l.work_date BETWEEN(v.starts_at AT TIME ZONE'Asia/Shanghai')::date AND((v.ends_at-interval'1 microsecond')AT TIME ZONE'Asia/Shanghai')::date;
  IF NOT related THEN RETURN NULL;END IF;RETURN jsonb_build_object('request_id',v.id,'fact_id',NULL,'classification','unknown','minutes',NULL,'baseline_overlap',0,'intervals','[]'::jsonb,'components','[]'::jsonb,'basis','manual_current_taken_reference');
 END IF;
 IF s.mode='inherited'THEN SELECT id INTO old_line FROM public.ty_time_report_line WHERE report_id=s.source_report_id AND line_key=l.line_key;IF old_line IS NULL THEN RETURN NULL;END IF;RETURN public.fn_ty_time_leave_expected(old_line,request_key_id);END IF;
 IF r.source_plan_id IS NOT NULL THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('start',x.start_at,'end',x.end_at,'breaks',x.breaks,'trusted',x.leave_kind IN('annual_leave','sick_leave','personal_leave','holiday')AND EXISTS(SELECT 1 FROM public.ty_roster_segment b JOIN public.ty_roster_day d ON d.id=b.day_id WHERE x.source_ref='base:'||b.id AND d.employment_id=x.employment_id AND d.work_date=x.work_date AND b.leave_kind=x.leave_kind AND x.start_at>=b.start_at AT TIME ZONE'Asia/Shanghai'AND x.end_at<=b.end_at AT TIME ZONE'Asia/Shanghai'))ORDER BY x.id),'[]')INTO segments FROM public.ty_time_plan_segment x WHERE x.plan_id=r.source_plan_id AND x.employment_id=l.employment_id AND x.work_date=l.work_date AND x.state='active'AND NOT x.overtime AND(NOT l.receiving_store_only OR x.work_company_id=l.scope_company_id);
 ELSIF r.source_period_id IS NOT NULL THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('start',x.start_at AT TIME ZONE'Asia/Shanghai','end',x.end_at AT TIME ZONE'Asia/Shanghai','breaks','[]'::jsonb,'trusted',x.leave_kind IN('annual_leave','sick_leave','personal_leave','holiday'))ORDER BY x.id),'[]')INTO segments FROM public.ty_roster_segment x JOIN public.ty_roster_day d ON d.id=x.day_id WHERE d.period_id=r.source_period_id AND d.employment_id=l.employment_id AND d.work_date=l.work_date AND NOT x.overtime AND(NOT l.receiving_store_only OR x.work_company_id=l.scope_company_id);
 ELSE RETURN NULL;END IF;
 net:=public.fn_ty_leave_roster_net(segments);SELECT public.fn_ty_leave_roster_net(coalesce(jsonb_agg(x),'[]'))INTO legacy FROM jsonb_array_elements(segments)x WHERE(x->>'trusted')::boolean;
 IF(v.facts->'roster_source'->>'version')::integer=237 THEN
  SELECT coalesce(jsonb_agg(i),'[]')INTO frozen FROM jsonb_array_elements(v.facts->'roster_source'->'days')d CROSS JOIN LATERAL jsonb_array_elements(d->'intervals')i;
  frozen:=public.fn_ty_leave_roster_exclude(frozen,ARRAY(SELECT jsonb_array_elements_text(v.facts->'roster_calendar_excluded_dates')::date));
 ELSE frozen:=jsonb_build_array(jsonb_build_object('start',v.starts_at,'end',v.ends_at));END IF;
 SELECT coalesce(range_agg(tstzrange((i->>'start')::timestamptz,(i->>'end')::timestamptz,'[)')),'{}')INTO m FROM jsonb_array_elements(net)i;
 m:=m*coalesce((SELECT range_agg(tstzrange((i->>'start')::timestamptz,(i->>'end')::timestamptz,'[)'))FROM jsonb_array_elements(frozen)i),'{}')*tstzmultirange(tstzrange(v.starts_at,v.ends_at,'[)'));
 IF m='{}'::tstzmultirange THEN RETURN NULL;END IF;
 SELECT*INTO scheme FROM public.ty_leave_scheme WHERE id=v.scheme_id;
 FOR piece IN SELECT unnest(m)LOOP
  cursor_at:=lower(piece);
  WHILE cursor_at<upper(piece)LOOP
   end_at:=least(upper(piece),(((cursor_at AT TIME ZONE'Asia/Shanghai')::date+1)::timestamp AT TIME ZONE'Asia/Shanghai'));fid:=NULL;cls:='unknown';
   IF(v.facts->'roster_source'->>'version')::integer=237 THEN
    SELECT f.*INTO head FROM public.ty_lp_parent p JOIN public.ty_lp_fact f ON f.id=p.current_approved_id WHERE p.request_id=v.id AND p.period=date_trunc('month',cursor_at AT TIME ZONE'Asia/Shanghai')::date AND public.fn_ty_lp_current(f.id);
    IF head.id IS NOT NULL THEN cls:=CASE WHEN head.data->'policy'->>'benefit'IN('CN_UNPAID','HK_UNPAID')THEN'unpaid'WHEN head.data->'policy'->>'benefit'IN('CN_PAID','CN_SICK','CN_MATERNITY','HK_ANNUAL','HK_SICK','HK_MATERNITY','HK_PATERNITY')THEN'paid'ELSE'unknown'END;fid:=head.id;
    ELSIF scheme.status='published'THEN cls:=coalesce(CASE WHEN jsonb_typeof(scheme.rules->'attendance_treatment')='string'THEN scheme.rules->>'attendance_treatment'ELSE scheme.rules->'attendance_treatment'->>'classification'END,'unknown');IF scheme.rules->>'pay_semantics'='paid_worktime'OR scheme.rules->'recurring'->>'pay_semantics'='paid_worktime'OR v.facts->>'pay_semantics'='paid_worktime'THEN cls:='paid';END IF;IF cls NOT IN('paid','unpaid')OR cls='unpaid'AND scheme.statutory AND scheme.code='annual'THEN cls:='unknown';END IF;END IF;
   END IF;
   remaining:=tstzmultirange(tstzrange(cursor_at,end_at,'[)'));
   IF cls='unknown'THEN
    retained:=remaining*coalesce((SELECT range_agg(tstzrange((i->>'start')::timestamptz,(i->>'end')::timestamptz,'[)'))FROM jsonb_array_elements(legacy)i),'{}');
    FOR part IN SELECT unnest(retained)LOOP parts:=parts||jsonb_build_array(jsonb_build_object('start',to_char(lower(part)AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'end',to_char(upper(part)AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'classification','baseline_retained','fact_id',NULL));END LOOP;remaining:=remaining-retained;
   END IF;
   FOR part IN SELECT unnest(remaining)LOOP parts:=parts||jsonb_build_array(jsonb_build_object('start',to_char(lower(part)AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'end',to_char(upper(part)AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'classification',cls,'fact_id',fid));END LOOP;
   cursor_at:=end_at;
  END LOOP;
 END LOOP;
 SELECT jsonb_agg(x ORDER BY x->>'start',x->>'end')INTO parts FROM jsonb_array_elements(parts)x;
 SELECT jsonb_agg(jsonb_build_object('start',x->>'start','end',x->>'end')ORDER BY x->>'start',x->>'end'),array_agg(DISTINCT x->>'classification'),array_agg(DISTINCT(x->>'fact_id')::bigint)FILTER(WHERE x->>'fact_id'IS NOT NULL)INTO intervals,classes,ids FROM jsonb_array_elements(parts)x;
 total:=public.fn_ty_leave_roster_minutes(intervals,'0001-01-01 00:00+00','9999-12-31 00:00+00');overlap:=0;FOR part IN SELECT unnest(m)LOOP overlap:=overlap+public.fn_ty_leave_roster_minutes(legacy,lower(part),upper(part));END LOOP;
 RETURN jsonb_build_object('request_id',v.id,'fact_id',CASE WHEN cardinality(ids)=1 THEN ids[1]ELSE NULL END,'classification',CASE WHEN cardinality(classes)=1 THEN classes[1]ELSE'mixed'END,'minutes',total::integer,'baseline_overlap',overlap::integer,'intervals',intervals,'components',parts,'basis','selected_net_taken_intersection');
END;$$;

CREATE FUNCTION fn_ty_time_leave_source_guard()RETURNS trigger LANGUAGE plpgsql SET search_path=''AS $$
DECLARE r public.ty_time_report_version%ROWTYPE;e public.ty_employment%ROWTYPE;l public.ty_time_report_line%ROWTYPE;expected jsonb;actual jsonb;
BEGIN
 IF TG_OP<>'INSERT'THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='考勤实际休假来源快照不可改写或删除';END IF;
 SELECT*INTO r FROM public.ty_time_report_version WHERE id=NEW.report_id FOR UPDATE;
 IF r.id IS NULL OR r.status<>'draft'THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='只能为新考勤草稿登记实际休假依据';END IF;
 IF TG_TABLE_NAME='ty_time_leave_report_source'THEN
  SELECT*INTO e FROM public.ty_employment WHERE id=NEW.employment_id;
  IF e.id IS NULL OR NEW.group_id<>e.group_id OR NEW.person_id<>e.person_id OR NEW.company_id<>e.company_id OR r.group_id<>e.group_id OR NEW.period<>r.period OR NEW.manifest IS DISTINCT FROM public.fn_ty_time_leave_manifest(e.id,r.period)OR NEW.geometry IS DISTINCT FROM public.fn_ty_time_leave_geometry(r.id,e.id)THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='实际休假快照须对应本人的当前完整来源与报告月份';END IF;
  IF NEW.mode='automatic'AND r.source_plan_id IS NULL AND r.source_period_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='自动核勤须有明确原班段来源';END IF;
  IF NEW.mode='inherited'AND(NEW.source_report_id IS DISTINCT FROM r.source_report_id OR NOT EXISTS(SELECT 1 FROM public.ty_time_leave_report_source s JOIN public.ty_time_report_version prior ON prior.id=s.report_id WHERE s.report_id=NEW.source_report_id AND s.employment_id=e.id AND prior.status='confirmed')OR NOT public.fn_ty_time_leave_current(NEW.source_report_id,e.id))THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='自动继承须有同人完整且仍有效的原考勤来源';END IF;
  IF NEW.mode='manual'THEN
   IF NEW.manual_basis->>'kind'='excel_import'THEN
    IF NOT EXISTS(SELECT 1 FROM public.ty_time_import_batch b WHERE b.id=(NEW.manual_basis->>'import_batch_id')::bigint AND b.group_id=r.group_id AND b.period=r.period AND b.kind IN('attendance_daily','attendance_monthly')AND b.status IN('validated','applied'))THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='人工导入须保留本集团本期真实预检原件';END IF;
   ELSIF NEW.manual_basis->>'kind'='reviewed_reconciliation'THEN
    IF length(btrim(coalesce(NEW.manual_basis->>'reason','')))<4 OR length(btrim(coalesce(NEW.manual_basis->>'evidence_ref','')))<4 OR r.source_report_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.ty_time_report_version prior JOIN public.ty_time_report_line ol ON ol.report_id=prior.id WHERE prior.id=r.source_report_id AND prior.status='confirmed'AND prior.group_id=r.group_id AND prior.period=r.period AND prior.grain=r.grain AND ol.employment_id=e.id)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='人工重新核定须有原已核报告、明确原因及实际依据';END IF;
   ELSE RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='人工核勤不能只登记来源头，须有真实导入或有据复核材料';END IF;
  END IF;
 ELSE
  SELECT*INTO l FROM public.ty_time_report_line WHERE id=NEW.line_id;
  IF l.id IS NULL OR l.report_id<>r.id THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='休假依据须对应真实本报告明细';END IF;
  expected:=public.fn_ty_time_leave_expected(l.id,NEW.request_id);
  actual:=jsonb_build_object('request_id',NEW.request_id,'fact_id',NEW.fact_id,'classification',NEW.classification,'minutes',NEW.minutes,'baseline_overlap',NEW.baseline_overlap,'intervals',NEW.intervals,'components',NEW.components,'basis',NEW.basis);
  IF expected IS NULL OR actual IS DISTINCT FROM expected THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='实际休假依据必须完整匹配本行净班段、实际已休和对应民用日的核定待遇';END IF;
 END IF;RETURN NEW;
END;$$;
CREATE TRIGGER ty_time_leave_source_guard BEFORE INSERT OR UPDATE OR DELETE ON ty_time_leave_report_source FOR EACH ROW EXECUTE FUNCTION fn_ty_time_leave_source_guard();
CREATE TRIGGER ty_time_leave_line_guard BEFORE INSERT OR UPDATE OR DELETE ON ty_time_leave_report_line FOR EACH ROW EXECUTE FUNCTION fn_ty_time_leave_source_guard();

CREATE FUNCTION fn_ty_time_leave_current(report_key bigint,employment_key bigint DEFAULT NULL)RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path='' AS $$
DECLARE s record;line_row record;request jsonb;expected jsonb;actual jsonb;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.ty_time_report_line WHERE report_id=report_key AND(employment_key IS NULL OR employment_id=employment_key))THEN RETURN false;END IF;
 FOR s IN SELECT*FROM public.ty_time_leave_report_source WHERE report_id=report_key AND(employment_key IS NULL OR employment_id=employment_key)LOOP
  IF s.manifest IS DISTINCT FROM public.fn_ty_time_leave_manifest(s.employment_id,s.period)OR s.geometry IS DISTINCT FROM public.fn_ty_time_leave_geometry(s.report_id,s.employment_id)THEN RETURN false;END IF;
  IF s.mode='manual'AND s.manual_basis->>'kind'='excel_import'AND NOT EXISTS(SELECT 1 FROM public.ty_time_import_batch b WHERE b.id=(s.manual_basis->>'import_batch_id')::bigint AND b.status='applied'AND b.result_report_id=s.report_id)THEN RETURN false;END IF;
  FOR line_row IN SELECT id,paid_leave_minutes,unpaid_leave_minutes FROM public.ty_time_report_line WHERE report_id=s.report_id AND employment_id=s.employment_id LOOP
   FOR request IN SELECT value FROM jsonb_array_elements(s.manifest->'requests')LOOP
    expected:=public.fn_ty_time_leave_expected(line_row.id,(request->>'id')::bigint);IF s.mode='manual'AND expected IS NOT NULL AND line_row.paid_leave_minutes=0 AND line_row.unpaid_leave_minutes=0 THEN RETURN false;END IF;
    SELECT jsonb_build_object('request_id',x.request_id,'fact_id',x.fact_id,'classification',x.classification,'minutes',x.minutes,'baseline_overlap',x.baseline_overlap,'intervals',x.intervals,'components',x.components,'basis',x.basis)INTO actual FROM public.ty_time_leave_report_line x WHERE x.line_id=line_row.id AND x.request_id=(request->>'id')::bigint;
    IF actual IS DISTINCT FROM expected THEN RETURN false;END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.ty_time_report_line l WHERE l.report_id=report_key AND(employment_key IS NULL OR l.employment_id=employment_key)AND NOT EXISTS(SELECT 1 FROM public.ty_time_leave_report_source captured WHERE captured.report_id=l.report_id AND captured.employment_id=l.employment_id))THEN RETURN false;END IF;
 RETURN true;
END;$$;
CREATE FUNCTION fn_ty_time_leave_authority_lock()RETURNS trigger LANGUAGE plpgsql SET search_path=''AS $$
DECLARE keys bigint[];BEGIN
 IF TG_TABLE_NAME IN('ty_lp_parent','ty_employment')THEN keys:=ARRAY[NEW.person_id];
 ELSIF TG_TABLE_NAME='ty_lp_fact'THEN SELECT ARRAY[p.person_id]INTO keys FROM public.ty_lp_parent p WHERE p.id=NEW.parent_id;
 ELSE SELECT array_agg(DISTINCT e.person_id ORDER BY e.person_id)INTO keys FROM public.ty_employment e WHERE e.company_id=NEW.company_id;
 END IF;PERFORM public.fn_ty_leave_roster_lock_people(keys);RETURN NEW;
END;$$;
CREATE TRIGGER aa_ty_time_leave_parent_lock BEFORE INSERT OR UPDATE ON ty_lp_parent FOR EACH ROW EXECUTE FUNCTION fn_ty_time_leave_authority_lock();
CREATE TRIGGER aa_ty_time_leave_fact_lock BEFORE INSERT OR UPDATE ON ty_lp_fact FOR EACH ROW EXECUTE FUNCTION fn_ty_time_leave_authority_lock();
CREATE TRIGGER aa_ty_time_leave_employment_lock BEFORE UPDATE ON ty_employment FOR EACH ROW EXECUTE FUNCTION fn_ty_time_leave_authority_lock();
CREATE TRIGGER aa_ty_time_leave_policy_lock BEFORE INSERT OR UPDATE ON ty_lp_policy FOR EACH ROW EXECUTE FUNCTION fn_ty_time_leave_authority_lock();
CREATE FUNCTION fn_ty_time_leave_cash_safe(report_key bigint,employment_key bigint,book_key bigint)RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=''AS $$
DECLARE book public.ty_pay_config%ROWTYPE;affected text[];rule jsonb;dependent boolean;category text;covered boolean;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.ty_time_leave_report_source WHERE report_id=report_key AND employment_id=employment_key AND jsonb_array_length(manifest->'requests')>0)THEN RETURN true;END IF;
 SELECT*INTO book FROM public.ty_pay_config WHERE id=book_key;SELECT EXISTS(SELECT 1 FROM public.ty_time_leave_report_source source CROSS JOIN LATERAL jsonb_array_elements(source.manifest->'requests')request CROSS JOIN LATERAL jsonb_array_elements(request->'fact_heads')head WHERE source.report_id=report_key AND source.employment_id=employment_key AND(head->>'current')::boolean AND(coalesce((head->'fact'->'data'->>'normal_covered')::numeric,0)>0 OR coalesce((head->'fact'->'data'->>'reduction')::numeric,0)>0))INTO covered;
 SELECT coalesce(array_agg(key),'{}')INTO affected FROM jsonb_each(book.data->'inputs')WHERE value->>'source'='time_report'AND coalesce(value->>'metric',key)IN('paid_leave_minutes','unpaid_leave_minutes','planned_minutes','worked_minutes','worked_hours');
 FOR rule IN SELECT value FROM jsonb_array_elements(book.data->'compiled'->'order')LOOP
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements_text(rule->'dependencies')d WHERE d=ANY(affected))INTO dependent;
  IF dependent THEN affected:=array_append(affected,rule->>'code');END IF;
  SELECT i.category INTO category FROM public.ty_pay_item_catalog i WHERE i.code=rule->>'code';
  IF rule->>'code'='UNPAID_TIME_REDUCTION'OR dependent AND(category='personal_deduction'OR category='cash_earnings'AND covered)THEN RETURN false;END IF;
 END LOOP;RETURN true;
END;$$;
CREATE FUNCTION fn_ty_time_leave_confirm_guard()RETURNS trigger LANGUAGE plpgsql SET search_path=''AS $$
DECLARE x record;rid bigint;BEGIN
 IF NEW.status<>'confirmed'OR OLD.status='confirmed'THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='ty_time_report_version'THEN
  PERFORM public.fn_ty_leave_roster_lock_people(array(SELECT DISTINCT person_id FROM public.ty_time_report_line WHERE report_id=NEW.id));
  IF NOT public.fn_ty_time_leave_current(NEW.id)THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='实际已休或假期待遇来源已变化，须另建考勤版本重新核对';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.ty_time_leave_pre238_report WHERE report_id=NEW.id)AND EXISTS(SELECT 1 FROM public.ty_time_report_line l WHERE l.report_id=NEW.id AND NOT EXISTS(SELECT 1 FROM public.ty_time_leave_report_source s WHERE s.report_id=NEW.id AND s.employment_id=l.employment_id)AND jsonb_array_length(public.fn_ty_time_leave_manifest(l.employment_id,NEW.period)->'requests')>0)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='新核勤版本不可遗漏实际已休来源，手工核定也须保存当前依据';END IF;
 ELSE
  FOR x IN SELECT DISTINCT row.employment_id,(a.source_snapshot->>'report_id')::bigint report_id FROM public.ty_pay_row row JOIN public.ty_pay_item i ON i.row_id=row.id JOIN public.ty_pay_adoption a ON a.id=i.adoption_id WHERE row.batch_id=NEW.id AND a.source_domain='payroll_calculation'AND a.source_snapshot->>'report_id'IS NOT NULL LOOP
   PERFORM public.fn_ty_leave_roster_lock_people(array(SELECT person_id FROM public.ty_employment WHERE id=x.employment_id));
   IF NOT public.fn_ty_time_leave_current(x.report_id,x.employment_id)THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='工资引用考勤的实际休假依据已过期，须重核新报告及预演';END IF;
   IF NOT public.fn_ty_time_leave_cash_safe(x.report_id,x.employment_id,NEW.rulebook_id)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='实际假期待遇已核定，未排除同假覆盖的计薪公式不能重复减发';END IF;
  END LOOP;
 END IF;RETURN NEW;
END;$$;
CREATE TRIGGER ty_time_leave_report_confirm BEFORE UPDATE ON ty_time_report_version FOR EACH ROW EXECUTE FUNCTION fn_ty_time_leave_confirm_guard();
CREATE TRIGGER ty_time_leave_pay_confirm BEFORE UPDATE ON ty_pay_batch FOR EACH ROW EXECUTE FUNCTION fn_ty_time_leave_confirm_guard();

-- New service-quantity adoption shares the same employee-month authority. An
-- already posted payable or confirmed wage is not reevaluated by payment reads.
CREATE FUNCTION fn_ty_time_leave_consumer_guard()RETURNS trigger LANGUAGE plpgsql SET search_path=''AS $$
DECLARE item record;keys bigint[];BEGIN
 IF TG_TABLE_NAME='ty_wf_acceptance_version'THEN
  IF NEW.status<>'approved'OR(TG_OP='UPDATE'AND OLD.status='approved')OR NEW.source_kind<>'native_time'THEN RETURN NEW;END IF;
  SELECT person_id,employment_id INTO item FROM public.ty_wf_acceptance_root WHERE id=NEW.root_id;PERFORM public.fn_ty_leave_roster_lock_people(ARRAY[item.person_id]);
  IF NOT public.fn_ty_time_leave_current(NEW.source_report_id,item.employment_id)THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='服务验收所用核勤的实际休假来源已变化，请先重新核定考勤与分摊';END IF;
 ELSIF TG_TABLE_NAME='ty_wf_bill_version'THEN
  IF NEW.status NOT IN('reviewed','shared','agreed','posted')OR(TG_OP='UPDATE'AND OLD.status=NEW.status)THEN RETURN NEW;END IF;
  SELECT array_agg(DISTINCT ar.person_id ORDER BY ar.person_id)INTO keys FROM public.ty_wf_bill_line line JOIN public.ty_wf_acceptance_version av ON av.id=line.acceptance_version_id JOIN public.ty_wf_acceptance_root ar ON ar.id=av.root_id WHERE line.version_id=NEW.id AND line.source_kind='accepted_service'AND av.source_kind='native_time';PERFORM public.fn_ty_leave_roster_lock_people(keys);
  FOR item IN SELECT av.source_report_id,ar.employment_id FROM public.ty_wf_bill_line line JOIN public.ty_wf_acceptance_version av ON av.id=line.acceptance_version_id JOIN public.ty_wf_acceptance_root ar ON ar.id=av.root_id WHERE line.version_id=NEW.id AND line.source_kind='accepted_service'AND av.source_kind='native_time'LOOP
   IF NOT public.fn_ty_time_leave_current(item.source_report_id,item.employment_id)THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='新对账采用的服务核勤来源已变化，请先核对新版服务量';END IF;
  END LOOP;
 ELSE
  IF NEW.status<>'approved'OR(TG_OP='UPDATE'AND OLD.status='approved')OR NEW.source_kind<>'native_time_and_reviewed_allocation'THEN RETURN NEW;END IF;PERFORM public.fn_ty_leave_roster_lock_people(ARRAY[NEW.person_id]);
  IF NOT public.fn_ty_time_leave_current(NEW.report_id,NEW.employment_id)THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='行业工作日依据所用核勤来源已变化，请先重新核定';END IF;
 END IF;RETURN NEW;
END;$$;
CREATE TRIGGER aa_ty_time_leave_acceptance BEFORE INSERT OR UPDATE ON ty_wf_acceptance_version FOR EACH ROW EXECUTE FUNCTION fn_ty_time_leave_consumer_guard();
CREATE TRIGGER aa_ty_time_leave_bill BEFORE INSERT OR UPDATE ON ty_wf_bill_version FOR EACH ROW EXECUTE FUNCTION fn_ty_time_leave_consumer_guard();
CREATE TRIGGER aa_ty_time_leave_industry BEFORE INSERT OR UPDATE ON ty_pay_industry_basis FOR EACH ROW EXECUTE FUNCTION fn_ty_time_leave_consumer_guard();
ALTER FUNCTION fn_ty_pay_industry_basis_valid(bigint)RENAME TO fn_ty_pay_industry_basis_valid_pre238;
CREATE FUNCTION fn_ty_pay_industry_basis_valid(p_id bigint)RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=''AS $$
DECLARE b public.ty_pay_industry_basis%ROWTYPE;BEGIN SELECT*INTO b FROM public.ty_pay_industry_basis WHERE id=p_id;
 IF b.source_kind='native_time_and_reviewed_allocation'THEN PERFORM public.fn_ty_leave_roster_lock_people(ARRAY[b.person_id]);IF NOT public.fn_ty_time_leave_current(b.report_id,b.employment_id)THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='行业工作日依据的实际休假来源已变化，新采用须重新核定';END IF;END IF;
 RETURN public.fn_ty_pay_industry_basis_valid_pre238(p_id);
END;$$;
