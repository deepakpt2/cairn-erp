/**
 * Enqueue and locking — CAIRN.md §5.2 engine E4, D-018
 *
 * The reference system has a central enqueue server with named lock objects.
 * Ours uses PostgreSQL advisory locks, which are transaction- or session-scoped
 * and released automatically — no stale locks to clean up after a crash.
 *
 * These tables hold the DEFINITIONS and the telemetry for the lock monitor (§24.4).
 * The locks themselves live in PostgreSQL (pg_locks), not here.
 */
import {
  pgTable,
  varchar,
  integer,
  boolean,
  timestamp,
  text,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { client } from './tenancy';

/** A named lock object: what can be locked, and how. */
export const lockObject = pgTable(
  'lock_object',
  {
    code: varchar('code', { length: 40 }).primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    /** Master data tables this object protects, for the where-used view. */
    tableNames: text('table_names').notNull().default(''),
    /** EXCLUSIVE | SHARED — shared allows concurrent readers, exclusive does not. */
    defaultMode: varchar('default_mode', { length: 16 }).notNull().default('EXCLUSIVE'),
    /** How long a waiter waits before giving up, in milliseconds. */
    waitTimeoutMs: integer('wait_timeout_ms').notNull().default(10000),
    isConfigured: boolean('is_configured').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Lock telemetry. Written when a lock is contended or times out, which is exactly
 * what an administrator needs to see in the lock monitor. Not written for every
 * uncontended acquisition — that would be a performance tax for no information.
 */
export const lockWaitLog = pgTable(
  'lock_wait_log',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    lockObjectCode: varchar('lock_object_code', { length: 40 }).notNull(),
    lockKey: varchar('lock_key', { length: 200 }).notNull(),
    /** ACQUIRED_AFTER_WAIT | TIMED_OUT | DEADLOCK_AVOIDED */
    outcome: varchar('outcome', { length: 24 }).notNull(),
    waitedMs: integer('waited_ms').notNull(),
    requestedBy: varchar('requested_by', { length: 60 }).notNull(),
    transactionCode: varchar('transaction_code', { length: 64 }),
    detail: text('detail'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('lock_wait_log_client_time_idx').on(t.client, t.occurredAt),
    index('lock_wait_log_object_idx').on(t.lockObjectCode),
  ],
);

/**
 * A dialog enqueue entry — the row SM12 lists.
 *
 * Unlike the advisory lock, this outlives the request. It stands while a
 * session has the object open in change, and it leaves when that session
 * releases it, signs out, or stops answering. A second session does not
 * take it; that session is shown the object and cannot change it.
 */
export const enqueueEntry = pgTable(
  'enqueue_entry',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    lockObject: varchar('lock_object', { length: 40 }).notNull(),
    argument: varchar('argument', { length: 200 }).notNull(),
    mode: varchar('mode', { length: 16 }).notNull().default('EXCLUSIVE'),
    ownerUser: varchar('owner_user', { length: 60 }).notNull(),
    ownerSessionId: varchar('owner_session_id', { length: 36 }).notNull(),
    transactionCode: varchar('transaction_code', { length: 64 }),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.client, t.lockObject, t.argument] }),
    index('enqueue_entry_session_idx').on(t.client, t.ownerSessionId),
    index('enqueue_entry_user_idx').on(t.client, t.ownerUser),
  ],
);
