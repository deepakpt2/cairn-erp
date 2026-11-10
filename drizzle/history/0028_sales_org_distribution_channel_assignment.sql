-- OVXK: tenant-scoped Sales Organization ↔ Distribution Channel assignments.
-- Existing Sales Areas imply their Sales Organization / Distribution Channel pair;
-- preserve those assignments when introducing the explicit relation table.

CREATE TABLE sales_org_distribution_channel (
  client varchar(4) NOT NULL,
  sales_org varchar(4) NOT NULL,
  distribution_channel varchar(4) NOT NULL,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT sales_org_distribution_channel_pk
    PRIMARY KEY (client, sales_org, distribution_channel),
  CONSTRAINT sales_org_distribution_channel_sales_org_format_ck
    CHECK (sales_org ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT sales_org_distribution_channel_channel_format_ck
    CHECK (distribution_channel ~ '^[A-Z0-9]{2}$'),
  CONSTRAINT sales_org_distribution_channel_client_fk
    FOREIGN KEY (client) REFERENCES client (client)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT sales_org_distribution_channel_sales_org_fk
    FOREIGN KEY (client, sales_org) REFERENCES sales_org (client, sales_org)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT sales_org_distribution_channel_definition_fk
    FOREIGN KEY (client, distribution_channel)
    REFERENCES distribution_channel (client, distribution_channel)
    ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX sales_org_distribution_channel_channel_idx
  ON sales_org_distribution_channel (client, distribution_channel, sales_org);

-- Migrate existing Sales Area combinations into the new explicit assignment set.
INSERT INTO sales_org_distribution_channel
  (client, sales_org, distribution_channel, created_by)
SELECT DISTINCT client, sales_org, distribution_channel, 'MIGRATION'
FROM sales_area
ON CONFLICT (client, sales_org, distribution_channel) DO NOTHING;
