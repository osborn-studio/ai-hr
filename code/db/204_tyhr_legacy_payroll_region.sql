-- The original payroll engine uses Mainland payroll/tax policies. A company
-- explicitly configured elsewhere must use its region's new workbench.
CREATE FUNCTION fn_ty_legacy_payroll_region_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE entity_id bigint;
BEGIN
 IF TG_TABLE_NAME='pay_run' THEN entity_id:=NEW.legal_entity_id;
 ELSE SELECT legal_entity_id INTO entity_id FROM public.pay_run WHERE id=NEW.pay_run_id; END IF;
 IF EXISTS(SELECT 1 FROM public.ty_legacy_company_binding b
   CROSS JOIN LATERAL public.fn_ty_company_locale(b.company_id) loc
   WHERE b.payroll_legal_entity_id=entity_id AND loc.region_code IS NOT NULL AND loc.region_code<>'CN') THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='此发薪主体包含香港或其他非内地公司，请使用对应地区的新薪酬核算工作台';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ty_legacy_payrun_region BEFORE INSERT OR UPDATE ON pay_run
FOR EACH ROW EXECUTE FUNCTION fn_ty_legacy_payroll_region_guard();
CREATE TRIGGER ty_legacy_payslip_region BEFORE INSERT OR UPDATE ON payslip
FOR EACH ROW EXECUTE FUNCTION fn_ty_legacy_payroll_region_guard();
INSERT INTO sys_check_registry(check_code,name,domain,kind,guard_object,guard_schema,guard_table,guard_kind,runner,assertion_sql)
VALUES('TYHR.LEGACY-REGION','香港公司不得误用原内地工资税费引擎','PAYROLL','ALGORITHM','ty_legacy_payrun_region','public','pay_run','TRIGGER',
 'node test/legacy-region.test.mjs','node test/legacy-region.test.mjs') ON CONFLICT(check_code) DO NOTHING;
