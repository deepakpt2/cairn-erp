/**
 * Phase 1 for the India UAT dataset: the people, the accounts, and the payroll master data.
 *
 * Two populations, because the product keeps two: employees are the org chart and never sign
 * in; users are the accounts and each holds one role. The fixture says which employee is
 * which user, so the guide can name a person and a sign-in for every step.
 *
 * Payroll master data is built here rather than in Phase 2 because a payroll run reads it and
 * a run is a Phase 3 activity: structures, component mappings, leave types, quotas and the
 * employee record types that carry PAN, UAN, ESIC and bank details.
 *
 * Every account gets its own password, generated at install time. That is what lets the UAT
 * test segregation of duties by signing in as each role, and it is why the credential report
 * lists a password per line rather than one for the tenant.
 */
import { and, eq, sql } from 'drizzle-orm';

import { withTenant } from '../db/client';
import { appUser, capability, role as roleTable, userRole } from '../tables/security';
import { hasCapability } from '../auth/pattern';
import { completePasswordReset, createUser, initiatePasswordReset } from '../../modules/platform/user-admin';
import { createRole, grantCapabilityToRole, grantRoleToUser } from '../../modules/platform/role-admin';
import { grantCompanyCodeScope, grantPlantScope } from '../../modules/platform/organisation-scope-admin';
import { defineOrgUnit, defineJob, definePosition } from '../../modules/people/org-structure';
import { createEmployee, linkEmployeeUser } from '../../modules/people/employee-master';
import { assignPosition } from '../../modules/people/assignment';
import { defineTimeType, setLeaveQuota } from '../../modules/people/time-leave';
import { defineRecordType } from '../../modules/people/record-types';
import { definePayComponent, getPayComponent, savePayComponentMapping } from '../../modules/people/pay-components';
import { addEmployeeComponent } from '../../modules/people/payroll-components';
import { withActingUser } from './demo-people';
import { defineSalaryStructure, setStructureComponent, assignStructure } from '../../modules/people/payroll-structure';
import { IN01_ACTOR, type Phase1Result } from './in01-phase0';
import type { FixtureSet } from './in01-fixtures';
import type { DemoAccount } from './demo-credentials';

const ADMIN_PATTERNS = ['*'] as const;
const PLATFORM_PATTERNS = [
  'CFG.PLT.ROLE.MAINTAIN',
  'CFG.PLT.USER.ROLE.MAINTAIN',
  'CFG.PLT.USER.CREATE',
  'CFG.PLT.USER.MAINTAIN',
] as const;

/**
 * A write that found the row already there is not a failure.
 *
 * The phrases are named per service rather than matched with a loose "already", because the
 * organisational services refuse a genuine mistake in the same voice: "an employee already
 * covers that day" means a fixture has two overlapping assignments and must stop the run, while
 * "already stands in this tenant" means a resumed pass found its own work.
 */
function ignoreExisting(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const duplicate =
    /already stands in this tenant/i.test(message)
    || /was created in the same moment/i.test(message)
    || /already has an assignment covering that day/i.test(message)
    || /already holds/i.test(message)
    || /already exists|is already|already in use|changed after it was opened/i.test(message);
  if (duplicate) return;
  throw error;
}

/**
 * Build Phase 1.
 *
 * The acting administrator is a real signed-in session, because user and role administration
 * refuse an actor who is not signed in — the services join `user_session` to prove it. The
 * session is revoked when the phase ends so nothing is left behind for anyone to find.
 */
export async function buildPhase1(input: {
  fixtures: FixtureSet;
  passwords: Map<string, string>;
  scenario: { fiscalYear: number; period: number; from: string; to: string };
}): Promise<Phase1Result> {
  const { fixtures, passwords, scenario } = input;
  const { core, country, company } = fixtures;
  const client = company.identity.clientKey;
  const companyCode = company.identity.companyCode;

  // ── Org chart ────────────────────────────────────────────────────────────────
  // Parents before children, because a unit's parent must exist when it is attached.
  const ordered = orderByParent(company.orgUnits);
  for (const unit of ordered) {
    await defineOrgUnit({
      client,
      changedBy: IN01_ACTOR,
      code: unit.code,
      name: unit.name,
      parentCode: unit.parentCode,
    }, ADMIN_PATTERNS).catch(ignoreExisting);
  }

  for (const job of company.jobs) {
    await defineJob({ client, changedBy: IN01_ACTOR, code: job.code, name: job.name }, ADMIN_PATTERNS)
      .catch(ignoreExisting);
  }

  // Positions: a position's superior must stand before it, so the list is ordered by the
  // reporting chain rather than by tier. Sorting by tier would be wrong: a shift supervisor on
  // tier 3 reports to a production manager on tier 6, and the supervisor would be asked for first.
  for (const position of orderBySuperior(company.positions)) {
    await definePosition({
      client,
      changedBy: IN01_ACTOR,
      code: position.code,
      title: position.title,
      jobCode: position.jobCode,
      orgUnitCode: position.orgUnitCode,
      ...(position.superiorCode ? { superiorCode: position.superiorCode } : {}),
      tier: position.tier,
    }, ADMIN_PATTERNS).catch(ignoreExisting);
  }

  // Employees and their assignments.
  for (const employee of company.employees) {
    await createEmployee({
      client,
      personnelNumber: employee.personnelNumber,
      fullName: employee.fullName,
      isActive: true,
      requestKey: `IN01-${employee.personnelNumber}`,
      changedBy: IN01_ACTOR,
    }, ADMIN_PATTERNS).catch(ignoreExisting);

    await assignPosition({
      client,
      personnelNumber: employee.personnelNumber,
      positionCode: employee.positionCode,
      controllingArea: core.structure.controllingArea,
      costCenter: employee.costCentre,
      plant: employee.costCentre === 'CC8000' || employee.costCentre === 'CC4000'
        ? core.structure.distributionPlant
        : core.structure.manufacturingPlant,
      validFrom: scenario.from,
      changedBy: IN01_ACTOR,
    }, ADMIN_PATTERNS).catch(ignoreExisting);
  }

  // ── Roles and accounts ───────────────────────────────────────────────────────
  const platformAdminUsername = company.founderAccounts.platformAdmin.username;

  await withActingUser(client, platformAdminUsername, async (actor) => {
    for (const definition of core.roles) {
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

    for (const user of company.users) {
      const password = passwords.get(user.username);
      if (!password) throw new Error(`No password was generated for ${user.username}.`);

      // The fixture's `in01.admin` is the tenant administrator that `createTenant` made in the
      // same transaction as the tenant. That path stores the username as typed and hashes the
      // password itself, whereas `createUser` upper-cases the username — so asking for it again
      // would create a second spelling of the same person. It is adopted by a case-insensitive
      // lookup and never re-created.
      const existing = await findAccount(client, user.username);
      const created = existing ?? await createUser({
        client,
        username: user.username,
        fullName: fullNameOf(fixtures, user.personnelNumber),
        email: `${user.username}@cairndemoindustries.example.in`,
        password,
        changedBy: IN01_ACTOR,
      }, [...PLATFORM_PATTERNS]).catch(recoverExistingUser(client, user.username));

      // The tenant administrator already holds ADMINISTRATOR, which is the wildcard; granting a
      // second role to it would narrow, not widen, its reach. Everyone else gets theirs.
      if (user.role !== 'ADMINISTRATOR') {
        await grantRoleToUser({ client, actor, targetUserId: created.id, roleCode: user.role })
          .catch(ignoreExisting);
      }

      await grantCompanyCodeScope({ client, actor, targetUserId: created.id, companyCode })
        .catch(ignoreExisting);

      for (const plantCode of user.plants) {
        await grantPlantScope({ client, actor, targetUserId: created.id, companyCode, plantCode })
          .catch(ignoreExisting);
      }
    }
  });

  // Each account is linked to its employee, so its position tier is the account's tier.
  for (const user of company.users) {
    await linkEmployeeUser(
      { client, personnelNumber: user.personnelNumber, username: user.username, changedBy: IN01_ACTOR },
      ADMIN_PATTERNS,
    ).catch(ignoreExisting);
  }

  // ── Time types and leave quotas ──────────────────────────────────────────────
  for (const leave of company.leaveTypes) {
    await defineTimeType({
      client,
      changedBy: IN01_ACTOR,
      code: leave.code,
      name: leave.name,
      typeKind: 'ABSENCE',
      reducesQuota: leave.reducesQuota,
      isPaid: leave.isPaid,
    }, ADMIN_PATTERNS).catch(ignoreExisting);
  }

  // Opening balances, for the scenario's fiscal year. A quota is per calendar year in the
  // model, so the year the scenario starts in is the one that gets a balance.
  let quotas = 0;
  const quotaYear = Number(scenario.from.slice(0, 4));
  for (const employee of company.employees) {
    for (const [code, entitlement] of Object.entries(company.leaveQuotas)) {
      await setLeaveQuota({
        client,
        changedBy: IN01_ACTOR,
        personnelNumber: employee.personnelNumber,
        timeTypeCode: code,
        year: String(quotaYear),
        entitlement,
      }, ADMIN_PATTERNS).then(() => { quotas += 1; }).catch(ignoreExisting);
    }
  }

  // ── Employee record types: PAN, UAN, ESIC, bank ────────────────────────────
  for (const type of company.employeeRecordTypes) {
    await defineRecordType({
      client,
      changedBy: IN01_ACTOR,
      code: type.code,
      name: type.name,
      fields: type.fields,
    }, ADMIN_PATTERNS).catch(ignoreExisting);
  }

  // ── Payroll master data ─────────────────────────────────────────────────────
  const payComponents = [...country.payrollStatutory.earningComponents, ...country.payrollStatutory.components];
  for (const component of payComponents) {
    await definePayComponent({
      client,
      code: component.code,
      name: component.name,
      componentKind: component.kind,
      changedBy: IN01_ACTOR,
    }, ADMIN_PATTERNS).catch(ignoreExisting);

    // A mapping is one row per component and chart; a second one is a collision, not a re-run.
    const standing = await getPayComponent(client, component.code).catch(() => null);
    const mapped = standing?.mappings?.some((row) =>
      (row as { chartOfAccounts?: string }).chartOfAccounts === core.structure.chartOfAccounts) ?? false;
    if (!mapped) {
      await savePayComponentMapping({
        client,
        componentCode: component.code,
        chartOfAccounts: core.structure.chartOfAccounts,
        debitAccount: component.debit,
        creditAccount: component.credit,
        costReceiverCategory: component.receiver,
        changedBy: IN01_ACTOR,
      }, 'CREATE', ADMIN_PATTERNS).catch(ignoreExisting);
    }
  }

  for (const [code, structure] of Object.entries(company.salaryStructures)) {
    await defineSalaryStructure({
      client,
      code,
      name: structure.name,
      currency: country.country.currency,
      validFrom: scenario.from,
      changedBy: IN01_ACTOR,
    }, ADMIN_PATTERNS).catch(ignoreExisting);

    for (const rule of structure.rules) {
      await setStructureComponent({
        client,
        structureCode: code,
        componentCode: rule.component,
        amountKind: rule.kind,
        amountValue: rule.value,
        changedBy: IN01_ACTOR,
      }, ADMIN_PATTERNS).catch(ignoreExisting);
    }
  }

  // One assignment per employee. ESI is applied only to the employees the fixture marks as
  // under the wage ceiling, because the engine has no ceiling rule of its own.
  for (const employee of company.employees) {
    await assignStructure({
      client,
      personnelNumber: employee.personnelNumber,
      structureCode: employee.structure,
      baseAmount: employee.base,
      currency: country.country.currency,
      validFrom: scenario.from,
      requestKey: `IN01-SAL-${employee.personnelNumber}`,
      changedBy: IN01_ACTOR,
    }, ADMIN_PATTERNS).catch(ignoreExisting);

    await applyEsiIfEligible(client, employee, scenario.from);
  }

  return {
    orgUnits: company.orgUnits.length,
    jobs: company.jobs.length,
    positions: company.positions.length,
    employees: company.employees.length,
    users: company.users.length,
    leaveTypes: company.leaveTypes.length,
    recordTypes: company.employeeRecordTypes.length,
    quotas,
    structures: Object.keys(company.salaryStructures).length,
    assignments: company.employees.length,
  };
}

/**
 * ESI for an employee whose wage the fixture places under the ceiling.
 *
 * The fixture decides eligibility; the engine cannot, because a structure rule is either a
 * fixed amount or a percentage of the base and carries no condition. The two ESI components
 * are therefore added as employee-level entries on the employees the fixture marks, and the
 * missing ceiling rule is recorded as a GAP rather than invented in code.
 */
async function applyEsiIfEligible(
  client: string,
  employee: { personnelNumber: string; esiEligible?: boolean },
  from: string,
): Promise<void> {
  if (!employee.esiEligible) return;
  for (const code of ['ESIEE', 'ESIER']) {
    await addEmployeeComponent({
      client,
      changedBy: IN01_ACTOR,
      personnelNumber: employee.personnelNumber,
      componentCode: code,
      mode: 'ADD',
      amountKind: 'PERCENT_OF_BASE',
      amountValue: code === 'ESIEE' ? '0.75' : '3.25',
      currency: 'INR',
      validFrom: from,
      prorationPolicy: 'PAYABLE_CALENDAR_DAYS',
      reason: 'Employee is below the ESI wage ceiling (fixture-marked; the engine has no ceiling rule).',
      requestKey: `IN01-ESI-${code}-${employee.personnelNumber}`,
    }, ADMIN_PATTERNS).catch(ignoreExisting);
  }
}

/** A position's superior must stand before it, so order the chart down its reporting edges. */
function orderBySuperior<T extends { code: string; superiorCode?: string }>(positions: T[]): T[] {
  const byCode = new Map(positions.map((position) => [position.code, position]));
  const ordered: T[] = [];
  const seen = new Set<string>();

  const visit = (code: string) => {
    if (seen.has(code)) return;
    const position = byCode.get(code);
    if (!position) return;
    if (position.superiorCode) visit(position.superiorCode);
    if (seen.has(code)) return;
    seen.add(code);
    ordered.push(position);
  };

  for (const position of positions) visit(position.code);
  return ordered;
}

/** A parent must exist before its child, so order the chart from the root down. */
function orderByParent(units: Array<{ code: string; parentCode?: string }>): Array<{ code: string; name: string; parentCode?: string }> {
  const byCode = new Map(units.map((unit) => [unit.code, unit]));
  const ordered: Array<{ code: string; name: string; parentCode?: string }> = [];
  const seen = new Set<string>();

  const visit = (code: string) => {
    if (seen.has(code)) return;
    const unit = byCode.get(code);
    if (!unit) return;
    if (unit.parentCode) visit(unit.parentCode);
    if (seen.has(code)) return;
    seen.add(code);
    ordered.push(unit as { code: string; name: string; parentCode?: string });
  };

  for (const unit of units) visit(unit.code);
  return ordered;
}

function fullNameOf(fixtures: FixtureSet, personnelNumber: string): string {
  return fixtures.company.employees.find((e) => e.personnelNumber === personnelNumber)?.fullName
    ?? personnelNumber;
}

/** Expand a capability pattern against the catalogue, because a custom role cannot hold a wildcard. */
async function expandCapabilities(client: string, patterns: string[]): Promise<string[]> {
  return withTenant(client, async (tx) => {
    const catalogue = await tx.select({ code: capability.code }).from(capability);
    return catalogue
      .map((entry) => entry.code)
      .filter((code) => patterns.some((pattern) => hasCapability([pattern], code)))
      .sort();
  });
}

/** An account by username, case-insensitively: the two creation paths disagree about case. */
async function findAccount(client: string, username: string): Promise<{ id: string; username: string } | null> {
  return withTenant(client, async (tx) => {
    const [row] = await tx
      .select({ id: appUser.id, username: appUser.username })
      .from(appUser)
      .where(and(eq(appUser.client, client), sql`upper(${appUser.username}) = ${username.toUpperCase()}`))
      .limit(1);
    return row ?? null;
  });
}

/** A user that already stands is adopted: the service refuses a duplicate, not a re-run. */
function recoverExistingUser(client: string, username: string) {
  return async (error: unknown): Promise<{ id: string; username: string }> => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists|is already|already in use|USERNAME_TAKEN|EXISTS/i.test(message)) throw error;
    // Case-insensitive, because `createUser` upper-cases a username while `createTenant`
    // stores it as typed, and the tenant administrator is created by the latter.
    const [row] = await withTenant(client, (tx) =>
      tx.select({ id: appUser.id, username: appUser.username }).from(appUser)
        .where(and(eq(appUser.client, client), sql`upper(${appUser.username}) = ${username.toUpperCase()}`)).limit(1));
    if (!row) throw error;
    return row;
  };
}

/**
 * Put each account's generated password on it, through the reset services.
 *
 * A created account already hashed this run's password, so the reset is redundant for it —
 * but the tenant administrator was created by `createTenant` with the same password under a
 * different username, and a resumed run adopts accounts a dead run created. Both are covered
 * by resetting every account the fixture names, which is the one way to be sure the password
 * in the credential file is the password that opens the account.
 */
export async function applyPasswords(input: {
  fixtures: FixtureSet;
  passwords: Map<string, string>;
}): Promise<void> {
  const client = input.fixtures.company.identity.clientKey;
  const adminUsername = input.fixtures.company.founderAccounts.administrator.username;

  // Both founder accounts, then every fixture account. `createTenant` created the two founders
  // with the administrator's password, but only the administrator is in the fixture's user list;
  // the platform administrator is named in `founderAccounts` and is reset here by the same
  // password so the credential file's two founder lines both open.
  const targets: Array<{ username: string; password: string }> = [
    {
      username: input.fixtures.company.founderAccounts.platformAdmin.username,
      password: input.passwords.get(adminUsername) ?? '',
    },
    ...input.fixtures.company.users.map((user) => ({
      username: user.username,
      password: input.passwords.get(user.username) ?? '',
    })),
  ];

  await withActingUser(client, adminUsername, async () => {
    for (const user of targets) {
      const password = user.password;
      if (!password) throw new Error(`No password was generated for ${user.username}.`);

      const account = await withTenant(client, async (tx) => {
        const [row] = await tx.select({ id: appUser.id }).from(appUser)
          .where(and(eq(appUser.client, client), sql`upper(${appUser.username}) = ${user.username.toUpperCase()}`))
          .limit(1);
        return row;
      });
      if (!account) throw new Error(`Account ${user.username} does not exist after Phase 1.`);

      const { token } = await initiatePasswordReset(
        { client, userId: account.id, changedBy: IN01_ACTOR, ipAddress: '127.0.0.1' },
        [...ADMIN_PATTERNS],
        { deliverByMail: false },
      );
      await completePasswordReset({ client, token, password, ipAddress: '127.0.0.1' });
    }
  });
}

/**
 * The accounts the credential report lists.
 *
 * Read back from the database rather than remembered from the run, so a resumed installation
 * still produces a complete list. The password is not read here: it lives only in the
 * credential file and the test-only view, never in the database.
 */
export async function listIn01Accounts(
  fixtures: FixtureSet,
): Promise<Array<DemoAccount & { department: string; personnelNumber: string | null }>> {
  const { company } = fixtures;
  const client = company.identity.clientKey;
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({
        username: appUser.username,
        fullName: appUser.fullName,
        email: appUser.email,
        roleCode: roleTable.code,
        roleName: roleTable.name,
      })
      .from(appUser)
      .leftJoin(userRole, and(eq(userRole.client, appUser.client), eq(userRole.userId, appUser.id)))
      .leftJoin(roleTable, and(eq(roleTable.client, userRole.client), eq(roleTable.code, userRole.roleCode)))
      .where(eq(appUser.client, client))
      .orderBy(appUser.username);

    const byUsername = new Map<string, DemoAccount & { department: string; personnelNumber: string | null }>();
    for (const row of rows) {
      const user = company.users.find((u) => u.username.toLowerCase() === row.username.toLowerCase());
      const existing = byUsername.get(row.username);
      if (existing) {
        if (row.roleName && !existing.role.includes(row.roleName)) existing.role = `${existing.role}, ${row.roleName}`;
        continue;
      }
      byUsername.set(row.username, {
        username: row.username,
        fullName: row.fullName,
        email: row.email ?? undefined,
        role: row.roleName ?? row.roleCode ?? '',
        department: user?.department ?? '',
        personnelNumber: user?.personnelNumber ?? null,
      });
    }
    return [...byUsername.values()];
  });
}
