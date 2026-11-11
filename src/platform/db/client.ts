/**
 * Database client — CAIRN.md §5, §22.4
 *
 * A thin layer over postgres.js + Drizzle. The important part is `withTenant()`:
 * every business operation runs inside a transaction that first sets the
 * `cairn.client` session variable, which the row-level security policies read.
 * Application code cannot forget to scope a query, because the database refuses
 * to return another tenant's rows.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../schema';

export type Db = PostgresJsDatabase<typeof schema>;

/** A transaction handle — same query surface as Db, inside one transaction. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

let _sql: ReturnType<typeof postgres> | null = null;
let _db: Db | null = null;
let _roleCheck: Promise<void> | null = null;

function connectionString(): string {
  return (
    process.env.DATABASE_URL ?? 'postgresql://cairn_app:cairn_app_dev@127.0.0.1:5432/cairn'
  );
}

/**
 * Shared connection. `prepare: false` because PgBouncer runs in transaction mode
 * in the container stack, where server-side prepared statements are not safe
 * (D-026). Setting it here keeps development and production identical.
 */
export function sql() {
  if (!_sql) {
    _sql = postgres(connectionString(), {
      max: 10,
      idle_timeout: 20,
      prepare: false,
      onnotice: () => {},
    });
  }
  return _sql;
}

export function db(): Db {
  if (!_db) {
    _db = drizzle(sql(), { schema });
  }
  return _db;
}

/**
 * Direct, unpooled connection for migrations and anything needing session semantics.
 *
 * An explicit connection string is required — `directSql()` never falls back to
 * `process.env.DATABASE_URL`, so a caller cannot silently connect to the wrong
 * database. Each call creates a fresh connection; nothing is cached, so a client
 * created for one target can never be reused against another.
 */
export function directSql(connectionString: string) {
  if (typeof connectionString !== 'string' || connectionString.trim().length === 0) {
    throw new Error(
      'directSql requires an explicit, non-empty connection string; it never falls back to environment configuration.',
    );
  }
  return postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });
}

/** Fail closed if the runtime URL accidentally points at the migration role. */
export async function assertApplicationRole(): Promise<void> {
  if (!_roleCheck) _roleCheck = (async () => {
    const [role] = await sql().unsafe<Array<{ elevated: boolean }>>(
      'select (rolsuper or rolbypassrls) as elevated from pg_roles where rolname = current_user',
    );
    if (role?.elevated) throw new Error('The application connection must use a NOSUPERUSER NOBYPASSRLS role. Use the separate migration URL for administration.');
  })();
  return _roleCheck;
}

/**
 * Run a callback inside a tenant-scoped transaction.
 *
 *   await withTenant('0100', async (tx) => { ... })
 *
 * The SET LOCAL is scoped to the transaction, so a pooled connection cannot leak
 * one tenant's scope into the next request.
 */
export async function withTenant<T>(
  client: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  await assertApplicationRole();
  return db().transaction(async (tx) => {
    await tx.execute(
      // Parameter binding is not permitted in SET, so the value is validated first.
      sqlSafeSetting(client),
    );
    return fn(tx);
  });
}


/**
 * Run a callback as one named person, inside one tenant.
 *
 * `withTenant` names the tenant and nobody, which is right for the tables whose
 * policies only ask about `client`. A few also ask who you are, and for those
 * the person has to be named or the policy answers no rows. The notification
 * inbox is the first of them.
 *
 * The user id is validated the same way the client key is, because SET LOCAL
 * cannot take a bind parameter and therefore cannot be parameterised.
 */
export async function withTenantAs<T>(
  client: string,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  await assertApplicationRole();
  return db().transaction(async (tx) => {
    await tx.execute(sqlSafeSetting(client));
    await tx.execute(sqlSafeUser(userId));
    return fn(tx);
  });
}

/**
 * SET LOCAL cannot take a bind parameter, so this guards the interpolation.
 *
 * The setting name is quoted because `user` is a reserved word in SQL: an
 * unquoted `cairn.user` is a syntax error. Quoting makes it a single
 * identifier, which is what a custom setting is, and `current_setting` still
 * reads it by name.
 */
function sqlSafeUser(userId: string) {
  const clean = String(userId);
  if (!/^[A-Za-z0-9_.:-]{1,60}$/.test(clean)) {
    throw new Error('Invalid user id: ' + JSON.stringify(userId));
  }
  return rawSql('SET LOCAL "cairn.user" = \'' + clean + '\'');
}

/**
 * SET LOCAL cannot take a bind parameter, so this guards the interpolation.
 */
function sqlSafeSetting(client: string) {
  const clean = String(client);
  if (!/^[A-Za-z0-9]{2,4}$/.test(clean)) {
    throw new Error(`Invalid client key: ${JSON.stringify(client)}`);
  }
  return rawSql(`SET LOCAL cairn.client = '${clean}'`);
}

// Small helper so the SET statement reads clearly above.
import { sql as rawSqlTag } from 'drizzle-orm';
function rawSql(text: string) {
  return rawSqlTag.raw(text);
}

/** Close pooled connections. Used by tests and shutdown hooks. */
export async function closeDb() {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
    _db = null;
    _roleCheck = null;
  }
}
