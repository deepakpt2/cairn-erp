import { readFileSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { partnerBankProfileActivationAudit } from '../src/platform/schema';

const auditConfig = getTableConfig(partnerBankProfileActivationAudit);
const tableMigration = readFileSync('drizzle/0016_partner_bank_profile_activation_audit.sql', 'utf8');
const accessMigration = readFileSync('drizzle/9018_partner_bank_profile_activation_audit_policies.sql', 'utf8');

describe('partner-bank profile activation audit schema contract', () => {
  it('registers a global, fixed-field audit table with actor and transition versions', () => {
    const columns = auditConfig.columns.map((column) => column.name);
    expect(auditConfig.name).toBe('partner_bank_profile_activation_audit');
    expect(columns).toContain('actor_client');
    expect(columns).toContain('actor_user_id');
    expect(columns).toContain('country_code');
    expect(columns).toContain('policy_revision');
    expect(columns).toContain('previous_status');
    expect(columns).toContain('new_status');
    expect(columns).toContain('previous_version');
    expect(columns).toContain('new_version');
    expect(columns).toContain('evidence_code');
    expect(columns).not.toContain('client');
    expect(columns).not.toContain('reason');
    expect(columns).not.toContain('rationale');
    expect(auditConfig.primaryKeys[0].columns.map((column) => column.name)).toEqual(['event_id']);
  });

  it('constrains IDs, actor keys, policy, one-way transition, versions, evidence and country', () => {
    expect(tableMigration).toContain('partner_bank_profile_activation_audit_event_uuidv4');
    expect(tableMigration).toContain('partner_bank_profile_activation_audit_actor_client');
    expect(tableMigration).toContain("^[A-Za-z0-9]{2,4}$");
    expect(tableMigration).toContain('partner_bank_profile_activation_audit_policy_revision');
    expect(tableMigration).toContain("'NOT_READY' AND \"new_status\" = 'READY'");
    expect(tableMigration).toContain("'PROFILE_VALIDATION_ACCEPTED'");
    expect(tableMigration).toContain('"new_version" = "previous_version" + 1');
    expect(tableMigration).toMatch(/FOREIGN KEY \("country_code"\)[\s\S]*?REFERENCES "public"\."country"\("code"\)/i);
    expect(tableMigration).not.toMatch(/\b(reason|rationale|details|notes)\b/i);
  });

  it('denies direct runtime and PUBLIC access pending a narrow activation function', () => {
    expect(accessMigration).toMatch(/REVOKE ALL PRIVILEGES ON TABLE partner_bank_profile_activation_audit FROM PUBLIC, cairn_app/i);
    expect(accessMigration).not.toMatch(/GRANT\s/i);
    expect(accessMigration).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
  });
});
