/** Pure fail-closed guards shared by the CLI and its trusted provisioning service. */
export const WALKTHROUGH_INSTALL_OPERATION = 'WALKTHROUGH_SEED_V1';
export const WALKTHROUGH_INSTALL_OBJECT_CLASS = 'walkthrough_installation';
export const WALKTHROUGH_INSTALL_REASON = 'Trusted development-only installation of the complete Cairn walkthrough.';

export interface WalkthroughScopeSnapshot {
  id: string;
  userId: string;
  scopeType: string;
  scopeValue: string;
  createdBy: string;
}

export function assertFreshWalkthroughTenantInventory(count: number, actualClient: string | undefined, expectedClient: string): void {
  if (count !== 1 || actualClient !== expectedClient) {
    throw new Error(`Fresh walkthrough installation requires exactly one tenant, ${expectedClient}; found ${count} tenant(s).`);
  }
}

export function assertFreshWalkthroughFirstAdmin(input: {
  users: Array<{ id: string; username: string; isActive: boolean; isLocked: boolean; mustChangePassword: boolean }>;
  expectedUsername: string;
  roleAssignments: Array<{ userId: string; roleCode: string }>;
  scopeCount: number;
}): void {
  const user = input.users[0];
  if (input.users.length !== 1 || user?.username !== input.expectedUsername || !user.isActive || user.isLocked || user.mustChangePassword) {
    throw new Error('Fresh walkthrough installation requires the single active first administrator in a usable password state.');
  }
  if (input.roleAssignments.length !== 1 || input.roleAssignments[0]?.userId !== user.id || input.roleAssignments[0]?.roleCode !== 'ADMINISTRATOR') {
    throw new Error('Fresh walkthrough installation requires the first administrator to hold only the initial ADMINISTRATOR assignment.');
  }
  if (input.scopeCount !== 0) throw new Error('Fresh walkthrough installation found pre-existing Company/Plant or other organisation scopes; refusing to adopt them.');
}

export function assertWalkthroughScopeSet(
  rows: WalkthroughScopeSnapshot[],
  actorUserId: string,
  username: string,
  companyScopeId: string,
  plantScopeId: string,
): void {
  if (rows.length !== 2 || rows.some((row) => row.userId !== actorUserId || row.createdBy !== username) ||
      !rows.some((row) => row.id === companyScopeId && row.scopeType === 'COMPANY_CODE' && row.scopeValue === '1000') ||
      !rows.some((row) => row.id === plantScopeId && row.scopeType === 'PLANT' && row.scopeValue === '1000')) {
    throw new Error('Persisted organisation scopes do not exactly match the audited walkthrough grants; refusing to continue.');
  }
}

export function assertWalkthroughCheckpointRequest(checkpoint: {
  operation: string; client: string; database: string; asOf: string;
}, requested: { operation: string; client: string; database: string; asOf: string }): void {
  if (checkpoint.operation !== requested.operation || checkpoint.client !== requested.client ||
      checkpoint.database !== requested.database || checkpoint.asOf !== requested.asOf) {
    throw new Error('A walkthrough installation checkpoint already exists for a different database, tenant, seed date, or payload; date/payload replay protection refused this run.');
  }
}

export function assertWalkthroughCheckpointActor(checkpoint: { actorUserId: string; username: string }, actor: { userId: string; username: string }): void {
  if (checkpoint.actorUserId !== actor.userId || checkpoint.username !== actor.username) {
    throw new Error('The walkthrough checkpoint belongs to a different first administrator; refusing replay under another identity.');
  }
}

const FORBIDDEN_WALKTHROUGH_DATABASES = new Set([
  'cairn_b210',
  'cairn_hr_accept',
  'cairn_demo',
  'cairn_acceptance',
  'cairn_integration',
]);

/** Validate the explicit database and URL before any target guard or pooled connection is used. */
export function assertWalkthroughDatabaseTarget(database: string, databaseUrl: string | undefined): void {
  if (!database || !/^[a-z0-9_]{1,63}$/.test(database)) {
    throw new Error('CAIRN_SEED_DATABASE must be a valid lowercase database name.');
  }
  if (FORBIDDEN_WALKTHROUGH_DATABASES.has(database.toLowerCase())) {
    throw new Error(`Walkthrough installation refuses protected or persistent database ${database}. Use a disposable development database.`);
  }
  if (!/^cairn_migration_test_[0-9]{8}_[a-z0-9][a-z0-9_-]*$/.test(database)) {
    throw new Error('Walkthrough installation requires the documented uniquely named disposable database pattern cairn_migration_test_YYYYMMDD_<run-id>.');
  }
  if (!databaseUrl) throw new Error('DATABASE_URL is required for walkthrough installation.');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is invalid; no database connection was attempted.');
  }
  let targetDatabase: string;
  let username: string;
  try {
    targetDatabase = decodeURIComponent(url.pathname.slice(1));
    username = decodeURIComponent(url.username);
  } catch {
    throw new Error('DATABASE_URL has invalid encoded components; no database connection was attempted.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || targetDatabase !== database) {
    throw new Error('DATABASE_URL must resolve to exactly CAIRN_SEED_DATABASE; no database connection was attempted.');
  }
  if (username !== 'cairn_app') {
    throw new Error('Walkthrough installation requires DATABASE_URL to use the cairn_app runtime role.');
  }
}

/** Runtime-boundary check: this trusted route exists only in the seed CLI, never in an HTTP worker. */
export function assertWalkthroughSeedRuntime(input: { client: string; database: string; username: string }): void {
  const entrypoint = (process.argv[1] ?? '').replace(/\\/g, '/');
  if (process.env.CAIRN_ENV !== 'development' || !entrypoint.endsWith('/walkthrough-seed.ts') && entrypoint !== 'walkthrough-seed.ts') {
    throw new Error('Trusted walkthrough provisioning is available only from the development walkthrough-seed.ts CLI.');
  }
  if (process.env.CAIRN_SEED_TENANT?.toUpperCase() !== input.client ||
      process.env.CAIRN_SEED_DATABASE !== input.database ||
      process.env.CAIRN_SEED_USERNAME !== input.username) {
    throw new Error('Trusted walkthrough provisioning runtime identity does not match the validated seed inputs.');
  }
  assertWalkthroughDatabaseTarget(input.database, process.env.DATABASE_URL);
}
