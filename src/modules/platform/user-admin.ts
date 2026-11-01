/**
 * User administration — CAIRN.md §23, SCR-003 (SU01, DRAFT).
 *
 * Application users stand apart from employee master records: an employee may
 * have no user account, and a user may have no employee link. Password recovery
 * works for users with no employee link — the reset flow touches only
 * `app_user`, never HR-owned fields.
 *
 * Constraints carried by this file:
 * - Resetting a password must not activate a disabled account, assign roles,
 *   expand organisational access, or modify HR-owned profile data.
 * - Reset tokens are single-use, short-lived, tenant-scoped, stored as a hash.
 * - The same message is returned whether the named user exists or not,
 *   so an attacker cannot enumerate usernames through the reset screen.
 * - No approved email transport exists yet (D-033): the administrative reset
 *   action is paused instead of minting an undeliverable token, and no browser
 *   action returns a reset token. Self-service requests remain non-enumerating.
 */
import { eq, and, sql, gt, isNull, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

import { type Tx, withTenant } from '../../platform/db/client';
import {
  appUser,
  userSession,
  auditAccessLog,
  passwordResetToken,
  userRole,
  role,
  capability,
} from '../../platform/tables/security';
import { employee } from '../people/schema';

import { recordChange } from '../../platform/change';
import { hashPassword, checkPasswordPolicy } from '../../platform/auth/password';
import {
  hasCapability,
  loadCapabilities,
  loadOrgRestrictions,
  type OrgRestriction,
} from '../../platform/auth/session';

const TOKEN_TTL_MINUTES = 60;
const MAX_RESET_REQUESTS_PER_HOUR = 3;
const PASSWORD_MIN = 10;

export const USER_ADMIN_VIEW_CAPABILITIES = [
  'CFG.PLT.USER.CREATE',
  'CFG.PLT.USER.MAINTAIN',
  'CFG.PLT.USER.PASSWORD_RESET',
] as const;

export type UserStatusFilter = 'ALL' | 'ACTIVE' | 'INACTIVE' | 'LOCKED' | 'UNLOCKED';
const userStatusFilter = z.enum(['ALL', 'ACTIVE', 'INACTIVE', 'LOCKED', 'UNLOCKED']);

/** Read access is limited to a session holding an established user-admin authority. */
export function canViewUserAdministration(sessionCapabilities: string[]): boolean {
  return USER_ADMIN_VIEW_CAPABILITIES.some((code) => hasCapability(sessionCapabilities, code));
}

function requireUserAdminView(sessionCapabilities: string[]) {
  if (!canViewUserAdministration(sessionCapabilities)) refuse('CAPABILITY_MISSING');
}

/** Input validation shared by create and change. */
const usernameInput = z
  .string()
  .trim()
  .min(3, 'USERNAME_TOO_SHORT')
  .max(40, 'USERNAME_TOO_LONG')
  .refine((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s), {
    message: 'USERNAME_FORMAT',
  });

const fullNameInput = z.string().trim().min(2, 'NAME_TOO_SHORT').max(120, 'NAME_TOO_LONG');

const passwordInput = z.string().min(PASSWORD_MIN, 'PASSWORD_TOO_SHORT');

const createUserInput = z.object({
  client: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, 'CLIENT_FORMAT'),
  username: usernameInput,
  fullName: fullNameInput,
  email: z.string().trim().email('EMAIL_FORMAT').max(200, 'EMAIL_TOO_LONG').optional().or(z.literal('')).nullable(),
  password: passwordInput,
  changedBy: z.string().trim().min(1, 'CHANGED_BY_REQUIRED').max(60),
});

const changeUserInput = z.object({
  client: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, 'CLIENT_FORMAT'),
  userId: z.string().trim().min(1, 'USER_ID_REQUIRED'),
  fullName: fullNameInput.optional(),
  email: z.string().trim().email('EMAIL_FORMAT').max(200, 'EMAIL_TOO_LONG').optional().or(z.literal('')).nullable(),
  isActive: z.boolean().optional(),
  changedBy: z.string().trim().min(1, 'CHANGED_BY_REQUIRED').max(60),
});

const initiateResetInput = z.object({
  client: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, 'CLIENT_FORMAT'),
  userId: z.string().trim().min(1, 'USER_ID_REQUIRED'),
  changedBy: z.string().trim().min(1, 'CHANGED_BY_REQUIRED').max(60),
  ipAddress: z.string().optional(),
});

const requestResetInput = z.object({
  client: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, 'CLIENT_FORMAT'),
  username: z.string().trim().min(1, 'USERNAME_REQUIRED'),
  ipAddress: z.string().optional(),
});

const completeResetInput = z.object({
  client: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, 'CLIENT_FORMAT'),
  token: z.string().trim().min(1, 'TOKEN_REQUIRED'),
  password: passwordInput,
  ipAddress: z.string().optional(),
});

/**
 * Error surface for the user administration service. Callers turn these into
 * action states; the service never masks a refusal as success.
 */
export class UserAdminError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'UserAdminError';
    this.remedy = remedy;
  }
}

const REFUSALS: Record<string, [string, string]> = {
  USERNAME_FORMAT: [
    `A username is 3 to 40 characters: letters, digits, dot, dash or underscore, starting with a letter or digit.`,
    `Correct the username and try again.`,
  ],
  NAME_TOO_SHORT: [`A full name is at least 2 characters.`, `Enter the user's full name.`],
  NAME_TOO_LONG: [`A full name is at most 120 characters.`, `Shorten the name.`],
  EMAIL_FORMAT: [`An email address must contain @ and a domain.`, `Enter a valid email address.`],
  EMAIL_TOO_LONG: [`An email address is at most 200 characters.`, `Shorten the email address.`],
  PASSWORD_TOO_SHORT: [`A password is at least ${PASSWORD_MIN} characters.`, `Make the password longer.`],
  USER_ID_REQUIRED: [`A user must be named.`, `Open the user from the list instead of typing an id.`],
  CLIENT_FORMAT: [`A tenant is the two-to-four-character code from the session.`, `Open the screen from the launchpad; the tenant comes from the session.`],
  CHANGED_BY_REQUIRED: [`The change must name the user who made it.`, `Sign in and try again.`],
  USERNAME_REQUIRED: [`A username is required.`, `Enter a username.`],
  USERNAME_TAKEN: [`That username is already in use in this tenant.`, `Choose a different username.`],
  USER_FILTER_INVALID: [`The user search or status filter is invalid.`, `Adjust the search or filter and try again.`],
  SELF_LOCK: [`You cannot lock your own account.`, `Ask another authorized user administrator to lock this account.`],
  SELF_DEACTIVATE: [`You cannot deactivate your own account.`, `Ask another authorized user administrator to deactivate this account.`],
  TOKEN_REQUIRED: [`A reset token is required.`, `Use the reset link sent to you.`],
  USER_UNKNOWN: [
    `No application user of that name stands in this tenant.`,
    `Check the username or ask an administrator to create the user.`,
  ],
  USER_NOT_FOUND: [
    `No application account matched the request in this tenant.`,
    `Open the account from the user directory and retry.`,
  ],
  USER_INACTIVE: [
    `This account is not active.`,
    `An administrator must activate it before a password can be reset.`,
  ],
  USER_LOCKED: [
    `This account is locked.`,
    `An administrator must unlock it before a password can be reset.`,
  ],
  TOKEN_UNKNOWN: [
    `This reset link is not known.`,
    `Request a new reset.`,
  ],
  TOKEN_EXPIRED: [
    `This reset link has expired.`,
    `Request a new reset.`,
  ],
  TOKEN_USED: [
    `This reset link has already been used.`,
    `Request a new reset.`,
  ],
  TOO_MANY_REQUESTS: [
    `Too many reset requests for this user.`,
    `Wait an hour and try again.`,
  ],
  CAPABILITY_MISSING: [
    `This session does not hold the needed authority.`,
    `Ask an administrator to grant it.`,
  ],
};

function refuse(code: string): never {
  const [message, remedy] = REFUSALS[code] ?? [code, 'Contact your administrator.'];
  throw new UserAdminError(message, remedy);
}

function emailOrNull(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateUserInput {
  client: string;
  username: string;
  fullName: string;
  email?: string | null;
  password: string;
  changedBy: string;
}

export interface UserView {
  id: string;
  client: string;
  username: string;
  fullName: string;
  email: string | null;
  isActive: boolean;
  isLocked: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdBy: string;
  createdAt: string;
  changedBy: string | null;
  changedAt: string | null;
}

/**
 * Create a new application user. Requires CFG.PLT.USER.CREATE.
 *
 * The password is hashed with scrypt and never stored in any reversible form.
 * The account starts active and unlocked, with no password-change requirement.
 */
export async function createUser(input: CreateUserInput, sessionCapabilities: string[]): Promise<UserView> {
  const parsed = createUserInput.safeParse(input);
  if (!parsed.success) refuse('USERNAME_FORMAT');
  const { client, username, fullName, email, password, changedBy } = parsed.data;

  if (!hasCapability(sessionCapabilities, 'CFG.PLT.USER.CREATE')) {
    refuse('CAPABILITY_MISSING');
  }

  const policy = checkPasswordPolicy(password);
  if (policy) refuse('PASSWORD_TOO_SHORT');

  return withTenant(client, async (tx) => {
    // Serialize normalized usernames within this tenant. The unique index remains
    // the final database guard; the advisory lock ensures duplicate concurrent
    // requests receive the same safe, domain-level refusal before any audit work.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cairn/user-create/${client}/${username.toUpperCase()}`}, 0))`);
    const actor = await auditActor(tx, client, changedBy);
    const existing = await tx
      .select({ id: appUser.id })
      .from(appUser)
      .where(and(eq(appUser.client, client), eq(appUser.username, username.toUpperCase())))
      .limit(1);
    if (existing.length > 0) {
      refuse('USERNAME_TAKEN');
    }

    const passwordHash = await hashPassword(password);
    const id = randomUUID();

    await tx.execute(sql`
      insert into app_user
        (id, client, username, full_name, email, password_hash,
         is_active, is_locked, must_change_password, created_by, changed_by)
      values
        (${id}, ${client}, ${username.toUpperCase()}, ${fullName},
         ${emailOrNull(email)}, ${passwordHash},
         true, false, false, ${changedBy}, ${changedBy})
    `);

    await recordChange(tx, {
      client,
      objectClass: 'app_user',
      objectKey: id,
      changeType: 'CREATE',
      changedBy,
      after: { username: username.toUpperCase(), fullName, email: emailOrNull(email), isActive: true, isLocked: false, mustChangePassword: false },
      securityRelevantFields: ['isActive', 'isLocked'],
    });

    await tx.insert(auditAccessLog).values({
      id: randomUUID(), client, userId: actor.id, username: actor.username,
      eventType: 'CONFIG_CHANGE', transactionCode: 'CFG.PLT.USER.CREATE',
      objectType: 'app_user', objectKey: id, detail: 'Application user created',
    });

    const [row] = await tx.select({
      id: appUser.id,
      client: appUser.client,
      username: appUser.username,
      fullName: appUser.fullName,
      email: appUser.email,
      isActive: appUser.isActive,
      isLocked: appUser.isLocked,
      mustChangePassword: appUser.mustChangePassword,
      lastLoginAt: appUser.lastLoginAt,
      createdBy: appUser.createdBy,
      createdAt: appUser.createdAt,
      changedBy: appUser.changedBy,
      changedAt: appUser.changedAt,
    }).from(appUser).where(and(eq(appUser.client, client), eq(appUser.id, id))).limit(1);
    return viewOf(row);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Read / list
// ─────────────────────────────────────────────────────────────────────────────

export interface UserDirectoryRow extends UserView {
  /** Current assignments to active roles; historical assignments are shown in detail. */
  roles: Array<{ code: string; name: string }>;
  hasEmployeeRecord: boolean;
}

export interface UserAdminDetail extends UserView {
  roles: Array<{
    code: string;
    name: string;
    isSystemRole: boolean;
    isRoleActive: boolean;
    validFrom: string;
    validTo: string | null;
    currentlyEffective: boolean;
  }>;
  capabilityPatterns: string[];
  effectiveCapabilities: Array<{
    code: string;
    module: string;
    action: string;
    isPostingRelevant: boolean;
    description: string | null;
  }>;
  organizationRestrictions: OrgRestriction[];
  hasEmployeeRecord: boolean;
}

/**
 * Search/filter application accounts in the authenticated tenant. The service
 * itself enforces the existing user-admin capability family; UI visibility is
 * not the authorization boundary.
 */
export async function listUsers(
  client: string,
  sessionCapabilities: string[],
  query?: string,
  status: UserStatusFilter = 'ALL',
): Promise<UserDirectoryRow[]> {
  requireUserAdminView(sessionCapabilities);
  const parsedQuery = z.string().trim().max(100).optional().safeParse(query);
  const parsedStatus = userStatusFilter.safeParse(status);
  if (!parsedQuery.success || !parsedStatus.success) refuse('USER_FILTER_INVALID');
  const search = parsedQuery.data?.toLowerCase() ?? '';
  const filter = parsedStatus.data;

  return withTenant(client, async (tx) => {
    const predicates = [eq(appUser.client, client)];
    if (search) {
      predicates.push(sql`(
        position(${search} in lower(${appUser.username})) > 0
        or position(${search} in lower(${appUser.fullName})) > 0
        or position(${search} in lower(coalesce(${appUser.email}, ''))) > 0
      )`);
    }
    if (filter === 'ACTIVE') predicates.push(eq(appUser.isActive, true));
    if (filter === 'INACTIVE') predicates.push(eq(appUser.isActive, false));
    if (filter === 'LOCKED') predicates.push(eq(appUser.isLocked, true));
    if (filter === 'UNLOCKED') predicates.push(eq(appUser.isLocked, false));

    const rows = await tx.select({
      id: appUser.id,
      client: appUser.client,
      username: appUser.username,
      fullName: appUser.fullName,
      email: appUser.email,
      isActive: appUser.isActive,
      isLocked: appUser.isLocked,
      mustChangePassword: appUser.mustChangePassword,
      lastLoginAt: appUser.lastLoginAt,
      createdBy: appUser.createdBy,
      createdAt: appUser.createdAt,
      changedBy: appUser.changedBy,
      changedAt: appUser.changedAt,
    }).from(appUser).where(and(...predicates)).orderBy(appUser.username);

    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const assignments = await tx.select({
      userId: userRole.userId,
      code: role.code,
      name: role.name,
    }).from(userRole)
      .innerJoin(role, and(eq(role.client, userRole.client), eq(role.code, userRole.roleCode)))
      .where(and(
        eq(userRole.client, client),
        inArray(userRole.userId, ids),
        eq(role.isActive, true),
        sql`${userRole.validFrom} <= now() and (${userRole.validTo} is null or ${userRole.validTo} >= now())`,
      )).orderBy(userRole.userId, role.code);
    const employeeRows = await tx.select({ appUserId: employee.appUserId }).from(employee)
      .where(and(eq(employee.client, client), inArray(employee.appUserId, ids)));
    const rolesByUser = new Map<string, Array<{ code: string; name: string }>>();
    for (const assignment of assignments) {
      const list = rolesByUser.get(assignment.userId) ?? [];
      list.push({ code: assignment.code, name: assignment.name });
      rolesByUser.set(assignment.userId, list);
    }
    const employeeLinked = new Set(employeeRows.flatMap((row) => row.appUserId ? [row.appUserId] : []));
    return rows.map((row) => ({
      ...viewOf(row),
      roles: rolesByUser.get(row.id) ?? [],
      hasEmployeeRecord: employeeLinked.has(row.id),
    }));
  });
}

/** Full, read-only account inspection without password/session/reset secrets. */
export async function getUserAdminDetails(
  client: string,
  username: string,
  sessionCapabilities: string[],
): Promise<UserAdminDetail | null> {
  requireUserAdminView(sessionCapabilities);
  const parsedUsername = usernameInput.safeParse(username);
  if (!parsedUsername.success) refuse('USER_NOT_FOUND');
  return withTenant(client, async (tx) => {
    const [row] = await tx.select({
      id: appUser.id,
      client: appUser.client,
      username: appUser.username,
      fullName: appUser.fullName,
      email: appUser.email,
      isActive: appUser.isActive,
      isLocked: appUser.isLocked,
      mustChangePassword: appUser.mustChangePassword,
      lastLoginAt: appUser.lastLoginAt,
      createdBy: appUser.createdBy,
      createdAt: appUser.createdAt,
      changedBy: appUser.changedBy,
      changedAt: appUser.changedAt,
    }).from(appUser).where(and(eq(appUser.client, client), eq(appUser.username, parsedUsername.data.toUpperCase()))).limit(1);
    if (!row) return null;

    const now = Date.now();
    const assignments = await tx.select({
      code: role.code,
      name: role.name,
      isSystemRole: role.isSystemRole,
      isRoleActive: role.isActive,
      validFrom: userRole.validFrom,
      validTo: userRole.validTo,
    }).from(userRole)
      .innerJoin(role, and(eq(role.client, userRole.client), eq(role.code, userRole.roleCode)))
      .where(and(eq(userRole.client, client), eq(userRole.userId, row.id)))
      .orderBy(role.code);
    const roles = assignments.map((assignment) => ({
      ...assignment,
      validFrom: assignment.validFrom.toISOString(),
      validTo: assignment.validTo?.toISOString() ?? null,
      currentlyEffective: assignment.isRoleActive
        && assignment.validFrom.getTime() <= now
        && (!assignment.validTo || assignment.validTo.getTime() >= now),
    }));
    const capabilityPatterns = await loadCapabilities(tx, client, row.id);
    const catalogue = await tx.select({
      code: capability.code,
      module: capability.module,
      action: capability.action,
      isPostingRelevant: capability.isPostingRelevant,
      description: capability.description,
    }).from(capability).orderBy(capability.code);
    const effectiveCapabilities = row.isActive && !row.isLocked
      ? catalogue.filter((item) => hasCapability(capabilityPatterns, item.code))
      : [];
    const organizationRestrictions = await loadOrgRestrictions(tx, client, row.id);
    const [employeeRow] = await tx.select({ appUserId: employee.appUserId }).from(employee)
      .where(and(eq(employee.client, client), eq(employee.appUserId, row.id)))
      .limit(1);

    return {
      ...viewOf(row),
      roles,
      capabilityPatterns,
      effectiveCapabilities,
      organizationRestrictions,
      hasEmployeeRecord: Boolean(employeeRow),
    };
  });
}

function viewOf(row: { id: string; client: string; username: string; fullName: string; email: string | null; isActive: boolean; isLocked: boolean; mustChangePassword: boolean; lastLoginAt: Date | null; createdBy: string; createdAt: Date; changedBy: string | null; changedAt: Date | null }): UserView {
  return {
    id: row.id,
    client: row.client,
    username: row.username,
    fullName: row.fullName,
    email: row.email,
    isActive: row.isActive,
    isLocked: row.isLocked,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    changedBy: row.changedBy ?? null,
    changedAt: row.changedAt?.toISOString() ?? null,
  };
}

/** Resolve an audit actor supplied by a trusted server action by id or username. */
async function auditActor(tx: Tx, client: string, actor: string): Promise<{ id: string | null; username: string }> {
  const [row] = await tx.select({ id: appUser.id, username: appUser.username }).from(appUser)
    .where(and(eq(appUser.client, client), or(eq(appUser.id, actor), sql`upper(${appUser.username}) = upper(${actor})`)))
    .limit(1);
  return row ?? { id: null, username: actor.slice(0, 40) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Change
// ─────────────────────────────────────────────────────────────────────────────

export interface ChangeUserInput {
  client: string;
  userId: string;
  fullName?: string;
  email?: string | null;
  isActive?: boolean;
  changedBy: string;
}

/**
 * Change user details. Requires CFG.PLT.USER.MAINTAIN.
 *
 * Only fullName, email and isActive may be changed. HR-owned fields (the
 * employee link) and authentication fields (password hash, lock state) are
 * never touched here — password reset and locking are separate acts.
 *
 * Deactivation revokes every persisted session in the same transaction, so a
 * later reactivation cannot revive an old session. The employee master record
 * is never changed.
 */
export async function changeUser(
  input: ChangeUserInput,
  sessionCapabilities: string[],
): Promise<UserView> {
  const parsed = changeUserInput.safeParse(input);
  if (!parsed.success) refuse('USER_ID_REQUIRED');
  const { client, userId, fullName, email, isActive, changedBy } = parsed.data;

  if (!hasCapability(sessionCapabilities, 'CFG.PLT.USER.MAINTAIN')) {
    refuse('CAPABILITY_MISSING');
  }

  return withTenant(client, async (tx) => {
    const actor = await auditActor(tx, client, changedBy);
    const row = await tx.select({
      id: appUser.id,
      client: appUser.client,
      username: appUser.username,
      fullName: appUser.fullName,
      email: appUser.email,
      isActive: appUser.isActive,
      isLocked: appUser.isLocked,
      mustChangePassword: appUser.mustChangePassword,
      lastLoginAt: appUser.lastLoginAt,
      createdBy: appUser.createdBy,
      createdAt: appUser.createdAt,
      changedBy: appUser.changedBy,
      changedAt: appUser.changedAt,
    }).from(appUser)
      .where(and(eq(appUser.client, client), eq(appUser.id, userId)))
      .limit(1)
      .for('update');
    if (row.length === 0) refuse('USER_NOT_FOUND');
    const current = row[0];
    if (isActive === false && current.isActive && actor.id === userId) {
      refuse('SELF_DEACTIVATE');
    }

    const before = {
      fullName: current.fullName,
      email: current.email,
      isActive: current.isActive,
    };
    const after: Record<string, unknown> = {};
    const changes: Array<{ field: string; before: unknown; after: unknown }> = [];

    if (fullName !== undefined && fullName !== current.fullName) {
      changes.push({ field: 'full_name', before: current.fullName, after: fullName });
      after.fullName = fullName;
    }
    const emailValue = emailOrNull(email);
    if (email !== undefined && emailValue !== current.email) {
      changes.push({ field: 'email', before: current.email, after: emailValue });
      after.email = emailValue;
    }
    if (isActive !== undefined && isActive !== current.isActive) {
      changes.push({ field: 'is_active', before: current.isActive, after: isActive });
      after.isActive = isActive;
    }

    if (changes.length === 0) {
      return viewOf(current);
    }

    const changedAt = new Date();
    await tx.update(appUser).set({
      fullName: fullName ?? current.fullName,
      email: email !== undefined ? emailValue : current.email,
      isActive: isActive ?? current.isActive,
      changedBy,
      changedAt,
    }).where(and(eq(appUser.client, client), eq(appUser.id, userId)));

    if (isActive === false && current.isActive) {
      // Deactivation invalidates the account immediately and revokes old sessions
      // so a later reactivation cannot revive a previously issued cookie.
      await tx.update(userSession).set({ revokedAt: new Date() })
        .where(and(eq(userSession.client, client), eq(userSession.userId, userId), isNull(userSession.revokedAt)));
    }

    await recordChange(tx, {
      client,
      objectClass: 'app_user',
      objectKey: userId,
      changeType: 'CHANGE',
      changedBy,
      before,
      after,
      securityRelevantFields: ['isActive'],
    });

    await tx.insert(auditAccessLog).values({
      id: randomUUID(), client, userId: actor.id, username: actor.username,
      eventType: 'CONFIG_CHANGE', transactionCode: 'CFG.PLT.USER.MAINTAIN',
      objectType: 'app_user', objectKey: userId,
      detail: isActive === false && current.isActive ? 'User deactivated; persisted sessions revoked' : 'User details maintained',
    });

    return viewOf({
      ...current,
      fullName: fullName ?? current.fullName,
      email: email !== undefined ? emailValue : current.email,
      isActive: isActive ?? current.isActive,
      changedBy,
      changedAt,
    });
  });
}

export interface SetUserLockInput {
  client: string;
  userId: string;
  isLocked: boolean;
  changedBy: string;
}

/** Manually lock/unlock an account using the established USER.MAINTAIN authority. */
export async function setUserLocked(
  input: SetUserLockInput,
  sessionCapabilities: string[],
): Promise<UserView> {
  const parsed = z.object({
    client: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/),
    userId: z.string().trim().min(1).max(36),
    isLocked: z.boolean(),
    changedBy: z.string().trim().min(1).max(60),
  }).safeParse(input);
  if (!parsed.success) refuse('USER_ID_REQUIRED');
  const { client, userId, isLocked, changedBy } = parsed.data;
  if (!hasCapability(sessionCapabilities, 'CFG.PLT.USER.MAINTAIN')) refuse('CAPABILITY_MISSING');

  return withTenant(client, async (tx) => {
    const actor = await auditActor(tx, client, changedBy);
    const [current] = await tx.select({
      id: appUser.id,
      client: appUser.client,
      username: appUser.username,
      fullName: appUser.fullName,
      email: appUser.email,
      isActive: appUser.isActive,
      isLocked: appUser.isLocked,
      mustChangePassword: appUser.mustChangePassword,
      lastLoginAt: appUser.lastLoginAt,
      createdBy: appUser.createdBy,
      createdAt: appUser.createdAt,
      changedBy: appUser.changedBy,
      changedAt: appUser.changedAt,
    }).from(appUser).where(and(eq(appUser.client, client), eq(appUser.id, userId))).for('update');
    if (!current) refuse('USER_NOT_FOUND');
    if (isLocked && actor.id === userId) refuse('SELF_LOCK');
    if (current.isLocked === isLocked) return viewOf(current);

    await tx.update(appUser).set({
      isLocked,
      ...(!isLocked ? { failedLoginCount: '0' } : {}),
      changedBy,
      changedAt: new Date(),
    }).where(and(eq(appUser.client, client), eq(appUser.id, userId)));

    if (isLocked) {
      await tx.update(userSession).set({ revokedAt: new Date() })
        .where(and(eq(userSession.client, client), eq(userSession.userId, userId), isNull(userSession.revokedAt)));
    }

    await recordChange(tx, {
      client,
      objectClass: 'app_user',
      objectKey: userId,
      changeType: 'CHANGE',
      changedBy,
      before: { isLocked: current.isLocked },
      after: { isLocked },
      securityRelevantFields: ['isLocked'],
    });
    await tx.insert(auditAccessLog).values({
      id: randomUUID(),
      client,
      userId: actor.id,
      username: actor.username,
      eventType: 'CONFIG_CHANGE',
      transactionCode: 'CFG.PLT.USER.MAINTAIN',
      objectType: 'app_user',
      objectKey: userId,
      detail: isLocked ? 'User account locked; persisted sessions revoked' : 'User account unlocked; failed-login counter reset',
    });

    return viewOf({ ...current, isLocked, changedBy, changedAt: new Date() });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Password reset — administrator-initiated
// ─────────────────────────────────────────────────────────────────────────────

export interface InitiateResetInput {
  client: string;
  userId: string;
  changedBy: string;
  ipAddress?: string | null;
}

export interface ResetTokenOutcome {
  userId: string;
  username: string;
  token: string;
  /** Server-internal only; must never be included in a browser response. */
  expiresAt: string;
}

/**
 * Administrator-initiated password reset. Requires CFG.PLT.USER.PASSWORD_RESET.
 *
 * Generates a single-use reset token, revokes all the user's sessions, and
 * flags the account for a mandatory password change at next sign-in.
 *
 * Does NOT activate a disabled account, does NOT assign roles, does NOT change
 * organisational access, does NOT touch HR-owned data.
 *
 * Server-internal service only. The server action intentionally refuses to
 * call this until an approved delivery channel exists; do not expose this
 * outcome through a page or client action.
 */
export async function initiatePasswordReset(
  input: InitiateResetInput,
  sessionCapabilities: string[],
): Promise<ResetTokenOutcome> {
  const parsed = initiateResetInput.safeParse(input);
  if (!parsed.success) refuse('USER_ID_REQUIRED');
  const { client, userId, changedBy, ipAddress } = parsed.data;

  if (!hasCapability(sessionCapabilities, 'CFG.PLT.USER.PASSWORD_RESET')) {
    refuse('CAPABILITY_MISSING');
  }

  return withTenant(client, async (tx) => {
    const actor = await auditActor(tx, client, changedBy);
    const [current] = await tx.select({
      id: appUser.id,
      username: appUser.username,
      isActive: appUser.isActive,
      isLocked: appUser.isLocked,
    }).from(appUser).where(and(eq(appUser.client, client), eq(appUser.id, userId))).for('update');
    if (!current) refuse('USER_NOT_FOUND');

    // A locked or inactive account cannot be reset through this path —
    // unlocking and activation are separate administrator acts.
    if (!current.isActive) refuse('USER_INACTIVE');
    if (current.isLocked) refuse('USER_LOCKED');

    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000);
    const tokenId = randomUUID();

    await tx.execute(sql`
      insert into password_reset_token
        (id, client, user_id, token_hash, expires_at, created_by, ip_address)
      values (${tokenId}, ${client}, ${userId}, ${tokenHash},
        ${expiresAt.toISOString()}, ${changedBy}, ${ipAddress ?? null})
    `);

    // Revoke every live session — the old password must not remain usable.
    await tx.execute(sql`
      update user_session
         set revoked_at = now()
       where client = ${client}
         and user_id = ${userId}
         and revoked_at is null
    `);

    // Flag for mandatory password change at next sign-in.
    await tx.execute(sql`
      update app_user
         set must_change_password = true,
             changed_by = ${changedBy},
             changed_at = now()
       where client = ${client} and id = ${userId}
    `);

    await recordChange(tx, {
      client,
      objectClass: 'app_user',
      objectKey: userId,
      changeType: 'CHANGE',
      changedBy,
      before: { mustChangePassword: false },
      after: { mustChangePassword: true },
      securityRelevantFields: ['mustChangePassword'],
    });

    await tx.insert(auditAccessLog).values({
      id: randomUUID(), client, userId: actor.id, username: actor.username,
      eventType: 'CONFIG_CHANGE', transactionCode: 'CFG.PLT.USER.PASSWORD_RESET',
      objectType: 'app_user', objectKey: userId, detail: 'Administrator-initiated password reset',
      ipAddress: ipAddress ?? null,
    });

    return {
      userId: current.id,
      username: current.username,
      token,
      expiresAt: expiresAt.toISOString(),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Password reset — self-service request
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestResetInput {
  client: string;
  username: string;
  ipAddress?: string | null;
}

export interface RequestResetOutcome {
  /** Always true — never reveals whether the user exists. */
  accepted: boolean;
}

/**
 * Self-service password reset request. No capability required — any username
 * may be submitted. The same outcome is returned whether the user exists,
 * so no username enumeration is possible through this screen.
 *
 * When the user exists and is active and unlocked, a short-lived token hash is
 * recorded. D-033 leaves delivery unavailable: the plaintext token is never
 * written to the audit log or returned to this public caller, so the UI directs
 * the user to the organization's approved support path.
 */
export async function requestPasswordReset(
  input: RequestResetInput,
): Promise<RequestResetOutcome> {
  const parsed = requestResetInput.safeParse(input);
  if (!parsed.success) return { accepted: true };
  const { client, username, ipAddress } = parsed.data;

  return withTenant(client, async (tx) => {
    // Serialize requests for this (client, normalized username) through the
    // count-and-insert transaction. Without the transaction-scoped advisory
    // lock, simultaneous requests can all observe the same count and exceed
    // the per-hour limit before any of them inserts its token.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext(${username.toUpperCase()}))`);

    // Rate limit: count requests for this username in the last hour.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = await tx
      .select({ count: sql`count(*)::int` })
      .from(passwordResetToken)
      .where(
        and(
          eq(passwordResetToken.client, client),
          gt(passwordResetToken.createdAt, new Date(hourAgo)),
          sql`password_reset_token.user_id in (
            select id from app_user where client = ${client} and username ILIKE ${username.toUpperCase()}
          )`,
        ),
      )
      .limit(1);
    const count = Number(recent[0]?.count ?? 0);
    if (count >= MAX_RESET_REQUESTS_PER_HOUR) {
      // Same accepted=true shape — never reveal why.
      return { accepted: true };
    }

    const row = await tx
      .select({ id: appUser.id, username: appUser.username, isActive: appUser.isActive, isLocked: appUser.isLocked })
      .from(appUser)
      .where(and(eq(appUser.client, client), sql`app_user.username ILIKE ${username.toUpperCase()}`))
      .limit(1);

    if (row.length === 0) {
      // Never reveals that the user does not exist.
      return { accepted: true };
    }
    const user = row[0];

    if (!user.isActive || user.isLocked) {
      // Never reveals that the user exists but is disabled.
      return { accepted: true };
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000);
    const tokenId = randomUUID();

    await tx.execute(sql`
      insert into password_reset_token
        (id, client, user_id, token_hash, expires_at, created_by, ip_address)
      values (${tokenId}, ${client}, ${user.id}, ${tokenHash},
        ${expiresAt.toISOString()}, 'SELF_SERVICE', ${ipAddress ?? null})
    `);

    await tx.execute(sql`
      insert into audit_access_log
        (id, client, user_id, username, event_type, detail, ip_address)
      values (${randomUUID()}, ${client}, ${user.id}, ${user.username}, 'CONFIG_CHANGE',
        'Self-service password reset requested', ${ipAddress ?? null})
    `);

    return { accepted: true };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Password reset — complete with token
// ─────────────────────────────────────────────────────────────────────────────

export interface CompleteResetInput {
  client: string;
  token: string;
  password: string;
  ipAddress?: string | null;
}

export interface CompleteResetOutcome {
  userId: string;
  username: string;
}

/**
 * Complete a password reset using a single-use token.
 *
 * No capability is required — the unguessable token is the authorization.
 * The token is consumed, all sessions are revoked, and mustChangePassword is
 * cleared so the user can sign in with the new password.
 *
 * Does NOT activate a disabled account, does NOT assign roles, does NOT change
 * organisational access, does NOT touch HR-owned data.
 */
export async function completePasswordReset(
  input: CompleteResetInput,
): Promise<CompleteResetOutcome> {
  const parsed = completeResetInput.safeParse(input);
  if (!parsed.success) {
    // Map the first Zod field error to the appropriate refusal code.
    const issues = parsed.error.issues;
    const clientIssue = issues.find((i) => i.path.includes('client'));
    const tokenIssue = issues.find((i) => i.path.includes('token'));
    const passwordIssue = issues.find((i) => i.path.includes('password'));
    if (clientIssue) refuse('CLIENT_FORMAT');
    if (tokenIssue) refuse('TOKEN_REQUIRED');
    if (passwordIssue) refuse('PASSWORD_TOO_SHORT');
    refuse('TOKEN_REQUIRED');
  }
  const { client, token, password, ipAddress } = parsed.data;

  const policy = checkPasswordPolicy(password);
  if (policy) refuse('PASSWORD_TOO_SHORT');

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const now = new Date().toISOString();

  return withTenant(client, async (tx) => {
    const row = await tx
      .select()
      .from(passwordResetToken)
      .where(
        and(
          eq(passwordResetToken.client, client),
          eq(passwordResetToken.tokenHash, tokenHash),
          isNull(passwordResetToken.usedAt),
          gt(passwordResetToken.expiresAt, sql`${now}`),
        ),
      )
      .limit(1);

    if (row.length === 0) {
      // Same refusal whether token is unknown, expired, or used — no enumeration.
      refuse('TOKEN_UNKNOWN');
    }

    const tokenRow = row[0];

    // The user must be active — a disabled account cannot self-activate through a reset.
    const userRow = await tx
      .select({ id: appUser.id, username: appUser.username, isActive: appUser.isActive })
      .from(appUser)
      .where(and(eq(appUser.client, client), eq(appUser.id, tokenRow.userId)))
      .limit(1);

    if (userRow.length === 0 || !userRow[0].isActive) {
      refuse('USER_INACTIVE');
    }

    const user = userRow[0];

    // Consume the token atomically — the used_at IS NULL guard ensures a
    // concurrent request cannot also consume this token. If zero rows were
    // updated, another request already consumed it.
    const consumed = await tx
      .update(passwordResetToken)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetToken.id, tokenRow.id),
          isNull(passwordResetToken.usedAt),
        ),
      )
      .returning({ id: passwordResetToken.id });
    if (consumed.length === 0) {
      refuse('TOKEN_USED');
    }

    // Set the new password.
    const passwordHash = await hashPassword(password);
    await tx.execute(sql`
      update app_user
         set password_hash = ${passwordHash},
             must_change_password = false,
             changed_by = 'SELF_SERVICE',
             changed_at = now()
       where client = ${client} and id = ${user.id}
    `);

    // Revoke every live session — the old password must not remain usable.
    await tx.execute(sql`
      update user_session
         set revoked_at = now()
       where client = ${client}
         and user_id = ${user.id}
         and revoked_at is null
    `);

    await recordChange(tx, {
      client,
      objectClass: 'app_user',
      objectKey: user.id,
      changeType: 'CHANGE',
      changedBy: 'SELF_SERVICE',
      before: { mustChangePassword: true },
      after: { mustChangePassword: false, passwordChanged: true },
      securityRelevantFields: ['mustChangePassword'],
    });

    await tx.execute(sql`
      insert into audit_access_log
        (id, client, user_id, username, event_type, detail, ip_address)
      values (${randomUUID()}, ${client}, ${user.id}, ${user.username}, 'CONFIG_CHANGE',
        'Password reset completed', ${ipAddress ?? null})
    `);

    return { userId: user.id, username: user.username };
  });
}