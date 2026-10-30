/**
 * Database target safety guard — CAIRN.md §22.8
 *
 * Prevents migrations, seeders, fixture setup, cleanup, and destructive tests
 * from modifying the wrong database. The defect this guards against: a
 * database-changing operation that resolves its target through
 * `process.env.DATABASE_URL` or a hard-coded default can silently connect to a
 * protected acceptance database instead of the intended development or scratch
 * database.
 *
 * The guard requires an explicit, validated target, connects to it using
 * application credentials, confirms the actual connected database identity via
 * `SELECT current_database()`, and only then confirms the target is safe.
 * Protected databases are refused unless an explicit, documented authorization
 * is supplied.
 *
 * Read-only diagnostics are unaffected — they use `directSql()` directly
 * without the guard.
 *
 * ## Protected databases
 *
 * The following databases are protected from ordinary database-changing
 * operations:
 *
 *   - `cairn_b210` — protected browser-acceptance database. Never reset,
 *     never given fixture tenants, never ledger-changed for routine testing.
 *
 * Additional protected names can be added through `registerProtected()`.
 *
 * ## Authorization for protected databases
 *
 * A protected database may only be targeted when the caller supplies an
 * authorization token that matches `process.env.CAIRN_DB_AUTHORIZATION_TOKEN`
 * and names the exact database. This is the documented mechanism for
 * legitimate acceptance procedures that need to write to a protected database.
 * Without both the token and the exact database name, the operation fails
 * closed.
 *
 * ## Scratch databases
 *
 * Disposable scratch databases are safe targets: they are not in the protected
 * list, they are created and destroyed by the operator, and they carry no
 * acceptance data. Use `scripts/test-db.ts` to create one, then pass its name
 * explicitly as the target.
 *
 * ## How to use
 *
 * In any database-changing script (migration runner, seeder, reset script,
 * bootstrap, test setup), replace:
 *
 *   const connectionString = process.env.MIGRATION_DATABASE_URL ?? ...;
 *   const client = postgres(connectionString, ...);
 *
 * with:
 *
 *   import { validateTarget } from '@/platform/db/target-guard';
 *   const validated = await validateTarget(
 *     process.env.MIGRATION_DATABASE_DB_NAME,
 *     { token, database, reason } // only needed for protected databases
 *   );
 *   const client = postgres(yourOwnConnectionStringFor(validated.database), ...);
 *
 * @module
 */
import postgres from 'postgres';

/** Databases that must never be modified by ordinary operations. */
const PROTECTED_DATABASES = new Set<string>(['cairn_b210']);

/** Register an additional protected database name. */
export function registerProtected(databaseName: string): void {
  PROTECTED_DATABASES.add(databaseName);
}

/** Check whether a database name is protected. */
export function isProtected(databaseName: string): boolean {
  return PROTECTED_DATABASES.has(databaseName);
}

/** The authorization context required to target a protected database. */
export interface DbAuthorization {
  /** Token that must match CAIRN_DB_AUTHORIZATION_TOKEN. */
  token: string;
  /** Exact database name being authorized. Must match the target. */
  database: string;
  /** Human-readable reason for the authorization (logged). */
  reason: string;
}

/** Result of a successful target validation. */
export interface ValidatedTarget {
  /** The database name that was requested and confirmed. */
  database: string;
  /** Whether the database is protected. */
  protected: boolean;
}

/** Database connection credentials for identity verification (app role). Never printed. */
function verifyCredentials(connectionString?: string): {
  user: string;
  password: string;
  host: string;
  port: number;
} {
  if (connectionString) {
    // Use the supplied connection string's credentials — host, port, user,
    // and password all come from the connection string. Never use owner
    // credentials for verification.
    const url = new URL(connectionString);
    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      host: url.hostname,
      port: Number(url.port ?? 5432),
    };
  }
  return {
    user: process.env.CAIRN_DB_USER ?? 'cairn_app',
    password: process.env.CAIRN_DB_PASSWORD ?? 'cairn_app_dev',
    host: process.env.CAIRN_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.CAIRN_DB_PORT ?? '5432'),
  };
}

/** Build a verification connection string for a database name. */
function verificationConnectionStringFor(
  database: string,
  connectionString?: string,
): string {
  const { user, password, host, port } = verifyCredentials(connectionString);
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

/** Resolve the authorization token from the environment. Never printed. */
function expectedAuthorizationToken(): string | undefined {
  return process.env.CAIRN_DB_AUTHORIZATION_TOKEN;
}

/** Validate an authorization against the environment and the requested target. */
function authorize(
  auth: DbAuthorization | undefined,
  target: string,
): { authorized: boolean; reason?: string } {
  const expected = expectedAuthorizationToken();
  if (!expected) {
    return {
      authorized: false,
      reason: 'CAIRN_DB_AUTHORIZATION_TOKEN is not set; protected databases cannot be targeted.',
    };
  }
  if (!auth) {
    return {
      authorized: false,
      reason: 'No authorization supplied; protected databases require explicit authorization.',
    };
  }
  if (auth.token !== expected) {
    return { authorized: false, reason: 'Authorization token does not match.' };
  }
  if (auth.database !== target) {
    return {
      authorized: false,
      reason: `Authorization names database "${auth.database}" but target is "${target}".`,
    };
  }
  return { authorized: true };
}

/**
 * Validate an explicit database target before any mutation.
 *
 * 1. Requires a non-empty target string.
 * 2. Connects using application credentials (never DATABASE_URL).
 * 3. Runs `SELECT current_database()` to confirm the actual connected
 *    identity matches the requested target.
 * 4. Refuses protected databases unless explicit authorization is supplied.
 * 5. Fails closed on any mismatch, missing target, or connection failure.
 *
 * Returns a validated target descriptor on success. Throws on any failure.
 * The caller then uses their own credentials to connect to the validated
 * database — this function does not create or cache the mutation connection.
 */
export async function validateTarget(
  target: string | undefined,
  authorization?: DbAuthorization,
  verificationConnectionString?: string,
): Promise<ValidatedTarget> {
  if (!target || typeof target !== 'string' || target.trim().length === 0) {
    throw new Error(
      'Database target is required: pass the database name explicitly. ' +
        'Do not rely on DATABASE_URL or MIGRATION_DATABASE_URL fallbacks.',
    );
  }

  const database = target.trim();
  const protectedFlag = isProtected(database);

  if (protectedFlag) {
    const decision = authorize(authorization, database);
    if (!decision.authorized) {
      throw new Error(
        `Refusing to target protected database "${database}": ${decision.reason}`,
      );
    }
  }

  // Connect using application credentials solely to verify database identity.
  // Never read DATABASE_URL here — that is the defect this guard prevents.
  const connectionString = verificationConnectionStringFor(database, verificationConnectionString);
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(connectionString, {
      max: 1,
      prepare: false,
      connect_timeout: 10,
    });
    const rows = await sql<Array<{ current_database: string }>>`
      SELECT current_database() AS current_database
    `;
    const actual = rows[0].current_database;
    if (actual !== database) {
      await sql!.end({ timeout: 5 });
      throw new Error(
        `Database identity mismatch: requested "${database}" but connected to "${actual}". ` +
          `Refusing to proceed.`,
      );
    }
    await sql!.end({ timeout: 5 });
  } catch (error) {
    try {
      await sql?.end({ timeout: 5 });
    } catch {
      // Ignore errors during cleanup.
    }
    if (error instanceof Error && error.message.includes('Database identity mismatch')) {
      throw error;
    }
    throw new Error(
      `Cannot verify database target "${database}": ${(error as Error).message}`,
    );
  }

  return { database, protected: protectedFlag };
}
