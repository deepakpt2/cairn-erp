-- OMCX may store an access that names a standing Inventory Management condition table.
-- The access number is two digits. Exclusive access, a requirement, and field mapping are not columns.
-- Naming a table does not search it.

CREATE TABLE IF NOT EXISTS batch_access_step (
  client varchar(4) NOT NULL,
  usage char(1) NOT NULL DEFAULT 'H',
  application char(2) NOT NULL DEFAULT 'ME',
  access_sequence varchar(4) NOT NULL,
  access_number char(2) NOT NULL,
  condition_table char(3) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, usage, application, access_sequence, access_number),
  CONSTRAINT batch_access_step_header_fk
    FOREIGN KEY (client, usage, application, access_sequence)
    REFERENCES batch_access_sequence (client, usage, application, access_sequence)
    ON DELETE CASCADE,
  CONSTRAINT batch_access_step_table_fk
    FOREIGN KEY (client, usage, condition_table)
    REFERENCES batch_condition_table (client, usage, condition_table),
  CONSTRAINT batch_access_step_usage_ck CHECK (usage = 'H'),
  CONSTRAINT batch_access_step_application_ck CHECK (application = 'ME'),
  CONSTRAINT batch_access_step_number_ck CHECK (access_number ~ '^[0-9]{2}$'),
  CONSTRAINT batch_access_step_table_ck CHECK (condition_table ~ '^[0-9]{3}$'),
  CONSTRAINT batch_access_step_version_ck CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS batch_access_step_table_idx
  ON batch_access_step (client, usage, condition_table);

ALTER TABLE batch_access_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_access_step FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_access_step
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_access_step FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_access_step TO cairn_app;

UPDATE term_registry
SET description = $omcx$Inventory Management access sequences. OMCX is a search alias only. The view is VV_T682_ME. Usage is H and application is ME. The key is four uppercase letters or digits. The description is at most thirty characters. An access names a condition table that already stands on OMA1. The access number is two digits and need not be gap-free. Naming a table does not search it. An exclusive indicator, a requirement, and a field mapping are not stored. A strategy type may name a standing sequence, and that name does not run an access or select a batch. Production and sales access sequences are not this screen. A transport and a plant are refused. Opening this screen writes nothing.$omcx$,
    changed_by = 'MIGRATION_9136',
    changed_at = now()
WHERE our_code = 'CFG.INV.BATCHACCESS.DEFINE';
