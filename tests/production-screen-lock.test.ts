/**
 * The production version (C223) and routing (CA01/CA02) screens open the row they show in change, so a
 * second session reads it instead of writing over the first. These cases drive the two page components
 * directly — the same way the partner display page is tested — and pin the three outcomes that matter:
 * change granted, change held elsewhere, and no lock at all. An unavailable lock must never read as
 * acquired, and a lock this session does hold must never leave the form or its buttons disabled.
 */
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The page components are transformed to the classic runtime (`React.createElement`) because the project
// tsconfig keeps `jsx: "preserve"`, and no renderer is installed here. The pages are called directly, so
// the only thing they need from React is that global.
vi.stubGlobal('React', React);

const auth = vi.hoisted(() => ({ requireSession: vi.fn(), can: vi.fn() }));
const locks = vi.hoisted(() => ({ openChangeForSession: vi.fn() }));
const reads = vi.hoisted(() => ({
  getProductionVersion: vi.fn(),
  listProductionVersions: vi.fn(),
  listProductionVersionChoices: vi.fn(),
  listRoutingConfiguration: vi.fn(),
  listRoutings: vi.fn(),
  resolveRouting: vi.fn(),
}));
const db = vi.hoisted(() => ({ withTenant: vi.fn() }));

vi.mock('@/platform/auth/current', () => ({ requireSession: auth.requireSession, can: auth.can }));
vi.mock('@/platform/db/client', () => ({ withTenant: db.withTenant }));
vi.mock('@/platform/lock/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/lock/enqueue')>()),
  openChangeForSession: locks.openChangeForSession,
}));
vi.mock('@/modules/production/production-version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/production/production-version')>()),
  getProductionVersion: reads.getProductionVersion,
  listProductionVersions: reads.listProductionVersions,
  listProductionVersionChoices: reads.listProductionVersionChoices,
}));
vi.mock('@/modules/production/routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/production/routing')>()),
  listRoutingConfiguration: reads.listRoutingConfiguration,
  listRoutings: reads.listRoutings,
  resolveRouting: reads.resolveRouting,
}));

import ProductionVersionsPage from '../src/app/production/production-versions/page';
import VersionForm from '../src/app/production/production-versions/VersionForm';
import RoutingsPage from '../src/app/production/routings/page';
import RoutingForm from '../src/app/production/routings/RoutingForm';

type AnyElement = ReactElement<{ children?: ReactNode; disabled?: unknown }>;

function nodeOf(node: unknown): AnyElement | null {
  return isValidElement(node) ? (node as AnyElement) : null;
}

/** The props of the first element of `type` found depth-first, arrays unfolded. */
function propsOf(node: unknown, type: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf(child, type);
      if (found) return found;
    }
    return null;
  }
  const element = nodeOf(node);
  if (!element) return null;
  if (element.type === type) return element.props as Record<string, unknown>;
  return propsOf(element.props.children, type);
}

/** Every button the page rendered, by its label, with the disabled state it was given. */
function buttons(node: unknown, found: Array<{ label: string; disabled: unknown }> = []) {
  if (Array.isArray(node)) {
    for (const child of node) buttons(child, found);
    return found;
  }
  const element = nodeOf(node);
  if (!element) return found;
  if (element.type === 'button') {
    const child = Array.isArray(element.props.children) ? element.props.children.join(' ') : String(element.props.children ?? '');
    found.push({ label: child, disabled: element.props.disabled });
  }
  buttons(element.props.children, found);
  return found;
}

/** Every piece of text the page rendered, so a notice can be asserted without a renderer. */
function textOf(node: unknown, collected: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, collected);
    return collected;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    collected.push(String(node));
    return collected;
  }
  const element = nodeOf(node);
  if (element) textOf(element.props.children, collected);
  return collected;
}

const SESSION = {
  sessionId: 'production-screen-session',
  user: { client: 'T100', userId: 'u-1', username: 'version.tester', fullName: 'Version Tester', email: null, mustChangePassword: false },
  capabilities: ['*'],
};

const VERSION_DOCUMENT = {
  client: 'T100', plant: '1000', materialNumber: 'M-1', productionVersion: '0001', description: 'Standard',
  validFrom: '2026-01-01', validTo: '9999-12-31', lotFrom: '0', lotTo: '100', lotUnit: 'KG',
  bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000001', groupCounter: '01',
  receivingStorageLocation: null, changeNumber: null, checkStatus: '1', checkedAt: '2026-01-02T00:00:00Z',
  checkedBy: 'version.tester', stale: false, lockIndicator: '0', version: 1, findings: [],
};

const ROUTING_DOCUMENT = {
  client: 'T100', taskListType: 'N', routingGroup: '50000001', groupCounter: '01', plant: '1000',
  description: 'Standard routing', usage: '1', status: '4', baseQuantity: '1', baseUnit: 'KG',
  lotFrom: '', lotTo: '', validFrom: '2026-01-01', validTo: '9999-12-31', deletionFlag: ' ',
  version: 1, assignments: [], operations: [],
};

function signIn() {
  auth.requireSession.mockResolvedValue(SESSION);
  auth.can.mockReturnValue(true);
  db.withTenant.mockResolvedValue([]);
  reads.listProductionVersions.mockResolvedValue({ rows: [VERSION_DOCUMENT], total: 1, limit: 25, offset: 0 });
  reads.getProductionVersion.mockResolvedValue(VERSION_DOCUMENT);
  reads.listProductionVersionChoices.mockResolvedValue({ boms: [], routings: [], storageLocations: [] });
  reads.listRoutingConfiguration.mockResolvedValue({
    types: [], usages: [], statuses: [], controlKeys: [], standardValueKeys: [],
  });
  reads.listRoutings.mockResolvedValue([ROUTING_DOCUMENT]);
  reads.resolveRouting.mockResolvedValue(ROUTING_DOCUMENT);
}

/** The capability set the screen sees. Whole-segment matching is the platform's own. */
function holding(...capabilities: string[]): void {
  auth.can.mockImplementation((_session: unknown, capability: string) => capabilities.includes(capability));
}

function change(mode: 'CHANGE' | 'DISPLAY', lockObject: string, argument: string) {
  return mode === 'CHANGE'
    ? { mode, lockObject, argument }
    : { mode, lockObject, argument, holder: { username: 'other.tester', transactionCode: 'CFG.PROD.ROUTING.DEFINE', acquiredAt: '2026-01-01T00:00:00Z' } };
}

describe('production screens take the change lock through the current API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signIn();
  });

  it('opens the production version in change and leaves the form and its acts enabled', async () => {
    locks.openChangeForSession.mockResolvedValue(change('CHANGE', 'PRODUCTION_VERSION', '1000/M-1/0001'));

    const page = await ProductionVersionsPage({
      searchParams: Promise.resolve({ plant: '1000', material: 'M-1', version: '0001' }),
    });

    expect(locks.openChangeForSession).toHaveBeenCalledWith(SESSION, {
      lockObject: 'PRODUCTION_VERSION',
      argument: '1000/M-1/0001',
      transactionCode: 'CFG.PROD.VERSION.DEFINE',
    });
    expect(propsOf(page, VersionForm)).toMatchObject({ locked: false, document: VERSION_DOCUMENT });
    const acts = buttons(page).filter((button) => /Check consistency|^Lock$|^Unlock$|Delete or deactivate/.test(button.label));
    expect(acts.length).toBeGreaterThan(0);
    expect(acts.every((button) => button.disabled === false)).toBe(true);
    expect(textOf(page).join(' ')).not.toContain('display only');
  });

  it('shows a production version another session holds as display only and disables every act', async () => {
    locks.openChangeForSession.mockResolvedValue({
      ...change('DISPLAY', 'PRODUCTION_VERSION', '1000/M-1/0001'),
      holder: { username: 'other.tester', transactionCode: 'CFG.PROD.VERSION.DEFINE', acquiredAt: '2026-01-01T00:00:00Z' },
    });

    const page = await ProductionVersionsPage({
      searchParams: Promise.resolve({ plant: '1000', material: 'M-1', version: '0001' }),
    });

    expect(propsOf(page, VersionForm)).toMatchObject({ locked: true });
    const acts = buttons(page).filter((button) => /Check consistency|^Lock$|^Unlock$|Delete or deactivate/.test(button.label));
    expect(acts.length).toBeGreaterThan(0);
    expect(acts.every((button) => button.disabled === true)).toBe(true);
    // The sentence is the platform's own, not a copy written for this screen.
    expect(textOf(page).join(' ')).toContain(
      'PRODUCTION_VERSION 1000/M-1/0001 is being changed by other.tester in CFG.PROD.VERSION.DEFINE. This opening is display only.',
    );
  });

  it('refuses to read an unavailable production-version lock as an acquisition', async () => {
    locks.openChangeForSession.mockResolvedValue(undefined);

    const page = await ProductionVersionsPage({
      searchParams: Promise.resolve({ plant: '1000', material: 'M-1', version: '0001' }),
    });

    expect(locks.openChangeForSession).toHaveBeenCalledTimes(1);
    expect(propsOf(page, VersionForm)).toMatchObject({ locked: true });
    expect(buttons(page).filter((button) => button.label === 'Check consistency')[0].disabled).toBe(true);
    // No holder was reported, so the screen says nothing about one: display only without a name.
    expect(textOf(page).join(' ')).not.toContain('display only');
  });

  it('takes no lock for a production version that does not exist yet', async () => {
    locks.openChangeForSession.mockResolvedValue(change('CHANGE', 'PRODUCTION_VERSION', ''));

    const page = await ProductionVersionsPage({
      searchParams: Promise.resolve({ plant: '1000', material: 'M-1', create: '1' }),
    });

    expect(reads.getProductionVersion).not.toHaveBeenCalled();
    expect(locks.openChangeForSession).not.toHaveBeenCalled();
    expect(propsOf(page, VersionForm)).toMatchObject({ locked: false, document: null });
  });

  it('opens the routing in change and leaves the form enabled', async () => {
    locks.openChangeForSession.mockResolvedValue(change('CHANGE', 'ROUTING', 'N/50000001/01'));

    const page = await RoutingsPage({
      searchParams: Promise.resolve({ type: 'N', group: '50000001', counter: '01' }),
    });

    expect(locks.openChangeForSession).toHaveBeenCalledWith(SESSION, {
      lockObject: 'ROUTING',
      argument: 'N/50000001/01',
      transactionCode: 'CFG.PROD.ROUTING.DEFINE',
    });
    expect(propsOf(page, RoutingForm)).toMatchObject({ locked: false, document: ROUTING_DOCUMENT });
    expect(textOf(page).join(' ')).not.toContain('display only');
  });

  it('shows a routing another session holds as display only, and still as display only when no lock came back', async () => {
    locks.openChangeForSession.mockResolvedValue(change('DISPLAY', 'ROUTING', 'N/50000001/01'));
    const held = await RoutingsPage({ searchParams: Promise.resolve({ type: 'N', group: '50000001', counter: '01' }) });
    expect(propsOf(held, RoutingForm)).toMatchObject({ locked: true });
    expect(textOf(held).join(' ')).toContain(
      'ROUTING N/50000001/01 is being changed by other.tester in CFG.PROD.ROUTING.DEFINE. This opening is display only.',
    );

    vi.clearAllMocks();
    signIn();
    locks.openChangeForSession.mockResolvedValue(null);
    const unavailable = await RoutingsPage({ searchParams: Promise.resolve({ type: 'N', group: '50000001', counter: '01' }) });
    expect(propsOf(unavailable, RoutingForm)).toMatchObject({ locked: true });
  });

  it('takes no lock for a routing that is being created', async () => {
    locks.openChangeForSession.mockResolvedValue(change('CHANGE', 'ROUTING', ''));

    const page = await RoutingsPage({ searchParams: Promise.resolve({ create: '1' }) });

    expect(reads.resolveRouting).not.toHaveBeenCalled();
    expect(locks.openChangeForSession).not.toHaveBeenCalled();
    expect(propsOf(page, RoutingForm)).toMatchObject({ locked: false, document: null });
  });
});

describe('the two screens do not go back to the obsolete lock shape', () => {
  const sources = [
    'src/app/production/production-versions/page.tsx',
    'src/app/production/routings/page.tsx',
  ].map((path) => ({ path, source: readFileSync(path, 'utf8') }));

  it.each(sources)('%s opens the lock with the current contract', ({ source }) => {
    expect(source).toMatch(/openChangeForSession\(session, \{/);
    expect(source).toMatch(/lockObject:/);
    expect(source).toMatch(/transactionCode:/);
    expect(source).not.toContain('acquired');
  });

  it('the copy affordance follows the create capability, not the change lock', () => {
    const form = readFileSync('src/app/production/production-versions/VersionForm.tsx', 'utf8');
    expect(form).toMatch(/\{document && canCopy && \(/);
    // The lock must not reach the copy form: withholding it from a create-only session would
    // otherwise take the copy flow away with it.
    expect(form).not.toMatch(/disabled=\{copyPending \|\| locked\}/);
    expect(form).not.toMatch(/name="newProductionVersion"[^>]*disabled=\{locked\}/);
  });

  it.each(sources)('%s gates change on the lock mode alone', ({ source }) => {
    expect(source).toMatch(/lock\?\.mode !== 'CHANGE'/);
    // A missing lock must not be able to reach the display-only helper unguarded.
    expect(source).toMatch(/const displayNotice = lock \? displayOnlyMessage\(lock\) : null;/);
    expect(source).not.toMatch(/\{locked && <p[^>]*>\{displayOnlyMessage\(/);
  });
});


describe('only a session that can write the row takes the lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signIn();
    locks.openChangeForSession.mockResolvedValue(change('CHANGE', 'PRODUCTION_VERSION', '1000/M-1/0001'));
  });

  it('a create-only session takes no lock on a standing production version', async () => {
    holding('PROD.VERSION.CREATE');

    const page = await ProductionVersionsPage({
      searchParams: Promise.resolve({ plant: '1000', material: 'M-1', version: '0001' }),
    });

    // No lock is taken at all, so nothing stands on the row for a session that cannot change it.
    expect(locks.openChangeForSession).not.toHaveBeenCalled();
    expect(propsOf(page, VersionForm)).toMatchObject({ locked: true, canCopy: true });
    // The acts belong to capabilities this session does not hold, so they are not offered.
    expect(buttons(page).filter((button) => /Check consistency|^Lock$|^Unlock$|Delete or deactivate/.test(button.label))).toHaveLength(0);
    // A copy is a create, so it stays available to exactly this session: the screen hands the form
    // the create capability for it. The button itself is inside the client form, which nothing here
    // renders, so the affordance's wiring is pinned in the static block below and its behaviour by
    // the copy case in tests/production-lock-acquisition.test.ts.
    // And it is display only without claiming a holder nobody named.
    expect(textOf(page).join(' ')).not.toContain('display only');
  });

  it('a create-only session takes no lock on a standing routing', async () => {
    holding('PROD.ROUTING.CREATE');

    const page = await RoutingsPage({
      searchParams: Promise.resolve({ type: 'N', group: '50000001', counter: '01' }),
    });

    expect(locks.openChangeForSession).not.toHaveBeenCalled();
    expect(propsOf(page, RoutingForm)).toMatchObject({ locked: true });
  });

  it('a session that can only run the acts still takes the lock it needs for them', async () => {
    // No change capability, but the check, lock-indicator and delete acts each stand under the lock
    // since stage 1 step 5 — withholding it here would make a granted authority unusable.
    holding('PROD.VERSION.CREATE', 'PROD.VERSION.CHECK');

    const page = await ProductionVersionsPage({
      searchParams: Promise.resolve({ plant: '1000', material: 'M-1', version: '0001' }),
    });

    expect(locks.openChangeForSession).toHaveBeenCalledTimes(1);
    expect(propsOf(page, VersionForm)).toMatchObject({ locked: false });
    expect(buttons(page).filter((button) => button.label === 'Check consistency')[0].disabled).toBe(false);
  });

  it('a change-capable session still takes the lock, and holds it for the save', async () => {
    holding('PROD.VERSION.CREATE', 'PROD.VERSION.CHANGE');

    const page = await ProductionVersionsPage({
      searchParams: Promise.resolve({ plant: '1000', material: 'M-1', version: '0001' }),
    });

    expect(locks.openChangeForSession).toHaveBeenCalledWith(SESSION, {
      lockObject: 'PRODUCTION_VERSION',
      argument: '1000/M-1/0001',
      transactionCode: 'CFG.PROD.VERSION.DEFINE',
    });
    expect(propsOf(page, VersionForm)).toMatchObject({ locked: false, canCopy: true });
  });

  it('leaves the create flow unlocked for the same create-only session', async () => {
    holding('PROD.VERSION.CREATE');

    const page = await ProductionVersionsPage({ searchParams: Promise.resolve({ create: '1' }) });

    expect(locks.openChangeForSession).not.toHaveBeenCalled();
    expect(propsOf(page, VersionForm)).toMatchObject({ locked: false, canCopy: true });
  });
});
