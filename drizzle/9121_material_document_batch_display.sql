-- MB03 shows the batch already stored on the material document line.
-- It adds no table and no index, and it does not change the line.

UPDATE term_registry
   SET description = $mb03$One material document exactly as posted, read-only: a required document number with the fiscal year as a cross-check and an optional item that narrows the grid, the header with its poster and entry time, every line with its movement type and direction, material and description, plant and storage location, stock type, the batch stored on the line, entry and base quantities, unit price, value and currency, purchase order and item, and the reversal pair. The company code is derived from the plants, never typed. A display applies no posting-period check, so a document whose period has closed still shows as it stood; F4 search help, the accounting-document drill and the reservation reference are deferred by name.$mb03$,
       changed_by = 'MIGRATION_9121',
       changed_at = now()
 WHERE our_code = 'INV.DISPLAY';
