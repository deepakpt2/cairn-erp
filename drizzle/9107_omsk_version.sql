-- OMSK parity with the other configuration masters: a version on the
-- reference and the class, so a stale save is refused, and a description
-- long enough for the reference. This does not add a landscape or a transport.

ALTER TABLE account_category_reference
  ALTER COLUMN name TYPE varchar(60);

ALTER TABLE account_category_reference
  ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE account_category_reference
  ADD CONSTRAINT account_category_reference_version_ck CHECK (version > 0);

ALTER TABLE valuation_class
  ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE valuation_class
  ADD CONSTRAINT valuation_class_version_ck CHECK (version > 0);

UPDATE term_registry
SET description = $omsk$Define valuation classes and the account category references that permit them. OMSK is a search alias only. The reference key is one to four letters or digits and keeps its leading zeros. The class key is the material master own key, one to twenty letters, digits or underscores, and is never converted to a number, so 0001 stays 0001. A class may be assigned to more than one reference. A material type already names one reference; changing that reference does not rewrite a material valuation class, and the change is refused when standing materials would no longer be allowed their class. A material may carry a class only when the class is active and assigned to the type reference. A delivered class also names the material types it was supplied for, so the raw class stays with raw materials while those types share one reference. An empty type list permits every type on the assigned references. A class a material or an account determination already names cannot be deactivated or deleted; the counts are named, and the description may still change. A posted document is not rewritten. Inventory postings judge the class again and do not substitute an account. A save must send the version it opened; a stale version is refused. A G/L account is not stored on the class. A closed posting period does not block this screen. A transport is refused by name: this product has no target landscape. The change document is the recorded change set.$omsk$,
    changed_by = 'MIGRATION_9107',
    changed_at = now()
WHERE our_code = 'CFG.INV.VALCLASS.DEFINE';
