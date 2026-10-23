-- The searchable title and description must not contain the token IMG.
-- IMG is the workbench alias. A title that contains it becomes an exact hit
-- for that query when the workbench alias is absent.

UPDATE term_registry
SET
  title = 'Batch management index',
  description = $ocha$OCHA is a search alias only. It opens the batch management configuration index. It does not define a characteristic, assign a class, or store a batch value. It does not create a batch, post a movement, or select a plant. Opening this screen writes nothing.$ocha$,
  changed_by = 'MIGRATION_9129',
  changed_at = now()
WHERE our_code = 'CFG.INV.BATCHIMG.DISPLAY';
