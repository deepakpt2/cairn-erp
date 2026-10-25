-- CO13 follow-up. The effect table has no confirmation level, so the shared
-- trigger must not read that field unless the row is a confirmation.
-- Default table privileges also granted update and delete. Cancellation is insert-only.

CREATE OR REPLACE FUNCTION production_confirmation_reject_second_active_final()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.confirmation_type IS DISTINCT FROM 'FINAL' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.client || '|CO13-FINAL|' || NEW.order_number, 0));

  IF TG_TABLE_NAME = 'production_confirmation' THEN
    IF NEW.confirmation_level = 'HEADER' THEN
      IF EXISTS (
        SELECT 1
          FROM production_confirmation c
         WHERE c.client = NEW.client
           AND c.order_number = NEW.order_number
           AND c.confirmation_level = 'HEADER'
           AND c.confirmation_type = 'FINAL'
           AND c.confirmation_number <> NEW.confirmation_number
           AND NOT EXISTS (
             SELECT 1 FROM production_confirmation_cancellation x
              WHERE x.client = c.client AND x.confirmation_number = c.confirmation_number
           )
      ) THEN
        RAISE EXCEPTION 'active final confirmation already stands'
          USING ERRCODE = 'unique_violation';
      END IF;
    ELSIF NEW.confirmation_level = 'OPERATION' THEN
      IF EXISTS (
        SELECT 1
          FROM production_confirmation c
         WHERE c.client = NEW.client
           AND c.order_number = NEW.order_number
           AND c.confirmation_level = 'OPERATION'
           AND c.operation_number = NEW.operation_number
           AND c.confirmation_type = 'FINAL'
           AND c.confirmation_number <> NEW.confirmation_number
           AND NOT EXISTS (
             SELECT 1 FROM production_confirmation_cancellation x
              WHERE x.client = c.client AND x.confirmation_number = c.confirmation_number
           )
      ) OR EXISTS (
        SELECT 1
          FROM production_confirmation_operation e
         WHERE e.client = NEW.client
           AND e.order_number = NEW.order_number
           AND e.operation_number = NEW.operation_number
           AND e.confirmation_type = 'FINAL'
           AND NOT EXISTS (
             SELECT 1 FROM production_confirmation_cancellation x
              WHERE x.client = e.client AND x.confirmation_number = e.confirmation_number
           )
      ) THEN
        RAISE EXCEPTION 'active final confirmation already stands'
          USING ERRCODE = 'unique_violation';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'production_confirmation_operation' THEN
    IF EXISTS (
      SELECT 1
        FROM production_confirmation_operation e
       WHERE e.client = NEW.client
         AND e.order_number = NEW.order_number
         AND e.operation_number = NEW.operation_number
         AND e.confirmation_type = 'FINAL'
         AND e.confirmation_number <> NEW.confirmation_number
         AND NOT EXISTS (
           SELECT 1 FROM production_confirmation_cancellation x
            WHERE x.client = e.client AND x.confirmation_number = e.confirmation_number
         )
    ) OR EXISTS (
      SELECT 1
        FROM production_confirmation c
       WHERE c.client = NEW.client
         AND c.order_number = NEW.order_number
         AND c.confirmation_level = 'OPERATION'
         AND c.operation_number = NEW.operation_number
         AND c.confirmation_type = 'FINAL'
         AND NOT EXISTS (
           SELECT 1 FROM production_confirmation_cancellation x
            WHERE x.client = c.client AND x.confirmation_number = c.confirmation_number
         )
    ) THEN
      RAISE EXCEPTION 'active final confirmation already stands'
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE UPDATE, DELETE ON production_confirmation_cancellation FROM cairn_app;
