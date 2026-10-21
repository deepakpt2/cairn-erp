-- SCR-145 / MBRL: a return is not a cancellation.
--
-- material_document_line already carries reversal_of_document / reversal_of_line, which say
-- "this document cancels that one". A commercial return is a different statement: the goods went
-- back to the vendor against the receipt that brought them in, and the receipt itself stands.
-- Reusing the reversal pair would make the two indistinguishable to every reader — including the
-- remaining-returnable calculation, which must never count a cancellation as a return.
--
-- Both directions are readable: the return line names where it came from, and the original item
-- is found by the index below.

ALTER TABLE material_document_line
  ADD COLUMN IF NOT EXISTS return_of_document varchar(20),
  ADD COLUMN IF NOT EXISTS return_of_document_year integer,
  ADD COLUMN IF NOT EXISTS return_of_line integer;

-- A return line that names a document names its line too: a document reference without the item
-- cannot say which quantity is being returned, and the returnable calculation reads exactly that.
ALTER TABLE material_document_line
  DROP CONSTRAINT IF EXISTS material_document_line_return_lineage_check;
ALTER TABLE material_document_line
  ADD CONSTRAINT material_document_line_return_lineage_check
  CHECK (
    (return_of_document IS NULL AND return_of_document_year IS NULL AND return_of_line IS NULL)
    OR (return_of_document IS NOT NULL AND return_of_document_year IS NOT NULL AND return_of_line IS NOT NULL)
  );

-- A line cannot be a reversal and a return at once: they are different statements about the
-- original, and the engine that reads one must not have to guess whether the other also applies.
ALTER TABLE material_document_line
  DROP CONSTRAINT IF EXISTS material_document_line_reversal_not_return_check;
ALTER TABLE material_document_line
  ADD CONSTRAINT material_document_line_reversal_not_return_check
  CHECK (reversal_of_document IS NULL OR return_of_document IS NULL);

CREATE INDEX IF NOT EXISTS material_document_line_return_of_idx
  ON material_document_line (client, return_of_document, return_of_document_year, return_of_line);
