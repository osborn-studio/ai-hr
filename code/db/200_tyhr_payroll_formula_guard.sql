-- Database-authoritative payroll: evaluate the approved AST independently of
-- client/service result metadata. Exact fractions avoid division/half-cent drift.
CREATE FUNCTION fn_ty_payroll_fraction(p_n numeric,p_d numeric) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE n numeric:=p_n; d numeric:=p_d; g numeric;
BEGIN
 IF n IS NULL OR d IS NULL OR d=0 OR n<>trunc(n) OR d<>trunc(d) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬数值无效或除数为零';
 END IF;
 IF d<0 THEN n:=-n;d:=-d;END IF;
 g:=gcd(abs(n),d);IF g=0 THEN g:=1;END IF;
 n:=div(n,g);d:=div(d,g);
 IF length(n::text)>90 OR length(d::text)>90 THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬数值超出计算范围';
 END IF;
 RETURN jsonb_build_object('_ty_num',true,'n',n::text,'d',d::text);
END $$;

CREATE FUNCTION fn_ty_payroll_number(p_v jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE s text; a numeric; exp_match text[]; exponent numeric; fractional integer;
BEGIN
 IF jsonb_typeof(p_v)='object' AND p_v->'_ty_num'='true'::jsonb THEN
  RETURN public.fn_ty_payroll_fraction((p_v->>'n')::numeric,(p_v->>'d')::numeric);
 END IF;
 IF jsonb_typeof(p_v) NOT IN ('string','number') OR p_v IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬运算需要明确数值';
 END IF;
 s:=btrim(p_v#>>'{}');
 IF length(s)>70 OR s !~ '^[+-]?[0-9]+(\.[0-9]*)?([eE][+-]?[0-9]+)?$' THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬输入不是有效数值';
 END IF;
 exp_match:=regexp_match(s,'[eE]([+-]?[0-9]+)$');
 exponent:=CASE WHEN exp_match IS NULL THEN 0 ELSE exp_match[1]::numeric END;
 fractional:=length(COALESCE((regexp_match(s,'\.([0-9]*)'))[1],''));
 IF abs(exponent-fractional)>30 THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬数值精度超限';
 END IF;
 a:=s::numeric;
 RETURN public.fn_ty_payroll_fraction(a*power(10::numeric,scale(a)),power(10::numeric,scale(a)));
END $$;

CREATE FUNCTION fn_ty_payroll_round_fraction(p_v jsonb,p_places integer) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v jsonb; n numeric; d numeric; s numeric; magnitude numeric; q numeric;
BEGIN
 IF p_places IS NULL OR p_places<0 OR p_places>8 THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ROUND小数位须为0至8的整数';
 END IF;
 v:=public.fn_ty_payroll_number(p_v);n:=(v->>'n')::numeric;d:=(v->>'d')::numeric;
 s:=power(10::numeric,p_places);magnitude:=abs(n)*s;
 q:=div(magnitude,d)+CASE WHEN mod(magnitude,d)*2>=d THEN 1 ELSE 0 END;
 RETURN public.fn_ty_payroll_fraction(CASE WHEN n<0 THEN -q ELSE q END,s);
END $$;

CREATE FUNCTION fn_ty_payroll_money(p_v jsonb) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v jsonb;
BEGIN
 v:=public.fn_ty_payroll_round_fraction(p_v,2);
 RETURN div((v->>'n')::numeric*100,(v->>'d')::numeric)*0.01::numeric;
END $$;

-- Validate every branch, even one skipped by IF, and collect static dependencies.
CREATE FUNCTION fn_ty_payroll_ast_meta(p_ast jsonb,p_depth integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE typ text:=jsonb_typeof(p_ast); op text; a jsonb; child jsonb;
 vars jsonb:='[]'; count_nodes integer:=1; argc integer; lo integer; hi integer;
BEGIN
 IF p_depth>30 OR p_ast IS NULL OR typ NOT IN ('number','string','boolean','object') THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬公式节点无效或过深';
 END IF;
 IF typ IN ('number','string','boolean') THEN RETURN jsonb_build_object('vars',vars,'count',count_nodes);END IF;
 IF p_ast?'var' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p_ast))<>1 OR jsonb_typeof(p_ast->'var') IS DISTINCT FROM 'string' OR p_ast->>'var' !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬公式变量名无效';
  END IF;
  RETURN jsonb_build_object('vars',jsonb_build_array(p_ast->>'var'),'count',1);
 END IF;
 op:=p_ast->>'op';
 IF (SELECT count(*) FROM jsonb_object_keys(p_ast))<>2 OR NOT(p_ast?'args') OR jsonb_typeof(p_ast->'args')<>'array' THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬公式结构无效';
 END IF;
 CASE op
  WHEN 'add','multiply','and','or' THEN lo:=2;hi:=20;
  WHEN 'min','max' THEN lo:=1;hi:=20;
  WHEN 'subtract','divide','eq','ne','lt','lte','gt','gte' THEN lo:=2;hi:=2;
  WHEN 'if' THEN lo:=3;hi:=3;
  WHEN 'round' THEN lo:=1;hi:=2;
  ELSE RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬公式使用了不支持的操作';
 END CASE;
 argc:=jsonb_array_length(p_ast->'args');
 IF argc<lo OR argc>hi THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬公式参数数量错误';END IF;
 FOR a IN SELECT * FROM jsonb_array_elements(p_ast->'args') LOOP
  child:=public.fn_ty_payroll_ast_meta(a,p_depth+1);
  vars:=vars||(child->'vars');count_nodes:=count_nodes+(child->>'count')::integer;
  IF count_nodes>300 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬公式节点数量超限';END IF;
 END LOOP;
 RETURN jsonb_build_object('vars',vars,'count',count_nodes);
END $$;

-- Internal evaluator returns {v,used}; v is a boolean/string or exact fraction.
CREATE FUNCTION fn_ty_payroll_eval_node(p_ast jsonb,p_context jsonb,p_depth integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE op text; args jsonb; child jsonb; other jsonb; values_json jsonb:='[]';
 used jsonb:='[]'; a jsonb; value jsonb; left_num jsonb; right_num jsonb;
 n numeric; d numeric; bn numeric; bd numeric; comparison numeric; eq_value boolean;
 i integer; places integer:=2; chosen integer;
BEGIN
 IF p_depth>30 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬公式过深';END IF;
 IF jsonb_typeof(p_ast)<>'object' THEN RETURN jsonb_build_object('v',p_ast,'used',used);END IF;
 IF p_ast?'var' THEN
  IF NOT(p_context?(p_ast->>'var')) OR p_context->(p_ast->>'var') IN ('null'::jsonb,'""'::jsonb) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬公式缺少输入：'||(p_ast->>'var');
  END IF;
  RETURN jsonb_build_object('v',p_context->(p_ast->>'var'),'used',jsonb_build_array(p_ast->>'var'));
 END IF;
 op:=p_ast->>'op';args:=p_ast->'args';
 IF op='if' THEN
  child:=public.fn_ty_payroll_eval_node(args->0,p_context,p_depth+1);
  IF jsonb_typeof(child->'v')<>'boolean' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='IF条件需要明确真假';END IF;
  chosen:=CASE WHEN child->'v'='true'::jsonb THEN 1 ELSE 2 END;
  other:=public.fn_ty_payroll_eval_node(args->chosen,p_context,p_depth+1);
  RETURN jsonb_build_object('v',other->'v','used',(child->'used')||(other->'used'));
 END IF;
 IF op IN ('and','or') THEN
  FOR a IN SELECT * FROM jsonb_array_elements(args) LOOP
   child:=public.fn_ty_payroll_eval_node(a,p_context,p_depth+1);used:=used||(child->'used');
   IF jsonb_typeof(child->'v')<>'boolean' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='逻辑运算需要明确真假';END IF;
   IF (op='and' AND child->'v'='false'::jsonb) OR (op='or' AND child->'v'='true'::jsonb) THEN
    RETURN jsonb_build_object('v',child->'v','used',used);
   END IF;
  END LOOP;
  RETURN jsonb_build_object('v',to_jsonb(op='and'),'used',used);
 END IF;
 FOR a IN SELECT * FROM jsonb_array_elements(args) LOOP
  child:=public.fn_ty_payroll_eval_node(a,p_context,p_depth+1);
  values_json:=values_json||jsonb_build_array(child->'v');used:=used||(child->'used');
 END LOOP;
 IF op IN ('eq','ne') THEN
  BEGIN
   left_num:=public.fn_ty_payroll_number(values_json->0);right_num:=public.fn_ty_payroll_number(values_json->1);
   eq_value:=(left_num->>'n')::numeric*(right_num->>'d')::numeric=(right_num->>'n')::numeric*(left_num->>'d')::numeric;
  EXCEPTION WHEN check_violation THEN eq_value:=values_json->0=values_json->1; END;
  RETURN jsonb_build_object('v',to_jsonb(CASE WHEN op='eq' THEN eq_value ELSE NOT eq_value END),'used',used);
 END IF;
 left_num:=public.fn_ty_payroll_number(values_json->0);n:=(left_num->>'n')::numeric;d:=(left_num->>'d')::numeric;
 IF op='round' THEN
  IF jsonb_array_length(values_json)=2 THEN
   right_num:=public.fn_ty_payroll_number(values_json->1);bn:=(right_num->>'n')::numeric;bd:=(right_num->>'d')::numeric;
   IF mod(bn,bd)<>0 OR bn<0 OR bn>8*bd THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ROUND小数位须为0至8的整数';END IF;
   places:=div(bn,bd)::integer;
  END IF;
  RETURN jsonb_build_object('v',public.fn_ty_payroll_round_fraction(left_num,places),'used',used);
 END IF;
 FOR i IN 1..jsonb_array_length(values_json)-1 LOOP
  right_num:=public.fn_ty_payroll_number(values_json->i);bn:=(right_num->>'n')::numeric;bd:=(right_num->>'d')::numeric;
  comparison:=n*bd-bn*d;
  CASE op
   WHEN 'add' THEN n:=n*bd+bn*d;d:=d*bd;
   WHEN 'subtract' THEN n:=n*bd-bn*d;d:=d*bd;
   WHEN 'multiply' THEN n:=n*bn;d:=d*bd;
   WHEN 'divide' THEN n:=n*bd;d:=d*bn;
   WHEN 'min' THEN IF comparison>=0 THEN n:=bn;d:=bd;END IF;
   WHEN 'max' THEN IF comparison<=0 THEN n:=bn;d:=bd;END IF;
   WHEN 'lt','lte','gt','gte' THEN
    RETURN jsonb_build_object('v',to_jsonb(CASE op WHEN 'lt' THEN comparison<0 WHEN 'lte' THEN comparison<=0 WHEN 'gt' THEN comparison>0 ELSE comparison>=0 END),'used',used);
   ELSE RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬公式操作无效';
  END CASE;
  value:=public.fn_ty_payroll_fraction(n,d);n:=(value->>'n')::numeric;d:=(value->>'d')::numeric;
 END LOOP;
 RETURN jsonb_build_object('v',public.fn_ty_payroll_fraction(n,d),'used',used);
END $$;

CREATE FUNCTION fn_ty_payroll_eval(p_ast jsonb,p_context jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN
 PERFORM public.fn_ty_payroll_ast_meta(p_ast);
 IF jsonb_typeof(p_context)<>'object' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬公式输入必须为对象';END IF;
 RETURN public.fn_ty_payroll_eval_node(p_ast,p_context);
END $$;

CREATE FUNCTION fn_ty_payroll_formula_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE rs public.ty_payroll_ruleset%ROWTYPE; r public.ty_payroll_row%ROWTYPE;
 rules jsonb; rule jsonb; meta jsonb; metas jsonb:='{}'; context jsonb; initial_context jsonb;
 value jsonb; actual jsonb; expected numeric; perf_total numeric; p public.ty_payroll_performance_input%ROWTYPE;
 tainted text[]:=ARRAY['performance_bonus','performance_amount']; bonus_codes text[]:='{}';
 rule_codes text[]:='{}'; derived text[]; used_keys text[]; actual_used jsonb; declared_used jsonb; key text;
BEGIN
 IF NEW.status<>'confirmed' OR NEW.kind<>'calculated' THEN RETURN NEW;END IF;
 SELECT * INTO rs FROM public.ty_payroll_ruleset WHERE id=NEW.ruleset_id;
 IF rs.status IS DISTINCT FROM 'approved' OR rs.group_id<>NEW.group_id OR rs.currency<>NEW.currency THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='薪酬必须使用同集团同币种已启用规则';
 END IF;
 rules:=rs.rules;
 IF jsonb_array_length(rules)>100 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资规则数量超限';END IF;
 FOR rule IN SELECT * FROM jsonb_array_elements(rules) LOOP
  key:=rule->>'code';
  IF key IS NULL OR key !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' OR key=ANY(rule_codes) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='批准规则工资项编码无效或重复';
  END IF;
  rule_codes:=array_append(rule_codes,key);meta:=public.fn_ty_payroll_ast_meta(rule->'formula');
  metas:=metas||jsonb_build_object(key,meta);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(meta->'vars') x WHERE x=ANY(tainted)) THEN
   tainted:=array_append(tainted,key);IF rule->>'kind'='earning' THEN bonus_codes:=array_append(bonus_codes,key);END IF;
  END IF;
 END LOOP;
 FOR r IN SELECT * FROM public.ty_payroll_row WHERE batch_id=NEW.id LOOP
  context:=COALESCE(r.source_data->'inputs','{}')||r.input_overrides;
  IF jsonb_typeof(context)<>'object' OR EXISTS(SELECT 1 FROM jsonb_each(context) x WHERE jsonb_typeof(x.value) NOT IN ('string','number','boolean','null')) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资输入仅能包含简单值';
  END IF;
  SELECT COALESCE(sum(amount),0) INTO perf_total FROM public.ty_payroll_performance_input WHERE row_id=r.id;
  FOR p IN SELECT * FROM public.ty_payroll_performance_input WHERE row_id=r.id LOOP
   IF NOT EXISTS(SELECT 1 FROM public.ty_perf_result pr JOIN public.ty_perf_cycle pc ON pc.id=pr.cycle_id
    WHERE pr.id=(p.candidate->>'result_id')::bigint AND pr.cycle_id=p.cycle_id AND pr.result_version=p.result_version
     AND pc.status='confirmed' AND pc.result_version=p.result_version AND pc.group_id=NEW.group_id AND pc.currency_code=NEW.currency
     AND pr.kind='person_bonus' AND pr.person_id=r.person_id AND pr.company_id=r.company_id AND pr.employment_id=r.employment_id
     AND p.source_key='perf:'||pr.cycle_id::text||':'||pr.result_version::text||':'||pr.id::text
     AND to_char(pr.period,'YYYY-MM')=NEW.period
     AND pr.amount=COALESCE(p.candidate->>'amount_exact',p.candidate->>'amount')::numeric
     AND p.amount=CASE WHEN p.candidate->>'payroll_rounding'='round_2' THEN round(pr.amount,2) ELSE pr.amount END
     AND jsonb_array_length(pr.issues)=0) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='绩效工资输入没有匹配当前已确认结果';
   END IF;
  END LOOP;
  context:=context||jsonb_build_object('performance_bonus',perf_total,'performance_amount',perf_total);
  initial_context:=context;derived:='{}';used_keys:='{}';
  IF EXISTS(SELECT 1 FROM public.ty_payroll_performance_input WHERE row_id=r.id) AND cardinality(bonus_codes)<>1 THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='确认绩效须以唯一工资收入项入薪';
  END IF;
  FOR rule IN SELECT * FROM jsonb_array_elements(rules) LOOP
   value:=public.fn_ty_payroll_eval_node(rule->'formula',context);
   expected:=public.fn_ty_payroll_money(value->'v');
   SELECT x INTO actual FROM jsonb_array_elements(r.result_data->'items') x WHERE x->>'code'=rule->>'code';
   IF actual IS NULL OR actual->>'kind' IS DISTINCT FROM rule->>'kind' OR actual->>'amount' IS NULL
     OR (actual->>'amount')::numeric<>expected THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资项目金额不符合已批准公式的数据库重算';
   END IF;
   IF (rule->>'code')=ANY(bonus_codes) AND EXISTS(SELECT 1 FROM public.ty_payroll_performance_input WHERE row_id=r.id)
     AND (expected<>perf_total OR r.result_data->>'performance_item_code' IS DISTINCT FROM rule->>'code') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='绩效收入金额或工资项与已确认来源不一致';
   END IF;
   FOR key IN SELECT * FROM jsonb_array_elements_text(value->'used') LOOP
    IF NOT(key=ANY(derived)) THEN
     IF NOT(key=ANY(used_keys)) THEN used_keys:=array_append(used_keys,key);END IF;
     IF key NOT IN ('performance_bonus','performance_amount') THEN
      IF (((r.source_data->'input_review')?key) OR r.input_overrides?key)
       AND (r.input_review->key->>'status' IS DISTINCT FROM 'verified' OR COALESCE(btrim(r.input_review->key->>'reason'),'')='') THEN
       RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='数据库重算实际读取的工资输入尚未核验';
      END IF;
      IF (r.result_data->'input_snapshot'->key) IS DISTINCT FROM initial_context->key THEN
       RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='数据库重算发现工资输入快照不一致';
      END IF;
     END IF;
    END IF;
   END LOOP;
   context:=context||jsonb_build_object(rule->>'code',expected::text);derived:=array_append(derived,rule->>'code');
  END LOOP;
  SELECT COALESCE(jsonb_agg(k ORDER BY k),'[]') INTO actual_used FROM unnest(used_keys) k;
  SELECT COALESCE(jsonb_agg(k ORDER BY k),'[]') INTO declared_used FROM jsonb_array_elements_text(r.result_data->'used_inputs') k;
  IF actual_used IS DISTINCT FROM declared_used THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资实际输入依赖与保存的使用记录不一致';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER ty_payroll_formula_guard BEFORE INSERT OR UPDATE ON ty_payroll_batch FOR EACH ROW EXECUTE FUNCTION fn_ty_payroll_formula_guard();

CREATE FUNCTION fn_ty_payroll_no_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='工资来源、审计及过账记录禁止TRUNCATE';END $$;
CREATE TRIGGER ty_payroll_audit_no_truncate BEFORE TRUNCATE ON ty_payroll_audit FOR EACH STATEMENT EXECUTE FUNCTION fn_ty_payroll_no_truncate();
CREATE TRIGGER ty_payroll_posted_no_truncate BEFORE TRUNCATE ON ty_payroll_posted_person FOR EACH STATEMENT EXECUTE FUNCTION fn_ty_payroll_no_truncate();
CREATE TRIGGER ty_payroll_performance_no_truncate BEFORE TRUNCATE ON ty_payroll_performance_input FOR EACH STATEMENT EXECUTE FUNCTION fn_ty_payroll_no_truncate();
CREATE TRIGGER ty_payroll_row_no_truncate BEFORE TRUNCATE ON ty_payroll_row FOR EACH STATEMENT EXECUTE FUNCTION fn_ty_payroll_no_truncate();
CREATE TRIGGER ty_payroll_batch_no_truncate BEFORE TRUNCATE ON ty_payroll_batch FOR EACH STATEMENT EXECUTE FUNCTION fn_ty_payroll_no_truncate();
CREATE TRIGGER ty_payroll_rules_no_truncate BEFORE TRUNCATE ON ty_payroll_ruleset FOR EACH STATEMENT EXECUTE FUNCTION fn_ty_payroll_no_truncate();
CREATE TRIGGER ty_perf_payroll_source_no_truncate BEFORE TRUNCATE ON ty_perf_result FOR EACH STATEMENT EXECUTE FUNCTION fn_ty_payroll_no_truncate();

DO $$ BEGIN
 IF to_regclass('public.sys_check_registry') IS NOT NULL THEN
  INSERT INTO public.sys_check_registry(check_code,name,domain,kind,guard_object,guard_schema,guard_table,guard_kind,runner,assertion_sql) VALUES
   ('TYHR.PAYROLL.FORMULA','数据库批准AST独立重算、精确舍入、真实绩效与实际输入依赖','PAYROLL','ALGORITHM','ty_payroll_formula_guard','public','ty_payroll_batch','TRIGGER','node test/customer-payroll.test.mjs','node test/customer-payroll.test.mjs'),
   ('TYHR.PAYROLL.APPEND','工资审计和来源过账禁止TRUNCATE绕过追加锁定','SECURITY','STRUCT','ty_payroll_audit_no_truncate','public','ty_payroll_audit','TRIGGER','node test/customer-payroll.test.mjs','node test/customer-payroll.test.mjs')
  ON CONFLICT(check_code) DO NOTHING;
 END IF;
END $$;
