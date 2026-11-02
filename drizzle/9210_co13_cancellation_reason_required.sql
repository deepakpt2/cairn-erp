-- CO13 follow-up: every new cancellation must carry a human reason.
-- Preserve any historical null-reason rows; the NOT VALID check enforces new
-- writes without inventing audit text for records that already exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'production_confirmation_cancellation'::regclass
       AND conname = 'production_confirmation_cancellation_reason_required_ck'
  ) THEN
    ALTER TABLE production_confirmation_cancellation
      ADD CONSTRAINT production_confirmation_cancellation_reason_required_ck
      CHECK (reason IS NOT NULL AND reason ~ '[^[:space:]]' AND char_length(reason) BETWEEN 1 AND 200)
      NOT VALID;
  END IF;
END;
$$;
