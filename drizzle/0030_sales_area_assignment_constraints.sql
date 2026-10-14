-- OVXG: constrain Sales Areas to the three supplied key formats and to the
-- Sales Organization's OVXK/OVXA assignment sets. The earlier OVXK/OVXA
-- migrations backfill those sets from existing Sales Areas before this runs.

DO $sales_area_key_validation$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM sales_area
     WHERE distribution_channel !~ '^[A-Z0-9]{2}$'
        OR division !~ '^[A-Z0-9]{2}$'
        OR length(btrim(name)) = 0
  ) THEN
    RAISE EXCEPTION 'Existing Sales Area rows do not satisfy the OVXG key/name format; repair them before applying this migration.';
  END IF;
END
$sales_area_key_validation$;

ALTER TABLE sales_area
  ALTER COLUMN distribution_channel TYPE varchar(2),
  ALTER COLUMN division TYPE varchar(2);

ALTER TABLE sales_area
  ADD CONSTRAINT sales_area_distribution_channel_key_format_ck
    CHECK (distribution_channel ~ '^[A-Z0-9]{2}$'),
  ADD CONSTRAINT sales_area_division_key_format_ck
    CHECK (division ~ '^[A-Z0-9]{2}$'),
  ADD CONSTRAINT sales_area_name_not_blank_ck
    CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT sales_area_sales_org_distribution_channel_assignment_fk
    FOREIGN KEY (client, sales_org, distribution_channel)
    REFERENCES sales_org_distribution_channel (client, sales_org, distribution_channel)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT sales_area_sales_org_division_assignment_fk
    FOREIGN KEY (client, sales_org, division)
    REFERENCES sales_org_division (client, sales_org, division)
    ON DELETE NO ACTION ON UPDATE NO ACTION;
