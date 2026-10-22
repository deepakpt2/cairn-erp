import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/config/movement-types/page.tsx', 'utf8');
const form = readFileSync('src/app/config/movement-types/MovementTypes.tsx', 'utf8');
const action = readFileSync('src/app/config/movement-types/actions.ts', 'utf8');
const service = readFileSync('src/modules/inventory/movement-type-configuration.ts', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');
const hub = readFileSync('src/app/config/page.tsx', 'utf8');

describe('movement type configuration screen contract', () => {
  it('stands on the catalogue route and treats OMJJ as a search alias', () => {
    expect(page).toContain("const ROUTE = '/config/movement-types'");
    expect(page).toContain('can(session, ACTIVITY)');
    expect(page).toContain('{ACTIVITY} · OMJJ');
    expect(page).not.toContain("'/omjj'");
    expect(seed).toContain("aliases: ['OMJJ']");
    expect(seed).toContain("route: '/config/movement-types'");
    expect(seed).toContain("code: 'CFG.INV.MOVETYPE.CONFIG'");
    const built = hub.slice(hub.indexOf('const BUILT_ROUTES'), hub.indexOf(']);', hub.indexOf('const BUILT_ROUTES')));
    expect(built).toContain("'/config/movement-types'");
  });

  it('submits the session tenant and a reason, and does not post', () => {
    expect(action).toContain('client: session.user.client');
    expect(action).toContain('changedBy: session.user.username');
    expect(action).toContain("read(form, 'reason')");
    expect(form).toContain('name="reason"');
    expect(form).toContain('name="offsetModifier"');
    expect(form).not.toMatch(/name="(client|changedBy|generalLedgerAccount|companyCode|bwart)"/);
    expect(form).toContain('checkMovementTypeAction');
    expect(form).toContain('Check');
    expect(form).toContain('Save');
    expect(form).not.toContain('>Post<');
    expect(action).not.toContain('revalidatePath');
    expect(action).not.toContain('redirect(');
  });

  it('maintains the standing row and refuses a second catalogue', () => {
    expect(service).toContain("from './schema'");
    expect(service).toContain('movementType');
    expect(service).not.toContain('movement_type_configuration');
    expect(service).not.toContain('goods-receipt');
    expect(service).not.toContain('goods-issue');
    expect(service).not.toContain('transfer-posting');
    expect(service).not.toContain('physical-inventory-posting');
    expect(service).not.toContain('material-period-control');
    expect(service).not.toContain('posting-periods');
    expect(service).toContain('A G/L account');
    expect(service).toContain('A closed period does not block this screen.');
    expect(action).toContain('generalLedgerAccount');
  });
});
