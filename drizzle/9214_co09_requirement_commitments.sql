-- CO09 Slice 2: immutable availability-check snapshots and append-only commitment events.
-- Existing order components retain NULL eligibility facts: their BOM item category,
-- phantom flag, and bulk flag were not snapshotted, so Slice 2 must refuse them rather
-- than reread a BOM that may have changed since the order was created.

ALTER TABLE public.bom_item_category
  ADD COLUMN stock_relevant char(1);
ALTER TABLE public.bom_item_category
  ADD CONSTRAINT bom_item_category_stock_relevant_ck
    CHECK (stock_relevant IS NULL OR stock_relevant IN ('X', ' '));

ALTER TABLE public.production_order_component
  ADD COLUMN bom_item_category char(1),
  ADD COLUMN bom_stock_relevant char(1),
  ADD COLUMN bom_phantom char(1),
  ADD COLUMN bom_bulk_material char(1);

ALTER TABLE public.production_order_component
  ADD CONSTRAINT production_order_component_bom_category_ck
    CHECK (bom_item_category IS NULL OR bom_item_category ~ '^[A-Z0-9]$'),
  ADD CONSTRAINT production_order_component_bom_stock_relevant_ck
    CHECK (bom_stock_relevant IS NULL OR bom_stock_relevant IN ('X', ' ')),
  ADD CONSTRAINT production_order_component_bom_phantom_ck
    CHECK (bom_phantom IS NULL OR bom_phantom IN ('X', ' ')),
  ADD CONSTRAINT production_order_component_bom_bulk_ck
    CHECK (bom_bulk_material IS NULL OR bom_bulk_material IN ('X', ' '));

CREATE TABLE public.production_order_availability_run (
  client varchar(4) NOT NULL REFERENCES public.client (client) ON DELETE CASCADE,
  request_key varchar(64) NOT NULL,
  order_number varchar(12) NOT NULL,
  action varchar(12) NOT NULL,
  request_fingerprint varchar(64) NOT NULL,
  result_snapshot jsonb NOT NULL,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_order_availability_run_pk PRIMARY KEY (client, request_key),
  CONSTRAINT production_order_availability_run_order_fk
    FOREIGN KEY (client, order_number)
    REFERENCES public.production_order (client, order_number) ON DELETE RESTRICT,
  CONSTRAINT production_order_availability_run_action_ck
    CHECK (action IN ('COMMIT', 'RESET')),
  CONSTRAINT production_order_availability_run_key_ck
    CHECK (char_length(btrim(request_key)) BETWEEN 1 AND 64),
  CONSTRAINT production_order_availability_run_fingerprint_ck
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT production_order_availability_run_result_ck
    CHECK (jsonb_typeof(result_snapshot) = 'object')
);
CREATE INDEX production_order_availability_run_order_idx
  ON public.production_order_availability_run (client, order_number, created_at);

CREATE TABLE public.production_order_component_commitment_event (
  client varchar(4) NOT NULL REFERENCES public.client (client) ON DELETE CASCADE,
  event_number bigserial NOT NULL,
  request_key varchar(64) NOT NULL,
  order_number varchar(12) NOT NULL,
  item_number integer NOT NULL,
  material_number varchar(40) NOT NULL,
  plant varchar(10) NOT NULL,
  event_kind varchar(12) NOT NULL,
  committed_quantity numeric(23, 3) NOT NULL,
  requirement_date date,
  checking_group varchar(12),
  checking_rule varchar(2),
  scope_key varchar(32),
  supersedes_event_number bigint,
  reason varchar(200),
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_order_component_commitment_event_pk PRIMARY KEY (client, event_number),
  CONSTRAINT production_order_component_commitment_event_run_fk
    FOREIGN KEY (client, request_key)
    REFERENCES public.production_order_availability_run (client, request_key) ON DELETE RESTRICT,
  CONSTRAINT production_order_component_commitment_event_component_fk
    FOREIGN KEY (client, order_number, item_number)
    REFERENCES public.production_order_component (client, order_number, item_number) ON DELETE RESTRICT,
  CONSTRAINT production_order_component_commitment_event_supersedes_fk
    FOREIGN KEY (client, supersedes_event_number)
    REFERENCES public.production_order_component_commitment_event (client, event_number) ON DELETE RESTRICT,
  CONSTRAINT production_order_component_commitment_event_kind_ck
    CHECK (event_kind IN ('COMMITTED', 'RELEASED', 'RESET')),
  CONSTRAINT production_order_component_commitment_event_quantity_ck
    CHECK (
      (event_kind = 'COMMITTED' AND committed_quantity > 0 AND requirement_date IS NOT NULL)
      OR (event_kind IN ('RELEASED', 'RESET') AND committed_quantity = 0)
    ),
  CONSTRAINT production_order_component_commitment_event_reason_ck
    CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 200),
  CONSTRAINT production_order_component_commitment_event_reset_reason_ck
    CHECK (event_kind <> 'RESET' OR char_length(btrim(reason)) BETWEEN 1 AND 200),
  CONSTRAINT production_order_component_commitment_event_supersedes_ck
    CHECK (supersedes_event_number IS NULL OR supersedes_event_number < event_number)
);
CREATE UNIQUE INDEX production_order_component_commitment_event_run_item_uq
  ON public.production_order_component_commitment_event (client, request_key, order_number, item_number);
CREATE INDEX production_order_component_commitment_event_current_idx
  ON public.production_order_component_commitment_event (client, order_number, item_number, event_number);
CREATE INDEX production_order_component_commitment_event_material_idx
  ON public.production_order_component_commitment_event (client, material_number, plant, event_number DESC);

ALTER TABLE public.production_order_availability_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_order_availability_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.production_order_availability_run
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON public.production_order_availability_run FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON public.production_order_availability_run FROM cairn_app;
GRANT SELECT, INSERT ON public.production_order_availability_run TO cairn_app;

ALTER TABLE public.production_order_component_commitment_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_order_component_commitment_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.production_order_component_commitment_event
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON public.production_order_component_commitment_event FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON public.production_order_component_commitment_event FROM cairn_app;
GRANT SELECT, INSERT ON public.production_order_component_commitment_event TO cairn_app;
GRANT USAGE, SELECT ON SEQUENCE public.production_order_component_commitment_event_event_number_seq TO cairn_app;

CREATE OR REPLACE FUNCTION public.production_order_availability_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CO09 availability runs and commitment events are append-only.'
    USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION public.production_order_availability_append_only() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.production_order_availability_append_only() TO cairn_app;
CREATE TRIGGER production_order_availability_run_append_only_trg
  BEFORE UPDATE OR DELETE ON public.production_order_availability_run
  FOR EACH ROW EXECUTE FUNCTION public.production_order_availability_append_only();
CREATE TRIGGER production_order_component_commitment_event_append_only_trg
  BEFORE UPDATE OR DELETE ON public.production_order_component_commitment_event
  FOR EACH ROW EXECUTE FUNCTION public.production_order_availability_append_only();

INSERT INTO public.capability (code, module, action, is_posting_relevant, description)
VALUES
  ('PROD.ORDER.AVAILABILITY.COMMIT', 'PROD', 'EXECUTE', false,
   'Commit fully covered production-order component requirements through CO09. Each component is all-or-nothing; this writes no goods movement, journal, reservation, or order status.'),
  ('PROD.ORDER.AVAILABILITY.RESET', 'PROD', 'REVERSE', false,
   'Append an audited reset event for active CO09 component commitments. The event history is retained; no physical deletion occurs.')
ON CONFLICT (code) DO UPDATE SET
  module = EXCLUDED.module,
  action = EXCLUDED.action,
  is_posting_relevant = EXCLUDED.is_posting_relevant,
  description = EXCLUDED.description;

COMMENT ON TABLE public.production_order_availability_run IS
  'Immutable request and result snapshot for one CO09 commit or reset run. The request key makes retries idempotent; the fingerprint refuses key reuse for different input.';
COMMENT ON TABLE public.production_order_component_commitment_event IS
  'Append-only CO09 component commitment history. COMMITTED establishes the current quantity; RELEASED and RESET supersede it without deleting prior events.';
COMMENT ON COLUMN public.production_order_component_commitment_event.committed_quantity IS
  'The full component requirement for COMMITTED events, or zero for RELEASED and RESET. Partial commitments are not configured in this ERP.';
COMMENT ON COLUMN public.production_order_component_commitment_event.supersedes_event_number IS
  'The prior current event for this order component, if any. A later event supersedes but never mutates it.';
