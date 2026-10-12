-- B-090: atomic one-way registry update + global audit insert.
-- Runtime EXECUTE is intentionally withheld until the capability-checked service is added.
CREATE OR REPLACE FUNCTION public.cairn_activate_partner_bank_profile(
  p_event_id uuid,
  p_actor_client varchar,
  p_actor_user_id uuid,
  p_country_code varchar,
  p_expected_policy_revision varchar,
  p_expected_version integer,
  p_evidence_code varchar
)
RETURNS varchar
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_profile public.partner_bank_country_profile%ROWTYPE;
  v_new_version integer;
BEGIN
  IF p_event_id IS NULL
    OR substring(p_event_id::text from 15 for 1) <> '4'
    OR substring(p_event_id::text from 20 for 1) NOT IN ('8', '9', 'a', 'b')
    OR p_actor_client IS NULL
    OR p_actor_client !~ '^[A-Za-z0-9]{2,4}$'
    OR p_actor_user_id IS NULL
    OR p_country_code IS NULL
    OR p_country_code !~ '^[A-Z]{2}$'
    OR p_expected_policy_revision IS NULL
    OR p_expected_policy_revision !~ '^D-[0-9]{3}$'
    OR p_expected_version IS NULL
    OR p_expected_version < 1
  THEN
    RETURN 'INPUT_INVALID';
  END IF;

  IF p_evidence_code IS DISTINCT FROM 'PROFILE_VALIDATION_ACCEPTED' THEN
    RETURN 'EVIDENCE_INVALID';
  END IF;

  -- Serialize concurrent attempts for this country before checking status/version.
  SELECT p.*
    INTO v_profile
    FROM public.partner_bank_country_profile AS p
   WHERE p.country_code = p_country_code
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'PROFILE_UNAVAILABLE';
  END IF;

  IF v_profile.policy_revision IS DISTINCT FROM p_expected_policy_revision THEN
    RETURN 'POLICY_REVISION_MISMATCH';
  END IF;

  IF v_profile.readiness_status = 'READY' THEN
    RETURN 'PROFILE_ALREADY_READY';
  END IF;

  IF v_profile.version <> p_expected_version THEN
    RETURN 'VERSION_MISMATCH';
  END IF;

  IF v_profile.version = 2147483647 THEN
    RETURN 'VERSION_EXHAUSTED';
  END IF;

  -- Repeat the guards in the UPDATE as a second line of defence. If anything
  -- unexpected prevents exactly one row changing, do not emit an audit event.
  UPDATE public.partner_bank_country_profile AS p
     SET readiness_status = 'READY',
         version = v_profile.version + 1,
         changed_by = p_actor_client || ':' || p_actor_user_id::text,
         changed_at = clock_timestamp()
   WHERE p.country_code = p_country_code
     AND p.policy_revision = p_expected_policy_revision
     AND p.readiness_status = 'NOT_READY'
     AND p.version = p_expected_version
  RETURNING p.version INTO v_new_version;

  IF NOT FOUND THEN
    RETURN 'UPDATE_CONFLICT';
  END IF;

  -- Any insert failure aborts this function call's transaction, rolling back the
  -- readiness update as well; successful activation and its evidence commit together.
  INSERT INTO public.partner_bank_profile_activation_audit (
    event_id,
    actor_client,
    actor_user_id,
    country_code,
    policy_revision,
    previous_status,
    new_status,
    previous_version,
    new_version,
    evidence_code
  ) VALUES (
    p_event_id,
    p_actor_client,
    p_actor_user_id,
    p_country_code,
    v_profile.policy_revision,
    v_profile.readiness_status,
    'READY',
    v_profile.version,
    v_new_version,
    p_evidence_code
  );

  RETURN 'ACTIVATED';
END;
$function$;

-- A SECURITY DEFINER routine is not public API by default. Only the later
-- capability-authorized server service will receive EXECUTE (via a new migration).
REVOKE ALL PRIVILEGES ON FUNCTION public.cairn_activate_partner_bank_profile(
  uuid, varchar, uuid, varchar, varchar, integer, varchar
) FROM PUBLIC, cairn_app;
