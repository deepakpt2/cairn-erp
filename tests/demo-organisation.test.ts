import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

import { withTenant } from '../src/platform/db/client';
import { appUser, authOrgRestriction } from '../src/platform/tables/security';
import { effectiveGrants, canWith, loadRestrictions, type Restrictions } from '../src/platform/auth/authority';
import { hasCapability } from '../src/platform/auth/pattern';
import {
  DEMO_ACTOR,
  DEMO_IDENTITY,
  DEMO_STRUCTURE,
} from '../src/platform/tenancy/demo-organisation';
import { DEMO_PHASE_PLAN } from '../src/platform/tenancy/demo-provisioning';

const CLIENT = DEMO_IDENTITY.clientKey;

/**
 * These assertions describe the company the provisioner builds. They need the demo
 * tenant to exist in the database the suite runs against, which is what the
 * `cairn_dp_*` disposable databases are for; against a database where the demo has
 * never been provisioned they report honestly that there is nothing to check.
 */
async function demoStands(): Promise<boolean> {
  return withTenant(CLIENT, async (tx) => {
    const rows = (await tx.execute(sql`select 1 as present from client where client = ${CLIENT}`)) as unknown as Array<{ present: number }>;
    return rows.length > 0;
  }).catch(() => false);
}

async function restrictionMap(userId: string): Promise<Restrictions> {
  return withTenant(CLIENT, async (tx) => {
    const restrictions = await loadRestrictions(tx, CLIENT, userId);
    return restrictions;
  });
}

async function userIdOf(username: string): Promise<string> {
  return withTenant(CLIENT, async (tx) => {
    const rows = (await tx.execute(
      sql`select id from app_user where client = ${CLIENT} and upper(username) = ${username.toUpperCase()} limit 1`,
    )) as unknown as Array<{ id: string }>;
    return rows[0]?.id ?? '';
  });
}

describe('demo company structure', () => {
  it('declares the two plants the demo is specified to have', () => {
    expect(DEMO_STRUCTURE.manufacturingPlant).toBe('1000');
    expect(DEMO_STRUCTURE.distributionPlant).toBe('2000');
    expect(DEMO_STRUCTURE.manufacturingPlant).not.toBe(DEMO_STRUCTURE.distributionPlant);
  });

  it('names a single company code for both plants to hang from', () => {
    expect(DEMO_STRUCTURE.companyCode).toBe('1000');
  });

  it('plans the organisation and the people as separate resumable phases', () => {
    // Later work appends; it never reorders. Asserted by prefix, so adding a
    // phase does not break this test.
    expect(DEMO_PHASE_PLAN.slice(0, 5)).toEqual([
      'A_FOUNDATION', 'B_ORGANISATION', 'B_PEOPLE', 'C_MASTERS', 'D1_PROCUREMENT',
    ]);
    // Appended, never reordered: a database provisioned by an earlier build must read
    // the same plan it was written with.
    expect(DEMO_PHASE_PLAN[0]).toBe('A_FOUNDATION');
  });

  it('does not invent its own numbering for objects the product already numbers', () => {
    // Every screen, report and test is written against the standard keys. A demo that
    // renumbered them would be a demo that could not use the product.
    expect(DEMO_STRUCTURE.controllingArea).toBe('A000');
    expect(DEMO_STRUCTURE.creditControlArea).toBe('0001');
    expect(DEMO_STRUCTURE.salesOrg).toBe('1000');
    expect(DEMO_STRUCTURE.distributionChannel).toBe('01');
    expect(DEMO_STRUCTURE.division).toBe('01');
  });

  it('builds custom roles, because every system role is protected and unassignable', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/platform/tenancy/demo-people.ts'),
      'utf8',
    );
    // Not one of the eleven protected codes is assigned anywhere in the module.
    for (const protectedCode of [
      'PLATFORM_ADMIN', 'ADMINISTRATOR', 'CONFIGURATOR', 'ACCOUNTANT', 'CONTROLLER',
      'BUYER', 'PLANNER', 'PRODUCTION_CLERK', 'WAREHOUSE_CLERK', 'SALES_CLERK', 'AUDITOR',
    ]) {
      expect(source).not.toMatch(new RegExp(`roleCode:\\s*'${protectedCode}'`));
      expect(source).not.toMatch(new RegExp(`code:\\s*'${protectedCode}'`));
    }
    // And every role it does define is namespaced so it can never collide with one.
    expect(source).toMatch(/code:\s*'DEMO_/);
  });

  it('expands its capability patterns instead of smuggling a wildcard past the guard', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/platform/tenancy/demo-people.ts'),
      'utf8',
    );
    // grantCapabilityToRole refuses a wildcard for a custom role; the module must
    // therefore resolve patterns against the catalogue before granting.
    expect(source).toContain('expandCapabilities');
    expect(source).toContain('hasCapability([pattern], code)');
  });

  it('signs the acting administrator in and out again', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/platform/tenancy/demo-people.ts'),
      'utf8',
    );
    expect(source).toContain('createSession');
    // Revoked in a finally, so a failure mid-phase leaves no live session behind.
    expect(source.indexOf('finally')).toBeLessThan(source.lastIndexOf('revokeSessionById'));
  });

  it('records the provisioner as the actor on every row it writes', () => {
    expect(DEMO_ACTOR).toBe('DEMO_PROVISION');
  });
});

describe('demo two-plant isolation', () => {
  it('gives the warehouse clerks the same capability pattern and different plants', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/platform/tenancy/demo-people.ts'),
      'utf8',
    );
    const mfg = /DEMO_WH_CLERK_MFG[\s\S]{0,400}?plants:\s*\[\s*DEMO_STRUCTURE\.(\w+)/.exec(source);
    const dist = /DEMO_WH_CLERK_DIST[\s\S]{0,400}?plants:\s*\[\s*DEMO_STRUCTURE\.(\w+)/.exec(source);
    expect(mfg?.[1]).toBeTruthy();
    expect(dist?.[1]).toBeTruthy();
    expect(mfg?.[1]).not.toBe(dist?.[1]);
    expect(mfg?.[1]).toBe('manufacturingPlant');
    expect(dist?.[1]).toBe('distributionPlant');
  });

  it('refuses a plant a user is not restricted to, and allows the one they are', async () => {
    // The pure half of the check, so the rule is stated even where no demo stands:
    // a restriction naming plant 1000 says nothing about the company code, and it
    // refuses plant 2000 outright.
    const restrictions: Restrictions = new Map([['plant', ['1000']]]);
    const grant = {
      pattern: 'INV.*',
      scope: {},
      source: 'ROLE' as const,
      validFrom: '2026-09-01',
      validTo: null,
    };
    expect(hasCapability(['INV.*'], 'INV.GR.POST')).toBe(true);
    expect(canWith([grant], 'INV.GR.POST', { plant: '1000' }, restrictions)).toBe(true);
    expect(canWith([grant], 'INV.GR.POST', { plant: '2000' }, restrictions)).toBe(false);
    // A user with no plant restriction at all works in both.
    expect(canWith([grant], 'INV.GR.POST', { plant: '2000' }, new Map())).toBe(true);
  });

  it('isolates the two warehouse clerks at the database, when the demo stands', async () => {
    if (!(await demoStands())) return;

    const mfg = await userIdOf('demo.warehouse1');
    const dist = await userIdOf('demo.warehouse2');
    expect(mfg).not.toBe('');
    expect(dist).not.toBe('');

    const mfgRestrictions = await restrictionMap(mfg);
    const distRestrictions = await restrictionMap(dist);

    expect(mfgRestrictions.get('plant')).toEqual([DEMO_STRUCTURE.manufacturingPlant]);
    expect(distRestrictions.get('plant')).toEqual([DEMO_STRUCTURE.distributionPlant]);
    // Both are inside the same company, which is what makes the plant the thing that
    // tells them apart.
    expect(mfgRestrictions.get('companyCode')).toEqual([DEMO_STRUCTURE.companyCode]);
    expect(distRestrictions.get('companyCode')).toEqual([DEMO_STRUCTURE.companyCode]);

    const capability = await firstInventoryCapability();
    const mfgGrants = await withTenant(CLIENT, (tx) => effectiveGrants(tx, CLIENT, mfg));
    const distGrants = await withTenant(CLIENT, (tx) => effectiveGrants(tx, CLIENT, dist));

    expect(canWith(mfgGrants, capability, { plant: DEMO_STRUCTURE.manufacturingPlant, companyCode: DEMO_STRUCTURE.companyCode }, mfgRestrictions)).toBe(true);
    expect(canWith(mfgGrants, capability, { plant: DEMO_STRUCTURE.distributionPlant, companyCode: DEMO_STRUCTURE.companyCode }, mfgRestrictions)).toBe(false);
    expect(canWith(distGrants, capability, { plant: DEMO_STRUCTURE.distributionPlant, companyCode: DEMO_STRUCTURE.companyCode }, distRestrictions)).toBe(true);
    expect(canWith(distGrants, capability, { plant: DEMO_STRUCTURE.manufacturingPlant, companyCode: DEMO_STRUCTURE.companyCode }, distRestrictions)).toBe(false);
  });

  it('leaves no live session behind in the demo tenant, when it stands', async () => {
    if (!(await demoStands())) return;
    const live = await withTenant(CLIENT, async (tx) => {
      const rows = (await tx.execute(
        sql`select count(*)::int as n from user_session where client = ${CLIENT} and revoked_at is null`,
      )) as unknown as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    });
    expect(live).toBe(0);
  });
});

/** A concrete capability the warehouse role holds, read from what was actually granted. */
async function firstInventoryCapability(): Promise<string> {
  return withTenant(CLIENT, async (tx) => {
    const rows = (await tx.execute(sql`
      select rc.capability_code as code
        from role_capability rc
        join app_user u on u.client = rc.client
        join user_role ur on ur.client = rc.client and ur.role_code = rc.role_code
       where rc.client = ${CLIENT}
         and ur.user_id = u.id
         and upper(u.username) = 'DEMO.WAREHOUSE1'
         and rc.capability_code like 'INV.%'
       order by rc.capability_code
       limit 1
    `)) as unknown as Array<{ code: string }>;
    return rows[0]?.code ?? 'INV.STOCK.VIEW';
  });
}

export { appUser, authOrgRestriction };
