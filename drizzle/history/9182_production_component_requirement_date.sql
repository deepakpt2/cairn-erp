-- Component requirement date for a production-order snapshot line.
--
-- A production-order component had quantity, material, plant, and optional BOM
-- identity, but no requirement date. MD01 and MD04 therefore could not count it
-- without inventing a date from the order start, the order finish, the bill of
-- material, or today. Those are not a component requirement date.
--
-- The column stays null until conversion copies a date from a matching open
-- dependent requirement. Existing rows are not backfilled: a historical
-- snapshot has no proven component date, and its dependent requirement, when
-- one still stands, remains the demand. A null date is not planning demand.
-- This does not add a reservation, a goods movement, or a journal.

ALTER TABLE production_order_component
  ADD COLUMN requirement_date date;

COMMENT ON COLUMN production_order_component.requirement_date IS
  'Component requirement date copied from a matching dependent requirement. Null means no date was established. It is not the order start, the order finish, the bill of material date, or today.';
