/**
 * The demo company's people, and the accounts they sign in with — phase `B_PEOPLE`.
 *
 * Two populations, because the product keeps two:
 *
 * - **Employees** are the org chart — org units, jobs, positions, who reports to
 *   whom, and which cost centre each position is paid from. An employee is never a
 *   user: the two tables have no column in common, and a person can appear in the
 *   chart without ever signing in.
 * - **Users** are the accounts. Each holds one custom role with an explicit
 *   capability pattern, and — where the job is tied to a place — a company code and
 *   a plant restriction.
 *
 * Why custom roles and not the eleven system roles. Every system role is protected:
 * `role-admin.ts` refuses to assign one through routine administration, and the
 * protected set was left exactly as it was. So the demo defines its own, with the
 * same capability patterns a customer would give a buyer or a warehouse clerk, and
 * assigns those.
 *
 * Why a session is opened. Both administration services refuse an actor who is not
 * signed in: they join `user_session` to prove the administrator is live. So the
 * provisioner signs the acting administrator in, does the work through the real
 * services, and revokes the session when the phase ends. No session is left behind
 * for anyone else to find, and the audit trail records a real signed-in actor rather
 * than a synthetic one.
 *
 * Two actors, because the two halves need different authority:
 * - `demo.admin`, holding `ADMINISTRATOR`, creates the org chart (`PEOPLE.*`);
 * - `demo.owner`, holding `PLATFORM_ADMIN`, creates the accounts, the roles and the
 *   scopes (`CFG.PLT.USER.CREATE`, `CFG.PLT.USER.MAINTAIN`, `CFG.PLT.ROLE.MAINTAIN`,
 *   `CFG.PLT.USER.ROLE.MAINTAIN`).
 */

import { and, eq, sql } from 'drizzle-orm';

import { withTenant } from '../db/client';
import { appUser, capability, role as roleTable, userRole } from '../tables/security';
import { createSession, resolveSession, revokeSessionById } from '../auth/session';
import { hasCapability } from '../auth/pattern';
import { completePasswordReset, createUser, initiatePasswordReset } from '../../modules/platform/user-admin';
import { createRole, grantCapabilityToRole, grantRoleToUser } from '../../modules/platform/role-admin';
import { grantCompanyCodeScope, grantPlantScope } from '../../modules/platform/organisation-scope-admin';
import { defineJob, defineOrgUnit, definePosition } from '../../modules/people/org-structure';
import { createEmployee } from '../../modules/people/employee-master';
import { assignPosition } from '../../modules/people/assignment';
import {
  DEMO_ACTOR,
  DEMO_FOUNDER_ACCOUNTS,
  DEMO_IDENTITY,
  DEMO_STRUCTURE,
} from './demo-organisation';
import type { DemoAccount } from './demo-credentials';
import type { DemoTimeline } from './demo-provisioning';

/** What the acting administrator holds. `ADMINISTRATOR` is the wildcard, so this is literally its pattern. */
const ADMINISTRATOR_PATTERNS = ['*'] as const;
/** What the platform administrator holds, exactly. */
const PLATFORM_ADMIN_PATTERNS = [
  'CFG.PLT.ROLE.MAINTAIN',
  'CFG.PLT.USER.ROLE.MAINTAIN',
  'CFG.PLT.USER.CREATE',
  'CFG.PLT.USER.MAINTAIN',
] as const;

/**
 * The org units. Codes are letters and digits only — the service's own key format
 * refuses a hyphen — and the root stands alone so the chart has one top.
 */
const ORG_UNITS = [
  { code: 'VF', name: 'Vantage Foods' },
  { code: 'VFOPS', name: 'Operations', parentCode: 'VF' },
  { code: 'VFPROD', name: 'Production', parentCode: 'VFOPS' },
  { code: 'VFWHS', name: 'Warehousing', parentCode: 'VFOPS' },
  { code: 'VFQUA', name: 'Quality', parentCode: 'VFOPS' },
  { code: 'VFPROC', name: 'Procurement', parentCode: 'VF' },
  { code: 'VFSAL', name: 'Sales', parentCode: 'VF' },
  { code: 'VFFIN', name: 'Finance', parentCode: 'VF' },
] as const;

/** Jobs: what a position does, held separately from where it stands. */
const JOBS = [
  { code: 'JMD', name: 'Managing Director' },
  { code: 'JOPSMGR', name: 'Operations Manager' },
  { code: 'JPRODSUP', name: 'Production Supervisor' },
  { code: 'JPRODCLK', name: 'Production Clerk' },
  { code: 'JPLANNER', name: 'Production Planner' },
  { code: 'JWHSSUP', name: 'Warehouse Supervisor' },
  { code: 'JWHSCLK', name: 'Warehouse Clerk' },
  { code: 'JPROCMGR', name: 'Procurement Manager' },
  { code: 'JBUYER', name: 'Buyer' },
  { code: 'JSALMGR', name: 'Sales Manager' },
  { code: 'JSALCLK', name: 'Sales Clerk' },
  { code: 'JFINMGR', name: 'Finance Manager' },
  { code: 'JACCT', name: 'Accountant' },
  { code: 'JCTRL', name: 'Controller' },
  { code: 'JQC', name: 'Quality Inspector' },
] as const;

/**
 * Positions: where each one stands, what job it does, and who it reports to.
 *
 * The reporting line is the point of the chart — a position that reports to nobody
 * is a department of one, and authority charts and chains of command are read from
 * these edges rather than from the units.
 */
const POSITIONS = [
  { code: 'P1000', title: 'Managing Director', jobCode: 'JMD', orgUnitCode: 'VF' },
  { code: 'P2000', title: 'Operations Manager', jobCode: 'JOPSMGR', orgUnitCode: 'VFOPS', superiorCode: 'P1000' },
  { code: 'P2100', title: 'Production Supervisor', jobCode: 'JPRODSUP', orgUnitCode: 'VFPROD', superiorCode: 'P2000' },
  { code: 'P2110', title: 'Production Clerk', jobCode: 'JPRODCLK', orgUnitCode: 'VFPROD', superiorCode: 'P2100' },
  { code: 'P2120', title: 'Production Planner', jobCode: 'JPLANNER', orgUnitCode: 'VFPROD', superiorCode: 'P2100' },
  { code: 'P2200', title: 'Warehouse Supervisor', jobCode: 'JWHSSUP', orgUnitCode: 'VFWHS', superiorCode: 'P2000' },
  { code: 'P2210', title: 'Warehouse Clerk — Manufacturing', jobCode: 'JWHSCLK', orgUnitCode: 'VFWHS', superiorCode: 'P2200' },
  { code: 'P2211', title: 'Warehouse Clerk — Distribution', jobCode: 'JWHSCLK', orgUnitCode: 'VFWHS', superiorCode: 'P2200' },
  { code: 'P6000', title: 'Quality Inspector', jobCode: 'JQC', orgUnitCode: 'VFQUA', superiorCode: 'P2000' },
  { code: 'P3000', title: 'Procurement Manager', jobCode: 'JPROCMGR', orgUnitCode: 'VFPROC', superiorCode: 'P1000' },
  { code: 'P3100', title: 'Buyer', jobCode: 'JBUYER', orgUnitCode: 'VFPROC', superiorCode: 'P3000' },
  { code: 'P4000', title: 'Sales Manager', jobCode: 'JSALMGR', orgUnitCode: 'VFSAL', superiorCode: 'P1000' },
  { code: 'P4100', title: 'Sales Clerk', jobCode: 'JSALCLK', orgUnitCode: 'VFSAL', superiorCode: 'P4000' },
  { code: 'P5000', title: 'Finance Manager', jobCode: 'JFINMGR', orgUnitCode: 'VFFIN', superiorCode: 'P1000' },
  { code: 'P5100', title: 'Accountant', jobCode: 'JACCT', orgUnitCode: 'VFFIN', superiorCode: 'P5000' },
  { code: 'P5200', title: 'Controller', jobCode: 'JCTRL', orgUnitCode: 'VFFIN', superiorCode: 'P5000' },
] as const;

/** The people. Fictional names for a fictional company; each sits in one position, paid from one cost centre. */
const EMPLOYEES = [
  { personnelNumber: '10000001', fullName: 'Nadia Al-Sabah', positionCode: 'P1000', costCenter: 'CC5000' },
  { personnelNumber: '10000002', fullName: 'Yousef Karam', positionCode: 'P2000', costCenter: 'CC5000' },
  { personnelNumber: '10000003', fullName: 'Reem Haddad', positionCode: 'P2100', costCenter: 'CC1000' },
  { personnelNumber: '10000004', fullName: 'Omar Nasser', positionCode: 'P2110', costCenter: 'CC1000' },
  { personnelNumber: '10000005', fullName: 'Ziad Homsi', positionCode: 'P2120', costCenter: 'CC1000' },
  { personnelNumber: '10000006', fullName: 'Layla Mansour', positionCode: 'P2200', costCenter: 'CC2000' },
  { personnelNumber: '10000007', fullName: 'Faisal Jaber', positionCode: 'P2210', costCenter: 'CC2000' },
  { personnelNumber: '10000008', fullName: 'Hana Qasem', positionCode: 'P2211', costCenter: 'CC2000' },
  { personnelNumber: '10000009', fullName: 'Noor Adeeb', positionCode: 'P6000', costCenter: 'CC6000' },
  { personnelNumber: '10000010', fullName: 'Tareq Zayed', positionCode: 'P3000', costCenter: 'CC3000' },
  { personnelNumber: '10000011', fullName: 'Mariam Fadel', positionCode: 'P3100', costCenter: 'CC3000' },
  { personnelNumber: '10000012', fullName: 'Samir Otaibi', positionCode: 'P4000', costCenter: 'CC4000' },
  { personnelNumber: '10000013', fullName: 'Dina Rahal', positionCode: 'P4100', costCenter: 'CC4000' },
  { personnelNumber: '10000014', fullName: 'Karim Solh', positionCode: 'P5000', costCenter: 'CC5000' },
  { personnelNumber: '10000015', fullName: 'Amina Barakat', positionCode: 'P5100', costCenter: 'CC5000' },
  { personnelNumber: '10000016', fullName: 'Walid Farouk', positionCode: 'P5200', costCenter: 'CC5000' },
] as const;

/**
 * The custom roles.
 *
 * The capability patterns are the ones the product's own system roles use, spelled
 * out rather than inherited: a buyer buys, a warehouse clerk moves stock, an
 * accountant posts to the ledger. Deliberately scoped, deliberately separate — a
 * demo where everyone can do everything teaches nothing about authority.
 *
 * The patterns are expanded against the catalogue before they are granted, because
 * `grantCapabilityToRole` refuses a wildcard: a system role may hold `PROC.*` and
 * have it resolved at authorisation time, but a custom role must name what it holds.
 * Expanding here keeps the definitions readable without smuggling a wildcard past a
 * guard that exists on purpose.
 */
const ROLES = [
  {
    code: 'DEMO_BUYER',
    name: 'Buyer',
    description: 'Requisitions, purchase orders and supplier negotiation',
    capabilities: ['PROC.*', 'INV.STOCK.VIEW', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'DEMO_PLANNER',
    name: 'Production planner',
    description: 'MRP, planned orders and production orders',
    capabilities: ['PROD.*', 'INV.STOCK.VIEW', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'DEMO_PROD_CLERK',
    name: 'Production clerk',
    description: 'Shop-floor confirmations and goods movements',
    capabilities: ['PROD.CONFIRM.*', 'PROD.ORDER.GI', 'PROD.ORDER.GR', 'INV.STOCK.VIEW', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'DEMO_WH_CLERK_MFG',
    name: 'Warehouse clerk — manufacturing plant',
    description: 'Goods movements at the manufacturing plant',
    capabilities: ['INV.*', 'QM.LOT.CREATE', 'SALES.RETURNS.RECEIPT.POST', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'DEMO_WH_CLERK_DIST',
    name: 'Warehouse clerk — distribution centre',
    description: 'Goods movements at the distribution centre',
    capabilities: ['INV.*', 'QM.LOT.CREATE', 'SALES.RETURNS.RECEIPT.POST', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'DEMO_SALES_CLERK',
    name: 'Sales clerk',
    description: 'Quotations, orders, deliveries and billing',
    capabilities: ['SALES.*', 'INV.STOCK.VIEW', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'DEMO_ACCOUNTANT',
    name: 'Accountant',
    description: 'General ledger, payables, receivables and banking',
    capabilities: ['FIN.*', 'COST.*', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'DEMO_CONTROLLER',
    name: 'Controller',
    description: 'Costing, profitability and reporting',
    capabilities: ['COST.*', 'FIN.RPT.*', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'DEMO_QUALITY',
    name: 'Quality inspector',
    description: 'Inspection lots, results and usage decisions',
    capabilities: ['QM.*', 'INV.STOCK.VIEW', 'AUDIT.TRAIL.VIEW'],
  },
] as const;

/**
 * The accounts.
 *
 * `plant` is the whole point of the second plant: two warehouse clerks hold the same
 * capability pattern and are told apart only by the plant each is restricted to.
 * Everyone else works across the company and gets no plant restriction at all.
 */
const USERS = [
  { username: 'demo.buyer', fullName: 'Mariam Fadel', role: 'DEMO_BUYER', plant: null },
  { username: 'demo.planner', fullName: 'Ziad Homsi', role: 'DEMO_PLANNER', plant: null },
  { username: 'demo.production', fullName: 'Omar Nasser', role: 'DEMO_PROD_CLERK', plant: DEMO_STRUCTURE.manufacturingPlant },
  { username: 'demo.warehouse1', fullName: 'Faisal Jaber', role: 'DEMO_WH_CLERK_MFG', plant: DEMO_STRUCTURE.manufacturingPlant },
  { username: 'demo.warehouse2', fullName: 'Hana Qasem', role: 'DEMO_WH_CLERK_DIST', plant: DEMO_STRUCTURE.distributionPlant },
  { username: 'demo.sales', fullName: 'Dina Rahal', role: 'DEMO_SALES_CLERK', plant: null },
  { username: 'demo.accountant', fullName: 'Amina Barakat', role: 'DEMO_ACCOUNTANT', plant: null },
  { username: 'demo.controller', fullName: 'Walid Farouk', role: 'DEMO_CONTROLLER', plant: null },
  { username: 'demo.quality', fullName: 'Noor Adeeb', role: 'DEMO_QUALITY', plant: null },
] as const;

export interface DemoPeopleResult {
  client: string;
  orgUnits: number;
  jobs: number;
  positions: number;
  employees: number;
  roles: number;
  users: number;
  /** The accounts that can sign in, in the order they should be listed. */
  accounts: DemoAccount[];
}

export interface BuildDemoPeopleInput {
  client: string;
  password: string;
  timeline: DemoTimeline;
}

/**
 * Build the org chart and the accounts.
 *
 * Idempotent by adoption: an org unit, position, employee, role or user that already
 * stands is left alone, so a resumed run continues where it stopped instead of
 * refusing on its own work.
 */
export async function buildDemoPeople(input: BuildDemoPeopleInput): Promise<DemoPeopleResult> {
  const client = input.client;

  await withAdministration(client, DEMO_FOUNDER_ACCOUNTS.administrator.username, async (actor) => {
    for (const unit of ORG_UNITS) {
      await defineOrgUnit(
        {
          client,
          code: unit.code,
          name: unit.name,
          ...('parentCode' in unit ? { parentCode: unit.parentCode } : {}),
          changedBy: DEMO_ACTOR,
        },
        ADMINISTRATOR_PATTERNS,
      ).catch(ignoreExisting);
    }

    for (const job of JOBS) {
      await defineJob(
        { client, code: job.code, name: job.name, changedBy: DEMO_ACTOR },
        ADMINISTRATOR_PATTERNS,
      ).catch(ignoreExisting);
    }

    for (const position of POSITIONS) {
      await definePosition(
        {
          client,
          code: position.code,
          title: position.title,
          jobCode: position.jobCode,
          orgUnitCode: position.orgUnitCode,
          ...('superiorCode' in position ? { superiorCode: position.superiorCode } : {}),
          changedBy: DEMO_ACTOR,
        },
        ADMINISTRATOR_PATTERNS,
      ).catch(ignoreExisting);
    }

    for (const employee of EMPLOYEES) {
      await createEmployee(
        {
          client,
          personnelNumber: employee.personnelNumber,
          fullName: employee.fullName,
          isActive: true,
          requestKey: `DEMO-${employee.personnelNumber}`,
          changedBy: DEMO_ACTOR,
        },
        ADMINISTRATOR_PATTERNS,
      ).catch(ignoreExisting);

      await assignPosition(
        {
          client,
          personnelNumber: employee.personnelNumber,
          positionCode: employee.positionCode,
          controllingArea: DEMO_STRUCTURE.controllingArea,
          costCenter: employee.costCenter,
          validFrom: input.timeline.startDate,
          changedBy: DEMO_ACTOR,
        },
        ADMINISTRATOR_PATTERNS,
      ).catch(ignoreExisting);
    }

    // Unused here, but the actor is what the administration services were handed.
    void actor;
  });

  await withAdministration(client, DEMO_FOUNDER_ACCOUNTS.platformAdmin.username, async (actor) => {
    for (const definition of ROLES) {
      await createRole({
        client,
        actor,
        code: definition.code,
        name: definition.name,
        description: definition.description,
      }).catch(ignoreExisting);

      for (const capabilityCode of await expandCapabilities(client, definition.capabilities)) {
        await grantCapabilityToRole({ client, actor, roleCode: definition.code, capabilityCode })
          .catch(ignoreExisting);
      }
    }

    for (const user of USERS) {
      const created = await createUser(
        {
          client,
          username: user.username,
          fullName: user.fullName,
          email: `${user.username}@vantage-demo.test`,
          password: input.password,
          changedBy: DEMO_ACTOR,
        },
        [...PLATFORM_ADMIN_PATTERNS],
      ).catch(recoverExistingUser(client, user.username));

      await grantRoleToUser({ client, actor, targetUserId: created.id, roleCode: user.role })
        .catch(ignoreExisting);

      await grantCompanyCodeScope({
        client,
        actor,
        targetUserId: created.id,
        companyCode: DEMO_STRUCTURE.companyCode,
      }).catch(ignoreExisting);

      if (user.plant) {
        await grantPlantScope({
          client,
          actor,
          targetUserId: created.id,
          companyCode: DEMO_STRUCTURE.companyCode,
          plantCode: user.plant,
        }).catch(ignoreExisting);
      }
    }
  });

  // Every account in the credential file is opened by the password in it.
  //
  // That sounds like a tautology and on a first run it nearly is: `createTenant`
  // and `createUser` both hashed this password as they went. It stops being one the
  // moment a run resumes. A run that died inside this phase left the accounts it had
  // already built holding a password that was never written down anywhere — that is
  // the whole point of a fingerprint — so the run that finishes the work cannot know
  // it. Rather than hand out a second password and leave the file a liar, the
  // finishing run issues one and sets it on every account the file lists.
  //
  // It goes through the administrator's own reset service, not around it: a token is
  // issued and completed, and the change is audited like any other password reset.
  await setEveryPassword(client, input.password);

  return {
    client,
    orgUnits: ORG_UNITS.length,
    jobs: JOBS.length,
    positions: POSITIONS.length,
    employees: EMPLOYEES.length,
    roles: ROLES.length,
    users: USERS.length,
    accounts: await listDemoAccounts(client),
  };
}

/**
 * The accounts a person could sign in with, for the credential file.
 *
 * Read back from the database rather than remembered from the run, so a resumed
 * installation — whose accounts were created by a run that is no longer alive —
 * still produces the whole list. The two administrators are listed first because
 * they are the ones who unlock everything else.
 */
export async function listDemoAccounts(client: string = DEMO_IDENTITY.clientKey): Promise<DemoAccount[]> {
  return withTenant(client, async (tx) => {
    const rows = (await tx
      .select({
        username: appUser.username,
        fullName: appUser.fullName,
        email: appUser.email,
        roleCode: userRole.roleCode,
        roleName: roleTable.name,
      })
      .from(appUser)
      .leftJoin(userRole, and(eq(userRole.client, appUser.client), eq(userRole.userId, appUser.id)))
      .leftJoin(roleTable, and(eq(roleTable.client, appUser.client), eq(roleTable.code, userRole.roleCode)))
      .where(eq(appUser.client, client))) as Array<{
      username: string;
      fullName: string;
      email: string | null;
      roleCode: string | null;
      roleName: string | null;
    }>;

    const byName = new Map<string, DemoAccount>();
    for (const row of rows) {
      const standing = byName.get(row.username);
      const described = row.roleName ?? row.roleCode ?? 'No role assigned';
      if (standing) {
        // A second role is a second line on the same account, not a second account.
        standing.role = `${standing.role}; ${described}`;
        continue;
      }
      byName.set(row.username, {
        username: row.username,
        fullName: row.fullName,
        email: row.email ?? undefined,
        role: described,
      });
    }

    const order = new Map<string, number>([
      [DEMO_FOUNDER_ACCOUNTS.platformAdmin.username.toUpperCase(), 0],
      [DEMO_FOUNDER_ACCOUNTS.administrator.username.toUpperCase(), 1],
    ]);
    return [...byName.values()].sort((left, right) => {
      const rank = (order.get(left.username.toUpperCase()) ?? 99) - (order.get(right.username.toUpperCase()) ?? 99);
      return rank !== 0 ? rank : left.username.localeCompare(right.username);
    });
  });
}

/**
 * Sign an administrator in, run the work, and revoke the session.
 *
 * The session is real — issued by `createSession`, resolved to its id through the
 * token, and revoked by id at the end, in a `finally` so a failure mid-phase does
 * not leave a live administrator session behind in a demo anyone can open.
 */
async function withAdministration<T>(
  client: string,
  username: string,
  work: (actor: { userId: string; sessionId: string }) => Promise<T>,
): Promise<T> {
  const { userId, sessionId } = await withTenant(client, async (tx) => {
    // Matched without regard to case, because the two paths that create accounts
    // disagree about it: `createTenant` stores the username as it was typed, while
    // `user-admin.createUser` upper-cases it. Neither is wrong to a person signing
    // in — the sign-in path is case-insensitive too — so neither is changed here.
    const [account] = await tx
      .select({ id: appUser.id })
      .from(appUser)
      .where(and(eq(appUser.client, client), sql`upper(${appUser.username}) = ${username.toUpperCase()}`))
      .limit(1);
    if (!account) {
      throw new Error(`Demo account ${username} was not found in tenant ${client}.`);
    }
    const { token } = await createSession(tx, {
      client,
      userId: account.id,
      ipAddress: '127.0.0.1',
      userAgent: 'cairn-demo-provisioning',
      ttlMinutes: 60,
    });
    const resolved = await resolveSession(tx, { client, token });
    if (!resolved?.sessionId) {
      throw new Error(`The demo administration session for ${username} could not be resolved.`);
    }
    return { userId: account.id, sessionId: resolved.sessionId };
  });

  try {
    return await work({ userId, sessionId });
  } finally {
    await withTenant(client, (tx) =>
      revokeSessionById(tx, { client, sessionId, reason: 'Demo provisioning completed' }),
    );
  }
}

/** Set one shared password on every account the demo owns. */
async function setEveryPassword(client: string, password: string): Promise<void> {
  const accounts = await withTenant(client, async (tx) => {
    const rows = await tx.select({ id: appUser.id }).from(appUser).where(eq(appUser.client, client));
    return rows.map((row) => row.id);
  });

  await withAdministration(client, DEMO_FOUNDER_ACCOUNTS.administrator.username, async () => {
    for (const userId of accounts) {
      const { token } = await initiatePasswordReset(
        { client, userId, changedBy: DEMO_ACTOR, ipAddress: '127.0.0.1' },
        [...ADMINISTRATOR_PATTERNS],
      );
      await completePasswordReset({ client, token, password, ipAddress: '127.0.0.1' });
    }
  });
}

/**
 * Turn the role's patterns into the concrete codes the catalogue actually holds.
 *
 * Read from the database rather than from a list in this file, so a capability added
 * by a later seed is picked up by the roles whose patterns cover it, and a pattern
 * that matches nothing is visible as a short role rather than as a silent gap.
 */
async function expandCapabilities(client: string, patterns: readonly string[]): Promise<string[]> {
  return withTenant(client, async (tx) => {
    const catalogue = await tx.select({ code: capability.code }).from(capability);
    return catalogue
      .map((entry) => entry.code)
      .filter((code) => patterns.some((pattern) => hasCapability([pattern], code)))
      .sort();
  });
}

/**
 * A write that found the row already there is not a failure; anything else is.
 *
 * The services this phase calls have no stable refusal code — they throw an
 * `OrgStructureError` or a plain `Error` carrying English and a remedy, and the key
 * behind it is not exposed. So the phrases are named here, one per service, rather
 * than matched with a loose `already`: a refusal that means "somebody else owns
 * this" or "that value is malformed" must still stop the run, and only the wording
 * of a duplicate is forgiven.
 */
const DUPLICATE_REFUSALS: ReadonlyArray<RegExp> = [
  // org-structure: org unit, job and position (UNIT_EXISTS, JOB_EXISTS, POSITION_EXISTS).
  /already stands in this tenant/i,
  // employee-master (EMPLOYEE_EXISTS).
  /already stands in this tenant|was created in the same moment/i,
  // assignment (OVERLAP): the employee already holds a position covering that day.
  /already (has|have) an assignment covering that day/i,
  // role-admin.
  /already exists\.|already holds /i,
];

function ignoreExisting(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (DUPLICATE_REFUSALS.some((pattern) => pattern.test(message))) return;
  throw error;
}

/**
 * A user created by an earlier pass through this phase.
 *
 * `createUser` refuses a username that is taken, which is right for a screen and
 * wrong for a resumed run; the row it would have written is read back instead.
 */
function recoverExistingUser(
  client: string,
  username: string,
): (error: unknown) => Promise<{ id: string }> {
  return async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // user-admin refuses a taken username with its own wording.
    if (!/taken|already/i.test(message)) throw error;
    return withTenant(client, async (tx) => {
      const [row] = await tx
        .select({ id: appUser.id })
        .from(appUser)
        .where(and(eq(appUser.client, client), sql`upper(${appUser.username}) = ${username.toUpperCase()}`))
        .limit(1);
      if (!row) throw error;
      return { id: row.id };
    });
  };
}
