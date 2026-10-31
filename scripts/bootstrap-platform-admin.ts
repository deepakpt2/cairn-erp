/**
 * One-time deployment-owner bootstrap for the tenant-local PLATFORM_ADMIN role.
 * This is an operator CLI, never an HTTP action or test/seed bypass. All routine
 * role administration requires a validated live application session.
 */
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { validateTarget } from '../src/platform/db/target-guard';
import { closeDb, withTenant } from '../src/platform/db/client';
import { recordChange } from '../src/platform/change';
import { auditAccessLog, appUser, capability, role, roleCapability, userRole, userSession } from '../src/platform/tables/security';
import { changeDocument } from '../src/platform/tables/audit-trail';
import { PLATFORM_ADMIN_ROLE_CODE, ROLE_MAINTAIN_CAPABILITY, USER_ROLE_MAINTAIN_CAPABILITY } from '../src/modules/platform/role-admin';

const CLIENT = process.env.CAIRN_PLATFORM_BOOTSTRAP_TENANT ?? '';
const USER_ID = process.env.CAIRN_PLATFORM_BOOTSTRAP_USER_ID ?? '';
const ACTOR = process.env.CAIRN_PLATFORM_BOOTSTRAP_ACTOR ?? '';
const TRANSACTION_CODE = 'CFG.PLT.PLATFORM_ADMIN.BOOTSTRAP';

function fail(message: string): never { throw new Error(message); }

function readOwnerConfirmation(): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Bootstrap requires an interactive terminal so the owner token can be entered without echo.'));
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = '';
    process.stdout.write('Deployment-owner bootstrap token (input hidden): ');
    input.setRawMode(true);
    input.resume();
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) { cleanup(); reject(new Error('Bootstrap cancelled.')); return; }
        if (byte === 13 || byte === 10) { cleanup(); process.stdout.write('\n'); resolve(value); return; }
        if (byte === 8 || byte === 127) { value = value.slice(0, -1); continue; }
        if (byte >= 32 && byte <= 126 && value.length < 256) value += String.fromCharCode(byte);
      }
    };
    const cleanup = () => { input.off('data', onData); input.setRawMode(false); input.pause(); };
    input.on('data', onData);
  });
}

export function platformBootstrapTokenMatches(configured: string, supplied: string): boolean {
  if (configured.length < 32 || supplied.length < 32 || supplied.length > 256) return false;
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(configured), hash(supplied));
}

function assertConfiguration(suppliedToken: string) {
  if (!process.env.DATABASE_URL) fail('DATABASE_URL must name the authorized runtime database explicitly.');
  if (!/^[A-Za-z0-9]{2,4}$/.test(CLIENT)) fail('CAIRN_PLATFORM_BOOTSTRAP_TENANT must be a valid tenant key.');
  if (!/^[A-Za-z0-9-]{8,36}$/.test(USER_ID)) fail('CAIRN_PLATFORM_BOOTSTRAP_USER_ID must identify an existing tenant user.');
  if (!/^[A-Za-z0-9_.@-]{1,60}$/.test(ACTOR)) fail('CAIRN_PLATFORM_BOOTSTRAP_ACTOR must be a non-secret operator identifier of at most 60 safe characters.');
  const configured = process.env.CAIRN_PLATFORM_BOOTSTRAP_TOKEN ?? '';
  if (!platformBootstrapTokenMatches(configured, suppliedToken)) {
    fail('Deployment-owner bootstrap authorization was not accepted; a separately configured high-entropy token is required.');
  }
}

async function bootstrap() {
  assertConfiguration(await readOwnerConfirmation());
  const databaseName = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, '');
  await validateTarget(databaseName, undefined, process.env.DATABASE_URL);

  await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cairn/platform-admin-bootstrap/${CLIENT}`}, 0))`);
    const [alreadyBootstrapped] = await tx.select({ id: changeDocument.id }).from(changeDocument)
      .where(and(eq(changeDocument.client, CLIENT), eq(changeDocument.objectClass, 'platform_admin_bootstrap'))).limit(1).for('share');
    if (alreadyBootstrapped) fail(`Tenant ${CLIENT} has already completed its deployment-owner platform-admin bootstrap.`);
    const [existingRole] = await tx.select({ code: role.code }).from(role)
      .where(and(eq(role.client, CLIENT), eq(role.code, PLATFORM_ADMIN_ROLE_CODE))).for('update');
    if (existingRole) fail(`Tenant ${CLIENT} already has the protected ${PLATFORM_ADMIN_ROLE_CODE} role; bootstrap is not repeatable.`);

    const registeredAuthorities = await tx.select({ code: capability.code }).from(capability).where(sql`${capability.code} in (${ROLE_MAINTAIN_CAPABILITY}, ${USER_ROLE_MAINTAIN_CAPABILITY})`);
    if (registeredAuthorities.length !== 2) fail('Required platform-administration capabilities are not registered; apply the approved migrations first.');

    const [target] = await tx.select({ id: appUser.id, username: appUser.username, fullName: appUser.fullName, isActive: appUser.isActive, isLocked: appUser.isLocked })
      .from(appUser).where(and(eq(appUser.client, CLIENT), eq(appUser.id, USER_ID))).for('update');
    if (!target) fail('The nominated user does not exist in the selected tenant.');
    if (target.username.trim().toLowerCase() === ACTOR.trim().toLowerCase()) fail('The deployment-owner operator cannot bootstrap their own account; nominate a separate user.');
    if (!target.isActive || target.isLocked) fail('The nominated user must be active and unlocked.');
    const liveSessions = await tx.select({ id: userSession.id }).from(userSession).where(and(
      eq(userSession.client, CLIENT), eq(userSession.userId, USER_ID), sql`${userSession.revokedAt} is null`, sql`${userSession.expiresAt} > now()`,
    )).limit(1).for('share');
    if (!liveSessions.length) fail('The nominated user must have a currently live persisted application session.');

    const now = new Date();
    await tx.insert(role).values({
      client: CLIENT,
      code: PLATFORM_ADMIN_ROLE_CODE,
      name: 'Platform administrator',
      description: 'Deployment-owner bootstrapped tenant-local role administration. This is not a global identity and is not the tenant wildcard administrator.',
      isSystemRole: true,
      isReadOnly: false,
      isActive: true,
      createdBy: ACTOR,
    });
    await tx.insert(roleCapability).values([
      { client: CLIENT, roleCode: PLATFORM_ADMIN_ROLE_CODE, capabilityCode: ROLE_MAINTAIN_CAPABILITY, createdBy: ACTOR },
      { client: CLIENT, roleCode: PLATFORM_ADMIN_ROLE_CODE, capabilityCode: USER_ROLE_MAINTAIN_CAPABILITY, createdBy: ACTOR },
    ]);
    await tx.insert(userRole).values({ client: CLIENT, userId: USER_ID, roleCode: PLATFORM_ADMIN_ROLE_CODE, validFrom: now, createdBy: ACTOR });

    await recordChange(tx, {
      client: CLIENT,
      objectClass: 'platform_admin_bootstrap',
      objectKey: `${CLIENT}/${USER_ID}`,
      changeType: 'CREATE',
      transactionCode: TRANSACTION_CODE,
      changedBy: ACTOR,
      before: undefined,
      after: { tenant: CLIENT, targetUserId: USER_ID, targetUsername: target.username, roleCode: PLATFORM_ADMIN_ROLE_CODE, authorities: [ROLE_MAINTAIN_CAPABILITY, USER_ROLE_MAINTAIN_CAPABILITY], bootstrappedBy: ACTOR },
      securityRelevantFields: ['targetUserId', 'roleCode', 'authorities'],
    });
    await tx.insert(auditAccessLog).values({
      id: randomUUID(),
      client: CLIENT,
      userId: null,
      username: ACTOR,
      eventType: 'CONFIG_CHANGE',
      transactionCode: TRANSACTION_CODE,
      objectType: 'platform_admin_bootstrap',
      objectKey: `${CLIENT}/${USER_ID}`,
      detail: `Deployment owner ${ACTOR} bootstrapped tenant-local ${PLATFORM_ADMIN_ROLE_CODE} for ${target.username} (${USER_ID}).`,
    });
  });
  await closeDb();
  console.log(`Bootstrapped tenant-local ${PLATFORM_ADMIN_ROLE_CODE} for the nominated account in tenant ${CLIENT}. The account must sign out and back in to refresh session authority.`);
}

if (basename(process.argv[1] ?? '') === 'bootstrap-platform-admin.ts') {
  bootstrap().catch(async (error: unknown) => {
    console.error(`Platform administrator bootstrap refused: ${error instanceof Error ? error.message : 'unknown error'}`);
    await closeDb();
    process.exitCode = 1;
  });
}
