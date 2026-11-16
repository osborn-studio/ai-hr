-- Editable/reviewed calculation inputs are separate from immutable source data.
ALTER TABLE ty_payroll_row ADD COLUMN input_overrides jsonb NOT NULL DEFAULT '{}'::jsonb
 CHECK(jsonb_typeof(input_overrides)='object');
ALTER TABLE ty_payroll_row ADD COLUMN input_review jsonb NOT NULL DEFAULT '{}'::jsonb
 CHECK(jsonb_typeof(input_review)='object');

CREATE FUNCTION fn_ty_payroll_input_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.input_overrides IS DISTINCT FROM OLD.input_overrides OR NEW.input_review IS DISTINCT FROM OLD.input_review THEN
  NEW.result_data:=NULL; NEW.validation:='{}'::jsonb;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ty_payroll_input_guard BEFORE UPDATE ON ty_payroll_row FOR EACH ROW EXECUTE FUNCTION fn_ty_payroll_input_guard();

-- An operator script cannot confirm false amounts by merely setting
-- validation.ok=true. Financial arithmetic, source reconciliation and the
-- approved item vocabulary are checked again inside the confirmation write.
CREATE FUNCTION fn_ty_payroll_money_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r public.ty_payroll_row%ROWTYPE; e public.ty_employment%ROWTYPE;
 items jsonb; it jsonb; src jsonb; k text; v jsonb; amt numeric;
 income numeric; deductions numeric; employee numeric; employer numeric;
 computed jsonb; expected jsonb; rules jsonb; perf_total numeric; perf_code text;
BEGIN
 IF NEW.status<>'confirmed' THEN RETURN NEW; END IF;
 IF NEW.kind='calculated' THEN SELECT rs.rules INTO rules FROM public.ty_payroll_ruleset rs WHERE rs.id=NEW.ruleset_id; END IF;
 FOR r IN SELECT * FROM public.ty_payroll_row WHERE batch_id=NEW.id LOOP
  IF jsonb_array_length(COALESCE(r.source_data->'source_issues','[]'::jsonb))>0 THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资来源仍有异常，不能用核验标记跳过';
  END IF;
  IF r.source_data->>'source_period' IS NOT NULL AND r.source_data->>'source_period'<>NEW.period THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资来源期间与批次不一致';
  END IF;
  SELECT * INTO e FROM public.ty_employment WHERE id=r.employment_id;
  IF e.status='cancelled' OR e.hire_date>(NEW.period||'-01')::date+interval '1 month'-interval '1 day'
   OR (e.leave_date IS NOT NULL AND e.leave_date<(NEW.period||'-01')::date) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资雇佣未覆盖该期间';
  END IF;
  items:=CASE WHEN NEW.kind='source_snapshot' THEN r.source_data->'items' ELSE r.result_data->'items' END;
  IF NEW.kind='calculated' THEN
   IF jsonb_typeof(r.result_data->'used_inputs') IS DISTINCT FROM 'array' OR jsonb_typeof(r.result_data->'input_snapshot') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资试算缺少当前输入快照，请重新试算';
   END IF;
   FOR k IN SELECT * FROM jsonb_array_elements_text(r.result_data->'used_inputs') LOOP
    IF ((r.source_data->'input_review')?k OR r.input_overrides?k)
     AND (r.input_review->k->>'status' IS DISTINCT FROM 'verified' OR COALESCE(btrim(r.input_review->k->>'reason'),'')='') THEN
     RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='来源或修改的工资输入尚未明确核验';
    END IF;
    IF k NOT IN ('performance_bonus','performance_amount') AND (r.result_data->'input_snapshot'->k) IS DISTINCT FROM (((r.source_data->'inputs')||r.input_overrides)->k) THEN
     RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资试算输入快照已经过期';
    END IF;
   END LOOP;
  END IF;
  IF items IS NULL OR jsonb_typeof(items)<>'array' OR jsonb_array_length(items)=0 THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资项目或试算结果缺失';
  END IF;
  IF (SELECT count(*)<>count(DISTINCT x->>'code') FROM jsonb_array_elements(items) x) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资项目编码重复';
  END IF;
  IF NEW.kind='calculated' AND jsonb_array_length(items)<>jsonb_array_length(rules) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资计算项目与批准规则数量不一致';
  END IF;
  income:=0;deductions:=0;employee:=0;employer:=0;
  FOR it IN SELECT * FROM jsonb_array_elements(items) LOOP
   IF it->>'amount' IS NULL OR it->>'amount' !~ '^-?[0-9]+(\.[0-9]{1,2})?$'
    OR length(it->>'amount')>24 OR it->>'kind' IS NULL OR it->>'kind' NOT IN ('earning','deduction','employee_contribution','employer_contribution','reference') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资项目金额必须明确为至多两位小数且性质有效';
   END IF;
   IF NEW.kind='calculated' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rules) rule WHERE rule->>'code'=it->>'code' AND rule->>'kind'=it->>'kind') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资项目未列入批准的规则版本';
   END IF;
   amt:=(it->>'amount')::numeric;
   CASE it->>'kind'
    WHEN 'earning' THEN income:=income+amt;
    WHEN 'deduction' THEN deductions:=deductions+amt;
    WHEN 'employee_contribution' THEN employee:=employee+amt;
    WHEN 'employer_contribution' THEN employer:=employer+amt;
    ELSE NULL;
   END CASE;
  END LOOP;
  computed:=jsonb_build_object('income_total',income,'deduction_total',deductions,'employee_contribution',employee,
   'employer_contribution',employer,'payable_gross',income-deductions,'net_pay',income-deductions-employee,'employer_cost',income-deductions+employer);
  IF NEW.kind='calculated' THEN
   FOR k,v IN SELECT * FROM jsonb_each(computed) LOOP
    IF r.result_data->'totals'->>k IS NULL OR r.result_data->'totals'->>k !~ '^-?[0-9]+(\.[0-9]{1,2})?$'
     OR (r.result_data->'totals'->>k)::numeric<>(v::text)::numeric THEN
     RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资结果总额与项目合计不一致';
    END IF;
   END LOOP;
   FOR src IN SELECT * FROM jsonb_array_elements(COALESCE(r.source_data->'items','[]'::jsonb)) LOOP
    IF src->>'amount' IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(items) x WHERE x->>'code'=src->>'code'
      AND x->>'kind'=src->>'kind' AND (x->>'amount')::numeric=(src->>'amount')::numeric) THEN
     RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资重算未与来源逐项核对一致';
    END IF;
   END LOOP;
  ELSIF r.source_data->'source_totals'->>'net_pay' IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='来源工资缺少独立实发核对值';
  END IF;
  FOR k,v IN SELECT * FROM jsonb_each(COALESCE(r.source_data->'source_totals','{}'::jsonb)) LOOP
   IF computed->>k IS NULL OR v::text='null' OR trim(both '"' from v::text) !~ '^-?[0-9]+(\.[0-9]{1,2})?$'
    OR (computed->>k)::numeric<>trim(both '"' from v::text)::numeric THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资项目合计与来源保存总额不一致';
   END IF;
  END LOOP;
  SELECT sum(p.amount) INTO perf_total FROM public.ty_payroll_performance_input p WHERE p.row_id=r.id;
  IF perf_total IS NOT NULL THEN
   perf_code:=r.result_data->>'performance_item_code';
   IF NEW.kind<>'calculated' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(items) x WHERE x->>'code'=perf_code AND x->>'kind'='earning' AND (x->>'amount')::numeric=perf_total) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='过账绩效未以确认金额纳入工资收入';
   END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER ty_payroll_money_guard BEFORE INSERT OR UPDATE ON ty_payroll_batch FOR EACH ROW EXECUTE FUNCTION fn_ty_payroll_money_guard();
DO $$ BEGIN
 IF to_regclass('public.sys_check_registry') IS NOT NULL THEN
  INSERT INTO public.sys_check_registry(check_code,name,domain,kind,guard_object,guard_schema,guard_table,guard_kind,runner,assertion_sql) VALUES
   ('TYHR.PAYROLL.INPUT','工资输入独立覆盖与核验、输入变更清除旧试算','PAYROLL','ALGORITHM','ty_payroll_input_guard','public','ty_payroll_row','TRIGGER','node test/customer-payroll.test.mjs','node test/customer-payroll.test.mjs'),
   ('TYHR.PAYROLL.MONEY','确认前数据库金额合计、来源逐项对账和绩效收入核验','PAYROLL','RECONCILE','ty_payroll_money_guard','public','ty_payroll_batch','TRIGGER','node test/customer-payroll.test.mjs','node test/customer-payroll.test.mjs')
  ON CONFLICT(check_code) DO NOTHING;
 END IF;
END $$;
