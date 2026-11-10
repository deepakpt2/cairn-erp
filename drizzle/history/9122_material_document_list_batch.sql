-- MB51 filters and shows the batch already stored on the material
-- document line. It adds no table and no index. A sales document is
-- not selected.

UPDATE term_registry
   SET description = $mb51$Material documents as a list, read-only over the ledger: ranges on material, plant, storage location, movement type and purchase order, a required posting-date range, optional document dates, a stock type and a user name, with a maximum hit count carrying the standing truncation marker. The posting-date range is required because a list over an unbounded ledger is a scan of history rather than a question. Movement types are the canon keys with their direction, never SAP numbers; storage locations, plants and materials are judged against their masters and refuse by name. Every line shows the document and year, item, movement type and direction, material and its description, entry and base quantities with units, unit price with price unit, value and currency, plant, storage location, stock type, the batch stored on the line, posting and document dates, header text, the journal document posted, the document status, the purchase order and item cited so a receipt is auditable against its order, and the creator, drilling into the material document display. A named batch filters those lines. History is never hidden: a reversed document is listed with that status and its reversal stands as a document of its own. Project and sales-order special stock, Scope-of-List variants, serial selection and exporting are deferred by name. A sales order, a delivery, a billing document, and a scheduling agreement are refused by name.$mb51$,
       changed_by = 'MIGRATION_9122',
       changed_at = now()
 WHERE our_code = 'INV.MATERIALDOC.LIST';
