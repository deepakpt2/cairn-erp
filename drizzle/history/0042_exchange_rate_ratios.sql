-- ---------------------------------------------------------------------------
-- SCR-034 / OB08 stage 2 — the translation ratios join the exchange rate
--
-- The contract (R-84) maintains a rate the way the reference model does: a
-- quoted rate and the translation ratio it is quoted for (the package's
-- FFACT/TFACT, attributed there to TCURF). The effective rate a currency pair
-- converts at is
--
--     effective = rate × ratio_to / ratio_from
--
-- and until now this table had nowhere to keep the two factors. The columns
-- arrive as integers, not decimals: a ratio is a unit count (1, 10, 100, …),
-- the contract holds it to at most nine digits, and nine digits fit an
-- integer with room to spare. Both default to 1, which is every existing
-- row's truth — the builder's seeded rates are quoted for one unit — so the
-- backfill states a fact rather than inventing one.
--
-- A ratio below 1 is meaningless and refused at the column: a write that
-- divided by zero, or multiplied by a negative factor, would produce rates
-- nobody decided on. The service validates first and says so in words; the
-- check is the database declining to rely on the service being honest.
--
-- Every step verifies before it applies, and refuses rather than repairs,
-- the way 0041 does. There is nothing here to refuse on: the columns are new,
-- and no existing row can violate a rule it predates.
-- ---------------------------------------------------------------------------

-- A. The ratio the rate is quoted from. -------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'exchange_rate' AND column_name = 'ratio_from'
  ) THEN
    ALTER TABLE exchange_rate
      ADD COLUMN ratio_from integer NOT NULL DEFAULT 1;
  END IF;
END $$;

-- B. The ratio the rate is quoted to. ---------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'exchange_rate' AND column_name = 'ratio_to'
  ) THEN
    ALTER TABLE exchange_rate
      ADD COLUMN ratio_to integer NOT NULL DEFAULT 1;
  END IF;
END $$;

-- C. A ratio is a unit count, at least one. ---------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exchange_rate_ratio_from_positive') THEN
    ALTER TABLE exchange_rate
      ADD CONSTRAINT exchange_rate_ratio_from_positive CHECK (ratio_from >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exchange_rate_ratio_to_positive') THEN
    ALTER TABLE exchange_rate
      ADD CONSTRAINT exchange_rate_ratio_to_positive CHECK (ratio_to >= 1);
  END IF;
END $$;
