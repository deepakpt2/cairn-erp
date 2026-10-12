import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/config/plants/page.tsx', 'utf8');
const form = readFileSync('src/app/config/plants/PlantDefinitionForm.tsx', 'utf8');

function openingTag(name: string, tag: 'input' | 'select' = 'input') {
  const marker = `name="${name}"`;
  const position = form.indexOf(marker);
  if (position < 0) return '';
  const start = form.lastIndexOf(`<${tag}`, position);
  const end = form.indexOf('>', position);
  return start < 0 || end < 0 ? '' : form.slice(start, end + 1);
}

describe('SCR-014 Plant definition UI contract', () => {
  it('gates create/change and country choices on the exact define capability', () => {
    expect(page).toContain("const PLANT_DEFINE = 'CFG.ORG.PLANT.DEFINE'");
    expect(page).toContain('can(session, PLANT_DEFINE)');
    expect(page).toContain('{showForm && (');
    expect(page).toContain('const countries = showForm');
    expect(page).toContain("t('auth.readOnly', { authority: PLANT_DEFINE })");
    expect(page).toContain('session.user.client');
    expect(page).toContain('getPlantDefinitionVersion(client, selected.plant)');
    expect(page).not.toContain('params.client');
    expect(page).not.toContain('CFG.ORG.PLANT.ASSIGN_COMPANY');
  });

  it('supports Plant create and change with the approved required and optional field contract', () => {
    expect(form).toContain('useActionState(savePlantDefinitionAction, INITIAL_STATE)');
    expect(form).toContain('name="mode" value={mode}');
    expect(form).toContain('name="expectedVersion" value={creating ? 0 : version}');
    expect(form).toContain('readOnly={!creating}');

    for (const field of ['plant', 'name', 'country']) {
      expect(form).toContain(`name="${field}"`);
      expect(openingTag(field, field === 'country' ? 'select' : 'input')).toContain('required');
    }
    expect(openingTag('plant')).toContain('maxLength={10}');
    expect(openingTag('name')).toContain('maxLength={160}');

    const optionalLengths: Record<string, number> = {
      street: 160,
      houseNumber: 40,
      postalCode: 20,
      city: 80,
      region: 80,
      factoryCalendar: 10,
    };
    for (const [field, maximum] of Object.entries(optionalLengths)) {
      const tag = openingTag(field);
      expect(tag, field).toContain(`name="${field}"`);
      expect(tag, field).toContain(`maxLength={${maximum}}`);
      expect(tag, field).not.toContain('required');
    }
    expect(openingTag('language')).toContain('defaultValue={initial.language || \'EN\'}');
    expect(openingTag('language')).not.toContain('required');
    expect(form).not.toMatch(/name="(client|changedBy|companyCode|defaultStorageLocation|isActive)"/);
  });

  it('keeps Factory Calendar inert and both Cairn role flags explicitly optional', () => {
    expect(form).toContain('plant.factoryCalendarNote');
    expect(form).toContain('plant.roleFlagsNote');
    expect(form).toContain('name="isProductionSite" value="false"');
    expect(form).toContain('name="isProductionSite"\n                value="true"');
    expect(form).toContain('name="isStorageSite" value="false"');
    expect(form).toContain('name="isStorageSite"\n                value="true"');
    expect(page).toContain('isProductionSite: true');
    expect(page).toContain('isStorageSite: true');
    expect(form).not.toMatch(/name="(companyCode|defaultStorageLocation|isActive)"/);
    expect(page).not.toContain('CFG.ORG.PLANT.ASSIGN_COMPANY');
  });
});
