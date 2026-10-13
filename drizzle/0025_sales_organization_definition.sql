-- SCR-020: Sales Organization definition, localized TVKOT text, CAM address links, and optional OVX5 fields.
-- Preserve existing names/countries by migrating them into the corresponding text and CAM records.
-- Company Code remains nullable and is maintained only by SCR-021.
DO $$
DECLARE
  bad_key text;
BEGIN
  SELECT client || '/' || sales_org INTO bad_key
    FROM sales_org
   WHERE sales_org !~ '^[A-Z0-9]{4}$'
   LIMIT 1;
  IF bad_key IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot narrow sales organisation key; existing key is not four uppercase alphanumeric characters: %', bad_key;
  END IF;

  SELECT client || '/' || sales_org INTO bad_key
    FROM sales_org
   WHERE char_length(btrim(name)) > 35
   LIMIT 1;
  IF bad_key IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot migrate Sales Organization name to the 35-character text table; existing value is longer: %', bad_key;
  END IF;

  SELECT client || '/' || sales_org INTO bad_key
    FROM sales_area
   WHERE sales_org !~ '^[A-Z0-9]{4}$'
   LIMIT 1;
  IF bad_key IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot narrow sales-area organisation key; existing key is not four uppercase alphanumeric characters: %', bad_key;
  END IF;

  SELECT client || '/' || sales_org INTO bad_key
    FROM customer_sales_area
   WHERE sales_org !~ '^[A-Z0-9]{4}$'
   LIMIT 1;
  IF bad_key IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot narrow customer sales-area organisation key; existing key is not four uppercase alphanumeric characters: %', bad_key;
  END IF;

  IF EXISTS (
    SELECT 1 FROM sales_area a
    LEFT JOIN sales_org o ON o.client = a.client AND o.sales_org = a.sales_org
    WHERE o.sales_org IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add the sales-area organisation reference while orphan sales areas exist.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM sales_org o
    LEFT JOIN company_code c ON c.client = o.client AND c.company_code = o.company_code
    WHERE o.company_code IS NOT NULL AND c.company_code IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add the sales organisation Company Code reference while orphan assignments exist.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM sales_org o
    LEFT JOIN country c ON c.code = o.country
    WHERE c.code IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot move the Sales Organization country into CAM while unknown country codes exist.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM sales_org o
    LEFT JOIN currency c ON c.code = btrim(o.currency)
    WHERE o.currency IS NOT NULL AND c.code IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot retain an unknown Sales Organization currency code.';
  END IF;
END $$;

-- Rebuild the customer-area composite FK after narrowing the shared key columns.
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'customer_sales_area'::regclass
       AND confrelid = 'sales_area'::regclass
       AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE customer_sales_area DROP CONSTRAINT %I', fk.conname);
  END LOOP;
END $$;

ALTER TABLE sales_org
  ALTER COLUMN sales_org TYPE varchar(4),
  ALTER COLUMN company_code DROP NOT NULL,
  ALTER COLUMN currency DROP NOT NULL,
  ALTER COLUMN currency TYPE varchar(5) USING btrim(currency);

ALTER TABLE sales_area
  ALTER COLUMN sales_org TYPE varchar(4);

ALTER TABLE customer_sales_area
  ALTER COLUMN sales_org TYPE varchar(4);

-- Align the reference value-help catalogue with TCURC's five-character CUKY field.
-- Supplier purchasing keeps its legacy three-character local key; rebuild its reference FK around the catalogue key change.
ALTER TABLE supplier_purchasing_org
  DROP CONSTRAINT IF EXISTS supplier_purchasing_org_order_currency_currency_code_fk;
ALTER TABLE currency
  ALTER COLUMN code TYPE char(5) USING rpad(btrim(code), 5, ' ');
ALTER TABLE supplier_purchasing_org
  ADD CONSTRAINT supplier_purchasing_org_order_currency_currency_code_fk
    FOREIGN KEY (order_currency) REFERENCES currency(code) ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE SEQUENCE central_address_number_seq AS bigint
  MINVALUE 1 MAXVALUE 9999999999 START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE central_address (
  client varchar(4) NOT NULL REFERENCES client(client) ON DELETE CASCADE,
  address_number char(10) NOT NULL,
  country char(2) NOT NULL,
  search_term_1 varchar(20),
  search_term_2 varchar(20),
  street varchar(60),
  house_number varchar(10),
  postal_code varchar(10),
  city varchar(40),
  region varchar(3),
  po_box varchar(10),
  po_box_postal_code varchar(10),
  company_postal_code varchar(10),
  telephone varchar(30),
  telephone_extension varchar(10),
  mobile_phone varchar(30),
  fax_number varchar(30),
  fax_extension varchar(10),
  email_address varchar(241),
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT central_address_pk PRIMARY KEY (client, address_number),
  CONSTRAINT central_address_number_format_ck CHECK (address_number ~ '^[0-9]{10}$'),
  CONSTRAINT central_address_country_fk FOREIGN KEY (country)
    REFERENCES country(code) ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE TABLE factory_calendar (
  client varchar(4) NOT NULL REFERENCES client(client) ON DELETE CASCADE,
  calendar_id char(2) NOT NULL,
  name varchar(120) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT factory_calendar_pk PRIMARY KEY (client, calendar_id),
  CONSTRAINT factory_calendar_key_format_ck CHECK (calendar_id ~ '^[A-Z0-9]{2}$')
);

ALTER TABLE sales_org
  ADD COLUMN address_number char(10),
  ADD COLUMN factory_calendar char(2),
  ADD COLUMN purchasing_organization varchar(4),
  ADD COLUMN reference_sales_org varchar(4),
  ADD COLUMN intercompany_billing_customer varchar(10),
  ADD COLUMN intercompany_billing_vendor varchar(10),
  ADD COLUMN rebate_processing_active boolean NOT NULL DEFAULT false,
  ADD COLUMN ale_purchase_orders boolean NOT NULL DEFAULT false;

CREATE TABLE sales_org_text (
  client varchar(4) NOT NULL REFERENCES client(client) ON DELETE CASCADE,
  sales_org varchar(4) NOT NULL,
  language_key char(1) NOT NULL,
  name varchar(35) NOT NULL,
  form_text char(12),
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT sales_org_text_pk PRIMARY KEY (client, sales_org, language_key),
  CONSTRAINT sales_org_text_language_format_ck CHECK (language_key ~ '^[A-Z]$'),
  CONSTRAINT sales_org_text_sales_org_fk FOREIGN KEY (client, sales_org)
    REFERENCES sales_org(client, sales_org) ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- Existing single-language names migrate to SAP's English language key E.
INSERT INTO sales_org_text (client, sales_org, language_key, name, form_text, created_by, created_at, changed_by, changed_at)
SELECT client, sales_org, 'E', btrim(name), 'STANDARD', created_by, created_at, changed_by, changed_at
  FROM sales_org;

-- Existing required country values become CAM address records with generated ten-digit ADRNRs.
-- Address details beyond country were not previously persisted on sales_org.
WITH source AS MATERIALIZED (
  SELECT client, sales_org, lpad(nextval('central_address_number_seq')::text, 10, '0') AS address_number,
         country, created_by, created_at, changed_by, changed_at
    FROM sales_org
   ORDER BY client, sales_org
), inserted AS (
  INSERT INTO central_address (client, address_number, country, created_by, created_at, changed_by, changed_at)
  SELECT client, address_number, country, created_by, created_at, changed_by, changed_at
    FROM source
  RETURNING client, address_number
)
UPDATE sales_org AS org
   SET address_number = inserted.address_number
  FROM source
  JOIN inserted USING (client, address_number)
 WHERE org.client = source.client
   AND org.sales_org = source.sales_org;

-- Convert the former inline Name/Country columns into language-dependent TVKOT text and CAM address data.
ALTER TABLE sales_org
  DROP COLUMN name,
  DROP COLUMN country;

ALTER TABLE sales_org
  ADD CONSTRAINT sales_org_key_format_ck CHECK (sales_org ~ '^[A-Z0-9]{4}$'),
  ADD CONSTRAINT sales_org_address_number_format_ck CHECK (address_number IS NULL OR address_number ~ '^[0-9]{10}$'),
  ADD CONSTRAINT sales_org_factory_calendar_format_ck CHECK (factory_calendar IS NULL OR factory_calendar ~ '^[A-Z0-9]{2}$'),
  ADD CONSTRAINT sales_org_purchasing_org_format_ck CHECK (purchasing_organization IS NULL OR purchasing_organization ~ '^[A-Z0-9]{4}$'),
  ADD CONSTRAINT sales_org_reference_sales_org_format_ck CHECK (reference_sales_org IS NULL OR reference_sales_org ~ '^[A-Z0-9]{4}$'),
  ADD CONSTRAINT sales_org_intercompany_vendor_format_ck CHECK (intercompany_billing_vendor IS NULL OR intercompany_billing_vendor ~ '^[0-9]{1,10}$'),
  ADD CONSTRAINT sales_org_company_code_fk FOREIGN KEY (client, company_code)
    REFERENCES company_code (client, company_code) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT sales_org_address_number_fk FOREIGN KEY (client, address_number)
    REFERENCES central_address (client, address_number) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT sales_org_factory_calendar_fk FOREIGN KEY (client, factory_calendar)
    REFERENCES factory_calendar (client, calendar_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT sales_org_purchasing_org_fk FOREIGN KEY (client, purchasing_organization)
    REFERENCES purchasing_org (client, purchasing_org) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT sales_org_reference_sales_org_fk FOREIGN KEY (client, reference_sales_org)
    REFERENCES sales_org (client, sales_org) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT sales_org_intercompany_customer_fk FOREIGN KEY (client, intercompany_billing_customer)
    REFERENCES business_partner (client, partner_number) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT sales_org_intercompany_vendor_fk FOREIGN KEY (client, intercompany_billing_vendor)
    REFERENCES business_partner (client, partner_number) ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE sales_area
  ADD CONSTRAINT sales_area_sales_org_key_format_ck CHECK (sales_org ~ '^[A-Z0-9]{4}$'),
  ADD CONSTRAINT sales_area_sales_org_fk FOREIGN KEY (client, sales_org)
    REFERENCES sales_org (client, sales_org) ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE customer_sales_area
  ADD CONSTRAINT customer_sales_area_sales_org_key_format_ck CHECK (sales_org ~ '^[A-Z0-9]{4}$'),
  ADD CONSTRAINT customer_sales_area_sales_area_fk FOREIGN KEY (client, sales_org, distribution_channel, division)
    REFERENCES sales_area (client, sales_org, distribution_channel, division) ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX central_address_country_idx ON central_address (client, country);
CREATE INDEX factory_calendar_active_idx ON factory_calendar (client, is_active, calendar_id);
CREATE INDEX sales_org_text_language_idx ON sales_org_text (client, language_key, sales_org);

-- These may already exist if earlier global RLS setup ran before this SCR-020 migration.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['central_address', 'factory_calendar', 'sales_org_text'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($policy$
      CREATE POLICY tenant_isolation ON %I
        FOR ALL
        USING (client = current_setting('cairn.client', true))
        WITH CHECK (client = current_setting('cairn.client', true))
    $policy$, t);
  END LOOP;
END $$;

-- Migrations can be installed after the global application role already exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cairn_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON central_address, factory_calendar, sales_org_text TO cairn_app';
    EXECUTE 'GRANT USAGE, SELECT, UPDATE ON SEQUENCE central_address_number_seq TO cairn_app';
  END IF;
END $$;
