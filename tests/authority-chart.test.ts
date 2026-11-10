/**
 * The organisation chart of authority.
 *
 * The screen exists to be read by a superior *before* they delegate, so what
 * these tests protect is not the formatting but the boundary: who a viewer may
 * look at, and the fact that a crafted user id cannot widen it.
 *
 * That is the load-bearing assertion. The set of visible people is derived from
 * the viewer's own positions and never taken from the caller, so `?user=<id>`
 * for someone outside the line must yield *no selection* — and, importantly, no
 * error, because an error would confirm the person exists.
 *
 * The rest is what makes the screen trustworthy once open: a grant is one row
 * per level, the count beside a name equals the rows beneath it, the reporting
 * line above a person is the one the structure says, and the three delegation
 * panels are empty rather than absent.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  appUser,
  positionCapability,
  role,
  roleCapability,
  userCapability,
  userCapabilityScope,
  userRole,
} from '../src/platform/tables/security';
import { employee } from '../src/modules/people/schema';
import {
  ASSIGNMENT_CAPABILITY,
  assignPosition as assignPositionService,
} from '../src/modules/people/assignment';
import {
  ORG_UNIT_CAPABILITY,
  POSITION_CAPABILITY,
  definePosition as definePositionService,
  defineOrgUnit as defineOrgUnitService,
} from '../src/modules/people/org-structure';
import {
  authorityChart,
  grantLines,
  levelLabel,
} from '../src/modules/people/authority-chart';
import type { AuthorityGrant } from '../src/platform/auth/authority';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'AUTHORITY_CHART_TEST';
const ORG_AUTH = [ORG_UNIT_CAPABILITY] as const;
const POS_AUTH = [POSITION_CAPABILITY] as const;
const ASN_AUTH = [ASSIGNMENT_CAPABILITY] as const;
const defineOrgUnit = (input: Parameters<typeof defineOrgUnitService>[0]) =>
  defineOrgUnitService(input, ORG_AUTH);
const definePosition = (input: Parameters<typeof definePositionService>[0]) =>
  definePositionService(input, POS_AUTH);
const assignPosition = (input: Parameters<typeof assignPositionService>[0]) =>
  assignPositionService(input, ASN_AUTH);

const AREA = 'A000';
const CC = 'CC100';
const FROM = '2020-01-01';

const READ = 'CHARTTEST.READ';
const PBUY = 'PBUY';
const APPROVE = 'CHARTTEST.APPROVE';

let tenant: TestTenant;
let other: TestTenant;
let counter = 0;

interface Person {
  userId: string;
  personnelNumber: string;
  fullName: string;
}

async function person(name: string, inTenant: TestTenant = tenant): Promise<Person> {
  const client = inTenant.client;
  const userId = `chart-${name}-${++counter}`;
  const personnelNumber = `P${String(8200000 + counter)}`;
  const fullName = `Chart ${name}`;
  await withTenant(client, async (tx) => {
    await tx.insert(appUser).values({
      id: userId,
      client,
      username: `chart.${name}.${counter}`,
      fullName,
      passwordHash: 'scrypt:not-a-real-hash:not-a-real-hash',
      isActive: true,
    });
    await tx.insert(employee).values({
      client,
      personnelNumber,
      fullName,
      appUserId: userId,
      isActive: true,
      createdBy: ACTOR,
    });
  });
  return { userId, personnelNumber, fullName };
}

async function grantRole(userId: string, roleCode: string, patterns: string[]): Promise<void> {
  const client = tenant.client;
  await withTenant(client, async (tx) => {
    await tx
      .insert(role)
      .values({ client, code: roleCode, name: `Role ${roleCode}`, createdBy: ACTOR })
      .onConflictDoNothing();
    for (const pattern of patterns) {
      await tx
        .insert(roleCapability)
        .values({ client, roleCode, capabilityCode: pattern, createdBy: ACTOR })
        .onConflictDoNothing();
    }
    await tx.insert(userRole).values({ client, userId, roleCode, createdBy: ACTOR });
  });
}

/** A direct grant, optionally across two plants — the case that makes lines and grants differ. */
async function directGrant(
  userId: string,
  capability: string,
  opts: { to?: string | null; plants?: string[]; granter?: string; inTenant?: TestTenant },
): Promise<string> {
  const t = opts.inTenant ?? tenant;
  const client = t.client;
  const id = `chart-grant-${++counter}`;
  await withTenant(client, async (tx) => {
    await tx.insert(userCapability).values({
      id,
      client,
      userId,
      capabilityCode: capability,
      validFrom: FROM,
      validTo: opts.to ?? null,
      reason: 'DIRECT',
      granter: opts.granter ?? ACTOR,
      createdBy: ACTOR,
    });
    for (const plant of opts.plants ?? []) {
      await tx
        .insert(userCapabilityScope)
        .values({ client, grantId: id, scopeType: 'PLANT', scopeValue: plant });
    }
  });
  return id;
}

async function grantPositionCapability(
  positionCode: string,
  patterns: string[],
): Promise<void> {
  const client = tenant.client;
  await withTenant(client, async (tx) => {
    for (const pattern of patterns) {
      await tx
        .insert(positionCapability)
        .values({ client, positionCode, capabilityCode: pattern, createdBy: ACTOR })
        .onConflictDoNothing();
    }
  });
}

/** Put someone into a position, standing from before now and not ended. */
async function standIn(who: Person, positionCode: string, client = tenant.client): Promise<void> {
  await assignPosition({
    client,
    personnelNumber: who.personnelNumber,
    positionCode,
    controllingArea: AREA,
    costCenter: CC,
    validFrom: FROM,
    changedBy: ACTOR,
  });
}

beforeAll(async () => {
  tenant = await createTenant('authority-chart');
  other = await createTenant('authority-chart-other');

  for (const t of [tenant, other]) {
    await withTenant(t.client, async (tx) => {
      await tx.execute(sql`
        insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
        values (${t.client}, ${AREA}, ${CC}, '2020-01-01', '9999-12-31', 'Authority chart cost centre', 'PRODUCTION', '1000', ${ACTOR})
        on conflict do nothing`);
    });
  }

  const client = tenant.client;
  await defineOrgUnit({ client, code: 'ROOT', name: 'Root', changedBy: ACTOR });
  await defineOrgUnit({ client, code: 'PROC', name: 'Procurement', parentCode: 'ROOT', changedBy: ACTOR });

  await definePosition({
    client,
    code: 'PHEAD',
    title: 'Head of procurement',
    orgUnitCode: 'PROC',
    changedBy: ACTOR,
  });
  await definePosition({
    client,
    code: PBUY,
    title: 'Buyer',
    orgUnitCode: 'PROC',
    superiorCode: 'PHEAD',
    changedBy: ACTOR,
  });
  // A second branch that reports to nobody in our line — the outsider stands here.
  await defineOrgUnit({ client, code: 'SIDE', name: 'Side unit', changedBy: ACTOR });
  await definePosition({
    client,
    code: 'PSIDE',
    title: 'Side role',
    orgUnitCode: 'SIDE',
    changedBy: ACTOR,
  });
});

afterAll(async () => {
  await destroyTenant(tenant.client);
  await destroyTenant(other.client);
});

describe('grantLines — one row per level', () => {
  const base: Omit<AuthorityGrant, 'scope' | 'pattern'> = {
    grantId: 'g1',
    source: 'DIRECT',
    validFrom: null,
    validTo: null,
  };

  it('renders an unrestricted grant as a single tenant row, not a blank', () => {
    const lines = grantLines({ ...base, pattern: READ, scope: {} });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('TENANT');
    expect(lines[0]!.values).toEqual([]);
    expect(levelLabel(lines[0]!.level)).toBe('Tenant');
  });

  it('keeps one level on one row instead of exploding forty plants into forty', () => {
    const lines = grantLines({ ...base, pattern: APPROVE, scope: { plant: ['1000', '2000'] } });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('plant');
    expect(lines[0]!.values).toEqual(['1000', '2000']);
  });

  it('names every level a grant carries, so nothing is hidden', () => {
    const lines = grantLines({
      ...base,
      pattern: APPROVE,
      scope: { plant: ['1000'], companyCode: ['1000'] },
    });
    expect(lines.map((l) => l.level).sort()).toEqual(['companyCode', 'plant']);
    expect(lines.map((l) => levelLabel(l.level)).sort()).toEqual(['Company code', 'Plant']);
  });

  it('skips a level that names no values rather than showing an empty row', () => {
    const lines = grantLines({ ...base, pattern: READ, scope: { plant: [] } });
    expect(lines.every((l) => l.values.length > 0 || l.level === 'TENANT')).toBe(true);
  });
});

describe('the reporting line a viewer may read', () => {
  let boss: Person;
  let junior: Person;
  let outsider: Person;
  let stranger: Person;

  beforeAll(async () => {
    boss = await person('boss');
    junior = await person('junior');
    outsider = await person('outsider');
    stranger = await person('stranger', other);

    await standIn(boss, 'PHEAD');
    await standIn(junior, PBUY);
    await standIn(outsider, 'PSIDE');

    // The stranger stands in their own tenant's copy of the same position, built
    // before they are placed in it.
    await defineOrgUnit({ client: other.client, code: 'ROOT', name: 'Root', changedBy: ACTOR });
    await definePosition({
      client: other.client,
      code: 'PHEAD',
      title: 'Head of procurement',
      orgUnitCode: 'ROOT',
      changedBy: ACTOR,
    });
    await standIn(stranger, 'PHEAD', other.client);

    await grantRole(boss.userId, 'R-BOSS', [READ]);
    await grantRole(junior.userId, 'R-JUNIOR', [READ]);
    await grantPositionCapability(PBUY, [APPROVE]);
    await directGrant(junior.userId, APPROVE, { plants: ['1000', '2000'], granter: boss.userId });
  });

  it('shows everyone beneath the viewer, including the viewer', () => {
    return withTenant(tenant.client, async (tx) => {
      const chart = await authorityChart(tx, tenant.client, boss.userId);
      const ids = chart.subjects.map((s) => s.userId).sort();
      expect(ids).toEqual([boss.userId, junior.userId].sort());
    });
  });

  it('excludes someone in a different branch, and refuses to select them', () => {
    return withTenant(tenant.client, async (tx) => {
      const chart = await authorityChart(tx, tenant.client, boss.userId, outsider.userId);
      expect(chart.subjects.map((s) => s.userId)).not.toContain(outsider.userId);
      // Not an error: an error would tell the caller the user exists.
      expect(chart.selected).toBeNull();
    });
  });

  it('excludes someone in another tenant entirely', () => {
    return withTenant(tenant.client, async (tx) => {
      const chart = await authorityChart(tx, tenant.client, boss.userId, stranger.userId);
      expect(chart.subjects.map((s) => s.userId)).not.toContain(stranger.userId);
      expect(chart.selected).toBeNull();
    });
  });

  it('gives a viewer with no position an empty line rather than an error', () => {
    return withTenant(tenant.client, async (tx) => {
      const loner = await person('loner');
      const chart = await authorityChart(tx, tenant.client, loner.userId);
      expect(chart.viewer.positions).toEqual([]);
      expect(chart.subjects).toEqual([]);
      expect(chart.selected).toBeNull();
    });
  });

  it('leaves the chart unselected when no one is asked for', () => {
    return withTenant(tenant.client, async (tx) => {
      const chart = await authorityChart(tx, tenant.client, boss.userId);
      expect(chart.selected).toBeNull();
      expect(chart.subjects.length).toBeGreaterThan(0);
    });
  });
});

describe('what the card shows', () => {
  let boss: Person;
  let junior: Person;

  beforeAll(async () => {
    boss = await person('cardboss');
    junior = await person('cardjunior');
    await standIn(boss, 'PHEAD');
    await standIn(junior, PBUY);
    await grantRole(junior.userId, 'R-CARD', [READ]);
    await grantPositionCapability(PBUY, [APPROVE]);
    await directGrant(junior.userId, APPROVE, { plants: ['1000', '2000'], granter: boss.userId });
  });

  it('lists every source of authority, labelled with where it came from', () => {
    return withTenant(tenant.client, async (tx) => {
      const chart = await authorityChart(tx, tenant.client, boss.userId, junior.userId);
      const sources = chart.selected!.grants.map((g) => g.source).sort();
      expect(sources).toEqual(['DIRECT', 'POSITION', 'ROLE']);
      const via = chart.selected!.grants.map((g) => g.via);
      expect(via).toContain('R-CARD');
      expect(via).toContain(PBUY);
    });
  });

  it('counts lines beside the name, so the list agrees with the panel', () => {
    return withTenant(tenant.client, async (tx) => {
      const chart = await authorityChart(tx, tenant.client, boss.userId, junior.userId);
      const row = chart.subjects.find((s) => s.userId === junior.userId)!;
      expect(row.grantCount).toBe(chart.selected!.grants.length);
    });
  });

  it('shows the position and the unit it stands in', () => {
    return withTenant(tenant.client, async (tx) => {
      const chart = await authorityChart(tx, tenant.client, boss.userId, junior.userId);
      expect(chart.selected!.positions).toEqual([
        { code: PBUY, title: 'Buyer', orgUnitCode: 'PROC', orgUnitName: 'Procurement' },
      ]);
    });
  });

  it('shows the reporting line above, ending at the unit', () => {
    return withTenant(tenant.client, async (tx) => {
      const chart = await authorityChart(tx, tenant.client, boss.userId, junior.userId);
      const kinds = chart.selected!.superiorLine.map((s) => s.kind);
      expect(kinds[0]).toBe('POSITION');
      expect(chart.selected!.superiorLine.map((s) => s.label)).toContain('PHEAD · Head of procurement');
      expect(kinds[kinds.length - 1]).toBe('ORG_UNIT');
    });
  });

  it('holds the three delegation panels empty, not missing', () => {
    return withTenant(tenant.client, async (tx) => {
      const chart = await authorityChart(tx, tenant.client, boss.userId, junior.userId);
      expect(chart.selected!.delegatedToThem).toEqual([]);
      expect(chart.selected!.delegatedAway).toEqual([]);
      expect(chart.selected!.pendingAcceptance).toEqual([]);
    });
  });
});
