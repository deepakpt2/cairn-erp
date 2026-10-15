-- SCR-026 / OB13: migrate Chart of Accounts to SAP's four-character key and
-- persist the definition fields. Preserve existing account-number lengths;
-- only newly created chart records use the new default of 10.
-- Historical append-only change documents remain under their original key CAIRN.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM chart_of_accounts old_chart
      JOIN chart_of_accounts new_chart
        ON new_chart.client = old_chart.client
       AND new_chart.chart_of_accounts = 'CA01'
     WHERE old_chart.chart_of_accounts = 'CAIRN'
  ) THEN
    RAISE EXCEPTION '0033 refuses CAIRN → CA01 migration: a tenant already has a CA01 Chart of Accounts';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM chart_of_accounts
     WHERE CASE WHEN chart_of_accounts = 'CAIRN' THEN 'CA01' ELSE chart_of_accounts END !~ '^[A-Z0-9]{4}$'
  ) THEN
    RAISE EXCEPTION '0033 refuses four-character Chart of Accounts keys: an existing key other than CAIRN is not uppercase alphanumeric Char 4';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM chart_of_accounts
     WHERE length(name) NOT BETWEEN 1 AND 50
  ) THEN
    RAISE EXCEPTION '0033 refuses the 50-character Description field: an existing Chart of Accounts description is empty or too long';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM chart_of_accounts
     WHERE language !~ '^[A-Z]{2}$'
        OR language <> 'EN'
        OR account_number_length NOT BETWEEN 1 AND 10
  ) THEN
    RAISE EXCEPTION '0033 refuses OB13 field constraints: an existing language key or G/L account-number length is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM chart_of_accounts chart
      LEFT JOIN chart_of_accounts group_chart
        ON group_chart.client = chart.client
       AND group_chart.chart_of_accounts = chart.group_chart
     WHERE chart.group_chart IS NOT NULL
       AND (
         CASE WHEN chart.group_chart = 'CAIRN' THEN 'CA01' ELSE chart.group_chart END !~ '^[A-Z0-9]{4}$'
         OR CASE WHEN chart.group_chart = 'CAIRN' THEN 'CA01' ELSE chart.group_chart END = CASE WHEN chart.chart_of_accounts = 'CAIRN' THEN 'CA01' ELSE chart.chart_of_accounts END
         OR group_chart.client IS NULL
       )
  ) THEN
    RAISE EXCEPTION '0033 refuses Group CoA references: an existing Group CoA is invalid, self-referencing, or missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM gl_account
     WHERE length(account_number) > 10
  ) OR EXISTS (
    SELECT 1
      FROM supplier_company_code
     WHERE reconciliation_account IS NOT NULL
       AND length(reconciliation_account) > 10
  ) OR EXISTS (
    SELECT 1
      FROM customer_company_code
     WHERE reconciliation_account IS NOT NULL
       AND length(reconciliation_account) > 10
  ) OR EXISTS (
    SELECT 1
      FROM journal_entry_line
     WHERE length(gl_account) > 10
  ) OR EXISTS (
    SELECT 1
      FROM company_code
     WHERE intercompany_clearing_account IS NOT NULL
       AND length(intercompany_clearing_account) > 10
  ) THEN
    RAISE EXCEPTION '0033 refuses the 10-character G/L Account Number limit: existing account or reconciliation references exceed 10 characters';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM company_code company
      LEFT JOIN chart_of_accounts chart
        ON chart.client = company.client
       AND chart.chart_of_accounts = company.chart_of_accounts
     WHERE company.chart_of_accounts IS NOT NULL
       AND chart.client IS NULL
  ) OR EXISTS (
    SELECT 1
      FROM gl_account account
      LEFT JOIN chart_of_accounts chart
        ON chart.client = account.client
       AND chart.chart_of_accounts = account.chart_of_accounts
     WHERE chart.client IS NULL
  ) OR EXISTS (
    SELECT 1
      FROM supplier_company_code supplier
      LEFT JOIN chart_of_accounts chart
        ON chart.client = supplier.client
       AND chart.chart_of_accounts = supplier.chart_of_accounts
     WHERE chart.client IS NULL
  ) OR EXISTS (
    SELECT 1
      FROM customer_company_code customer
      LEFT JOIN chart_of_accounts chart
        ON chart.client = customer.client
       AND chart.chart_of_accounts = customer.chart_of_accounts
     WHERE chart.client IS NULL
  ) THEN
    RAISE EXCEPTION '0033 refuses tenant-local Chart of Accounts foreign keys: an existing assignment/account references a missing chart';
  END IF;
END $$;

-- Drop only the reconciliation-account FKs whose referenced key columns are narrowed below.
ALTER TABLE supplier_company_code
  DROP CONSTRAINT supplier_company_code_client_chart_of_accounts_reconciliation_a;
ALTER TABLE customer_company_code
  DROP CONSTRAINT customer_company_code_client_chart_of_accounts_reconciliation_a;

-- Standard key migration. Keep historical audit/change-document records immutable.
UPDATE chart_of_accounts
   SET chart_of_accounts = 'CA01'
 WHERE chart_of_accounts = 'CAIRN';
UPDATE chart_of_accounts
   SET group_chart = 'CA01'
 WHERE group_chart = 'CAIRN';
UPDATE company_code
   SET chart_of_accounts = 'CA01'
 WHERE chart_of_accounts = 'CAIRN';
UPDATE gl_account
   SET chart_of_accounts = 'CA01'
 WHERE chart_of_accounts = 'CAIRN';
UPDATE supplier_company_code
   SET chart_of_accounts = 'CA01'
 WHERE chart_of_accounts = 'CAIRN';
UPDATE customer_company_code
   SET chart_of_accounts = 'CA01'
 WHERE chart_of_accounts = 'CAIRN';

ALTER TABLE chart_of_accounts
  ALTER COLUMN chart_of_accounts TYPE varchar(4),
  ALTER COLUMN name TYPE varchar(50),
  ALTER COLUMN account_number_length SET DEFAULT 10,
  ALTER COLUMN group_chart TYPE varchar(4),
  ADD COLUMN cost_element_integration varchar(12) NOT NULL DEFAULT 'AUTOMATIC',
  ADD COLUMN is_blocked boolean NOT NULL DEFAULT false;
ALTER TABLE company_code
  ALTER COLUMN chart_of_accounts TYPE varchar(4),
  ALTER COLUMN intercompany_clearing_account TYPE varchar(10);
ALTER TABLE gl_account
  ALTER COLUMN chart_of_accounts TYPE varchar(4),
  ALTER COLUMN account_number TYPE varchar(10);
ALTER TABLE journal_entry_line
  ALTER COLUMN gl_account TYPE varchar(10);
ALTER TABLE supplier_company_code
  ALTER COLUMN chart_of_accounts TYPE varchar(4),
  ALTER COLUMN reconciliation_account TYPE varchar(10);
ALTER TABLE customer_company_code
  ALTER COLUMN chart_of_accounts TYPE varchar(4),
  ALTER COLUMN reconciliation_account TYPE varchar(10);

ALTER TABLE chart_of_accounts
  ADD CONSTRAINT chart_of_accounts_key_format
    CHECK (chart_of_accounts ~ '^[A-Z0-9]{4}$'),
  ADD CONSTRAINT chart_of_accounts_name_nonempty
    CHECK (length(btrim(name)) BETWEEN 1 AND 50),
  ADD CONSTRAINT chart_of_accounts_language_format
    CHECK (language ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT chart_of_accounts_language_supported
    CHECK (language IN ('EN')),
  ADD CONSTRAINT chart_of_accounts_account_length
    CHECK (account_number_length BETWEEN 1 AND 10),
  ADD CONSTRAINT chart_of_accounts_group_key_format
    CHECK (group_chart IS NULL OR group_chart ~ '^[A-Z0-9]{4}$'),
  ADD CONSTRAINT chart_of_accounts_group_not_self
    CHECK (group_chart IS NULL OR group_chart <> chart_of_accounts),
  ADD CONSTRAINT chart_of_accounts_cost_element_integration
    CHECK (cost_element_integration IN ('AUTOMATIC', 'MANUAL', 'NONE')),
  ADD CONSTRAINT chart_of_accounts_client_group_chart_fk
    FOREIGN KEY (client, group_chart)
    REFERENCES chart_of_accounts (client, chart_of_accounts)
    ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE company_code
  ADD CONSTRAINT company_code_client_chart_of_accounts_fk
    FOREIGN KEY (client, chart_of_accounts)
    REFERENCES chart_of_accounts (client, chart_of_accounts)
    ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE gl_account
  ADD CONSTRAINT gl_account_client_chart_of_accounts_fk
    FOREIGN KEY (client, chart_of_accounts)
    REFERENCES chart_of_accounts (client, chart_of_accounts)
    ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE supplier_company_code
  ADD CONSTRAINT supplier_company_chart_of_accounts_fk
    FOREIGN KEY (client, chart_of_accounts)
    REFERENCES chart_of_accounts (client, chart_of_accounts)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT supplier_company_code_client_chart_of_accounts_reconciliation_a
    FOREIGN KEY (client, chart_of_accounts, reconciliation_account)
    REFERENCES gl_account (client, chart_of_accounts, account_number)
    ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE customer_company_code
  ADD CONSTRAINT customer_company_chart_of_accounts_fk
    FOREIGN KEY (client, chart_of_accounts)
    REFERENCES chart_of_accounts (client, chart_of_accounts)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT customer_company_code_client_chart_of_accounts_reconciliation_a
    FOREIGN KEY (client, chart_of_accounts, reconciliation_account)
    REFERENCES gl_account (client, chart_of_accounts, account_number)
    ON DELETE NO ACTION ON UPDATE NO ACTION;
