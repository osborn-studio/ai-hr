-- Foundation governance: append-only audit, relationship change history and safe deactivation.
CREATE TABLE ty_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id bigint NOT NULL,
  action text NOT NULL,
  entity_kind text NOT NULL,
  entity_id bigint,
  before_data jsonb,
  after_data jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION fn_ty_audit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='基础配置审计只可追加，不得覆盖或删除'; END; $$;
CREATE TRIGGER trg_ty_audit_immutable BEFORE UPDATE OR DELETE ON ty_audit
FOR EACH ROW EXECUTE FUNCTION fn_ty_audit_immutable();
CREATE TRIGGER trg_ty_audit_no_truncate BEFORE TRUNCATE ON ty_audit
FOR EACH STATEMENT EXECUTE FUNCTION fn_ty_audit_immutable();

CREATE TABLE ty_company_change (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES ty_company(id),
  previous_data jsonb,
  current_data jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION fn_ty_company_change() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.ledger_id<>OLD.ledger_id OR NEW.brand_id IS DISTINCT FROM OLD.brand_id)
    AND EXISTS(SELECT 1 FROM public.ty_employment WHERE company_id=OLD.id) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='已有雇佣历史的公司不能直接改品牌或帐套，需要单独办理带生效日的归属变更';
  END IF;
  INSERT INTO public.ty_company_change(company_id,previous_data,current_data)
  VALUES(NEW.id,CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,to_jsonb(NEW));
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_ty_company_change AFTER INSERT OR UPDATE ON ty_company
FOR EACH ROW EXECUTE FUNCTION fn_ty_company_change();
CREATE TRIGGER trg_ty_company_history_immutable BEFORE UPDATE OR DELETE ON ty_company_change
FOR EACH ROW EXECUTE FUNCTION fn_ty_audit_immutable();
CREATE TRIGGER trg_ty_company_history_no_truncate BEFORE TRUNCATE ON ty_company_change
FOR EACH STATEMENT EXECUTE FUNCTION fn_ty_audit_immutable();

-- One predicate protects commands and direct status updates alike.
CREATE FUNCTION fn_ty_assert_deactivate(p_kind text,p_id bigint) RETURNS text
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v_table text; v_busy boolean:=false;
BEGIN
  v_table:=CASE p_kind WHEN 'groups' THEN 'ty_group' WHEN 'brands' THEN 'ty_brand'
    WHEN 'ledgers' THEN 'ty_ledger' WHEN 'companies' THEN 'ty_company'
    WHEN 'departments' THEN 'ty_department' WHEN 'work-areas' THEN 'ty_work_area'
    WHEN 'jobs' THEN 'ty_job' WHEN 'grades' THEN 'ty_grade'
    WHEN 'positions' THEN 'ty_company_position' WHEN 'people' THEN 'ty_person' ELSE NULL END;
  IF v_table IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='这种记录须使用结束日期或撤销流程'; END IF;
  EXECUTE format('SELECT id FROM public.%I WHERE id=$1 FOR UPDATE',v_table) USING p_id;
  IF p_kind='groups' THEN
    SELECT EXISTS(SELECT 1 FROM public.ty_brand WHERE group_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_ledger WHERE group_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_company WHERE group_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_job WHERE group_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_grade WHERE group_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_person WHERE group_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_employment WHERE group_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_position_assignment WHERE group_id=p_id AND status='active') INTO v_busy;
  ELSIF p_kind='brands' THEN
    SELECT EXISTS(SELECT 1 FROM public.ty_company WHERE brand_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_ledger WHERE brand_id=p_id AND status='active') INTO v_busy;
  ELSIF p_kind='ledgers' THEN
    SELECT EXISTS(SELECT 1 FROM public.ty_company WHERE ledger_id=p_id AND status='active') INTO v_busy;
  ELSIF p_kind='companies' THEN
    SELECT EXISTS(SELECT 1 FROM public.ty_department WHERE company_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_work_area WHERE company_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_company_position WHERE company_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_employment WHERE company_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_position_assignment WHERE company_id=p_id AND status='active') INTO v_busy;
  ELSIF p_kind='departments' THEN
    SELECT EXISTS(SELECT 1 FROM public.ty_department WHERE parent_department_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_company_position WHERE department_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_work_area WHERE department_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_position_assignment WHERE department_id=p_id AND status='active') INTO v_busy;
  ELSIF p_kind='work-areas' THEN
    SELECT EXISTS(SELECT 1 FROM public.ty_position_assignment WHERE work_area_id=p_id AND status='active') INTO v_busy;
  ELSIF p_kind='jobs' THEN
    SELECT EXISTS(SELECT 1 FROM public.ty_company_position WHERE job_id=p_id AND status='active') INTO v_busy;
  ELSIF p_kind='grades' THEN
    SELECT EXISTS(SELECT 1 FROM public.ty_company_position WHERE grade_id=p_id AND status='active')
      OR EXISTS(SELECT 1 FROM public.ty_position_assignment WHERE grade_id=p_id AND status='active') INTO v_busy;
  ELSIF p_kind='positions' THEN
    SELECT EXISTS(SELECT 1 FROM public.ty_position_assignment WHERE position_id=p_id AND status='active') INTO v_busy;
  ELSIF p_kind='people' THEN
    SELECT EXISTS(SELECT 1 FROM public.ty_employment WHERE person_id=p_id AND status='active') INTO v_busy;
  END IF;
  IF v_busy THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='还有启用的下级或在职任职记录，请先处理依赖再停用'; END IF;
  RETURN v_table;
END; $$;

CREATE FUNCTION fn_ty_deactivate(p_kind text,p_id bigint) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v_table text;
BEGIN
  v_table:=public.fn_ty_assert_deactivate(p_kind,p_id);
  EXECUTE format('UPDATE public.%I SET status=''inactive'' WHERE id=$1',v_table) USING p_id;
END; $$;

CREATE FUNCTION fn_ty_require_active(p_table text,p_id bigint) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v_status text;
BEGIN
  IF p_id IS NULL THEN RETURN; END IF;
  IF p_table NOT IN ('ty_group','ty_brand','ty_ledger','ty_company','ty_department',
      'ty_work_area','ty_job','ty_grade','ty_company_position','ty_person','ty_employment') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='不支持的基础引用类型';
  END IF;
  -- Hold the parent lock until commit: deactivation and dependency creation must
  -- not both pass checks against the other transaction's uncommitted change.
  EXECUTE format('SELECT status FROM public.%I WHERE id=$1 FOR UPDATE',p_table) INTO v_status USING p_id;
  IF v_status IS NULL THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='引用的基础记录不存在'; END IF;
  IF v_status<>'active' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='启用或新增业务不能引用已停用或已结束的基础记录';
  END IF;
END; $$;

CREATE FUNCTION fn_ty_active_reference_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v jsonb:=to_jsonb(NEW); v_kind text;
BEGIN
  v_kind:=CASE TG_TABLE_NAME WHEN 'ty_group' THEN 'groups' WHEN 'ty_brand' THEN 'brands'
    WHEN 'ty_ledger' THEN 'ledgers' WHEN 'ty_company' THEN 'companies'
    WHEN 'ty_department' THEN 'departments' WHEN 'ty_work_area' THEN 'work-areas'
    WHEN 'ty_job' THEN 'jobs' WHEN 'ty_grade' THEN 'grades'
    WHEN 'ty_company_position' THEN 'positions' WHEN 'ty_person' THEN 'people' ELSE NULL END;
  IF TG_OP='UPDATE' AND v_kind IS NOT NULL AND OLD.status='active' AND NEW.status='inactive' THEN
    PERFORM public.fn_ty_assert_deactivate(v_kind,NEW.id);
  END IF;
  -- Historical ended/cancelled employment and assignment rows can retain their
  -- original references after a company closes; they are not active dependents.
  IF NEW.status<>'active' THEN RETURN NEW; END IF;
  IF v ? 'group_id' THEN PERFORM public.fn_ty_require_active('ty_group',(v->>'group_id')::bigint); END IF;
  IF TG_TABLE_NAME IN ('ty_ledger','ty_company') THEN
    PERFORM public.fn_ty_require_active('ty_brand',(v->>'brand_id')::bigint);
  END IF;
  IF TG_TABLE_NAME='ty_company' THEN PERFORM public.fn_ty_require_active('ty_ledger',(v->>'ledger_id')::bigint); END IF;
  IF v ? 'company_id' THEN PERFORM public.fn_ty_require_active('ty_company',(v->>'company_id')::bigint); END IF;
  IF v ? 'parent_department_id' THEN
    PERFORM public.fn_ty_require_active('ty_department',(v->>'parent_department_id')::bigint);
  END IF;
  IF v ? 'department_id' THEN PERFORM public.fn_ty_require_active('ty_department',(v->>'department_id')::bigint); END IF;
  IF v ? 'job_id' THEN PERFORM public.fn_ty_require_active('ty_job',(v->>'job_id')::bigint); END IF;
  IF v ? 'position_id' THEN PERFORM public.fn_ty_require_active('ty_company_position',(v->>'position_id')::bigint); END IF;
  IF v ? 'grade_id' THEN PERFORM public.fn_ty_require_active('ty_grade',(v->>'grade_id')::bigint); END IF;
  IF v ? 'work_area_id' THEN PERFORM public.fn_ty_require_active('ty_work_area',(v->>'work_area_id')::bigint); END IF;
  IF v ? 'person_id' THEN PERFORM public.fn_ty_require_active('ty_person',(v->>'person_id')::bigint); END IF;
  IF v ? 'employment_id' THEN PERFORM public.fn_ty_require_active('ty_employment',(v->>'employment_id')::bigint); END IF;
  RETURN NEW;
END; $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ty_group','ty_brand','ty_ledger','ty_company','ty_department',
    'ty_work_area','ty_job','ty_grade','ty_company_position','ty_person','ty_employment','ty_position_assignment']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_ty_active_reference BEFORE INSERT OR UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.fn_ty_active_reference_guard()',t);
  END LOOP;
END; $$;
