-- ---------------------------------------------------------------------------
-- SCR-029 / OB29 stage 2 — rebuild the fiscal year variant and its periods.
--
-- The pair of tables existed since §8.2 with a four-character key, a 120-character
-- description and period rows carrying both a start and an end. OB29's contract stores a
-- two-character PERIV, a thirty-character LTEXT, the year-dependent indicator XMONAT, and
-- periods that hold only their end plus a year shift — the start of a period is the end of
-- the one before it, which is how the reference product computes it and the only way a
-- hand-maintained list cannot disagree with itself.
--
-- The tables are dropped and rebuilt rather than altered, so the tenant's variants are
-- carried across explicitly and the rebuild refuses to guess: a key longer than two
-- characters is an error, not a truncation. Period rows keep their stored end date, and a
-- period whose end month precedes its start month was crossing the year boundary, which is
-- what the year shift now records. calendar_year is 0 for every carried row, meaning the
-- period list holds for every year — the year-dependent case is maintained per year from
-- now on.
-- ---------------------------------------------------------------------------

-- 1 · Controlling Area holds the only foreign key onto the table being dropped.
ALTER TABLE controlling_area
  DROP CONSTRAINT IF EXISTS controlling_area_fiscal_year_variant_fk;

-- 2 · Carry the tenant's definitions across the rebuild.
CREATE TEMP TABLE fyv_old ON COMMIT DROP AS
SELECT client, variant, name, regular_periods, special_periods, is_calendar_year,
       is_active, created_by, created_at, changed_by, changed_at
FROM fiscal_year_variant;

CREATE TEMP TABLE fyp_old ON COMMIT DROP AS
SELECT client, variant, period, period_type, start_month, end_month, end_day,
       created_by, created_at
FROM fiscal_year_period;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM fyv_old WHERE length(btrim(variant)) > 2) THEN
    RAISE EXCEPTION
      'CAIRN_MIGRATION: a fiscal year variant key longer than two characters exists, and OB29 stores two. Rename the variant and its assignments before migrating.'
      USING ERRCODE = 'check_violation',
            HINT = 'Keys are two uppercase letters or digits (PERIV), for example K4 or V6.';
  END IF;
  IF EXISTS (SELECT 1 FROM fyv_old WHERE length(btrim(name)) > 30) THEN
    -- The standard package described K4 in 33 characters; shortening a description loses
    -- nothing but must not happen silently in a tenant that wrote its own.
    UPDATE fyv_old SET name = left(btrim(name), 30) WHERE length(btrim(name)) > 30;
  END IF;
END $$;

-- 3 · Drop and rebuild.
DROP TABLE fiscal_year_period;
DROP TABLE fiscal_year_variant;

CREATE TABLE fiscal_year_variant (
  "client"            varchar(4)  NOT NULL REFERENCES "client"("client") ON DELETE CASCADE,
  "variant"           varchar(2)  NOT NULL,
  "name"              varchar(30) NOT NULL,
  "is_calendar_year"  boolean     NOT NULL DEFAULT false,
  "regular_periods"   smallint    NOT NULL,
  "special_periods"   smallint    NOT NULL DEFAULT 0,
  "is_year_dependent" boolean     NOT NULL DEFAULT false,
  "is_active"         boolean     NOT NULL DEFAULT true,
  "version"           integer     NOT NULL DEFAULT 1,
  "created_by"        varchar(60) NOT NULL DEFAULT 'SYSTEM',
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "changed_by"        varchar(60),
  "changed_at"        timestamp with time zone,
  CONSTRAINT "fiscal_year_variant_pkey" PRIMARY KEY ("client", "variant"),
  CONSTRAINT "fiscal_year_variant_key_format_ck" CHECK ("variant" ~ '^[A-Z0-9]{2}$'),
  CONSTRAINT "fiscal_year_variant_name_not_blank_ck" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "fiscal_year_variant_regular_periods_ck" CHECK ("regular_periods" between 1 and 16),
  CONSTRAINT "fiscal_year_variant_special_periods_ck" CHECK ("special_periods" between 0 and 4)
);

CREATE TABLE fiscal_year_period (
  "client"        varchar(4) NOT NULL REFERENCES "client"("client") ON DELETE CASCADE,
  "variant"       varchar(2) NOT NULL,
  "calendar_year" integer    NOT NULL DEFAULT 0,
  "period"        smallint   NOT NULL,
  "period_type"   varchar(10) NOT NULL,
  "month"         smallint   NOT NULL,
  "day"           smallint   NOT NULL DEFAULT 31,
  "year_shift"    smallint   NOT NULL DEFAULT 0,
  "created_by"    varchar(60) NOT NULL DEFAULT 'SYSTEM',
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "changed_by"    varchar(60),
  "changed_at"    timestamp with time zone,
  CONSTRAINT "fiscal_year_period_pkey" PRIMARY KEY ("client", "variant", "calendar_year", "period"),
  CONSTRAINT "fiscal_year_period_variant_fk"
    FOREIGN KEY ("client", "variant")
    REFERENCES "fiscal_year_variant" ("client", "variant") ON DELETE CASCADE,
  CONSTRAINT "fiscal_year_period_type_ck" CHECK ("period_type" in ('REGULAR', 'SPECIAL')),
  CONSTRAINT "fiscal_year_period_number_ck" CHECK ("period" between 1 and 20),
  CONSTRAINT "fiscal_year_period_month_ck" CHECK ("month" between 1 and 12),
  CONSTRAINT "fiscal_year_period_day_ck" CHECK ("day" between 1 and 31),
  CONSTRAINT "fiscal_year_period_year_shift_ck" CHECK ("year_shift" between -1 and 1)
);

CREATE INDEX "fiscal_year_period_variant_idx"
  ON "fiscal_year_period" ("client", "variant", "calendar_year");

-- 4 · Restore what the tenant had.
INSERT INTO fiscal_year_variant
  ("client", "variant", "name", "is_calendar_year", "regular_periods", "special_periods",
   "is_year_dependent", "is_active", "version", "created_by", "created_at", "changed_by", "changed_at")
SELECT client, btrim(variant), btrim(name), is_calendar_year,
       regular_periods::smallint, special_periods::smallint,
       false, is_active, 1, created_by, created_at, changed_by, changed_at
FROM fyv_old;

INSERT INTO fiscal_year_period
  ("client", "variant", "calendar_year", "period", "period_type", "month", "day", "year_shift",
   "created_by", "created_at", "changed_by", "changed_at")
SELECT client, btrim(variant), 0, period::smallint, period_type,
       end_month::smallint, end_day::smallint,
       (CASE WHEN end_month < start_month THEN 1 ELSE 0 END)::smallint,
       created_by, created_at, NULL, NULL
FROM fyp_old;

-- 5 · The company code's reference narrows with the key, and Controlling Area points at the
--     rebuilt table again. The trigger from 9000 that refuses an undefined variant is on
--     company_code, so it survived the rebuild and needs no change.
ALTER TABLE company_code ALTER COLUMN fiscal_year_variant TYPE varchar(2);

ALTER TABLE controlling_area
  ADD CONSTRAINT controlling_area_fiscal_year_variant_fk
  FOREIGN KEY ("client", "fiscal_year_variant")
  REFERENCES "fiscal_year_variant" ("client", "variant");
