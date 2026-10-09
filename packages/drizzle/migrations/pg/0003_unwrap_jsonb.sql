-- Earlier versions stored every jsonb value as a JSON string (the object was stringified before the
-- driver encoded it again), so jsonb held "[\"a\"]" instead of ["a"]. Decode those strings once,
-- in every jsonb column; values that are genuine strings (not JSON text) are left as they are.
CREATE FUNCTION pg_temp.polpo_unwrap_jsonb(value jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(value) <> 'string' THEN RETURN value; END IF;
  BEGIN
    RETURN (value #>> '{}')::jsonb;
  EXCEPTION WHEN others THEN
    RETURN value;
  END;
END $$;
--> statement-breakpoint
DO $$
DECLARE col record;
BEGIN
  FOR col IN
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'jsonb'
  LOOP
    EXECUTE format(
      'UPDATE %I SET %I = pg_temp.polpo_unwrap_jsonb(%I) WHERE jsonb_typeof(%I) = ''string''',
      col.table_name, col.column_name, col.column_name, col.column_name
    );
  END LOOP;
END $$;
