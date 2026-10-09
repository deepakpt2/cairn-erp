-- D-046: company-scoped accounting ranges, shared type assignment and stable keys.
-- No posted document or allocation is removed; old document keys remain valid.

UPDATE journal_entry SET display_number = document_number WHERE display_number = '';

-- Carry forward the HIGH-WATER mark of the legacy tenant-wide FI intervals.
-- All standard accounting types share GENERAL; independent identical intervals
-- for each document type would otherwise issue the same number twice.
INSERT INTO number_range
  (client, object_code, company_code, sub_object, fiscal_year, prefix,
   from_number, to_number, current_number, number_length, display_style,
   is_external, status, created_by)
SELECT r.client, 'JOURNAL_ENTRY', c.company_code, 'GENERAL', r.fiscal_year,
       'JE', min(r.from_number), max(r.to_number), max(r.current_number),
       greatest(6, max(r.number_length)), 'READABLE', false, 'ACTIVE', 'MIGRATION_9003'
  FROM number_range r JOIN company_code c ON c.client = r.client
 WHERE r.object_code = 'JOURNAL_ENTRY' AND r.company_code = '*'
 GROUP BY r.client, c.company_code, r.fiscal_year
ON CONFLICT DO NOTHING;

-- Retain legacy intervals, blocked, as historical evidence. They can never
-- satisfy a company-scoped posting request.
UPDATE number_range SET status = 'BLOCKED', changed_by = 'MIGRATION_9003', changed_at = now()
 WHERE object_code = 'JOURNAL_ENTRY' AND company_code = '*';
UPDATE document_type SET number_range_sub_object = 'GENERAL',
       changed_by = 'MIGRATION_9003', changed_at = now()
 WHERE number_range_object = 'JOURNAL_ENTRY';

UPDATE number_range_allocation a SET company_code = j.company_code, document_id = j.document_number
  FROM journal_entry j
 WHERE a.object_code = 'JOURNAL_ENTRY' AND a.client = j.client
   AND a.displayed_number = j.document_number AND a.fiscal_year = j.fiscal_year;
UPDATE number_range_allocation a SET range_fiscal_year = a.fiscal_year
 WHERE EXISTS (SELECT 1 FROM number_range r WHERE r.client = a.client
   AND r.object_code = a.object_code AND r.sub_object = a.sub_object
   AND r.fiscal_year = a.fiscal_year);

-- Defence in depth against malformed intervals, even in scripts.
ALTER TABLE number_range ADD CONSTRAINT number_range_limits_ck CHECK (
  from_number >= 1 AND to_number >= from_number
  AND current_number >= from_number - 1 AND current_number <= to_number
  AND to_number <= 9007199254740991 AND number_length BETWEEN 1 AND 16
  AND fiscal_year >= 0 AND status IN ('ACTIVE', 'BLOCKED')
  AND display_style IN ('READABLE', 'CLASSIC')
);
