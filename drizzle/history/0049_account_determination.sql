-- ---------------------------------------------------------------------------
-- SCR-040 / OBYC stage 2 — the account determination registry
--
-- The design's §8.3 has planned this table since its inventory of the
-- accounting spine (`account_determination`, our key → G/L account, per
-- chart of accounts / valuation area / transaction key, the reference
-- T030 recorded as alias only) without building it. This migration
-- creates it in the shape the contract settled (R-89): the product's
-- posting events as the stored vocabulary (INVENTORY, GR_IR_CLEARING,
-- OFFSETTING_INVENTORY, PRICE_DIFFERENCE), the valuation-grouping
-- dimension omitted whole, the valuation class in the material master's
-- own keys, and both modifier columns allowed blank as stored values —
-- blank valuation class meaning any class, blank general modifier
-- meaning no split.
--
-- What the database carries here is format: the chart's four characters,
-- the event's upper-case word shape, the class and modifier alphabets,
-- an account that is not blank. What it deliberately does not carry is
-- the event vocabulary itself, the account's existence in the chart, its
-- kind, or whether an event uses a modifier at all: those read other
-- tables or the service's catalogue, and a check constraint here could
-- only lie about having verified them (the judgement the house-bank G/L
-- rule taught). The service states them, per failure, in stage 3.
--
-- Nothing derives accounts from these rows yet; the table lands empty.
-- Nothing here can refuse: the table is new, and no existing row can
-- violate a rule it predates.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account_determination (
  client          varchar(4)  NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  chart_of_accounts varchar(4) NOT NULL,
  event           varchar(24) NOT NULL,
  valuation_class varchar(20) NOT NULL DEFAULT '',
  general_modifier varchar(4) NOT NULL DEFAULT '',
  gl_account      varchar(10) NOT NULL,
  created_by      varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at      timestamptz NOT NULL DEFAULT now(),
  changed_by      varchar(60),
  changed_at      timestamptz,
  CONSTRAINT account_determination_pk PRIMARY KEY (client, chart_of_accounts, event, valuation_class, general_modifier),
  CONSTRAINT account_determination_chart_format CHECK (chart_of_accounts ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT account_determination_event_format CHECK (event ~ '^[A-Z][A-Z0-9_]{2,23}$'),
  CONSTRAINT account_determination_valuation_class_format CHECK (valuation_class ~ '^([A-Z0-9_]{1,20})?$'),
  CONSTRAINT account_determination_modifier_format CHECK (general_modifier ~ '^([A-Z0-9]{1,4})?$'),
  CONSTRAINT account_determination_gl_account_nonempty CHECK (length(btrim(gl_account)) BETWEEN 1 AND 10)
);

-- The lookup this registry serves: a chart and event's rows are found by
-- the primary key's prefix; this index backs the same read across charts.
CREATE INDEX IF NOT EXISTS account_determination_chart_event_idx
  ON account_determination (client, chart_of_accounts, event);
