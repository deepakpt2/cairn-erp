import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const actionSource = readFileSync(
  'src/app/foundation/partners/partner-bank-profile-activation-actions.ts',
  'utf8',
);
const runtimeGrantSql = readFileSync(
  'drizzle/9020_partner_bank_profile_activation_function_runtime.sql',
  'utf8',
);
const executableGrantSql = runtimeGrantSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('partner-bank profile activation server-action boundary', () => {
  it('requires a verified session and supplies fixed evidence without accepting actor/free-text fields', () => {
    expect(actionSource).toContain("requireSession('/foundation/partners')");
    expect(actionSource).toContain('activatePartnerBankProfile(session, {');
    expect(actionSource).toContain("country: readString(form, 'country')");
    expect(actionSource).toContain("expectedPolicyRevision: readString(form, 'expectedPolicyRevision')");
    expect(actionSource).toContain('evidenceCode: PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE');
    expect(actionSource).not.toMatch(/readString\(form,\s*'(?:actorClient|actorUserId|reason|rationale|evidenceCode)'/);
    expect(actionSource).not.toMatch(/form\.get\(['"](?:actorClient|actorUserId|reason|rationale|evidenceCode)['"]\)/);
    expect(actionSource).toContain("revalidatePath('/foundation/partners')");
  });

  it('grants only EXECUTE on the narrow function to cairn_app, not table DML or capability grants', () => {
    expect(executableGrantSql).toMatch(/REVOKE ALL PRIVILEGES ON FUNCTION[\s\S]*FROM PUBLIC, cairn_app/i);
    expect(executableGrantSql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO cairn_app/i);
    expect(executableGrantSql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)\s+ON\s+TABLE/i);
    expect(executableGrantSql).not.toMatch(/role_capability/i);
  });
});
