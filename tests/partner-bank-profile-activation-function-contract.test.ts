import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const functionSql = readFileSync('drizzle/9019_partner_bank_profile_activation_function.sql', 'utf8');

describe('partner-bank profile activation database function contract', () => {
  it('is a fixed-signature SECURITY DEFINER routine with a locked-down search path', () => {
    expect(functionSql).toMatch(/CREATE OR REPLACE FUNCTION public\.cairn_activate_partner_bank_profile\(/i);
    expect(functionSql).toMatch(/SECURITY DEFINER/i);
    expect(functionSql).toMatch(/SET search_path = pg_catalog/i);
    expect(functionSql).toMatch(/REVOKE ALL PRIVILEGES ON FUNCTION[\s\S]*FROM PUBLIC, cairn_app/i);
    expect(functionSql).not.toMatch(/^\s*GRANT\s/im);
  });

  it('validates the fixed evidence and optimistic concurrency inputs before mutation', () => {
    expect(functionSql).toContain("substring(p_event_id::text from 15 for 1) <> '4'");
    expect(functionSql).toContain("p_actor_client !~ '^[A-Za-z0-9]{2,4}$'");
    expect(functionSql).toContain("p_country_code !~ '^[A-Z]{2}$'");
    expect(functionSql).toContain("p_expected_policy_revision !~ '^D-[0-9]{3}$'");
    expect(functionSql).toContain('p_expected_version < 1');
    expect(functionSql).toContain("p_evidence_code IS DISTINCT FROM 'PROFILE_VALIDATION_ACCEPTED'");
    expect(functionSql).toContain('WHERE p.country_code = p_country_code');
    expect(functionSql).toContain('FOR UPDATE');
    expect(functionSql).toContain("v_profile.policy_revision IS DISTINCT FROM p_expected_policy_revision");
    expect(functionSql).toContain('v_profile.version <> p_expected_version');
  });

  it('changes only NOT_READY to READY and appends the matching event in the same function call', () => {
    const updatePosition = functionSql.indexOf('UPDATE public.partner_bank_country_profile AS p');
    const insertPosition = functionSql.indexOf('INSERT INTO public.partner_bank_profile_activation_audit');
    expect(updatePosition).toBeGreaterThan(-1);
    expect(insertPosition).toBeGreaterThan(updatePosition);
    expect(functionSql).toContain("SET readiness_status = 'READY'");
    expect(functionSql).toContain('version = v_profile.version + 1');
    expect(functionSql).toContain("AND p.readiness_status = 'NOT_READY'");
    expect(functionSql).toContain('AND p.version = p_expected_version');
    expect(functionSql).toContain('changed_by = p_actor_client ||');
    expect(functionSql).toContain('changed_at = clock_timestamp()');
    for (const column of [
      'event_id',
      'actor_client',
      'actor_user_id',
      'country_code',
      'policy_revision',
      'previous_status',
      'new_status',
      'previous_version',
      'new_version',
      'evidence_code',
    ]) {
      expect(functionSql.slice(insertPosition)).toContain(column);
    }
    expect(functionSql).toContain("RETURN 'ACTIVATED'");
    expect(functionSql).not.toMatch(/\bDELETE\s+FROM\s+public\.partner_bank_country_profile/i);
  });
});
