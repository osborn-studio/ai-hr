-- Preserve compatibility payroll for supported direct employment only.
CREATE FUNCTION fn_ty_legacy_service_unsafe(p_entity bigint,p_period text)RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.ty_legacy_company_binding b JOIN public.ty_employment e ON e.company_id=b.company_id WHERE b.payroll_legal_entity_id=p_entity AND e.status<>'cancelled'AND e.hire_date<(p_period||'-01')::date+interval '1 month'AND(e.leave_date IS NULL OR e.leave_date>=(p_period||'-01')::date)AND(e.employment_type='outsourced'OR EXISTS(SELECT 1 FROM public.ty_employment other WHERE other.person_id=e.person_id AND other.id<>e.id AND other.status<>'cancelled'AND other.hire_date<(p_period||'-01')::date+interval '1 month'AND(other.leave_date IS NULL OR other.leave_date>=(p_period||'-01')::date)AND daterange(e.hire_date,e.leave_date+1,'[)')&&daterange(other.hire_date,other.leave_date+1,'[)'))))
$$;
CREATE OR REPLACE FUNCTION fn_ty_legacy_payroll_region_guard()RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE entity_id bigint;pay_period text;
BEGIN
 IF TG_TABLE_NAME='pay_run' THEN entity_id:=NEW.legal_entity_id;pay_period:=NEW.period;
 ELSE SELECT legal_entity_id,period INTO entity_id,pay_period FROM public.pay_run WHERE id=NEW.pay_run_id;END IF;
 IF EXISTS(SELECT 1 FROM public.ty_legacy_company_binding b CROSS JOIN LATERAL public.fn_ty_company_locale(b.company_id)loc WHERE b.payroll_legal_entity_id=entity_id AND loc.region_code IS NOT NULL AND loc.region_code<>'CN')THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='此发薪主体包含香港或其他非内地公司，请使用对应地区的新薪酬核算工作台';END IF;
 IF public.fn_ty_legacy_service_unsafe(entity_id,pay_period)THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='本期包含新版外包服务或并行用工，请使用新版薪酬核算与外包账单，不能按旧直营模型算薪';END IF;
 RETURN NEW;
END $$;
INSERT INTO sys_check_registry(check_code,name,domain,kind,guard_object,guard_schema,guard_table,guard_kind,runner,assertion_sql)VALUES('TYHR.LEGACY-SERVICE','外包并行用工不误用兼容算薪','PAYROLL','ALGORITHM','ty_legacy_payrun_region','public','pay_run','TRIGGER','node test/outsourcing.test.mjs','node test/outsourcing.test.mjs');
