-- ---------------------------------------------------------------------------
-- 9196: the People screens become findable by the transaction code they stand for.
--
-- The browser run for the organisational screens went looking for the promise the design makes in §10.8 — that
-- a familiar external code is accepted "as a lookup courtesy" and lands on the screen that carries the
-- capability — and found nothing: 9193 and 9194 registered their `term_registry` rows with `route_path`, but
-- wrote no `term_alias` row, so typing PPOCE or PPOME into `/registry` or the command bar answers with no hit
-- at all, while 287 aliases were already registered for the modules that came before. The screens were built,
-- the codes were named in their own descriptions, and the lookup that joins them was left out.
--
-- Which code belongs to which screen is not decided here. §10.8 lists, in its own words:
--   PEOPLE.ORGUNIT.CREATE      — PPOCE
--   PEOPLE.POSITION.CREATE     — PPOME
--   PEOPLE.EMPLOYEE.CREATE     — PA30 / PA40
--   PEOPLE.ASSIGNMENT.MAINTAIN — PA30
--   PEOPLE.RECORD.MAINTAIN     — PA30
--
-- An alias row leads to exactly one term, so PA30 goes to the employee master: in the reference product PA30
-- and PA40 maintain and display one person's master record and its infotypes, which is what /people/employees
-- is. That leaves §10.8's other two PA30 citations without a code of their own — the dated-record type screen
-- and the position-assignment screen. No substitute is invented for either: PO13 and the infotype-type codes
-- are not in §10.8, and CAIRN.md is the only authority this project takes transaction codes from. The overlap
-- is recorded as an open decision (see notes/people-increment-3.md) and both screens carry their own activity
-- code in the header in the meantime, which is what an operator inside the product actually reads.
--
-- Nothing else changes: no capability row, no grant, no table. The alias table is read by
-- `src/platform/registry` for both the registry screen and the command bar, and it already had the data it
-- needed on our side — the term rows these migrations filed.
-- ---------------------------------------------------------------------------

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'PPOCE', 'SEARCH_ONLY', 'MIGRATION_9196'
FROM term_registry t
WHERE t.our_code = 'PEOPLE.ORGUNIT.CREATE'
ON CONFLICT (external_system, alias) DO NOTHING;

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'PPOME', 'SEARCH_ONLY', 'MIGRATION_9196'
FROM term_registry t
WHERE t.our_code = 'PEOPLE.POSITION.CREATE'
ON CONFLICT (external_system, alias) DO NOTHING;

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'PA30', 'SEARCH_ONLY', 'MIGRATION_9196'
FROM term_registry t
WHERE t.our_code = 'PEOPLE.EMPLOYEE.CREATE'
ON CONFLICT (external_system, alias) DO NOTHING;

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'PA40', 'SEARCH_ONLY', 'MIGRATION_9196'
FROM term_registry t
WHERE t.our_code = 'PEOPLE.EMPLOYEE.CREATE'
ON CONFLICT (external_system, alias) DO NOTHING;

-- The descriptions of the two terms left without an alias say which code §10.8 cites for them, so they have to
-- say now that the lookup does not answer to it here — an operator who reads the description and then types the
-- code should not be left wondering whether the search is broken.
UPDATE term_registry
SET description = description
  || ' §10.8 cites PA30 for this screen too; the alias is registered against the employee master, which is '
  || 'where PA30 leads in the reference product, so typing it here opens the person rather than this screen.',
    changed_by = 'MIGRATION_9196',
    changed_at = now()
WHERE our_code = 'PEOPLE.ASSIGNMENT.MAINTAIN'
  AND description NOT LIKE '%the alias is registered against the employee master%';

UPDATE term_registry
SET description = description
  || ' A record type is configured at /config/people-record-types; §10.8 cites PA30 for maintaining a dated '
  || 'record, and that alias leads to the employee master, where the record is written.',
    changed_by = 'MIGRATION_9196',
    changed_at = now()
WHERE our_code = 'CFG.PEOPLE.RECORDTYPE.DEFINE'
  AND description NOT LIKE '%that alias leads to the employee master%';
