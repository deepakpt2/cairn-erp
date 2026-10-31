import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { appUser, role, roleCapability, userRole } from '../src/platform/tables/security';
import { employee } from '../src/modules/people/schema';
import {
  loadCapabilities,
  hasCapability,
  signIn,
} from '../src/platform/auth/session';
import { hashPassword } from '../src/platform/auth/password';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * People authorization and employee-to-user linking — CAIRN.md §23, §7.3, DV-012.
 *
 * These tests prove the authorization gap is closed: no People capability is
 * reachable by a session that lacks it, and employee master records remain
 * independent of application-user accounts unless an explicit link is made.
 *
 * Things carried by this file:
 *
 *   1. an employee can exist without any application-user account;
 *   2. an employee can be linked to an application user, voluntarily;
 *   3. the link is unique in both directions (one employee → one user, one user → one employee);
 *   4. clearing the link leaves the employee intact;
 *   5. a user receives only the capabilities their roles grant — nothing more;
 *   6. a user with no roles holds no People capabilities;
 *   7. signIn resolves capabilities through the session;
 *   8. revoking a role removes capabilities from the next session;
 *   9. deactivating an account ends its sessions;
 *   10. cross-tenant access stays prohibited;
 *   11. the administrator's '*' wildcard works.
 */
const ACTOR = 'PEOPLE_AUTH_TEST';

let tenant: TestTenant;
let configuratorUserId: string;
let noPeopleUserId: string;

beforeAll(async () => {
  tenant = await createTenant('ppl-auth', { withConfiguration: true });

  await withTenant(tenant.client, async (tx) => {
    // Seed the CONFIGURATOR role and its People capability grants. The test
    // helper creates the tenant but does not seed system roles — that happens
    // in the server-side createTenant, which this test bypasses.
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
        id: 'ppl-auth-configurator',
        client: tenant.client,
        username: 'ppl.configurator',
        fullName: 'People Configurator',
        passwordHash: await hashPassword('Password1'),
        isActive: true,
        createdBy: ACTOR,
      })
      .returning();
    configuratorUserId = configurator.id;

    const [noPeople] = await tx
      .insert(appUser)
      .values({
        id: 'ppl-auth-nopeople',
        client: tenant.client,
        username: 'ppl.nople',
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
  });
});

afterAll(async () => {
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('employee can exist without a login account', () => {
  it('inserts an employee with no app_user_id and no app_user row', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(employee).values({
        client: tenant.client,
        personnelNumber: 'ENOLOGIN',
        fullName: 'No Login Person',
        isActive: true,
        createdBy: ACTOR,
      });
    });

    const rows = await withTenant(tenant.client, (tx) =>
      tx.select().from(employee).where(eq(employee.client, tenant.client)),
    );
    const person = rows.find((r) => r.personnelNumber === 'ENOLOGIN');
    expect(person).toBeDefined();
    expect(person!.appUserId).toBeNull();
  });

  it('confirms no app_user row was created for that employee', async () => {
    const count = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`select count(*) as n from app_user where client = ${tenant.client}`),
    );
    const n = Number((count as unknown as Array<{ n: string }>)[0].n);
    expect(n).toBe(2); // only the two test users
  });
});

describe('employee-to-user linking', () => {
  it('links an employee to an application user', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(employee).values({
        client: tenant.client,
        personnelNumber: 'ELINKED',
        fullName: 'Linked Person',
        isActive: true,
        appUserId: configuratorUserId,
        createdBy: ACTOR,
      });
    });

    const rows = await withTenant(tenant.client, (tx) =>
      tx.select().from(employee).where(eq(employee.client, tenant.client)),
    );
    const person = rows.find((r) => r.personnelNumber === 'ELINKED');
    expect(person).toBeDefined();
    expect(person!.appUserId).toBe(configuratorUserId);
  });

  it('linking an employee does not grant roles, capabilities, or login authority', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(employee).values({
        client: tenant.client,
        personnelNumber: 'ELINKNOAUTH',
        fullName: 'Linked User Without Roles',
        isActive: true,
        appUserId: noPeopleUserId,
        createdBy: ACTOR,
      });
    });

    const capabilities = await withTenant(tenant.client, (tx) =>
      loadCapabilities(tx, tenant.client, noPeopleUserId),
    );
    expect(capabilities).toEqual([]);
    const signedIn = await signIn({
      client: tenant.client,
      username: 'ppl.nople',
      password: 'Password1',
    });
    expect(signedIn.capabilities).toEqual([]);
  });

  it('refuses a second link from another employee to the same user', async () => {
    await expect(
      withTenant(tenant.client, async (tx) => {
        await tx.insert(employee).values({
          client: tenant.client,
          personnelNumber: 'ELINKED2',
          fullName: 'Second Link Attempt',
          isActive: true,
          appUserId: configuratorUserId,
          createdBy: ACTOR,
        });
      }),
    ).rejects.toThrow();
  });

  it('unlinks by clearing app_user_id, leaving the employee intact', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx
        .update(employee)
        .set({ appUserId: null })
        .where(eq(employee.personnelNumber, 'ELINKED'));
    });

    const rows = await withTenant(tenant.client, (tx) =>
      tx.select().from(employee).where(eq(employee.client, tenant.client)),
    );
    const person = rows.find((r) => r.personnelNumber === 'ELINKED');
    expect(person).toBeDefined();
    expect(person!.appUserId).toBeNull();
  });

  it('allows a different employee to link to the same user after unlinking', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(employee).values({
        client: tenant.client,
        personnelNumber: 'ELINKEDAGAIN',
        fullName: 'Re-linked Person',
        isActive: true,
        appUserId: configuratorUserId,
        createdBy: ACTOR,
      });
    });

    const rows = await withTenant(tenant.client, (tx) =>
      tx.select().from(employee).where(eq(employee.client, tenant.client)),
    );
    const person = rows.find((r) => r.personnelNumber === 'ELINKEDAGAIN');
    expect(person).toBeDefined();
    expect(person!.appUserId).toBe(configuratorUserId);
  });
});

describe('capability grants through roles', () => {
  it('CONFIGURATOR user holds People capabilities', async () => {
    const caps = await withTenant(tenant.client, (tx) =>
      loadCapabilities(tx, tenant.client, configuratorUserId),
    );
    expect(caps).toContain('PEOPLE.EMPLOYEE.CREATE');
    expect(caps).toContain('PEOPLE.TIME.ENTER');
    expect(caps).toContain('PEOPLE.LEAVE.VIEW');
    expect(caps).toContain('PEOPLE.ASSIGNMENT.MAINTAIN');
  });

  it('user with no roles holds no People capabilities', async () => {
    const caps = await withTenant(tenant.client, (tx) =>
      loadCapabilities(tx, tenant.client, noPeopleUserId),
    );
    expect(caps).not.toContain('PEOPLE.TIME.ENTER');
    expect(caps).not.toContain('PEOPLE.LEAVE.VIEW');
    expect(caps).not.toContain('PEOPLE.EMPLOYEE.CREATE');
  });

  it('hasCapability matches segment patterns exactly', async () => {
    expect(hasCapability(['PEOPLE.TIME.ENTER'], 'PEOPLE.TIME.ENTER')).toBe(true);
    expect(hasCapability(['PEOPLE.TIME.ENTER'], 'PEOPLE.LEAVE.VIEW')).toBe(false);
    expect(hasCapability(['PEOPLE.*'], 'PEOPLE.TIME.ENTER')).toBe(true);
    expect(hasCapability(['PEOPLE.TIME.ENTER'], 'PEOPLE.TIME.ENTER.APPROVE')).toBe(false);
    expect(hasCapability(['*'], 'PEOPLE.TIME.ENTER')).toBe(true);
  });

  it('signIn resolves capabilities through the session', async () => {
    const user = await signIn({
      client: tenant.client,
      username: 'ppl.configurator',
      password: 'Password1',
    });
    expect(user.capabilities).toContain('PEOPLE.TIME.ENTER');
    expect(user.capabilities).toContain('PEOPLE.LEAVE.VIEW');
  });
});

describe('authorization denial', () => {
  it('loadCapabilities returns empty for a user with no roles', async () => {
    const caps = await withTenant(tenant.client, (tx) =>
      loadCapabilities(tx, tenant.client, noPeopleUserId),
    );
    expect(caps).toEqual([]);
  });

  it('a deactivated user resolves to no session', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx
        .update(appUser)
        .set({ isActive: false })
        .where(eq(appUser.id, noPeopleUserId));
    });

    await expect(
      signIn({
        client: tenant.client,
        username: 'ppl.nople',
        password: 'Password1',
      }),
    ).rejects.toThrow();
  });

  it('a role revocation removes capabilities from the next session', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx
        .delete(userRole)
        .where(
          and(
            eq(userRole.client, tenant.client),
            eq(userRole.userId, configuratorUserId),
            eq(userRole.roleCode, 'CONFIGURATOR'),
          ),
        );
    });

    await expect(
      signIn({
        client: tenant.client,
        username: 'ppl.configurator',
        password: 'Password1',
      }),
    ).resolves.toMatchObject({
      capabilities: expect.not.arrayContaining(['PEOPLE.TIME.ENTER']),
    });
  });
});

describe('cross-tenant access', () => {
  it('a user of one tenant cannot load capabilities in another', async () => {
    const other = await createTenant('ppl-auth-other', { withConfiguration: true });

    try {
      const caps = await withTenant(other.client, (tx) =>
        loadCapabilities(tx, other.client, configuratorUserId),
      );
      expect(caps).toEqual([]);
    } finally {
      await destroyTenant(other.client);
    }
  });
});
