-- Durable work items for automatic CO11N goods movements.
--
-- A confirmation and its movement intents commit first. Each issue/receipt then
-- runs in its own transaction. A failed posting transaction is rolled back before
-- its attempt is recorded as FAILED here; a successful posting and the transition
-- to POSTED share one transaction. This migration adds no COGI screen or alias.

CREATE TABLE public.production_goods_movement_failure (
  id varchar(36) PRIMARY KEY,
  client varchar(4) NOT NULL REFERENCES public.client (client) ON DELETE CASCADE,
  source_transaction varchar(8) NOT NULL DEFAULT 'CO11N',
  source_document_class varchar(48) NOT NULL DEFAULT 'production_confirmation',
  source_document_number varchar(12) NOT NULL,
  confirmation_number varchar(12) NOT NULL,
  confirmation_request_key varchar(64) NOT NULL,
  order_number varchar(12) NOT NULL,
  operation_number varchar(4) NOT NULL,
  plant varchar(10) NOT NULL,
  movement_kind varchar(8) NOT NULL,
  movement_type varchar(20) NOT NULL,
  posting_date date NOT NULL,
  document_date date NOT NULL,
  header_text varchar(25) NOT NULL,
  original_request_key varchar(64) NOT NULL,
  idempotency_fingerprint varchar(64) NOT NULL,
  original_payload jsonb NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  failure_code varchar(64),
  error_text text,
  attempt_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  processing_token varchar(36),
  processing_lease_expires_at timestamptz,
  material_document_number varchar(20),
  document_year integer,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT production_gm_failure_client_id_uq UNIQUE (client, id),
  CONSTRAINT production_gm_failure_client_id_plant_uq UNIQUE (client, id, plant),
  CONSTRAINT production_gm_failure_request_uq UNIQUE (client, original_request_key),
  CONSTRAINT production_gm_failure_confirmation_kind_uq UNIQUE (client, confirmation_number, movement_kind),
  CONSTRAINT production_gm_failure_source_confirmation_fk
    FOREIGN KEY (client, source_document_number)
    REFERENCES public.production_confirmation (client, confirmation_number) ON DELETE RESTRICT,
  CONSTRAINT production_gm_failure_confirmation_fk
    FOREIGN KEY (client, confirmation_number)
    REFERENCES public.production_confirmation (client, confirmation_number) ON DELETE RESTRICT,
  CONSTRAINT production_gm_failure_order_fk
    FOREIGN KEY (client, order_number)
    REFERENCES public.production_order (client, order_number) ON DELETE RESTRICT,
  CONSTRAINT production_gm_failure_plant_fk
    FOREIGN KEY (client, plant)
    REFERENCES public.plant (client, plant) ON DELETE RESTRICT,
  CONSTRAINT production_gm_failure_document_fk
    FOREIGN KEY (client, material_document_number)
    REFERENCES public.material_document (client, material_document_number) ON DELETE RESTRICT,
  CONSTRAINT production_gm_failure_source_ck
    CHECK (source_transaction = 'CO11N' AND source_document_class = 'production_confirmation'),
  CONSTRAINT production_gm_failure_source_key_ck
    CHECK (source_document_number = confirmation_number),
  CONSTRAINT production_gm_failure_operation_ck
    CHECK (operation_number ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT production_gm_failure_movement_ck
    CHECK ((movement_kind = 'ISSUE' AND movement_type = 'PROD_ISSUE_ORDER')
        OR (movement_kind = 'RECEIPT' AND movement_type = 'PROD_RECEIPT_ORDER')),
  CONSTRAINT production_gm_failure_status_ck
    CHECK (status IN ('PENDING', 'PROCESSING', 'FAILED', 'BLOCKED', 'POSTED')),
  CONSTRAINT production_gm_failure_payload_ck
    CHECK (jsonb_typeof(original_payload) = 'object'),
  CONSTRAINT production_gm_failure_fingerprint_ck
    CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT production_gm_failure_attempt_count_ck
    CHECK (attempt_count >= 0 AND (status <> 'PROCESSING' OR attempt_count > 0)),
  CONSTRAINT production_gm_failure_lease_ck
    CHECK ((status = 'PROCESSING' AND processing_token IS NOT NULL AND processing_lease_expires_at IS NOT NULL)
        OR (status <> 'PROCESSING' AND processing_token IS NULL AND processing_lease_expires_at IS NULL)),
  CONSTRAINT production_gm_failure_posted_ck
    CHECK ((status = 'POSTED' AND material_document_number IS NOT NULL AND document_year IS NOT NULL)
        OR (status <> 'POSTED' AND material_document_number IS NULL AND document_year IS NULL)),
  CONSTRAINT production_gm_failure_error_ck
    CHECK (status NOT IN ('FAILED', 'BLOCKED') OR (failure_code IS NOT NULL AND error_text IS NOT NULL))
);

CREATE INDEX production_gm_failure_queue_idx
  ON public.production_goods_movement_failure (client, status, next_retry_at, created_at);
CREATE INDEX production_gm_failure_order_idx
  ON public.production_goods_movement_failure (client, order_number, created_at);
CREATE INDEX production_gm_failure_plant_idx
  ON public.production_goods_movement_failure (client, plant, status, created_at);

COMMENT ON TABLE public.production_goods_movement_failure IS
  'CO11N automatic goods movement intent and recovery state. COGI UI is not delivered by this migration.';
COMMENT ON COLUMN public.production_goods_movement_failure.original_payload IS
  'Immutable posting-service input captured with the confirmation; never reconstructed from mutable master data.';
COMMENT ON COLUMN public.production_goods_movement_failure.idempotency_fingerprint IS
  'SHA-256 of original_payload; the original_request_key is reused by every posting attempt.';

CREATE TABLE public.production_goods_movement_failure_line (
  client varchar(4) NOT NULL REFERENCES public.client (client) ON DELETE CASCADE,
  failure_id varchar(36) NOT NULL,
  line_number integer NOT NULL,
  material_number varchar(40) NOT NULL,
  plant varchar(10) NOT NULL,
  quantity numeric(23, 3) NOT NULL,
  unit varchar(10) NOT NULL,
  storage_location varchar(10),
  batch_number varchar(40) NOT NULL DEFAULT '',
  special_stock_type varchar(4),
  special_stock_number varchar(40),
  production_order_item integer,
  reservation_number varchar(20),
  reservation_item integer,
  original_payload jsonb NOT NULL,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT production_gm_failure_line_pk PRIMARY KEY (client, failure_id, line_number),
  CONSTRAINT production_gm_failure_line_parent_fk
    FOREIGN KEY (client, failure_id, plant)
    REFERENCES public.production_goods_movement_failure (client, id, plant) ON DELETE CASCADE,
  CONSTRAINT production_gm_failure_line_material_plant_fk
    FOREIGN KEY (client, material_number, plant)
    REFERENCES public.material_plant (client, material_number, plant) ON DELETE RESTRICT,
  CONSTRAINT production_gm_failure_line_storage_location_fk
    FOREIGN KEY (client, plant, storage_location)
    REFERENCES public.storage_location (client, plant, storage_location) ON DELETE RESTRICT,
  CONSTRAINT production_gm_failure_line_number_ck CHECK (line_number > 0),
  CONSTRAINT production_gm_failure_line_qty_ck CHECK (quantity > 0 AND char_length(btrim(unit)) > 0),
  CONSTRAINT production_gm_failure_line_reservation_ck
    CHECK ((reservation_number IS NULL AND reservation_item IS NULL)
        OR (reservation_number IS NOT NULL AND reservation_item IS NOT NULL)),
  CONSTRAINT production_gm_failure_line_special_stock_ck
    CHECK ((special_stock_type IS NULL AND special_stock_number IS NULL)
        OR (special_stock_type IS NOT NULL AND special_stock_number IS NOT NULL)),
  CONSTRAINT production_gm_failure_line_payload_ck CHECK (jsonb_typeof(original_payload) = 'object')
);
CREATE INDEX production_gm_failure_line_material_idx
  ON public.production_goods_movement_failure_line (client, material_number, plant);

COMMENT ON TABLE public.production_goods_movement_failure_line IS
  'Immutable normalized CO11N movement lines, including batch, reservation, and special-stock context when supplied.';

CREATE TABLE public.production_goods_movement_failure_attempt (
  id varchar(36) PRIMARY KEY,
  client varchar(4) NOT NULL REFERENCES public.client (client) ON DELETE CASCADE,
  failure_id varchar(36) NOT NULL,
  attempt_number integer NOT NULL,
  lease_token varchar(36) NOT NULL,
  attempted_by varchar(60) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PROCESSING',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  failure_code varchar(64),
  error_text text,
  material_document_number varchar(20),
  document_year integer,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT production_gm_failure_attempt_number_uq UNIQUE (client, failure_id, attempt_number),
  CONSTRAINT production_gm_failure_attempt_parent_fk
    FOREIGN KEY (client, failure_id)
    REFERENCES public.production_goods_movement_failure (client, id) ON DELETE CASCADE,
  CONSTRAINT production_gm_failure_attempt_document_fk
    FOREIGN KEY (client, material_document_number)
    REFERENCES public.material_document (client, material_document_number) ON DELETE RESTRICT,
  CONSTRAINT production_gm_failure_attempt_number_ck CHECK (attempt_number > 0),
  CONSTRAINT production_gm_failure_attempt_status_ck
    CHECK (status IN ('PROCESSING', 'FAILED', 'BLOCKED', 'SUCCEEDED', 'ABANDONED')),
  CONSTRAINT production_gm_failure_attempt_finish_ck
    CHECK ((status = 'PROCESSING' AND finished_at IS NULL)
        OR (status <> 'PROCESSING' AND finished_at IS NOT NULL)),
  CONSTRAINT production_gm_failure_attempt_error_ck
    CHECK (status NOT IN ('FAILED', 'BLOCKED', 'ABANDONED') OR (failure_code IS NOT NULL AND error_text IS NOT NULL)),
  CONSTRAINT production_gm_failure_attempt_document_ck
    CHECK ((status = 'SUCCEEDED' AND material_document_number IS NOT NULL AND document_year IS NOT NULL)
        OR (status <> 'SUCCEEDED' AND material_document_number IS NULL AND document_year IS NULL))
);
CREATE INDEX production_gm_failure_attempt_history_idx
  ON public.production_goods_movement_failure_attempt (client, failure_id, attempt_number);

COMMENT ON TABLE public.production_goods_movement_failure_attempt IS
  'Per-attempt result history. An expired PROCESSING attempt is marked ABANDONED before exclusive ownership is reclaimed.';

ALTER TABLE public.production_goods_movement_failure ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_goods_movement_failure FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.production_goods_movement_failure;
CREATE POLICY tenant_isolation ON public.production_goods_movement_failure
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON public.production_goods_movement_failure FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.production_goods_movement_failure TO cairn_app;

ALTER TABLE public.production_goods_movement_failure_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_goods_movement_failure_line FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.production_goods_movement_failure_line;
CREATE POLICY tenant_isolation ON public.production_goods_movement_failure_line
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON public.production_goods_movement_failure_line FROM PUBLIC;
GRANT SELECT, INSERT ON public.production_goods_movement_failure_line TO cairn_app;

ALTER TABLE public.production_goods_movement_failure_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_goods_movement_failure_attempt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.production_goods_movement_failure_attempt;
CREATE POLICY tenant_isolation ON public.production_goods_movement_failure_attempt
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON public.production_goods_movement_failure_attempt FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.production_goods_movement_failure_attempt TO cairn_app;
