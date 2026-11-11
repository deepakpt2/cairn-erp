/**
 * Messages, jobs and mail — CAIRN.md §21, §17, §22.8
 */
import {
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { auditColumns, client } from './tenancy';

/**
 * The message catalogue. Every user-visible string resolves through a message
 * code with an i18n key — no hardcoded UI text anywhere (R-19, D-008).
 */
export const messageCatalog = pgTable(
  'message_catalog',
  {
    code: varchar('code', { length: 80 }).primaryKey(),
    /** ERROR | WARNING | INFO | SUCCESS | ACTION */
    severity: varchar('severity', { length: 16 }).notNull(),
    messageClass: varchar('message_class', { length: 40 }).notNull(),
    /** English text with {placeholders}. */
    textEn: text('text_en').notNull(),
    /** i18n key, resolved by the locale layer. */
    i18nKey: varchar('i18n_key', { length: 120 }).notNull(),
    /** Longer explanation shown in the details panel. */
    longText: text('long_text'),
    /** What the user should do about it. Our messages explain, they do not just complain. */
    remedy: text('remedy'),
    /** true when the message should be surfaced immediately after the action. */
    isUserFacing: boolean('is_user_facing').notNull().default(true),
    ...auditColumns,
  },
  (t) => [index('message_catalog_class_idx').on(t.messageClass)],
);

/**
 * What a run is waiting for. One entry per held document.
 *
 * This is the JOB.BLOCKED notification payload, kept queryable on the run rather than
 * buried in a log line, because the jobs status page is what the user actually reads.
 */
export interface BlockedOn {
  documents: {
    lockObject: string;
    argument: string;
    holderUser: string;
    holderSessionId: string | null;
  }[];
  /** Set when this run has the authority to clear the locks, and has warned the holders. */
  willTerminateAt?: string;
}

/** A schedulable unit of work. Everything long-running lives here (§21, D-022). */
export const jobDefinition = pgTable(
  'job_definition',
  {
    code: varchar('code', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 160 }).notNull(),
    description: text('description'),
    /** Queue name controlling concurrency. */
    queue: varchar('queue', { length: 40 }).notNull().default('DEFAULT'),
    module: varchar('module', { length: 16 }).notNull(),
    /** Cron expression when scheduled, otherwise NULL for on-demand only. */
    schedule: varchar('schedule', { length: 80 }),
    isScheduled: boolean('is_scheduled').notNull().default(false),
    maxRetries: integer('max_retries').notNull().default(0),
    timeoutSeconds: integer('timeout_seconds').notNull().default(600),
    isEnabled: boolean('is_enabled').notNull().default(true),

    /**
     * Scheduled critical runs only: permits revoking a holder session to clear an
     * enqueue lock. Never granted to an ad-hoc user-submitted job — a person's own
     * job does not get to close someone else's screen, however long it waits.
     */
    mayTerminateSessions: boolean('may_terminate_sessions').notNull().default(false),
    /** How long a scheduled job warns a lock holder before closing their session. */
    gracePeriodSeconds: integer('grace_period_seconds').notNull().default(300),
    /** Documents per lock-commit cycle. Locking the whole scope at once would block users. */
    chunkSize: integer('chunk_size').notNull().default(100),
    /** How long a finished run is kept before purging. Terminal statuses only. */
    retentionDays: integer('retention_days').notNull().default(30),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('job_definition_queue_idx').on(t.queue)],
);

export const jobRun = pgTable(
  'job_run',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    jobCode: varchar('job_code', { length: 64 })
      .notNull()
      .references(() => jobDefinition.code),
    /** QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELLED */
    status: varchar('status', { length: 16 }).notNull().default('QUEUED'),
    /** MANUAL | SCHEDULED | CHAINED */
    triggerType: varchar('trigger_type', { length: 16 }).notNull().default('MANUAL'),
    triggeredBy: varchar('triggered_by', { length: 60 }).notNull(),
    parameters: jsonb('parameters').$type<Record<string, unknown>>().notNull().default({}),
    /** 0-100, for long runs like MRP. */
    progressPercent: integer('progress_percent').notNull().default(0),
    progressText: varchar('progress_text', { length: 200 }),
    resultSummary: text('result_summary'),
    errorText: text('error_text'),
    retryCount: integer('retry_count').notNull().default(0),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),

    /** Same key for the same job and tenant yields one run, so a retry cannot double-queue. */
    idempotencyKey: varchar('idempotency_key', { length: 120 }),
    /**
     * When the run becomes claimable. queued_at for a fresh run; moved forward for
     * backoff, for a lock wait, and for the grace period before a session is closed.
     */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    /**
     * Where the run stopped, as opaque JSON handed back to the handler on resume.
     * A resumed run restarts from this chunk, never from zero.
     */
    cursor: jsonb('cursor').$type<Record<string, unknown> | null>().default(null),
    chunksDone: integer('chunks_done').notNull().default(0),
    chunksTotal: integer('chunks_total'),
    workerId: varchar('worker_id', { length: 80 }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /**
     * Advanced by the worker while it runs. A RUNNING run whose heartbeat has stopped
     * was orphaned by a killed worker and is reaped back to QUEUED, keeping its cursor.
     */
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    /** The JOB.BLOCKED payload: which documents are held, and by whom. */
    blockedOn: jsonb('blocked_on').$type<BlockedOn | null>().default(null),
    warnedAt: timestamp('warned_at', { withTimezone: true }),
    deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }),
  },
  (t) => [
    index('job_run_client_status_idx').on(t.client, t.status),
    index('job_run_job_idx').on(t.jobCode, t.queuedAt),
  ],
);

export const jobLog = pgTable(
  'job_log',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    jobRunId: varchar('job_run_id', { length: 36 })
      .notNull()
      .references(() => jobRun.id, { onDelete: 'cascade' }),
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    /** DEBUG | INFO | WARN | ERROR */
    level: varchar('level', { length: 12 }).notNull().default('INFO'),
    message: text('message').notNull(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    loggedAt: timestamp('logged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('job_log_run_idx').on(t.jobRunId, t.loggedAt)],
);

/**
 * A message to one user about one thing that happened — Phase 7.
 *
 * Not the attention panel. That is a live query about what is waiting; this is
 * a stored row about what happened. Different mechanisms, and they are not
 * merged.
 *
 * Written through the `notification_deliver` definer function, never by a
 * plain insert: the recipient term of the policy is what keeps one person out
 * of another's inbox, and it would equally stop anybody writing to another
 * person's inbox — including the worker resolving a pool. See the migration.
 */
export const notification = pgTable(
  'notification',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    notificationId: varchar('notification_id', { length: 36 }).notNull(),
    /** app_user.id of the person being told. Resolved, never caller-supplied. */
    recipient: varchar('recipient', { length: 60 }).notNull(),
    kind: varchar('kind', { length: 40 }).notNull(),
    /** What it points at: purchase_requisition, job_run, user_session. Not a foreign key. */
    objectClass: varchar('object_class', { length: 60 }).notNull(),
    objectKey: varchar('object_key', { length: 80 }).notNull(),
    /** i18n key, resolved at render. No user-visible text is stored (R-19, D-008). */
    messageKey: varchar('message_key', { length: 120 }).notNull(),
    messageParams: jsonb('message_params').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null means unseen, which is the only state the inbox distinguishes. */
    seenAt: timestamp('seen_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.client, t.notificationId] }),
    index('notification_inbox_idx').on(t.client, t.recipient, t.seenAt, t.createdAt),
  ],
);

/**
 * Mail server configuration — D-033. Configured in the application, not the
 * environment, with the password encrypted at rest and write-only in the UI.
 */
export const mailServerConfig = pgTable(
  'mail_server_config',
  {
    client: varchar('client', { length: 4 })
      .primaryKey()
      .references(() => client.client, { onDelete: 'cascade' }),
    host: varchar('host', { length: 200 }),
    port: integer('port').notNull().default(587),
    /** STARTTLS | TLS | NONE */
    encryption: varchar('encryption', { length: 16 }).notNull().default('STARTTLS'),
    username: varchar('username', { length: 200 }),
    /** Encrypted at rest. Never returned to the client — set-only. */
    passwordEncrypted: text('password_encrypted'),
    senderAddress: varchar('sender_address', { length: 200 }),
    senderName: varchar('sender_name', { length: 120 }),
    isEnabled: boolean('is_enabled').notNull().default(false),
    lastTestAt: timestamp('last_test_at', { withTimezone: true }),
    lastTestResult: text('last_test_result'),
    ...auditColumns,
  },
);
