-- ============================================================================
-- Cairn — administration functions
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tenant directory
--
-- Listing tenants is inherently cross-tenant: the sign-in screen has to know
-- which tenants exist before any tenant scope can be established. Exposing that
-- by giving the application a superuser connection would be wrong — one mistake
-- and the application role no longer respects row-level security anywhere.
--
-- Instead: one narrow SECURITY DEFINER function returning a whitelisted set of
-- columns and nothing else. It cannot read business data, and it cannot be
-- widened by accident. Granting EXECUTE is a deliberate, reviewable act (D-038).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cairn_list_tenants()
RETURNS TABLE (
  client         varchar(4),
  name           varchar(120),
  country        char(2),
  currency       char(3),
  status         varchar(16),
  is_development boolean,
  created_at     timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.client, c.name, c.country, c.currency, c.status, c.is_development, c.created_at
  FROM client c
  ORDER BY c.client;
$$;

REVOKE ALL ON FUNCTION cairn_list_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cairn_list_tenants() TO cairn_app;

-- ---------------------------------------------------------------------------
-- Configuration readiness
--
-- The workbench checklist (§7.1) counts completed activities for one tenant.
-- The tenant key is passed explicitly and the function returns only counts and
-- the next step, so it cannot be used to read another tenant's configuration.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cairn_config_readiness(p_client varchar(4))
RETURNS TABLE (
  total_activities     bigint,
  completed_activities bigint,
  next_activity        varchar(80),
  next_activity_title  varchar(200),
  next_activity_route  varchar(200)
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT s.activity_code, s.status, a.sequence, a.title, a.route_path
    FROM config_activity_status s
    JOIN config_activity a ON a.code = s.activity_code
    WHERE s.client = p_client
  ),
  counts AS (
    SELECT count(*) AS total,
           count(*) FILTER (WHERE status = 'COMPLETED') AS completed
    FROM scoped
  ),
  nxt AS (
    SELECT activity_code, title, route_path
    FROM scoped
    WHERE status <> 'COMPLETED'
    ORDER BY sequence
    LIMIT 1
  )
  SELECT counts.total, counts.completed,
         nxt.activity_code, nxt.title, nxt.route_path
  FROM counts LEFT JOIN nxt ON true;
$$;

REVOKE ALL ON FUNCTION cairn_config_readiness(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cairn_config_readiness(varchar) TO cairn_app;

-- ---------------------------------------------------------------------------
-- Tenant existence
--
-- Used during sign-in, before a tenant scope exists, to tell "no such tenant"
-- apart from "wrong password" without disclosing anything else.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cairn_tenant_exists(p_client varchar(4))
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM client WHERE client = p_client);
$$;

REVOKE ALL ON FUNCTION cairn_tenant_exists(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cairn_tenant_exists(varchar) TO cairn_app;
