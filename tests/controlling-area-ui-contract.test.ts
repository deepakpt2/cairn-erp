import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { controllingAreaValuesSchema } from '../src/modules/foundation/controlling-area-maintenance';

const page = readFileSync('src/app/config/controlling-area/page.tsx', 'utf8');
const createForm = readFileSync('src/app/config/controlling-area/ControllingAreaForm.tsx', 'utf8');
const list = readFileSync('src/app/config/controlling-area/ControllingAreasList.tsx', 'utf8');
const assignmentField = readFileSync('src/app/config/controlling-area/AssignmentControlField.tsx', 'utf8');
const actions = readFileSync('src/app/config/controlling-area/actions.ts', 'utf8');
const maintenance = readFileSync('src/modules/foundation/controlling-area-maintenance.ts', 'utf8');
const locale = readFileSync('src/platform/i18n/index.ts', 'utf8');
const workbench = readFileSync('src/app/config/page.tsx', 'utf8');

function values(overrides: Record<string, unknown> = {}) {
  return {
    controllingArea: 'a000',
    name: 'Standard cost area',
    organizationName: '',
    companyCodeScope: 'SINGLE',
    currency: 'KWD',
    fiscalYearVariant: 'K4',
    ...overrides,
  };
}

describe('SCR-024 Controlling Area value contract', () => {
  it('normalizes the immutable key and optional organization name', () => {
    const result = controllingAreaValuesSchema.safeParse(values());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.controllingArea).toBe('A000');
      expect(result.data.organizationName).toBeNull();
      expect(result.data.companyCodeScope).toBe('SINGLE');
    }
  });

  it('rejects incorrect key, name, currency, fiscal-year and Assignment Control formats', () => {
    for (const invalid of [
      values({ controllingArea: 'A00' }),
      values({ name: '' }),
      values({ name: 'x'.repeat(31) }),
      values({ organizationName: 'x'.repeat(31) }),
      values({ currency: 'US' }),
      values({ fiscalYearVariant: 'K' }),
      values({ companyCodeScope: 'CROSS' }),
    ]) {
      expect(controllingAreaValuesSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('SCR-024 OKKP UI contract', () => {
  it('guards the definition form by the session capability and loads references only for maintainers', () => {
    expect(page).toContain("can(session, ACTIVITY)");
    expect(page).toMatch(/canMaintain\s*\?\s*controllingAreaF4Choices\(client\)/);
    expect(page).toContain("requireSession(ROUTE)");
    expect(page).toContain('<ControllingAreaForm currencies={currencies} fiscalYearVariants={fiscalYearVariants} />');
    expect(actions).toContain("requireCapability(ACTIVITY, session)");
    expect(actions).toContain('client: session.user.client');
    expect(actions).toContain('changedBy: session.user.username');
    expect(actions).not.toMatch(/name="(client|changedBy)"/);
  });

  it('uses the owner-supplied Assignment Control labels and complete explanatory copy verbatim', () => {
    const exactCopy = [
      'Description of Controlling Area’s Purpose',
      'Controls the relationship between Controlling Area and Company Code',
      'Controlling area same as company code (1:1 Relationship)',
      'This maps Controlling Area to a single Company Code in a strict 1:1 relationship, where only one Company Code may be assigned to the Controlling Area.',
      'Cross-company-code cost accounting (1:N Relationship)',
      'This enables one Controlling Area to be assigned to multiple Company Codes, allowing cost accounting to be performed across all assigned Company Codes.',
      'The scope controls whether a Controlling Area can be assigned to one or multiple Company Codes in the system.',
      '1:1 Relationship: Exactly one Company Code must be assigned to the Controlling Area.',
      '1:N Relationship: One Controlling Area can be assigned to multiple Company Codes.',
      'This will determine whether cost accounting for a Controlling Area is restricted to a single Company Code or includes all cross-company costs.',
    ];
    for (const phrase of exactCopy) expect(locale).toContain(phrase);
    expect(assignmentField).toContain('name="companyCodeScope"');
    expect(assignmentField).toContain("value=\"SINGLE\"");
    expect(assignmentField).toContain("value=\"MULTIPLE\"");
  });

  it('keeps field limits, normalization, default scope, duplicate feedback and immutable existing keys in the UI', () => {
    expect(createForm).toContain("useState<'SINGLE' | 'MULTIPLE'>('SINGLE')");
    expect(createForm).toContain('maxLength={4}');
    expect(createForm).toContain('maxLength={30}');
    expect(createForm).toContain("toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)");
    expect(createForm).toContain('maxLength={3}');
    expect(createForm).toContain('maxLength={2}');
    expect(actions).toContain("t('controllingArea.alreadyExists'");
    expect(list).toContain('name="controllingArea" value={area.controllingArea}');
    expect(list).not.toMatch(/name="controllingArea"[^\n]*onChange/);
  });

  it('uses active-only Currency F4, all-variant Fiscal Year Variant F4, and server-backed lock state', () => {
    expect(maintenance).toContain('eq(currencyReference.isActive, true)');
    expect(maintenance).toContain('.where(eq(fiscalYearVariant.client, tenant))');
    expect(maintenance).not.toMatch(/where\(and\([\s\S]{0,180}fiscalYearVariant\.isActive/);
    expect(list).toContain('readOnly={area.currencyLocked}');
    expect(list).toContain('readOnly={area.fiscalYearVariantLocked}');
    expect(list).toContain('area.companyCodeCount > 1');
  });

  it('keeps OX19 assignment and deactivate/reactivate controls out of the OKKP form', () => {
    expect(page).toContain("t('controllingArea.assignmentSeparate')");
    expect(locale).toContain('Company Code assignments are maintained separately in OX19');
    expect(createForm).not.toMatch(/name="companyCode"/);
    expect(list).not.toMatch(/name="companyCode"/);
    expect(list).not.toMatch(/deactivateControllingArea|reactivateControllingArea/);
    expect(workbench).toContain("new Set(['CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY'])");
  });
});
