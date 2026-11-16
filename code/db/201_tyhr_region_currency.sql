-- Locale is configuration, never inferred from a brand name or currency symbol.
ALTER TABLE ty_brand ADD COLUMN region_code text CHECK(region_code ~ '^[A-Z]{2}$');
ALTER TABLE ty_brand ADD COLUMN currency_code text CHECK(currency_code ~ '^[A-Z]{3}$');
ALTER TABLE ty_brand ADD CONSTRAINT ty_brand_locale_pair CHECK((region_code IS NULL)=(currency_code IS NULL));
ALTER TABLE ty_ledger ADD COLUMN region_code text CHECK(region_code ~ '^[A-Z]{2}$');
ALTER TABLE ty_ledger ADD COLUMN currency_code text CHECK(currency_code ~ '^[A-Z]{3}$');
ALTER TABLE ty_ledger ADD CONSTRAINT ty_ledger_locale_pair CHECK((region_code IS NULL)=(currency_code IS NULL));

CREATE FUNCTION fn_ty_company_locale(p_company bigint)
RETURNS TABLE(group_id bigint,ledger_id bigint,region_code text,currency_code text)
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT c.group_id,c.ledger_id,COALESCE(b.region_code,l.region_code),COALESCE(b.currency_code,l.currency_code)
 FROM public.ty_company c JOIN public.ty_ledger l ON l.id=c.ledger_id
 LEFT JOIN public.ty_brand b ON b.id=COALESCE(c.brand_id,l.brand_id) WHERE c.id=p_company;
$$;

CREATE FUNCTION fn_ty_ledger_locale_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE b public.ty_brand%ROWTYPE;
BEGIN
 IF NEW.brand_id IS NOT NULL THEN
  SELECT * INTO b FROM public.ty_brand WHERE id=NEW.brand_id;
  IF b.region_code IS NOT NULL THEN
   NEW.region_code:=COALESCE(NEW.region_code,b.region_code);
   NEW.currency_code:=COALESCE(NEW.currency_code,b.currency_code);
   IF NEW.region_code<>b.region_code OR NEW.currency_code<>b.currency_code THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='品牌帐套的地区与币种须与所属品牌一致';
   END IF;
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.ty_company c JOIN public.ty_brand cb ON cb.id=c.brand_id
    WHERE c.ledger_id=NEW.id AND cb.region_code IS NOT NULL AND NEW.region_code IS NOT NULL
      AND (cb.region_code<>NEW.region_code OR cb.currency_code<>NEW.currency_code)) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='帐套地区币种与现有公司品牌声明不一致';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ty_ledger_locale_guard BEFORE INSERT OR UPDATE ON ty_ledger
FOR EACH ROW EXECUTE FUNCTION fn_ty_ledger_locale_guard();

CREATE FUNCTION fn_ty_company_locale_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE b public.ty_brand%ROWTYPE; l public.ty_ledger%ROWTYPE;
BEGIN
 SELECT * INTO l FROM public.ty_ledger WHERE id=NEW.ledger_id;
 SELECT * INTO b FROM public.ty_brand WHERE id=COALESCE(NEW.brand_id,l.brand_id);
 IF b.region_code IS NOT NULL AND l.region_code IS NOT NULL
   AND (b.region_code<>l.region_code OR b.currency_code<>l.currency_code) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='经营公司的品牌与业务帐套地区币种冲突';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ty_company_locale_guard BEFORE INSERT OR UPDATE ON ty_company
FOR EACH ROW EXECUTE FUNCTION fn_ty_company_locale_guard();

CREATE FUNCTION fn_ty_brand_locale_before() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF OLD.region_code IS NULL AND NEW.region_code IS NOT NULL AND EXISTS(
   SELECT 1 FROM public.ty_ledger l WHERE l.brand_id=NEW.id AND l.region_code IS NOT NULL
    AND (l.region_code<>NEW.region_code OR l.currency_code<>NEW.currency_code)) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='既有帐套已声明不同地区或币种，请先核对配置';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ty_brand_locale_before BEFORE UPDATE OF region_code,currency_code ON ty_brand
FOR EACH ROW EXECUTE FUNCTION fn_ty_brand_locale_before();

CREATE FUNCTION fn_ty_brand_locale_propagate() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.region_code IS DISTINCT FROM OLD.region_code OR NEW.currency_code IS DISTINCT FROM OLD.currency_code THEN
  UPDATE public.ty_ledger SET region_code=NEW.region_code,currency_code=NEW.currency_code
   WHERE brand_id=NEW.id AND (region_code IS NULL OR
     (region_code IS NOT DISTINCT FROM OLD.region_code AND currency_code IS NOT DISTINCT FROM OLD.currency_code));
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ty_brand_locale_propagate AFTER UPDATE OF region_code,currency_code ON ty_brand
FOR EACH ROW EXECUTE FUNCTION fn_ty_brand_locale_propagate();

INSERT INTO sys_check_registry(check_code,name,domain,kind,guard_object,guard_schema,guard_table,guard_kind,runner,assertion_sql)
VALUES('TYHR.LOCALE','品牌、帐套和公司地区币种一致性','ORG','ALGORITHM','ty_company_locale_guard','public','ty_company','TRIGGER',
 'node test/region.test.mjs','node test/region.test.mjs') ON CONFLICT(check_code) DO NOTHING;
