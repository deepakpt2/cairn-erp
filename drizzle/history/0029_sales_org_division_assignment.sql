-- OVXA: tenant-scoped Sales Organization ↔ Division assignments.
-- Preserve every Sales Organization / Division pair already implied by Sales Areas.

CREATE TABLE sales_org_division (
  client varchar(4) NOT NULL,
  sales_org varchar(4) NOT NULL,
  division varchar(4) NOT NULL,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT sales_org_division_pk
    PRIMARY KEY (client, sales_org, division),
  CONSTRAINT sales_org_division_sales_org_format_ck
    CHECK (sales_org ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT sales_org_division_division_format_ck
    CHECK (division ~ '^[A-Z0-9]{2}$'),
  CONSTRAINT sales_org_division_client_fk
    FOREIGN KEY (client) REFERENCES client (client)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT sales_org_division_sales_org_fk
    FOREIGN KEY (client, sales_org) REFERENCES sales_org (client, sales_org)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT sales_org_division_definition_fk
    FOREIGN KEY (client, division) REFERENCES division (client, division)
    ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX sales_org_division_division_idx
  ON sales_org_division (client, division, sales_org);

-- Existing Sales Area combinations imply an allowed Sales Organization / Division pair.
INSERT INTO sales_org_division (client, sales_org, division, created_by)
SELECT DISTINCT client, sales_org, division, 'MIGRATION'
  FROM sales_area
ON CONFLICT (client, sales_org, division) DO NOTHING;
