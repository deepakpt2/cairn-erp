import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TARGETS } from '../scripts/browser-smoke/targets';
import { ACCEPTANCE_DATABASE_GUARDS } from '../scripts/browser-smoke/database-guards';

const route = readFileSync('src/app/config/storage-locations/page.tsx', 'utf8');
const form = readFileSync('src/app/config/storage-locations/StorageLocationForm.tsx', 'utf8');
const deactivate = readFileSync('src/app/config/storage-locations/DeactivateStorageLocationForm.tsx', 'utf8');
const actions = readFileSync('src/app/config/storage-locations/actions.ts', 'utf8');
const workbench = readFileSync('src/app/config/page.tsx', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');
const browserRunner = readFileSync('scripts/browser-smoke.ts', 'utf8');
const browserChecks = readFileSync('scripts/browser-smoke/checks.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');

function inputTag(name: string, source = form, tag: 'input' | 'select' = 'input') {
  const marker = `name="${name}"`;
  const position = source.indexOf(marker);
  if (position < 0) return '';
  const start = source.lastIndexOf(`<${tag}`, position);
  const end = source.indexOf('>', position);
  return start < 0 || end < 0 ? '' : source.slice(start, end + 1);
}

describe('SCR-016 Storage Location UI/page contract', () => {
  it('uses the verified tenant, exact maintenance authority and active same-tenant Plant choices', () => {
    expect(route).toContain("const STORAGE_LOCATION_DEFINE = 'CFG.ORG.STORAGELOC.DEFINE'");
    expect(route).toContain("requireSession('/config/storage-locations')");
    expect(route).toContain('const client = session.user.client');
    expect(route).toContain('can(session, STORAGE_LOCATION_DEFINE)');
    expect(route).toContain('const creating = params.new === \'1\' && canMaintain');
    expect(route).toContain('where(eq(plantTable.client, client))');
    expect(route).toContain('where(eq(storageLocationTable.client, client))');
    expect(route).toContain('plants.filter((item) => item.isActive)');
    expect(route).toContain('activePlantChoices.map');
    expect(route).not.toContain('params.client');
    expect(route).not.toContain('plantTable.companyCode');
    expect(route).not.toContain('plantTable.defaultStorageLocation');
  });

  it('supports only create/change fields, fixes the composite key during change and labels stored-only configuration', () => {
    expect(form).toContain("useActionState<StorageLocationActionState, FormData>(\n    saveStorageLocationAction");
    expect(form).toContain('name="mode" value={mode}');
    expect(form).toContain('name="expectedVersion" value={version}');
    expect(inputTag('plant', form, 'select')).toContain('required');
    expect(inputTag('plant', form, 'select')).toContain('disabled={!plants.length}');
    expect(inputTag('storageLocation')).toContain('maxLength={10}');
    expect(inputTag('storageLocation')).toContain('readOnly={!creating}');
    expect(inputTag('name')).toContain('maxLength={120}');
    expect(form).toContain('type="checkbox"\n              name="allowNegativeStock"');
    expect(form).toContain("name=\"allowNegativeStock\" value=\"false\"");
    expect(form).toContain("t('storageLocation.negativeStockNote')");
    expect(messages).toContain('Stored configuration only; this setting does not enforce stock movements.');
    expect(form).not.toMatch(/name="(client|changedBy|companyCode|isActive|defaultStorageLocation)"/);
    expect(route).not.toMatch(/name="(client|changedBy|companyCode|isActive|defaultStorageLocation)"/);
  });

  it('keeps the lifecycle to audited create/change/deactivate and provides no hard-delete control', () => {
    expect(actions).toContain("const ACTIVITY = 'CFG.ORG.STORAGELOC.DEFINE'");
    expect(actions).toContain('client: session.user.client');
    expect(actions).toContain('changedBy: session.user.username');
    expect(deactivate).toContain('deactivateStorageLocationAction');
    expect(deactivate).toContain('name="expectedVersion"');
    expect(deactivate).not.toMatch(/name="(client|changedBy|isActive)"/);
    expect(route).toContain(".from(storageLocationTable)");
    expect(route).toContain("t('storageLocation.retentionNote')");
    expect(messages).toContain('Hard delete is not available.');
    expect(messages).toContain('No data is deleted; hard deletion is unavailable.');
    expect(route).not.toMatch(/deleteStorageLocation|hardDeleteStorageLocation/i);
    expect(actions).not.toMatch(/deleteStorageLocation|hardDeleteStorageLocation/i);
  });

  it('registers the existing route as built in the workbench and term registry', () => {
    expect(workbench).toContain("'/config/storage-locations'");
    expect(registry).toContain("ourCode: 'CFG.ORG.STORAGELOC.DEFINE'");
    expect(registry).toContain("route: '/config/storage-locations', tier: 'TIER_2_CONFIGURED'");
    expect(registry).toContain("a.alias = 'OX09'");
    expect(registry).toContain("t.our_code = 'CFG.ORG.PLANT.DEFINE'");
  });

  it('defines a separate B-139 browser target without consuming the cross-tenant fixture key', () => {
    expect(TARGETS.find((target) => target.id === 'storage-locations')).toMatchObject({ client: 'T981' });
    expect(TARGETS.some((target) => String(target.client) === 'T982')).toBe(false);
    // R-77: rebound to the reviewed loopback database, still named for its B-139 batch.
    expect(ACCEPTANCE_DATABASE_GUARDS['storage-locations']).toMatchObject({
      database: 'cairn_b210', port: '5432', batch: 'B-139 local loopback',
    });
    expect(browserRunner).toContain("target.id === 'storage-locations'");
    expect(browserChecks).toContain("'storage-locations': storageLocations");
    expect(browserChecks).toContain('async function storageLocations(ctx: BrowserContext)');
  });
});
