-- 0009_timestamps_are_instants.sql
--
-- Every time column becomes `timestamptz` (an absolute instant) instead of
-- `timestamp` (a bare wall clock with no zone attached).
--
-- WHY
--   The box runs in UTC, so every row written so far holds a UTC wall clock —
--   but nothing in the column says so. Reading it in India means guessing, and
--   the moment anything on the system is switched to local time, new rows hold
--   IST wall clocks in the SAME column as the old UTC ones, with no way to tell
--   them apart. That is unrecoverable: an event at "05:00" could be either.
--
--   As `timestamptz` the stored value is an instant. Postgres renders it in
--   whatever timezone the session asks for, so `psql` shows IST, the app shows
--   IST, and nobody anywhere adds or subtracts hours by hand. No offset is
--   hardcoded, so a zone whose rules change (India's do not, but others do) is
--   handled by the tz database rather than by us.
--
-- SAFETY
--   `USING col AT TIME ZONE 'UTC'` states the assumption explicitly: the
--   existing wall clocks are UTC, because that is what the server has always
--   run as. The instant each row refers to is therefore unchanged — only its
--   description becomes unambiguous. Re-running this is a no-op: columns
--   already converted are skipped.

DO $$
DECLARE
  r RECORD;
  n INT := 0;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema()
      AND t.table_type = 'BASE TABLE'
      AND c.data_type = 'timestamp without time zone'
    ORDER BY c.table_name, c.column_name
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE ''UTC''',
      r.table_name, r.column_name, r.column_name
    );
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'converted % column(s) to timestamptz in schema %', n, current_schema();
END $$;
