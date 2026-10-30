import { readFileSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { partnerBankCountryProfile } from '../src/platform/schema';
import { PARTNER_BANK_PROFILE_POLICIES } from '../src/platform/security/partner-bank-profile-readiness';

const profileConfig = getTableConfig(partnerBankCountryProfile);
const tableMigration = readFileSync('drizzle/0015_partner_bank_country_profile.sql', 'utf8');
const accessMigration = readFileSync('drizzle/9017_partner_bank_country_profile_policies.sql', 'utf8');
const referenceSeed = readFileSync('scripts/standard-reference-data.ts', 'utf8');

describe('global partner-bank profile registry contract', () => {
  it('registers a global country-keyed readiness table, not a tenant table', () => {
    const columns = profileConfig.columns.map((column) => column.name);
    expect(profileConfig.name).toBe('partner_bank_country_profile');
    expect(columns).toContain('country_code');
    expect(columns).toContain('policy_revision');
    expect(columns).toContain('readiness_status');
    expect(columns).toContain('version');
    expect(columns).not.toContain('client');
    expect(profileConfig.primaryKeys[0].columns.map((column) => column.name)).toEqual(['country_code']);
  });

  it('constrains readiness, revision shape, version, and country reference', () => {
    expect(tableMigration).toContain("DEFAULT 'NOT_READY'");
    expect(tableMigration).toContain("IN ('NOT_READY', 'READY')");
    expect(tableMigration).toContain("'^D-[0-9]{3}$'");
    expect(tableMigration).toContain('"version" > 0');
    expect(tableMigration).toMatch(/PRIMARY KEY\("country_code"\)/i);
    expect(tableMigration).toMatch(/FOREIGN KEY \("country_code"\)[\s\S]*?REFERENCES "public"\."country"\("code"\)/i);
  });

  it('seeds only the five approved policy revisions and keeps each row blocked by default', () => {
    expect(PARTNER_BANK_PROFILE_POLICIES).toEqual([
      { country: 'IN', policyRevision: 'D-063' },
      { country: 'KW', policyRevision: 'D-062' },
      { country: 'GB', policyRevision: 'D-064' },
      { country: 'US', policyRevision: 'D-065' },
      { country: 'JP', policyRevision: 'D-066' },
    ]);
    expect(referenceSeed).toContain("values ($1, $2, 'NOT_READY', 'SYSTEM')");
    expect(referenceSeed).toMatch(/on conflict \(country_code\) do nothing/i);
    expect(referenceSeed).not.toMatch(/readiness_status\s*=\s*'NOT_READY'[\s\S]*?do update/i);
    expect(referenceSeed).not.toMatch(/version = partner_bank_country_profile\.version \+ 1/i);
  });

  it('grants the runtime read-only access to the shared registry', () => {
    expect(accessMigration).toMatch(/REVOKE ALL PRIVILEGES ON TABLE partner_bank_country_profile FROM cairn_app/i);
    expect(accessMigration).toMatch(/GRANT SELECT ON TABLE partner_bank_country_profile TO cairn_app/i);
    expect(accessMigration).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE|TRUNCATE)/i);
    expect(accessMigration).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
  });
});
