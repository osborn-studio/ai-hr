--237 authoritative roster geometry for NEW leave; no historical request or wage rewrite.
CREATE TABLE ty_leave_roster_pre237_request(request_id bigint PRIMARY KEY REFERENCES ty_leave_request(id));
INSERT INTO ty_leave_roster_pre237_request SELECT id FROM ty_leave_request;
CREATE TRIGGER ty_leave_roster_pre237_immutable BEFORE INSERT OR UPDATE OR DELETE ON ty_leave_roster_pre237_request FOR EACH ROW EXECUTE FUNCTION fn_ty_leave_immutable();
CREATE FUNCTION fn_ty_leave_roster_lock_people(keys bigint[])RETURNS void LANGUAGE plpgsql SET search_path=''AS $$DECLARE k bigint;BEGIN
 FOR k IN SELECT DISTINCT n FROM unnest(keys)n WHERE n IS NOT NULL ORDER BY n LOOP PERFORM pg_advisory_xact_lock(hashtextextended('tyhr-leave-roster237:'||k,0));END LOOP;
END;$$;
CREATE FUNCTION fn_ty_leave_roster_net(segments jsonb)RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=''AS $$
 WITH parts AS(SELECT unnest(tstzmultirange(tstzrange((s->>'start')::timestamptz,(s->>'end')::timestamptz,'[)'))-coalesce((SELECT range_agg(tstzrange((b->>'start_at')::timestamptz,(b->>'end_at')::timestamptz,'[)'))FROM jsonb_array_elements(coalesce(s->'breaks','[]'))b WHERE NOT coalesce((b->>'paid')::boolean,false)),'{}'::tstzmultirange))r FROM jsonb_array_elements(segments)s),combined AS(SELECT unnest(range_agg(r))r FROM parts)
 SELECT coalesce(jsonb_agg(jsonb_build_object('start',to_char(lower(r)AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'end',to_char(upper(r)AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))ORDER BY lower(r)),'[]'::jsonb)FROM combined;
$$;
CREATE FUNCTION fn_ty_leave_roster_minutes(intervals jsonb,a timestamptz,b timestamptz)RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path=''AS $$
 SELECT coalesce(sum(greatest(0,extract(epoch FROM(least((v->>'end')::timestamptz,b)-greatest((v->>'start')::timestamptz,a)))/60)),0)FROM jsonb_array_elements(intervals)v;
$$;
CREATE FUNCTION fn_ty_leave_roster_impact(s jsonb)RETURNS text LANGUAGE sql IMMUTABLE SET search_path=''AS $$
 SELECT md5(jsonb_build_object('employment_id',s->'employment_id','starts_at',s->'starts_at','ends_at',s->'ends_at','days',(SELECT coalesce(jsonb_agg(jsonb_build_object('work_date',d->'work_date','day_kind',d->'source'->'day_kind','intervals',d->'intervals','scheduled_minutes',d->'scheduled_minutes','request_minutes',d->'request_minutes')ORDER BY d->>'work_date'),'[]')FROM jsonb_array_elements(s->'days')d))::text);
$$;
CREATE FUNCTION fn_ty_leave_roster_snapshot(eid bigint,a timestamptz,b timestamptz)RETURNS jsonb LANGUAGE plpgsql SET search_path=''AS $$
DECLARE e public.ty_employment%ROWTYPE;d date;first_day date;last_day date;n integer;v record;source jsonb;segments jsonb;intervals jsonb;days jsonb:='[]';payload jsonb;total numeric;BEGIN
 IF a IS NULL OR b IS NULL OR b<=a OR extract(second FROM a)<>0 OR extract(second FROM b)<>0 OR b>a+interval'3660 days'THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='排班核量须为有效的分钟对齐区间';END IF;
 SELECT*INTO e FROM public.ty_employment WHERE id=eid;IF e.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='排班核量实际雇佣不存在';END IF;
 PERFORM public.fn_ty_leave_roster_lock_people(ARRAY[e.person_id]);first_day:=(a AT TIME ZONE'Asia/Shanghai')::date;last_day:=((b-interval'1 microsecond')AT TIME ZONE'Asia/Shanghai')::date;
 FOR d IN SELECT z::date FROM generate_series(first_day::timestamp,last_day::timestamp,interval'1 day')z UNION SELECT s.work_date FROM public.ty_time_plan_segment s JOIN public.ty_time_plan_version p ON p.id=s.plan_id WHERE s.employment_id=eid AND p.status='published'AND s.state='active'AND NOT s.overtime AND s.start_at<b AND s.end_at>a UNION SELECT x.work_date FROM public.ty_roster_day x JOIN public.ty_roster_period p ON p.id=x.period_id JOIN public.ty_roster_segment s ON s.day_id=x.id WHERE x.employment_id=eid AND p.status IN('published','closed')AND NOT s.overtime AND(s.start_at AT TIME ZONE'Asia/Shanghai')<b AND(s.end_at AT TIME ZONE'Asia/Shanghai')>a ORDER BY 1 LOOP
  SELECT count(*)INTO n FROM public.ty_time_plan_day x JOIN public.ty_time_plan_version p ON p.id=x.plan_id WHERE x.employment_id=eid AND x.work_date=d AND p.status='published';
  IF n>1 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='同一雇佣同日存在多个正式排班来源，须先核定唯一有效版本';END IF;
  segments:='[]';source:=jsonb_build_object('kind','none','day_kind','unscheduled');
  IF n=1 THEN
   SELECT x.id day_id,x.plan_id,x.day_kind INTO v FROM public.ty_time_plan_day x JOIN public.ty_time_plan_version p ON p.id=x.plan_id WHERE x.employment_id=eid AND x.work_date=d AND p.status='published';
   source:=jsonb_build_object('kind','time216','plan_id',v.plan_id::text,'day_id',v.day_id::text,'day_kind',v.day_kind);
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id::text,'ref','plan:'||s.id,'start',to_char(s.start_at AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'end',to_char(s.end_at AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'breaks',s.breaks,'work_company_id',s.work_company_id::text,'department_id',s.department_id::text)ORDER BY s.start_at,s.end_at,s.id),'[]')INTO segments FROM public.ty_time_plan_segment s WHERE s.plan_id=v.plan_id AND s.employment_id=eid AND s.work_date=d AND s.state='active'AND NOT s.overtime;
   IF source->>'day_kind'IN('rest','unscheduled')AND jsonb_array_length(segments)>0 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='正式休息或未排班安排仍含有效工作班段，须先核定来源';END IF;
  IF v.day_kind IN('rest','unscheduled')AND jsonb_array_length(segments)>0 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='正式休息或未排班日期仍含正常班段，须先核定唯一工作安排';END IF;
  ELSE
   SELECT count(*)INTO n FROM public.ty_roster_day x JOIN public.ty_roster_period p ON p.id=x.period_id WHERE x.employment_id=eid AND x.work_date=d AND p.status IN('published','closed');
   IF n>1 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='同一雇佣同日存在多个已发布旧基线，须先核定唯一来源';END IF;
   IF n=1 THEN
    SELECT x.id day_id,x.period_id,x.day_kind INTO v FROM public.ty_roster_day x JOIN public.ty_roster_period p ON p.id=x.period_id WHERE x.employment_id=eid AND x.work_date=d AND p.status IN('published','closed');source:=jsonb_build_object('kind','roster208','period_id',v.period_id::text,'day_id',v.day_id::text,'day_kind',v.day_kind);
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id::text,'ref','base:'||s.id,'start',to_char(s.start_at,'YYYY-MM-DD"T"HH24:MI:SS')||'+08:00','end',to_char(s.end_at,'YYYY-MM-DD"T"HH24:MI:SS')||'+08:00','breaks','[]'::jsonb,'work_company_id',s.work_company_id::text,'department_id',s.department_id::text)ORDER BY s.start_at,s.end_at,s.id),'[]')INTO segments FROM public.ty_roster_segment s WHERE s.day_id=v.day_id AND NOT s.overtime;
   END IF;
  END IF;
  -- An explicit rest/unscheduled published day never falls back to208.
  IF source->>'kind'='time216'AND source->>'day_kind'IN('rest','unscheduled')AND jsonb_array_length(segments)>0 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='正式休息或未排班日含有效工作班段，须先核对排班';END IF;
  intervals:=public.fn_ty_leave_roster_net(segments);
  days:=days||jsonb_build_array(jsonb_build_object('work_date',d::text,'source',source,'segments',segments,'intervals',intervals,'scheduled_minutes',trunc(public.fn_ty_leave_roster_minutes(intervals,'0001-01-01 00:00:00+00','9999-12-31 00:00:00+00'))::text,'request_minutes',trunc(public.fn_ty_leave_roster_minutes(intervals,a,b))::text));
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(days)d1 CROSS JOIN jsonb_array_elements(days)d2 CROSS JOIN LATERAL jsonb_array_elements(d1->'intervals')i1 CROSS JOIN LATERAL jsonb_array_elements(d2->'intervals')i2 WHERE d1->>'work_date'<d2->>'work_date'AND(i1->>'start')::timestamptz<(i2->>'end')::timestamptz AND(i2->>'start')::timestamptz<(i1->>'end')::timestamptz)THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='不同归属工作日的有效净班段重叠，须先核定实际排班';END IF;
 -- Daily geometry is disjoint in216; union also protects legacy multi-shift overlap.
 SELECT coalesce(jsonb_agg(i),'[]')INTO intervals FROM jsonb_array_elements(days)x CROSS JOIN LATERAL jsonb_array_elements(x->'intervals')i;
 SELECT public.fn_ty_leave_roster_minutes(public.fn_ty_leave_roster_net(intervals),a,b)INTO total;
 payload:=jsonb_build_object('version',237,'employment_id',eid::text,'person_id',e.person_id::text,'starts_at',to_char(a AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'ends_at',to_char(b AT TIME ZONE'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'days',days,'minutes',trunc(total)::text);
 RETURN payload||jsonb_build_object('source_hash',md5(payload::text),'impact_hash',public.fn_ty_leave_roster_impact(payload));
END;$$;
CREATE FUNCTION fn_ty_leave_roster_civil(s jsonb,civil date,excluded date[]DEFAULT'{}')RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=''AS $$
DECLARE d jsonb;qty numeric;full_minutes numeric;num numeric:=0;den numeric:=1;g numeric;pieces jsonb:='[]';total numeric:=0;a timestamptz;b timestamptz;BEGIN
 a:=greatest((s->>'starts_at')::timestamptz,civil::timestamp AT TIME ZONE'Asia/Shanghai');b:=least((s->>'ends_at')::timestamptz,(civil+1)::timestamp AT TIME ZONE'Asia/Shanghai');
 IF b>a AND NOT(civil=ANY(excluded))THEN FOR d IN SELECT value FROM jsonb_array_elements(s->'days')LOOP qty:=public.fn_ty_leave_roster_minutes(d->'intervals',a,b);full_minutes:=(d->>'scheduled_minutes')::numeric;IF qty>0 THEN IF full_minutes<=0 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='冻结的原班分母须大于零';END IF;pieces:=pieces||jsonb_build_array(jsonb_build_object('work_date',d->'work_date','scheduled_minutes',trunc(full_minutes)::text,'request_minutes',trunc(qty)::text));num:=num*full_minutes+qty*den;den:=den*full_minutes;g:=gcd(num,den);num:=num/g;den:=den/g;total:=total+qty;END IF;END LOOP;END IF;
 RETURN jsonb_build_object('request_minutes',trunc(total)::text,'pieces',pieces,'units',jsonb_build_object('numerator',trunc(num)::text,'denominator',trunc(den)::text),'roster_ref','leave-roster237:'||(s->>'source_hash')||':'||civil::text,'source_hash',s->'source_hash','roster_hash',s->'source_hash')||CASE WHEN jsonb_array_length(pieces)=1 THEN jsonb_build_object('scheduled_minutes',pieces->0->'scheduled_minutes')ELSE'{}'::jsonb END;
END;$$;
CREATE FUNCTION fn_ty_leave_roster_frozen_valid(s jsonb,eid bigint,a timestamptz,b timestamptz)RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=''AS $$
 SELECT coalesce((s->>'version')::integer=237 AND(s->>'employment_id')::bigint=eid AND(s->>'starts_at')::timestamptz=a AND(s->>'ends_at')::timestamptz=b AND s->>'source_hash'=md5((s-ARRAY['source_hash','impact_hash'])::text)AND s->>'impact_hash'=public.fn_ty_leave_roster_impact(s),false);
$$;
CREATE FUNCTION fn_ty_leave_roster_exclude(intervals jsonb,excluded date[])RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=''AS $$
 SELECT public.fn_ty_leave_roster_net(coalesce((SELECT jsonb_agg(i||jsonb_build_object('breaks',coalesce((SELECT jsonb_agg(jsonb_build_object('start_at',d::timestamp AT TIME ZONE'Asia/Shanghai','end_at',(d+1)::timestamp AT TIME ZONE'Asia/Shanghai','paid',false))FROM unnest(excluded)d),'[]'::jsonb)))FROM jsonb_array_elements(intervals)i),'[]'::jsonb));
$$;
CREATE FUNCTION fn_ty_leave_roster_quantity(s jsonb,unit_kind text,excluded date[]DEFAULT'{}')RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=''AS $$DECLARE d jsonb;all_intervals jsonb;part numeric;full_minutes numeric;total numeric:=0;BEGIN
 IF unit_kind='minute'THEN SELECT coalesce(jsonb_agg(i),'[]')INTO all_intervals FROM jsonb_array_elements(s->'days')day_row CROSS JOIN LATERAL jsonb_array_elements(day_row->'intervals')i;RETURN public.fn_ty_leave_roster_minutes(public.fn_ty_leave_roster_exclude(public.fn_ty_leave_roster_net(all_intervals),excluded),(s->>'starts_at')::timestamptz,(s->>'ends_at')::timestamptz);END IF;
 FOR d IN SELECT value FROM jsonb_array_elements(s->'days')LOOP full_minutes:=(d->>'scheduled_minutes')::numeric;IF full_minutes>0 THEN part:=public.fn_ty_leave_roster_minutes(public.fn_ty_leave_roster_exclude(d->'intervals',excluded),(s->>'starts_at')::timestamptz,(s->>'ends_at')::timestamptz);total:=total+round(part/full_minutes,4);END IF;END LOOP;RETURN total;
END;$$;
CREATE FUNCTION fn_ty_leave_roster_request_guard()RETURNS trigger LANGUAGE plpgsql SET search_path=''AS $$
DECLARE s jsonb;current_source jsonb;scheme public.ty_leave_scheme%ROWTYPE;calendar jsonb;excluded date[]:='{}';expected numeric;BEGIN
 IF TG_OP='DELETE'THEN IF OLD.facts?'roster_source'THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='冻结排班假期不可删除';END IF;RETURN OLD;END IF;
 SELECT*INTO scheme FROM public.ty_leave_scheme WHERE id=NEW.scheme_id;
 IF TG_OP='UPDATE'AND OLD.facts?'roster_source'AND(NEW.account_id<>OLD.account_id OR NEW.scheme_id<>OLD.scheme_id OR NEW.employment_id<>OLD.employment_id OR NEW.starts_at<>OLD.starts_at OR NEW.ends_at<>OLD.ends_at OR NEW.quantity<>OLD.quantity OR NEW.facts IS DISTINCT FROM OLD.facts)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='请假排班来源、数量及原期间已冻结，须取消后重新申请';END IF;
 IF scheme.rules->>'quantity_basis'<>'roster'THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE'AND EXISTS(SELECT 1 FROM public.ty_leave_roster_pre237_request WHERE request_id=OLD.id)AND NOT(OLD.facts?'roster_source')THEN RETURN NEW;END IF;
 IF NEW.facts->>'quantity_basis'IS DISTINCT FROM'roster'OR(NEW.facts->>'rule_version')::integer IS DISTINCT FROM scheme.version THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='请假须冻结实际规则版本与排班核量口径';END IF;
 s:=NEW.facts->'roster_source';
 IF NOT public.fn_ty_leave_roster_frozen_valid(s,NEW.employment_id,NEW.starts_at,NEW.ends_at)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='新请假须冻结当前完整排班权威来源';END IF;
 IF scheme.statutory AND scheme.jurisdiction='CN'AND scheme.code='annual'THEN
  calendar:=coalesce(scheme.rules->'personnel_calendars'->NEW.employment_id::text,scheme.rules);
  IF calendar->>'calendar_status'IS DISTINCT FROM'verified'OR calendar->>'calendar_version'IS NULL OR jsonb_typeof(calendar->'holiday_dates')IS DISTINCT FROM'array'OR jsonb_typeof(calendar->'rest_dates')IS DISTINCT FROM'array'OR calendar->>'calendar_valid_from'IS NULL OR calendar->>'calendar_valid_to'IS NULL OR(calendar->>'calendar_valid_from')::date>(NEW.starts_at AT TIME ZONE'Asia/Shanghai')::date OR(calendar->>'calendar_valid_to')::date<=((NEW.ends_at-interval'1 microsecond')AT TIME ZONE'Asia/Shanghai')::date THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='法定年假适用日历待核，不能扣假';END IF;
  IF NEW.facts->>'calendar_version'IS DISTINCT FROM calendar->>'calendar_version'OR NEW.facts->>'calendar_status'IS DISTINCT FROM'verified'THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='请假须保留实际已核日历版本';END IF;
  SELECT coalesce(array_agg(DISTINCT v::date ORDER BY v::date),'{}')INTO excluded FROM(SELECT jsonb_array_elements_text(calendar->'holiday_dates')v UNION SELECT jsonb_array_elements_text(calendar->'rest_dates')UNION SELECT jsonb_array_elements_text(coalesce(scheme.rules->'holiday_dates','[]')))x;
 END IF;
 IF NEW.facts->'roster_calendar_excluded_dates'IS DISTINCT FROM to_jsonb(excluded)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='排班假期须冻结已核规则适用的法定日历排除日期';END IF;
 expected:=public.fn_ty_leave_roster_quantity(s,scheme.unit,excluded);
 IF NEW.quantity<>expected OR(NEW.facts->>'minutes')::numeric IS DISTINCT FROM public.fn_ty_leave_roster_quantity(s,'minute',excluded)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='请假数量与冻结净排班及法定日历核量不符';END IF;
 IF TG_OP='INSERT'OR(TG_OP='UPDATE'AND NEW.status IN('approved','taken')AND NEW.status IS DISTINCT FROM OLD.status)THEN
  current_source:=public.fn_ty_leave_roster_snapshot(NEW.employment_id,NEW.starts_at,NEW.ends_at);
  IF TG_OP='INSERT'AND s IS DISTINCT FROM current_source OR TG_OP='UPDATE'AND s->>'impact_hash'IS DISTINCT FROM current_source->>'impact_hash'THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='实际排班已变化，请取消原申请后按新班表重新核量';END IF;
 END IF;RETURN NEW;
END;$$;
CREATE TRIGGER aa_ty_leave_roster_request BEFORE INSERT OR UPDATE OR DELETE ON ty_leave_request FOR EACH ROW EXECUTE FUNCTION fn_ty_leave_roster_request_guard();
CREATE FUNCTION fn_ty_leave_roster_publish_guard()RETURNS trigger LANGUAGE plpgsql SET search_path=''AS $$DECLARE keys bigint[];BEGIN
 IF NEW.status='published'OR(TG_OP='UPDATE'AND OLD.status='published')THEN
  SELECT array_agg(DISTINCT x.person_id ORDER BY x.person_id)INTO keys FROM public.ty_time_plan_day x WHERE x.plan_id=NEW.id;PERFORM public.fn_ty_leave_roster_lock_people(keys);
  IF NEW.status='published'AND NEW.source_plan_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.ty_time_plan_version WHERE id=NEW.source_plan_id AND status='published')THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='排班来源已不是当前正式版本，请从当前计划重新修订';END IF;
  IF NEW.status='published'AND EXISTS(SELECT 1 FROM public.ty_time_plan_segment s WHERE s.plan_id=NEW.id AND s.state='active'AND NOT EXISTS(SELECT 1 FROM public.ty_time_plan_day d WHERE d.plan_id=s.plan_id AND d.employment_id=s.employment_id AND d.work_date=s.work_date))THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='正式班段必须有相同实际雇佣及工作日安排';END IF;
 END IF;RETURN NEW;
END;$$;
CREATE TRIGGER aa_ty_leave_roster_publish BEFORE INSERT OR UPDATE ON ty_time_plan_version FOR EACH ROW EXECUTE FUNCTION fn_ty_leave_roster_publish_guard();
CREATE FUNCTION fn_ty_leave_roster_published_unique()RETURNS trigger LANGUAGE plpgsql SET search_path=''AS $$BEGIN
 IF NEW.status='published'OR(TG_OP='UPDATE'AND OLD.status='published')THEN
 IF EXISTS(SELECT 1 FROM public.ty_time_plan_day d JOIN public.ty_time_plan_day x ON x.employment_id=d.employment_id AND x.work_date=d.work_date JOIN public.ty_time_plan_version p ON p.id=x.plan_id WHERE d.plan_id=NEW.id AND p.status='published'GROUP BY d.employment_id,d.work_date HAVING count(DISTINCT p.id)>1)THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='同一实际雇佣工作日不能有多个正式排班头，请从唯一当前计划修订';END IF;END IF;RETURN NEW;
END;$$;
CREATE CONSTRAINT TRIGGER ty_leave_roster_published_unique AFTER INSERT OR UPDATE ON ty_time_plan_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ty_leave_roster_published_unique();
CREATE FUNCTION fn_ty_leave_roster208_guard()RETURNS trigger LANGUAGE plpgsql SET search_path=''AS $$DECLARE keys bigint[];BEGIN
 IF TG_TABLE_NAME='ty_roster_period'THEN SELECT array_agg(DISTINCT person_id ORDER BY person_id)INTO keys FROM public.ty_roster_day WHERE period_id=CASE WHEN TG_OP='DELETE'THEN OLD.id ELSE NEW.id END;
 ELSIF TG_TABLE_NAME='ty_roster_day'THEN keys:=CASE WHEN TG_OP='INSERT'THEN ARRAY[NEW.person_id]WHEN TG_OP='DELETE'THEN ARRAY[OLD.person_id]ELSE ARRAY[OLD.person_id,NEW.person_id]END;
 ELSE SELECT array_agg(DISTINCT person_id ORDER BY person_id)INTO keys FROM public.ty_roster_day WHERE id=ANY(CASE WHEN TG_OP='INSERT'THEN ARRAY[NEW.day_id]WHEN TG_OP='DELETE'THEN ARRAY[OLD.day_id]ELSE ARRAY[OLD.day_id,NEW.day_id]END);END IF;
 PERFORM public.fn_ty_leave_roster_lock_people(keys);IF TG_OP='DELETE'THEN RETURN OLD;END IF;RETURN NEW;
END;$$;
CREATE TRIGGER aa_ty_leave_roster208_period BEFORE UPDATE OR DELETE ON ty_roster_period FOR EACH ROW EXECUTE FUNCTION fn_ty_leave_roster208_guard();
CREATE TRIGGER aa_ty_leave_roster208_day BEFORE INSERT OR UPDATE OR DELETE ON ty_roster_day FOR EACH ROW EXECUTE FUNCTION fn_ty_leave_roster208_guard();
CREATE TRIGGER aa_ty_leave_roster208_segment BEFORE INSERT OR UPDATE OR DELETE ON ty_roster_segment FOR EACH ROW EXECUTE FUNCTION fn_ty_leave_roster208_guard();
CREATE FUNCTION fn_ty_leave_roster_pay_valid(request_id_value bigint,paydays jsonb,payperiod date DEFAULT NULL)RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=''AS $$
DECLARE r public.ty_leave_request%ROWTYPE;unit_kind text;d jsonb;x jsonb;seen date[]:='{}';expected_dates date[]:='{}';excluded date[];civil date;qty numeric;un numeric;ud numeric;BEGIN
 SELECT*INTO r FROM public.ty_leave_request WHERE id=request_id_value;IF NOT(r.facts?'roster_source')THEN RETURN true;END IF;
 SELECT unit INTO unit_kind FROM public.ty_leave_account WHERE id=r.account_id;
 IF NOT public.fn_ty_leave_roster_frozen_valid(r.facts->'roster_source',r.employment_id,r.starts_at,r.ends_at)OR jsonb_typeof(paydays)IS DISTINCT FROM'array'OR jsonb_array_length(paydays)NOT BETWEEN 1 AND 31 THEN RETURN false;END IF;
 SELECT coalesce(array_agg(v::date),'{}')INTO excluded FROM jsonb_array_elements_text(r.facts->'roster_calendar_excluded_dates')v;
 IF payperiod IS NULL THEN payperiod:=date_trunc('month',(paydays->0->>'date')::date)::date;END IF;
 FOR d IN SELECT value FROM jsonb_array_elements(paydays)LOOP
  IF jsonb_typeof(d)IS DISTINCT FROM'object'OR NOT coalesce(d->>'date'~'^\d{4}-\d{2}-\d{2}$',false)OR NOT coalesce(d->>'quantity'~'^[0-9]+([.][0-9]+)?$',false)OR jsonb_typeof(d->'units')IS DISTINCT FROM'object'OR NOT coalesce(d->'units'->>'numerator'~'^[0-9]+$',false)OR NOT coalesce(d->'units'->>'denominator'~'^[0-9]+$',false)THEN RETURN false;END IF;
  civil:=(d->>'date')::date;qty:=(d->>'quantity')::numeric;un:=(d->'units'->>'numerator')::numeric;ud:=(d->'units'->>'denominator')::numeric;
  IF qty<=0 OR un<=0 OR ud<=0 OR civil=ANY(seen)OR civil<payperiod OR civil>=(payperiod+interval'1 month')::date OR civil<(r.starts_at AT TIME ZONE'Asia/Shanghai')::date OR civil>((r.ends_at-interval'1 microsecond')AT TIME ZONE'Asia/Shanghai')::date THEN RETURN false;END IF;seen:=array_append(seen,civil);
  x:=public.fn_ty_leave_roster_civil(r.facts->'roster_source',civil,excluded);
  IF NOT coalesce(un*(x->'units'->>'denominator')::numeric=(x->'units'->>'numerator')::numeric*ud,false)OR qty IS DISTINCT FROM(CASE unit_kind WHEN'minute'THEN(x->>'request_minutes')::numeric ELSE round((x->'units'->>'numerator')::numeric/(x->'units'->>'denominator')::numeric,4)END)OR d->'roster_components'IS DISTINCT FROM x->'pieces'OR d->>'roster_hash'IS DISTINCT FROM x->>'roster_hash'OR d->>'roster_ref'IS DISTINCT FROM x->>'roster_ref'OR d->'scheduled_minutes'IS DISTINCT FROM x->'scheduled_minutes'THEN RETURN false;END IF;
 END LOOP;
 FOR civil IN SELECT z::date FROM generate_series(greatest(payperiod,(r.starts_at AT TIME ZONE'Asia/Shanghai')::date)::timestamp,least((payperiod+interval'1 month')::date-1,((r.ends_at-interval'1 microsecond')AT TIME ZONE'Asia/Shanghai')::date)::timestamp,interval'1 day')z LOOP x:=public.fn_ty_leave_roster_civil(r.facts->'roster_source',civil,excluded);IF(x->>'request_minutes')::numeric>0 THEN expected_dates:=array_append(expected_dates,civil);END IF;END LOOP;
 RETURN ARRAY(SELECT unnest(seen)ORDER BY 1)IS NOT DISTINCT FROM expected_dates;
 EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR division_by_zero OR SQLSTATE'22007' THEN RETURN false;
END;$$;
CREATE FUNCTION fn_ty_leave_roster_pay_guard()RETURNS trigger LANGUAGE plpgsql SET search_path=''AS $$DECLARE rid bigint;month_value date;BEGIN
 SELECT request_id,period INTO rid,month_value FROM public.ty_lp_parent WHERE id=NEW.parent_id;IF NOT public.fn_ty_leave_roster_pay_valid(rid,NEW.data->'days',month_value)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='假期给薪须完整保留冻结原班分母、实际民用日切片及精确比例';END IF;RETURN NEW;
END;$$;
CREATE TRIGGER aa_ty_leave_roster_pay_fact BEFORE INSERT OR UPDATE ON ty_lp_fact FOR EACH ROW EXECUTE FUNCTION fn_ty_leave_roster_pay_guard();
ALTER FUNCTION fn_ty_lp_current(bigint)RENAME TO fn_ty_lp_current_pre237;
CREATE FUNCTION fn_ty_lp_current(fact_key bigint)RETURNS boolean LANGUAGE sql STABLE SET search_path=''AS $$SELECT public.fn_ty_lp_current_pre237(fact_key)AND public.fn_ty_leave_roster_pay_valid(p.request_id,f.data->'days',p.period)FROM public.ty_lp_fact f JOIN public.ty_lp_parent p ON p.id=f.parent_id WHERE f.id=fact_key$$;
-- A civil date can contain parts of two original work-days. Keep234's legal
-- policy checks and calculation, presenting each independently guarded piece
-- to its <=1 original-work-day formula. HK statutory calendar rules stay intact.
ALTER FUNCTION fn_ty_lp_amount_data(jsonb,text)RENAME TO fn_ty_lp_amount_data_pre237;
CREATE FUNCTION fn_ty_lp_amount_data(d jsonb,part text)RETURNS numeric LANGUAGE plpgsql STABLE SET search_path=''AS $$
DECLARE r public.ty_leave_request%ROWTYPE;expanded jsonb;BEGIN
 IF d->'request'->'facts'->'roster_source'->>'version'='237'AND d->'policy'->>'benefit'LIKE'CN_%'THEN
  SELECT*INTO r FROM public.ty_leave_request WHERE id=(d->'request'->>'request_id')::bigint;
  IF r.id IS NULL OR r.status<>'taken'OR r.facts IS DISTINCT FROM d->'request'->'facts'OR NOT public.fn_ty_leave_roster_pay_valid(r.id,d->'days',(d->>'period')::date)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工作日跨午夜给薪须来自完整且有据的实际已休冻结记录';END IF;
  SELECT jsonb_agg(day_row||jsonb_build_object('units',jsonb_build_object('numerator',piece->>'request_minutes','denominator',piece->>'scheduled_minutes'))ORDER BY day_row->>'date',piece->>'work_date')INTO expanded FROM jsonb_array_elements(d->'days')day_row CROSS JOIN LATERAL jsonb_array_elements(day_row->'roster_components')piece;
  RETURN public.fn_ty_lp_amount_data_pre237(jsonb_set(d,'{days}',expanded),part);
 END IF;RETURN public.fn_ty_lp_amount_data_pre237(d,part);
END;$$;
