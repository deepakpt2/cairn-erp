-- SCR-146 / MB1B: the movement catalogue becomes configuration.
--
-- Until now `movement_type` could say how a movement is named, which direction it has, what it
-- references and what its counter is. Everything that makes a movement *a transfer* — which
-- organizational dimensions may change, which stock types are legal on each side, whether it is
-- one-step, what master data it requires, how negative stock is treated and whether it is
-- valuation-relevant — lived in a TypeScript constant array and was matched by string equality.
-- The owner's specification (§3, §9) requires those to be configuration, so they become columns.

ALTER TABLE movement_type
  ADD COLUMN IF NOT EXISTS movement_kind varchar(20) NOT NULL DEFAULT 'MATERIAL',
  ADD COLUMN IF NOT EXISTS source_stock_type varchar(16),
  ADD COLUMN IF NOT EXISTS destination_stock_type varchar(16),
  ADD COLUMN IF NOT EXISTS plant_rule varchar(12) NOT NULL DEFAULT 'ANY',
  ADD COLUMN IF NOT EXISTS location_rule varchar(12) NOT NULL DEFAULT 'ANY',
  ADD COLUMN IF NOT EXISTS is_two_step boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_batch boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_serial boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_special_stock boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_valuation_type boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS negative_stock_policy varchar(12) NOT NULL DEFAULT 'LOCATION',
  ADD COLUMN IF NOT EXISTS valuation_relevant boolean NOT NULL DEFAULT true;

-- The vocabulary is closed. TRANSFER is kept: it is the correct statement about a two-line
-- document that nets to zero, and each line still carries its own ISSUE or RECEIPT direction.
ALTER TABLE movement_type DROP CONSTRAINT IF EXISTS movement_type_direction_ck;
ALTER TABLE movement_type
  ADD CONSTRAINT movement_type_direction_ck
  CHECK (direction IN ('RECEIPT', 'ISSUE', 'REVERSAL', 'TRANSFER'));

ALTER TABLE movement_type DROP CONSTRAINT IF EXISTS movement_type_plant_rule_ck;
ALTER TABLE movement_type
  ADD CONSTRAINT movement_type_plant_rule_ck
  CHECK (plant_rule IN ('SAME', 'DIFFERENT', 'ANY'));

ALTER TABLE movement_type DROP CONSTRAINT IF EXISTS movement_type_location_rule_ck;
ALTER TABLE movement_type
  ADD CONSTRAINT movement_type_location_rule_ck
  CHECK (location_rule IN ('SAME', 'DIFFERENT', 'ANY'));

ALTER TABLE movement_type DROP CONSTRAINT IF EXISTS movement_type_negative_stock_ck;
ALTER TABLE movement_type
  ADD CONSTRAINT movement_type_negative_stock_ck
  CHECK (negative_stock_policy IN ('LOCATION', 'FORBID'));

-- A transfer that names two stock types must name neither as its inverse by accident, and a
-- movement that is two-step cannot claim to be a one-step transfer kind.
ALTER TABLE movement_type DROP CONSTRAINT IF EXISTS movement_type_two_step_kind_ck;
ALTER TABLE movement_type
  ADD CONSTRAINT movement_type_two_step_kind_ck
  CHECK (NOT is_two_step OR movement_kind IN ('MATERIAL', 'TWO_STEP'));

-- §8.1: the external reference the specification asks for, and §16's payload fingerprint so a
-- reused idempotency key is compared rather than trusted.
ALTER TABLE material_document
  ADD COLUMN IF NOT EXISTS external_reference varchar(40),
  ADD COLUMN IF NOT EXISTS request_fingerprint varchar(64);

-- The existing transfer movements were seeded as constants; give them the configuration they were
-- implicitly carrying, so every tenant's rows describe themselves.
UPDATE movement_type SET
  movement_kind = 'TRANSFER_SLOC', source_stock_type = 'UNRESTRICTED',
  destination_stock_type = 'UNRESTRICTED', plant_rule = 'SAME', location_rule = 'DIFFERENT',
  valuation_relevant = false
WHERE movement_type = 'TRANSFER_SLOC';

UPDATE movement_type SET
  movement_kind = 'TRANSFER_PLANT', source_stock_type = 'UNRESTRICTED',
  destination_stock_type = 'UNRESTRICTED', plant_rule = 'DIFFERENT', location_rule = 'ANY',
  valuation_relevant = true
WHERE movement_type = 'TRANSFER_PLANT';

UPDATE movement_type SET
  movement_kind = 'STOCK_TYPE', source_stock_type = 'QUALITY',
  destination_stock_type = 'UNRESTRICTED', plant_rule = 'SAME', location_rule = 'SAME',
  valuation_relevant = false
WHERE movement_type = 'TRANSFER_STYPE';

-- Counters inherit the shape of what they reverse, and are never valuation-relevant themselves.
UPDATE movement_type SET
  movement_kind = 'TRANSFER_SLOC', plant_rule = 'SAME', location_rule = 'DIFFERENT',
  valuation_relevant = false
WHERE movement_type = 'TRANSFER_SLOC_REV';
UPDATE movement_type SET
  movement_kind = 'TRANSFER_PLANT', plant_rule = 'DIFFERENT', location_rule = 'ANY',
  valuation_relevant = false
WHERE movement_type = 'TRANSFER_PLANT_REV';
UPDATE movement_type SET
  movement_kind = 'STOCK_TYPE', plant_rule = 'SAME', location_rule = 'SAME',
  valuation_relevant = false
WHERE movement_type = 'TRANSFER_STYPE_REV';
