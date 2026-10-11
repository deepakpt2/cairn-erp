-- B-073: PostgreSQL ARE limits repetition counts; bound the whole envelope instead.
ALTER TABLE partner_bank
  DROP CONSTRAINT partner_bank_iban_envelope,
  ADD CONSTRAINT partner_bank_iban_envelope CHECK (
    iban_ciphertext IS NULL OR (
      iban_ciphertext ~ '^cbd1[.][A-Za-z0-9_-]{1,32}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$'
      AND char_length(iban_ciphertext) <= 5540
    )
  );

ALTER TABLE partner_bank
  DROP CONSTRAINT partner_bank_local_account_envelope,
  ADD CONSTRAINT partner_bank_local_account_envelope CHECK (
    local_account_number_ciphertext IS NULL OR (
      local_account_number_ciphertext ~ '^cbd1[.][A-Za-z0-9_-]{1,32}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$'
      AND char_length(local_account_number_ciphertext) <= 5540
    )
  );
