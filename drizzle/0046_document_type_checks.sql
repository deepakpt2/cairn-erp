-- ---------------------------------------------------------------------------
-- SCR-038 / OBA7 stage 2 — the document type's format rules, in the database
--
-- The document_type table has stood since the first schema and stage 2 of
-- this SCR verified it against the contract (R-87) from the database: the
-- columns, the primary key, the forced tenant isolation and the grants are
-- all as the contract needs, and every row the standard package delivered
-- complies with the rules below. What the table never carried is a single
-- check constraint — its key could be twelve lowercase characters, its
-- account-type set empty or foreign, its reversal mode invented — because
-- until now only the package wrote it, and the package is careful. A
-- maintenance screen is a second writer, and every sibling registry in
-- this product (0043, 0044, 0045) states its format rules in the database
-- as well as the service, so a mistake at any layer is refused rather than
-- stored.
--
-- The rules, exactly as the service will state them: the key is two
-- upper-case letters or digits; the account types are one to five of the
-- posting vocabulary's letters (Assets, Customers, Vendors, Materials,
-- G/L — repetition is the service's to normalize, emptiness is nobody's);
-- the reversal mode is one of the three the engine reads; the description
-- is not blank. Each check is added only if absent, the way the
-- verification migrations before this one apply.
--
-- Verified before applying: on the development database all delivered
-- rows comply (11 rows, one tenant, every key exactly two upper-case
-- characters, every set and mode valid). A tenant whose rows have drifted
-- further than the standard package ever wrote is told so by the refusal
-- rather than silently rewritten.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_type_code_format') THEN
    ALTER TABLE document_type
      ADD CONSTRAINT document_type_code_format CHECK (document_type ~ '^[A-Z0-9]{2}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_type_account_types_format') THEN
    ALTER TABLE document_type
      ADD CONSTRAINT document_type_account_types_format CHECK (allowed_account_types ~ '^[ADKMS]{1,5}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_type_reversal_mode_vocabulary') THEN
    ALTER TABLE document_type
      ADD CONSTRAINT document_type_reversal_mode_vocabulary
        CHECK (reversal_mode IN ('REVERSE_ONLY', 'REVERSE_AND_ALT_DATE', 'NO_REVERSE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_type_name_nonempty') THEN
    ALTER TABLE document_type
      ADD CONSTRAINT document_type_name_nonempty CHECK (length(btrim(name)) BETWEEN 1 AND 120);
  END IF;
END $$;
