-- ═══════════════════════════════════════════════════════════════
-- ATTAIR Database Functions & Triggers
-- Run this after 001-schema.sql.
-- All statements use CREATE OR REPLACE so they are safe to re-run.
-- ═══════════════════════════════════════════════════════════════


-- ─── 1. handle_new_user ───────────────────────────────────────
-- Creates a profiles row whenever a new auth.users record is inserted.
-- Wired up via the on_auth_user_created trigger below.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.profiles (id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ─── 2. increment_scans_today ─────────────────────────────────
-- Atomically resets and increments the daily scan counter.
-- Returns the new scans_today value, or 0 if the limit was already reached.
-- Call via: SELECT increment_scans_today(user_id, CURRENT_DATE, 3)

CREATE OR REPLACE FUNCTION public.increment_scans_today(
  p_user_id UUID,
  p_today   DATE,
  p_limit   INT
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INT;
BEGIN
  -- Reset counter if the stored date is not today
  UPDATE profiles
  SET scans_today = 0, scans_today_reset = p_today
  WHERE id = p_user_id
    AND scans_today_reset IS DISTINCT FROM p_today;

  -- Atomically increment only if still under the daily limit
  UPDATE profiles
  SET scans_today = scans_today + 1
  WHERE id = p_user_id
    AND scans_today < p_limit
  RETURNING scans_today INTO v_count;

  -- If no row was updated the limit was already reached
  RETURN COALESCE(v_count, 0);
END;
$$;


-- ─── 3. rls_auto_enable ──────────────────────────────────────
-- Event trigger that automatically enables RLS on every new table
-- created in the public schema.  Prevents accidental open tables.

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table', 'partitioned table')
  LOOP
    IF cmd.schema_name IS NOT NULL
       AND cmd.schema_name IN ('public')
       AND cmd.schema_name NOT IN ('pg_catalog', 'information_schema')
       AND cmd.schema_name NOT LIKE 'pg_toast%'
       AND cmd.schema_name NOT LIKE 'pg_temp%'
    THEN
      BEGIN
        EXECUTE format('ALTER TABLE IF EXISTS %s ENABLE ROW LEVEL SECURITY', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
    ELSE
      RAISE LOG 'rls_auto_enable: skip % (system schema or outside enforced list: %)',
        cmd.object_identity, cmd.schema_name;
    END IF;
  END LOOP;
END;
$$;

-- Wire up the event trigger (drops first so re-running is safe)
DROP EVENT TRIGGER IF EXISTS rls_auto_enable_trigger;
CREATE EVENT TRIGGER rls_auto_enable_trigger
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.rls_auto_enable();
