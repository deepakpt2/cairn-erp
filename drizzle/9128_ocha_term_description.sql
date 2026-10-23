-- The first OCHA description named other transaction codes. Search treats a
-- code inside a description as an exact hit. This leaves the alias OCHA and
-- removes those codes from the searchable sentence.

UPDATE term_registry
SET
  description = $ocha$IMG Batch Management. OCHA is a search alias only. It opens the batch management configuration index. It does not define a characteristic, assign a class, or store a batch value. It does not create a batch, post a movement, or select a plant. Opening this screen writes nothing.$ocha$,
  changed_by = 'MIGRATION_9128',
  changed_at = now()
WHERE our_code = 'CFG.INV.BATCHIMG.DISPLAY';
