-- ── Whether a material is counted in serials ──────────────────────────────────
--
-- §5.5b. The serial master created by 9261 needs to know which materials are
-- counted in serials, and the material master has never been asked.
--
-- In SAP this is MARC-SERNP, a serial number *profile* maintained per material
-- per plant. The profile does three jobs: it says whether serials are required
-- at all, it says whether they are optional or obligatory on particular
-- movements, and it names the procedure that assigns numbers. This canon takes
-- the first job and leaves the other two. A boolean next to the existing
-- `batch_managed` (MARA-XCHPF) is the honest reduction: a material either is a
-- thing you count one at a time or it is not, and a tenant that wants the other
-- two jobs has not asked for them.
--
-- Nothing is seeded, and the column defaults to false. Every material that
-- stands is untouched, and so is every delivery that has ever been picked — a
-- material only starts asking for serials from the moment somebody says it is
-- counted in them.

alter table material
  add column if not exists serial_managed boolean not null default false;

comment on column material.serial_managed is
  'Whether this material is counted one unit at a time (§5.5b). Where it is, a delivery pick has to name which units came off the shelf, and the serial master records where each one stands and which customer holds it. SAP carries MARC-SERNP, a per-plant serial number profile; this canon takes from it only the question of whether serials apply at all. False for every material that stands, so nothing changes until a tenant says otherwise.';
