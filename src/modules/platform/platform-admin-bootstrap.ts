/**
 * Creation of the tenant-local PLATFORM_ADMIN role.
 *
 * This role cannot be created through routine administration: role-admin.ts refuses to
 * grant CFG.PLT.ROLE.MAINTAIN or CFG.PLT.USER.ROLE.MAINTAIN to any role (see the
 * protected-authority guards there), and every routine role mutation requires a live
 * session that already holds this role. It therefore has to be created once by a
 * trusted path, at a moment that is itself gated.
 *
 * Two trusted paths exist, and they share this helper so their idea of what a platform
 * administrator is cannot drift apart:
 *
 *   - tenant creation, where the deployment owner has just proved they hold the owner
 *     token, and the first user of the new tenant becomes its platform administrator;
 *   - scripts/bootstrap-platform-admin.ts, the deployment-owner CLI that nominates a
 *     platform administrator in a tenant created before this role existed.
 *
 * This module does not widen a runtime check. It writes the same rows the CLI always
 * wrote, in the same tables, with the same change document and the same audit record.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import type { Tx } from '../../platform/db/client';
import { auditAccessLog, role, roleCapability, userRole } from '../../platform/tables/security';
import {
  PLATFORM_ADMIN_ROLE_CODE,
  ROLE_MAINTAIN_CAPABILITY,
  USER_ROLE_MAINTAIN_CAPABILITY,
} from './role-admin';

/** Re-exported so callers name the role without reaching past this module. */
export { PLATFORM_ADMIN_ROLE_CODE };

/** createUser will not accept a caller without this. */
export const PLATFORM_ADMIN_USER_CREATE_CAPABILITY = 'CFG.PLT.USER.CREATE';
/** The organisation-scope service will not grant company or plant access without this. */
export const PLATFORM_ADMIN_USER_MAINTAIN_CAPABILITY = 'CFG.PLT.USER.MAINTAIN';

/**
 * The authorities a platform administrator holds.
 *
 * ROLE.MAINTAIN and USER.ROLE.MAINTAIN are the two this role has always carried. The
 * user ones were added because a platform administrator is expected to create the
 * tenant's administrator and to give it company and plant access, and neither
 * createUser nor the scope service would otherwise accept the call. There is no
 * CFG.PLT.USER.UPDATE code in the capability catalogue; CFG.PLT.USER.MAINTAIN is the
 * registered code for maintaining an existing user.
 */
export const PLATFORM_ADMIN_CAPABILITIES: readonly string[] = [
  ROLE_MAINTAIN_CAPABILITY,
  USER_ROLE_MAINTAIN_CAPABILITY,
  PLATFORM_ADMIN_USER_CREATE_CAPABILITY,
  PLATFORM_ADMIN_USER_MAINTAIN_CAPABILITY,
];

export const PLATFORM_ADMIN_BOOTSTRAP_TRANSACTION_CODE = 'CFG.PLT.PLATFORM_ADMIN.BOOTSTRAP';
export const PLATFORM_ADMIN_BOOTSTRAP_OBJECT_CLASS = 'platform_admin_bootstrap';

export interface PlatformAdminBootstrapInput {
  client: string;
  userId: string;
  /** Target username, recorded in the audit trail. */
  username: string;
  /** Operator identity recorded on the role and on the audit rows. */
  actor: string;
}

export interface PlatformAdminBootstrapResult {
  roleCreated: boolean;
  capabilitiesGranted: number;
}

/**
 * Ensure the role exists with its full authority set, assign it to exactly one user,
 * and record the bootstrap.
 *
 * Must run inside the tenant transaction that owns the user. The role and its
 * capabilities are idempotent, so a tenant whose role was created by the migration for
 * pre-existing tenants is topped up rather than duplicated; the assignment is not
 * idempotent, because granting this role a second time is never a routine event.
 */
export async function bootstrapPlatformAdminInTransaction(
  tx: Tx,
  input: PlatformAdminBootstrapInput,
): Promise<PlatformAdminBootstrapResult> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`cairn/platform-admin-bootstrap/${input.client}`}, 0))`,
  );

  const [existingRole] = await tx
    .select({ code: role.code })
    .from(role)
    .where(and(eq(role.client, input.client), eq(role.code, PLATFORM_ADMIN_ROLE_CODE)))
    .for('update');
  const roleCreated = !existingRole;

  if (!existingRole) {
    await tx.insert(role).values({
      client: input.client,
      code: PLATFORM_ADMIN_ROLE_CODE,
      name: 'Platform administrator',
      description:
        'Tenant-local role and user-role administration. This is not a global identity and is not the tenant wildcard administrator.',
      isSystemRole: true,
      isReadOnly: false,
      isActive: true,
      createdBy: input.actor,
    });
  }

  let capabilitiesGranted = 0;
  for (const capabilityCode of PLATFORM_ADMIN_CAPABILITIES) {
    const inserted = await tx
      .insert(roleCapability)
      .values({
        client: input.client,
        roleCode: PLATFORM_ADMIN_ROLE_CODE,
        capabilityCode,
        createdBy: input.actor,
      })
      .onConflictDoNothing()
      .returning({ capabilityCode: roleCapability.capabilityCode });
    capabilitiesGranted += inserted.length;
  }

  const [existingAssignment] = await tx
    .select({ userId: userRole.userId })
    .from(userRole)
    .where(
      and(
        eq(userRole.client, input.client),
        eq(userRole.userId, input.userId),
        eq(userRole.roleCode, PLATFORM_ADMIN_ROLE_CODE),
      ),
    )
    .for('share');
  if (existingAssignment) {
    throw new Error(
      `User ${input.username} already holds ${PLATFORM_ADMIN_ROLE_CODE}; the bootstrap is not repeatable.`,
    );
  }

  await tx.insert(userRole).values({
    client: input.client,
    userId: input.userId,
    roleCode: PLATFORM_ADMIN_ROLE_CODE,
    validFrom: new Date(),
    createdBy: input.actor,
  });

  await recordChange(tx, {
    client: input.client,
    objectClass: PLATFORM_ADMIN_BOOTSTRAP_OBJECT_CLASS,
    objectKey: `${input.client}/${input.userId}`,
    changeType: 'CREATE',
    transactionCode: PLATFORM_ADMIN_BOOTSTRAP_TRANSACTION_CODE,
    changedBy: input.actor,
    before: undefined,
    after: {
      tenant: input.client,
      targetUserId: input.userId,
      targetUsername: input.username,
      roleCode: PLATFORM_ADMIN_ROLE_CODE,
      authorities: [...PLATFORM_ADMIN_CAPABILITIES],
      bootstrappedBy: input.actor,
    },
    securityRelevantFields: ['targetUserId', 'roleCode', 'authorities'],
  });

  await tx.insert(auditAccessLog).values({
    id: randomUUID(),
    client: input.client,
    userId: null,
    username: input.actor,
    eventType: 'CONFIG_CHANGE',
    transactionCode: PLATFORM_ADMIN_BOOTSTRAP_TRANSACTION_CODE,
    objectType: PLATFORM_ADMIN_BOOTSTRAP_OBJECT_CLASS,
    objectKey: `${input.client}/${input.userId}`,
    detail: `${input.actor} granted tenant-local ${PLATFORM_ADMIN_ROLE_CODE} to ${input.username} (${input.userId}).`,
  });

  return { roleCreated, capabilitiesGranted };
}
