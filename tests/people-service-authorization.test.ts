import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { appUser, role, roleCapability, userRole } from '../src/platform/tables/security';
import { employee } from '../src/modules/people/schema';
import {
  loadCapabilities,
  loadOrgRestrictions,
  hasOrgAccess,
  signIn,
} from '../src/platform/auth/session';
import { hashPassword } from '../src/platform/auth/password';
import {
  createEmployee,
  changeEmployee,
  EMPLOYEE_CAPABILITY,
} from '../src/modules/people/employee-master';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * Service-layer People authorization — direct API cannot bypass capability checks.
 *
 * These tests prove that the service layer enforces capabilities, so a direct
 * API call (bypassing the server action) is stopped at the service boundary.
 *
 * Things carried by this file:
 *
 *   1. createEmployee refuses when the caller holds no PEOPLE.EMPLOYEE.CREATE;
 *   2. createEmployee succeeds when the caller holds PEOPLE.EMPLOYEE.CREATE;
 *   3. changeEmployee refuses when the caller holds no PEOPLE.EMPLOYEE.CREATE;
 *   4. loadOrgRestrictions returns the user's company/plant scopes;
 *   5. hasOrgAccess returns true when unrestricted, false when scoped and denied;
 *   6. signIn resolves capabilities and restrictions through the session.
 */
const ACTOR = 'PEOPLE_SVC_AUTH_TEST';

let tenant: TestTenant;
let configuratorUserId: string;
let noPeopleUserId: string;

beforeAll(async () => {
  tenant = await createTenant('ppl-svc-auth', { withConfiguration: true });

  await withTenant(tenant.client, async (tx) => {
    await tx.insert(role).values({
      client: tenant.client,
      code: 'CONFIGURATOR',
      name: 'Configurator',
      description: 'Maintains configuration through the workbench; cannot post documents',
      isSystemRole: true,
      isReadOnly: false,
      createdBy: ACTOR,
    });

    const peopleCapabilities = [
      'PEOPLE.EMPLOYEE.CREATE',
      'PEOPLE.RECORD.MAINTAIN',
      'PEOPLE.ORGUNIT.CREATE',
      'PEOPLE.POSITION.CREATE',
      'PEOPLE.ASSIGNMENT.MAINTAIN',
      'PEOPLE.TIME.ENTER',
      'PEOPLE.LEAVE.VIEW',
    ];
    for (const code of peopleCapabilities) {
      await tx.insert(roleCapability).values({
        client: tenant.client,
        roleCode: 'CONFIGURATOR',
        capabilityCode: code,
        createdBy: ACTOR,
      });
    }

    const [configurator] = await tx
      .insert(appUser)
      .values({
        id: 'ppl-svc-auth-configurator',
        client: tenant.client,
        username: 'ppl.svc.configurator',
        fullName: 'People Service Configurator',
        passwordHash: await hashPassword('Password1'),
        isActive: true,
        createdBy: ACTOR,
      })
      .returning();
    configuratorUserId = configurator.id;

    const [noPeople] = await tx
      .insert(appUser)
      .values({
        id: 'ppl-svc-auth-nopeople',
        client: tenant.client,
        username: 'ppl.svc.nople',
        fullName: 'No People Access',
        passwordHash: await hashPassword('Password1'),
        isActive: true,
        createdBy: ACTOR,
      })
      .returning();
    noPeopleUserId = noPeople.id;

    await tx.insert(userRole).values({
      client: tenant.client,
      userId: configuratorUserId,
      roleCode: 'CONFIGURATOR',
      createdBy: ACTOR,
    });

    // Scope the configurator to one company code to exercise org restrictions.
    await tx.execute(sql`
      insert into auth_org_restriction (id, client, user_id, scope_type, scope_value, created_by)
      values (gen_random_uuid(), ${tenant.client}, ${configuratorUserId}, 'COMPANY_CODE', '1000', ${ACTOR})
    `);
  });
});

afterAll(async () => {
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('service-layer capability enforcement', () => {
  it('createEmployee refuses when the caller holds no People capability', async () => {
    const caps = await withTenant(tenant.client, (tx) =>
      loadCapabilities(tx, tenant.client, noPeopleUserId),
    );
    expect(caps).not.toContain(EMPLOYEE_CAPABILITY);

    await expect(
      createEmployee(
        {
          client: tenant.client,
          personnelNumber: 'SVCNOAUTH',
          fullName: 'No Authority Person',
          isActive: true,
          changedBy: 'ppl.svc.nople',
        },
        caps,
      ),
    ).rejects.toThrow();
  });

  it('createEmployee succeeds when the caller holds PEOPLE.EMPLOYEE.CREATE', async () => {
    const caps = await withTenant(tenant.client, (tx) =>
      loadCapabilities(tx, tenant.client, configuratorUserId),
    );
    expect(caps).toContain(EMPLOYEE_CAPABILITY);

    const view = await createEmployee(
      {
        client: tenant.client,
        personnelNumber: 'SVCAUTH',
        fullName: 'Authorized Person',
        isActive: true,
        changedBy: 'ppl.svc.configurator',
      },
      caps,
    );
    expect(view.personnelNumber).toBe('SVCAUTH');
    expect(view.fullName).toBe('Authorized Person');
  });

  it('changeEmployee refuses when the caller holds no People capability', async () => {
    const caps = await withTenant(tenant.client, (tx) =>
      loadCapabilities(tx, tenant.client, noPeopleUserId),
    );
    expect(caps).not.toContain(EMPLOYEE_CAPABILITY);

    await expect(
      changeEmployee(
        {
          client: tenant.client,
          personnelNumber: 'SVCAUTH',
          fullName: 'Should Not Change',
          changedBy: 'ppl.svc.nople',
        },
        caps,
      ),
    ).rejects.toThrow();
  });

  it('changeEmployee succeeds when the caller holds PEOPLE.EMPLOYEE.CREATE', async () => {
    const caps = await withTenant(tenant.client, (tx) =>
      loadCapabilities(tx, tenant.client, configuratorUserId),
    );

    const view = await changeEmployee(
      {
        client: tenant.client,
        personnelNumber: 'SVCAUTH',
        fullName: 'Authorized Person Changed',
        isActive: true,
        changedBy: 'ppl.svc.configurator',
      },
      caps,
    );
    expect(view.fullName).toBe('Authorized Person Changed');
  });

  it('undefined capabilities are refused', async () => {
    await expect(
      createEmployee(
        {
          client: tenant.client,
          personnelNumber: 'SVCNOCAPS',
          fullName: 'No Caps Person',
          isActive: true,
          changedBy: 'ppl.svc.configurator',
        },
        undefined,
      ),
    ).rejects.toThrow();
  });
});

describe('organisational restrictions', () => {
  it('loadOrgRestrictions returns the user\'s company/plant scopes', async () => {
    const restrictions = await withTenant(tenant.client, (tx) =>
      loadOrgRestrictions(tx, tenant.client, configuratorUserId),
    );
    expect(restrictions.length).toBeGreaterThan(0);
    expect(restrictions.find((r) => r.scopeType === 'COMPANY_CODE' && r.scopeValue === '1000')).toBeDefined();
  });

  it('hasOrgAccess returns true when unrestricted (empty restrictions)', async () => {
    expect(hasOrgAccess([], 'COMPANY_CODE', '9999')).toBe(true);
    expect(hasOrgAccess(undefined, 'COMPANY_CODE', '9999')).toBe(true);
    expect(hasOrgAccess(null, 'PLANT', 'P001')).toBe(true);
  });

  it('hasOrgAccess returns false when scoped and denied', async () => {
    const restrictions = await withTenant(tenant.client, (tx) =>
      loadOrgRestrictions(tx, tenant.client, configuratorUserId),
    );
    expect(hasOrgAccess(restrictions, 'COMPANY_CODE', '9999')).toBe(false);
    expect(hasOrgAccess(restrictions, 'COMPANY_CODE', '1000')).toBe(true);
  });

  it('a user with no restrictions holds no company/plant limits', async () => {
    const restrictions = await withTenant(tenant.client, (tx) =>
      loadOrgRestrictions(tx, tenant.client, noPeopleUserId),
    );
    expect(restrictions).toEqual([]);
  });
});

describe('sign-in resolves capabilities and restrictions', () => {
  it('signIn resolves capabilities through the session', async () => {
    const user = await signIn({
      client: tenant.client,
      username: 'ppl.svc.configurator',
      password: 'Password1',
    });
    expect(user.capabilities).toContain(EMPLOYEE_CAPABILITY);
    expect(user.capabilities).toContain('PEOPLE.TIME.ENTER');
    expect(user.capabilities).toContain('PEOPLE.LEAVE.VIEW');
  });
});
