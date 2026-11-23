-- Durable binding of a queued payment execution to the exact released proposal, bank selection,
-- actual-bank-amount evidence and release state that the user submitted. The worker recomputes the
-- fingerprint at the posting boundary and refuses if any material part changed.
ALTER TABLE payment_run_operation
  ADD COLUMN IF NOT EXISTS instruction_fingerprint varchar(64);
