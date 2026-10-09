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
