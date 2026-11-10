-- ---------------------------------------------------------------------------
-- SCR-029 / OB29: repair the description 0038 shortened mid-word.
--
-- OB29's LTEXT is thirty characters and the standard package described K4 in thirty-two, so
-- the rebuild cut it to 'Calendar year, 4 special perio'. A tenant should not have to read a
-- truncated sentence about its own fiscal year, and the package's wording is known, so the
-- repair matches on the text 0038 produced together with the parameters that identify the
-- package variant — a description a tenant wrote for itself is left alone.
--
-- No audit column is touched: this is a migration repair, not a business change, and there is
-- no change document for a migration to sit in.
-- ---------------------------------------------------------------------------
UPDATE fiscal_year_variant
   SET name = 'Calendar year + 4 special'
 WHERE name = 'Calendar year, 4 special perio'
   AND regular_periods = 12
   AND special_periods = 4
   AND is_calendar_year;
