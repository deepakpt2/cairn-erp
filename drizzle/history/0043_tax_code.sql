-- ---------------------------------------------------------------------------
-- SCR-035 / FTXP stage 2 — the tax code a journal line names, defined
--
-- Journal entry lines have carried a tax code as free text since the first
-- posting schema, and nothing has ever defined what the codes mean: the
-- activity row has routed at an empty route, and a line can name any four
-- characters anybody types. This migration creates the registry those lines
-- refer to.
--
-- The key is the tenant, the country and the code. The country is the
-- country master's own two-character key, held by foreign key, because a tax
-- code is a country's levy and a code defined for a country that does not
-- exist taxes nowhere. The code is up to four upper-case letters or digits —
-- the width the journal line itself holds (R-85), not the two the reference
-- package allows, so anything a line can already carry is a code that can be
-- defined.
--
-- The rate is a percentage at two fractional digits, between nothing and
-- everything: a rate above a hundred would tax more than the base it is
-- levied on, and a negative one would pay out, and neither is a rate anybody
-- defends to an auditor. The condition type and the account key are the
-- operator-entered values the posting rule reads (R-85): tenant data in
-- house-named columns, shape-checked here — upper-case, within width —
-- because there is no condition master in this product for them to be
-- checked against, and inventing one inside a tax migration would be a
-- second SCR wearing this one's number.
--
-- There is deliberately no active flag: the lifecycle the owner chose is
-- deletion, refused while journal lines carry the code, so a row is either
-- defined or gone and its history lives in the change documents.
--
-- Every step verifies before it applies, the way 0041 does. Nothing here
-- can refuse: the table is new, and no existing row can violate a rule it
-- predates.
-- ---------------------------------------------------------------------------

-- A. The registry itself. ----------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_code (
  client       varchar(4)  NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  country      char(2)     NOT NULL REFERENCES country (code),
  tax_code     varchar(4)  NOT NULL,
  name         varchar(50) NOT NULL,
  tax_type     varchar(4)  NOT NULL,
  rate_percent numeric(7, 2) NOT NULL,
  account_key  varchar(3),
  created_by   varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at   timestamptz NOT NULL DEFAULT now(),
  changed_by   varchar(60),
  changed_at   timestamptz,
  CONSTRAINT tax_code_pk PRIMARY KEY (client, country, tax_code),
  CONSTRAINT tax_code_code_format CHECK (tax_code ~ '^[A-Z0-9]{1,4}$'),
  CONSTRAINT tax_code_name_nonempty CHECK (length(btrim(name)) BETWEEN 1 AND 50),
  CONSTRAINT tax_code_type_format CHECK (tax_type ~ '^[A-Z0-9]{1,4}$'),
  CONSTRAINT tax_code_rate_bounds CHECK (rate_percent BETWEEN 0 AND 100),
  CONSTRAINT tax_code_account_key_format CHECK (account_key IS NULL OR account_key ~ '^[A-Z0-9]{1,3}$')
);

-- B. Finding a code by the text a journal line carries. ----------------------
CREATE INDEX IF NOT EXISTS tax_code_code_idx ON tax_code (client, tax_code);
