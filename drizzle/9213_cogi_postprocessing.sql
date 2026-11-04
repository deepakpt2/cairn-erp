-- COGI-style recovery for automatic goods movements caused by CO11N.
--
-- The source payload remains immutable. Corrections are append-only revisions and each
-- posting attempt records the exact revision it used. Discard is a retained, audited
-- terminal state (not a physical delete); reservations are deliberately not adjusted.

ALTER TABLE public.production_goods_movement_failure
  DROP CONSTRAINT production_gm_failure_status_ck;
ALTER TABLE public.production_goods_movement_failure
  ADD CONSTRAINT production_gm_failure_status_ck
  CHECK (status IN ('PENDING', 'PROCESSING', 'FAILED', 'BLOCKED', 'POSTED', 'DISCARDED'));

ALTER TABLE public.production_goods_movement_failure
  ADD COLUMN discarded_at timestamptz,
  ADD COLUMN discarded_by varchar(60),
  ADD COLUMN disposition_reason varchar(200);
ALTER TABLE public.production_goods_movement_failure
  ADD CONSTRAINT production_gm_failure_disposition_ck
  CHECK (
    (status = 'DISCARDED'
      AND discarded_at IS NOT NULL
      AND discarded_by IS NOT NULL
      AND char_length(btrim(disposition_reason)) BETWEEN 1 AND 200)
    OR
    (status <> 'DISCARDED'
      AND discarded_at IS NULL
      AND discarded_by IS NULL
      AND disposition_reason IS NULL)
  );

CREATE TABLE public.production_goods_movement_failure_revision (
  client varchar(4) NOT NULL REFERENCES public.client (client) ON DELETE CASCADE,
  failure_id varchar(36) NOT NULL,
  revision_number integer NOT NULL,
  corrected_payload jsonb NOT NULL,
  payload_fingerprint varchar(64) NOT NULL,
  change_reason varchar(200) NOT NULL,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_gm_failure_revision_pk PRIMARY KEY (client, failure_id, revision_number),
  CONSTRAINT production_gm_failure_revision_parent_fk
    FOREIGN KEY (client, failure_id)
    REFERENCES public.production_goods_movement_failure (client, id) ON DELETE RESTRICT,
  CONSTRAINT production_gm_failure_revision_number_ck CHECK (revision_number > 0),
  CONSTRAINT production_gm_failure_revision_payload_ck CHECK (jsonb_typeof(corrected_payload) = 'object'),
  CONSTRAINT production_gm_failure_revision_fingerprint_ck CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT production_gm_failure_revision_reason_ck CHECK (char_length(btrim(change_reason)) BETWEEN 1 AND 200)
);
CREATE INDEX production_gm_failure_revision_history_idx
  ON public.production_goods_movement_failure_revision (client, failure_id, revision_number);

ALTER TABLE public.production_goods_movement_failure_attempt
  ADD COLUMN payload_revision integer NOT NULL DEFAULT 0;
ALTER TABLE public.production_goods_movement_failure_attempt
  ADD CONSTRAINT production_gm_failure_attempt_revision_ck CHECK (payload_revision >= 0);

-- Status and audit fields may change, but the source document, request key, fingerprint,
-- and original posting payload are an immutable CO11N snapshot.
CREATE OR REPLACE FUNCTION public.production_gm_failure_protect_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'DISCARDED' THEN
    RAISE EXCEPTION 'A discarded goods-movement failure is a terminal retained record.'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.client, NEW.id, NEW.source_transaction, NEW.source_document_class,
    NEW.source_document_number, NEW.confirmation_number, NEW.confirmation_request_key,
    NEW.order_number, NEW.operation_number, NEW.plant, NEW.movement_kind,
    NEW.movement_type, NEW.posting_date, NEW.document_date, NEW.header_text,
    NEW.original_request_key, NEW.idempotency_fingerprint, NEW.original_payload
  ) IS DISTINCT FROM ROW(
    OLD.client, OLD.id, OLD.source_transaction, OLD.source_document_class,
    OLD.source_document_number, OLD.confirmation_number, OLD.confirmation_request_key,
    OLD.order_number, OLD.operation_number, OLD.plant, OLD.movement_kind,
    OLD.movement_type, OLD.posting_date, OLD.document_date, OLD.header_text,
    OLD.original_request_key, OLD.idempotency_fingerprint, OLD.original_payload
  ) THEN
    RAISE EXCEPTION 'CO11N source intent is immutable; create a COGI correction revision instead.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.production_gm_failure_protect_source() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.production_gm_failure_protect_source() TO cairn_app;
DROP TRIGGER IF EXISTS production_gm_failure_protect_source_trg ON public.production_goods_movement_failure;
CREATE TRIGGER production_gm_failure_protect_source_trg
  BEFORE UPDATE ON public.production_goods_movement_failure
  FOR EACH ROW EXECUTE FUNCTION public.production_gm_failure_protect_source();

-- An attempt can complete, but its identity and payload revision cannot be rewritten.
CREATE OR REPLACE FUNCTION public.production_gm_attempt_protect_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.client, NEW.id, NEW.failure_id, NEW.attempt_number, NEW.payload_revision,
         NEW.lease_token, NEW.attempted_by, NEW.started_at)
     IS DISTINCT FROM
     ROW(OLD.client, OLD.id, OLD.failure_id, OLD.attempt_number, OLD.payload_revision,
         OLD.lease_token, OLD.attempted_by, OLD.started_at) THEN
    RAISE EXCEPTION 'Goods-movement attempt identity and payload revision are immutable.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.production_gm_attempt_protect_revision() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.production_gm_attempt_protect_revision() TO cairn_app;
DROP TRIGGER IF EXISTS production_gm_attempt_protect_revision_trg ON public.production_goods_movement_failure_attempt;
CREATE TRIGGER production_gm_attempt_protect_revision_trg
  BEFORE UPDATE ON public.production_goods_movement_failure_attempt
  FOR EACH ROW EXECUTE FUNCTION public.production_gm_attempt_protect_revision();

ALTER TABLE public.production_goods_movement_failure_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_goods_movement_failure_revision FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.production_goods_movement_failure_revision;
CREATE POLICY tenant_isolation ON public.production_goods_movement_failure_revision
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON public.production_goods_movement_failure_revision FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON public.production_goods_movement_failure_revision FROM cairn_app;
GRANT SELECT, INSERT ON public.production_goods_movement_failure_revision TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'PROD.GM.REPROCESS',
  'PROD',
  'POST',
  true,
  'Review, correct, reprocess, or explicitly discard an automatic goods movement that failed during CO11N. Original source payload and every correction remain auditable.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

-- Grant only to active, writable roles that can enter confirmations and already hold
-- a production goods-issue or production-receipt posting authority. The COGI authority
-- remains an exact grant (not inherited from PROD.*).
INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT DISTINCT rc.client, rc.role_code, 'PROD.GM.REPROCESS', 'MIGRATION_9213'
  FROM role_capability rc
  JOIN role r ON r.client = rc.client AND r.code = rc.role_code AND r.is_active = true AND r.is_read_only = false
 WHERE rc.capability_code = 'PROD.CONFIRM.ENTER'
   AND EXISTS (
     SELECT 1 FROM role_capability post_rc
      WHERE post_rc.client = rc.client
        AND post_rc.role_code = rc.role_code
        AND post_rc.capability_code IN ('PROD.ORDER.GI', 'PROD.ORDER.GR', 'INV.GI.POST')
   )
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'PROD.GM.REPROCESS',
  NULL,
  'Reprocess automatic production goods movements',
  'TRANSACTION',
  'PROD',
  'COGI-style postprocessing for automatic goods movements produced by CO11N. Filter individual persisted failures, inspect attempt errors, correct supported line fields, retry the original movement, or retain an explicit audited discard. Source confirmation and original payload remain unchanged. Reservations are not adjusted by discard. Manual MIGO movements and CO15 header confirmations do not create these automatic movement failures in Cairn.',
  'TIER_1_BUILT',
  '/production/cogi',
  'B',
  'MIGRATION_9213'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9213',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'COGI', 'SEARCH_ONLY', 'MIGRATION_9213'
  FROM term_registry t
 WHERE t.our_code = 'PROD.GM.REPROCESS'
ON CONFLICT (external_system, alias) DO UPDATE SET
  term_id = excluded.term_id,
  usage = excluded.usage,
  changed_by = 'MIGRATION_9213',
  changed_at = now();

COMMENT ON TABLE public.production_goods_movement_failure_revision IS
  'Append-only COGI correction snapshots. The CO11N original payload remains immutable; each posting attempt references a revision number.';
COMMENT ON COLUMN public.production_goods_movement_failure_attempt.payload_revision IS
  'Zero uses the immutable CO11N payload; a positive value identifies the append-only COGI correction revision used by this attempt.';
COMMENT ON COLUMN public.production_goods_movement_failure.disposition_reason IS
  'Required explanation when a failed movement is explicitly discarded; the failed record is retained and no reservation is adjusted.';
