/**
 * Mail platform service — SCOT (node configuration) and SOST (send queue).
 *
 * Rules this file keeps:
 * - Nothing on a request path talks SMTP, except `testMailConnection`, a diagnostic the user is
 *   waiting for, bounded by the transport timeouts. Every other entry point writes a row and returns;
 *   the MAIL.SEND job sends.
 * - The SMTP password is write-only. It is never read into a view, a log, an error or a change document.
 * - A one-time secret never sits in `body_text`. The body holds `{link}`, the secret is encrypted in
 *   its own column, the two are joined only inside `sendOneMail`, and the column is nulled on SENT / DEAD.
 * - There is deliberately no synchronous sendMail export. A module that needs mail calls `enqueueMail`
 *   with its own transaction, or does not send mail.
 */
import { randomUUID } from 'node:crypto';
import { desc, eq, and, sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../db/client';
import { hasCapability } from '../auth/pattern';
import { recordChange } from '../change';
import { mailMessage, mailServerConfig } from '../tables/system';
import { decryptBankData, encryptBankData, type BankDataContext } from '../security/bank-data-encryption';
import { loadBankDataKeyring } from '../security/bank-data-keyring';
import type { BankRecordId } from '../security/bank-record-id';
import {
  deliverMail,
  probeConnection,
  MailTransportError,
  type MailAttachment,
  type MailEncryption,
  type MailTransportConfig,
} from './transport';

export const MAIL_DEFINE_CAPABILITY = 'CFG.PLT.MAIL.DEFINE';
export const MAIL_OBJECT_CLASS = 'mail_server_config';

const ENCRYPTIONS: readonly MailEncryption[] = ['STARTTLS', 'TLS', 'NONE'];
const LAST_TEST_MAX = 500;
const LAST_ERROR_MAX = 500;
const DEFAULT_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_CAP_SECONDS = 300;
const PLACEHOLDER = '{link}';

/**
 * Fixed AAD identity for the SMTP password. `BankDataContext` carries bank vocabulary
 * (partnerNumber, bankRecordId); it is reused here for a non-bank secret so mail credentials
 * share the one deployment keyring and its rotation tooling instead of a second keyring we would
 * own forever. Do not "fix" the field names and do not widen `BankDataContext`. The record id must
 * be a UUIDv4 (the envelope rejects anything else), so it is this documented constant; one row per tenant.
 */
const SMTP_PASSWORD_RECORD_ID = '5d1b7c2e-3a4f-4e8b-9c6d-0a1b2c3d4e5f' as BankRecordId;

function passwordContext(client: string): BankDataContext {
  return { client, partnerNumber: 'MAIL', bankRecordId: SMTP_PASSWORD_RECORD_ID, field: 'password' };
}

/** A queued secret is bound to its own message: a ciphertext copied to another row will not open. */
function secretContext(client: string, messageId: string): BankDataContext {
  return { client, partnerNumber: 'MAIL', bankRecordId: messageId as BankRecordId, field: 'secret' };
}

export type MailErrorCode =
  | 'MAIL_FORBIDDEN'
  | 'MAIL_HOST_REQUIRED'
  | 'MAIL_SENDER_REQUIRED'
  | 'MAIL_NOT_CONFIGURED'
  | 'MAIL_ADDRESS_INVALID'
  | 'MAIL_INPUT_INVALID'
  | 'MAIL_KEY_UNAVAILABLE';

export class MailError extends Error {
  constructor(
    readonly code: MailErrorCode,
    message: string,
    readonly remedy?: string,
  ) {
    super(message);
    this.name = 'MailError';
  }
}

export interface MailConfigView {
  host: string | null;
  port: number;
  encryption: MailEncryption;
  username: string | null;
  /** The only thing the screen learns about the password. */
  hasPassword: boolean;
  senderAddress: string | null;
  senderName: string | null;
  isEnabled: boolean;
  lastTestAt: string | null;
  lastTestResult: string | null;
}

export interface SaveMailConfigInput {
  client: string;
  changedBy: string;
  host: string;
  port: number;
  encryption: MailEncryption;
  username: string;
  /** Empty = leave the stored password unchanged. */
  password: string;
  clearPassword: boolean;
  senderAddress: string;
  senderName: string;
  isEnabled: boolean;
}

export interface EnqueueMailInput {
  client: string;
  toAddress: string;
  subject: string;
  /** May contain the literal {link}. */
  bodyText: string;
  /** Substituted for {link}; encrypted before insert. */
  secret?: string;
  objectClass?: string;
  objectKey?: string;
  maxAttempts?: number;
  /** One file per message (MAIL-03). Stored base64; nothing in this item calls it. */
  attachment?: MailAttachment;
  changedBy: string;
}

export interface TestMailInput {
  client: string;
  changedBy: string;
  /** sendTestMail only. */
  toAddress?: string;
}

export interface TestOutcome {
  ok: boolean;
  message: string;
}

export interface EnqueueOutcome {
  messageId: string;
}

export type SendOutcome = 'SENT' | 'FAILED' | 'DEAD' | 'SKIPPED';

export interface MailQueueRow {
  id: string;
  createdAt: string;
  toAddress: string;
  subject: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  lastError: string | null;
}

// ── helpers ────────────────────────────────────────────────────────────────

function requireDefine(capabilities: string[]): void {
  if (!hasCapability(capabilities, MAIL_DEFINE_CAPABILITY)) {
    throw new MailError(
      'MAIL_FORBIDDEN',
      `Mail server configuration needs ${MAIL_DEFINE_CAPABILITY}, which this session does not hold.`,
      `Ask an administrator to grant ${MAIL_DEFINE_CAPABILITY} to one of your roles.`,
    );
  }
}

/** One address: an `@`, no whitespace, none of the characters that would make it a list. */
export function isValidMailAddress(value: string): boolean {
  return value.length > 0 && value.length <= 200 && /^[^\s@,;<>"]+@[^\s@,;<>"]+$/.test(value);
}

function requireAddress(value: string): void {
  if (!isValidMailAddress(value)) {
    throw new MailError('MAIL_ADDRESS_INVALID', 'The mail address must be a single address such as name@example.com.', 'Correct the address and try again.');
  }
}

/** Seconds to wait after the nth failed attempt (1-based): 30, 60, 120, 240, 300. */
export function retryDelaySeconds(attempt: number): number {
  return Math.min(BACKOFF_BASE_SECONDS * 2 ** (attempt - 1), BACKOFF_CAP_SECONDS);
}

function keyring() {
  try {
    return loadBankDataKeyring();
  } catch {
    throw new MailError(
      'MAIL_KEY_UNAVAILABLE',
      'The deployment encryption keyring is not available, so a mail secret cannot be protected.',
      'Ask the deployment owner to configure CAIRN_BANK_DATA_KEYRING_JSON.',
    );
  }
}

/** The text that may be stored for a failure. Only errors this module knows to be safe contribute their message. */
function safeErrorText(err: unknown): string {
  if (err instanceof MailTransportError) return err.message.slice(0, LAST_ERROR_MAX);
  const name = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  return /^[A-Z0-9_]{1,60}$/.test(name) ? name : 'MAIL_SEND_FAILED';
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

type ConfigRow = typeof mailServerConfig.$inferSelect;

function viewOf(row: ConfigRow | undefined): MailConfigView {
  return {
    host: row?.host ?? null,
    port: row?.port ?? 587,
    encryption: ENCRYPTIONS.includes(row?.encryption as MailEncryption) ? (row!.encryption as MailEncryption) : 'STARTTLS',
    username: row?.username ?? null,
    hasPassword: Boolean(row?.passwordEncrypted),
    senderAddress: row?.senderAddress ?? null,
    senderName: row?.senderName ?? null,
    isEnabled: row?.isEnabled ?? false,
    lastTestAt: iso(row?.lastTestAt ?? null),
    lastTestResult: row?.lastTestResult ?? null,
  };
}

/** Change-document snapshot. `passwordSet`, never a value. */
function snapshot(row: ConfigRow | undefined): Record<string, unknown> {
  return {
    host: row?.host ?? null,
    port: row?.port ?? 587,
    encryption: row?.encryption ?? 'STARTTLS',
    username: row?.username ?? null,
    passwordSet: Boolean(row?.passwordEncrypted),
    senderAddress: row?.senderAddress ?? null,
    senderName: row?.senderName ?? null,
    isEnabled: row?.isEnabled ?? false,
  };
}

async function loadConfigRow(tx: Tx, client: string): Promise<ConfigRow | undefined> {
  const [row] = await tx.select().from(mailServerConfig).where(eq(mailServerConfig.client, client)).limit(1);
  return row;
}

/** Decrypt the node for one send or probe. The returned object must not outlive the call. */
function transportConfigOf(row: ConfigRow): MailTransportConfig {
  if (!row.host || !row.senderAddress) {
    throw new MailError('MAIL_NOT_CONFIGURED', 'The mail node has no host or sender address.', 'Complete the node on the mail server screen.');
  }
  return {
    host: row.host,
    port: row.port,
    encryption: ENCRYPTIONS.includes(row.encryption as MailEncryption) ? (row.encryption as MailEncryption) : 'STARTTLS',
    username: row.username,
    password: row.passwordEncrypted ? decryptBankData(row.passwordEncrypted, passwordContext(row.client), keyring()) : null,
    senderAddress: row.senderAddress,
    senderName: row.senderName,
  };
}

// ── configuration ──────────────────────────────────────────────────────────

export async function getMailConfig(client: string, capabilities: string[]): Promise<MailConfigView> {
  requireDefine(capabilities);
  return withTenant(client, async (tx) => viewOf(await loadConfigRow(tx, client)));
}

export async function saveMailConfig(input: SaveMailConfigInput, capabilities: string[]): Promise<MailConfigView> {
  requireDefine(capabilities);

  const host = input.host.trim();
  const senderAddress = input.senderAddress.trim();
  const username = input.username.trim();
  const senderName = input.senderName.trim();
  if (!ENCRYPTIONS.includes(input.encryption)) {
    throw new MailError('MAIL_INPUT_INVALID', 'Encryption must be STARTTLS, TLS or NONE.');
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new MailError('MAIL_INPUT_INVALID', 'The port must be a whole number from 1 to 65535.');
  }
  if (host.length > 200 || username.length > 200 || senderName.length > 120) {
    throw new MailError('MAIL_INPUT_INVALID', 'Host and username are limited to 200 characters, sender name to 120.');
  }
  if (senderAddress) requireAddress(senderAddress);
  if (input.isEnabled && !host) {
    throw new MailError('MAIL_HOST_REQUIRED', 'A node in use needs a mail host.', 'Enter the host, or clear "node in use".');
  }
  if (input.isEnabled && !senderAddress) {
    throw new MailError('MAIL_SENDER_REQUIRED', 'A node in use needs a sender address.', 'Enter the sender address, or clear "node in use".');
  }

  const newPassword = input.clearPassword ? null : input.password.length > 0 ? encryptBankData(input.password, passwordContext(input.client), keyring()) : undefined;

  return withTenant(input.client, async (tx) => {
    const before = await loadConfigRow(tx, input.client);
    const values = {
      host: host || null,
      port: input.port,
      encryption: input.encryption,
      username: username || null,
      senderAddress: senderAddress || null,
      senderName: senderName || null,
      isEnabled: input.isEnabled,
      changedBy: input.changedBy,
      changedAt: new Date(),
      // undefined leaves the column untouched on update.
      ...(newPassword !== undefined ? { passwordEncrypted: newPassword } : {}),
    };
    await tx
      .insert(mailServerConfig)
      .values({ client: input.client, ...values, createdBy: input.changedBy })
      .onConflictDoUpdate({ target: mailServerConfig.client, set: values });
    const after = await loadConfigRow(tx, input.client);

    await recordChange(tx, {
      client: input.client,
      objectClass: MAIL_OBJECT_CLASS,
      objectKey: input.client,
      changeType: before ? 'CHANGE' : 'CREATE',
      changedBy: input.changedBy,
      transactionCode: MAIL_DEFINE_CAPABILITY,
      before: before ? snapshot(before) : undefined,
      after: snapshot(after),
      securityRelevantFields: ['host', 'port', 'encryption', 'username', 'passwordEncrypted', 'passwordSet', 'senderAddress', 'senderName', 'isEnabled'],
    });
    return viewOf(after);
  });
}

async function recordTest(client: string, changedBy: string, result: string): Promise<void> {
  await withTenant(client, (tx) =>
    tx
      .update(mailServerConfig)
      .set({ lastTestAt: new Date(), lastTestResult: result.slice(0, LAST_TEST_MAX), changedBy, changedAt: new Date() })
      .where(eq(mailServerConfig.client, client)),
  );
}

/** The one diagnostic that opens a socket from a request. Bounded by the transport timeouts. */
export async function testMailConnection(input: TestMailInput, capabilities: string[]): Promise<TestOutcome> {
  requireDefine(capabilities);
  // Read inside a short transaction and release it before the socket opens.
  const row = await withTenant(input.client, (tx) => loadConfigRow(tx, input.client));
  if (!row || !row.host || !row.senderAddress) {
    throw new MailError('MAIL_NOT_CONFIGURED', 'Save a host and sender address before testing the connection.');
  }
  let outcome: TestOutcome;
  try {
    await probeConnection(transportConfigOf(row));
    outcome = { ok: true, message: 'Connection test succeeded.' };
  } catch (err) {
    outcome = { ok: false, message: `Connection test failed: ${safeErrorText(err)}` };
  }
  await recordTest(input.client, input.changedBy, outcome.message);
  return outcome;
}

/** Enqueues; never sends inline. The test send is itself proof that the queue works. */
export async function sendTestMail(input: TestMailInput, capabilities: string[]): Promise<EnqueueOutcome> {
  requireDefine(capabilities);
  const toAddress = (input.toAddress ?? '').trim();
  const messageId = await withTenant(input.client, (tx) =>
    enqueueMail(tx, {
      client: input.client,
      toAddress,
      subject: 'Test message from the mail server configuration',
      bodyText: 'This is a test message. If you can read it, the outbound mail queue and this node are working.',
      objectClass: 'mail_server_config',
      objectKey: input.client,
      changedBy: input.changedBy,
    }),
  );
  await recordTest(input.client, input.changedBy, `Test mail ${messageId} queued for ${toAddress}.`);
  return { messageId };
}

// ── queue ──────────────────────────────────────────────────────────────────

/**
 * Add a message to the queue inside the caller's transaction. Not an entry point: it takes no
 * capabilities, authorisation is the caller's. Refuses loudly when the node is absent or not in use,
 * because a queue that never drains looks like success.
 */
export async function enqueueMail(tx: Tx, input: EnqueueMailInput): Promise<string> {
  requireAddress(input.toAddress);
  const subject = input.subject.replace(/[\r\n]+/g, ' ').trim();
  if (!subject || subject.length > 255 || !input.bodyText) {
    throw new MailError('MAIL_INPUT_INVALID', 'A message needs a subject of up to 255 characters and a body.');
  }
  const hasPlaceholder = input.bodyText.includes(PLACEHOLDER);
  if (hasPlaceholder !== Boolean(input.secret)) {
    throw new MailError('MAIL_INPUT_INVALID', `The body contains ${PLACEHOLDER} exactly when a secret is supplied.`);
  }

  const config = await loadConfigRow(tx, input.client);
  if (!config || !config.isEnabled) {
    throw new MailError('MAIL_NOT_CONFIGURED', 'Outbound mail is not configured for this tenant.', 'Ask a mail administrator to set up and enable the mail node.');
  }

  const id = randomUUID();
  await tx.insert(mailMessage).values({
    id,
    client: input.client,
    toAddress: input.toAddress,
    subject,
    bodyText: input.bodyText,
    secretEncrypted: input.secret ? encryptBankData(input.secret, secretContext(input.client, id), keyring()) : null,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    objectClass: input.objectClass ?? null,
    objectKey: input.objectKey ?? null,
    attachmentName: input.attachment?.name ?? null,
    attachmentMime: input.attachment?.mime ?? null,
    attachmentData: input.attachment?.base64 ?? null,
    createdBy: input.changedBy,
  });
  return id;
}

/** Send one queued message. Claims the row with FOR UPDATE; anything not QUEUED / FAILED is a no-op. */
export async function sendOneMail(tx: Tx, client: string, messageId: string): Promise<SendOutcome> {
  const [msg] = await tx
    .select()
    .from(mailMessage)
    .where(and(eq(mailMessage.client, client), eq(mailMessage.id, messageId)))
    .for('update')
    .limit(1);
  if (!msg || (msg.status !== 'QUEUED' && msg.status !== 'FAILED')) return 'SKIPPED';

  try {
    const config = await loadConfigRow(tx, client);
    if (!config || !config.isEnabled) {
      throw new MailError('MAIL_NOT_CONFIGURED', 'The mail node is not in use.');
    }
    const secret = msg.secretEncrypted ? decryptBankData(msg.secretEncrypted, secretContext(client, msg.id), keyring()) : null;
    const text = secret === null ? msg.bodyText : msg.bodyText.split(PLACEHOLDER).join(secret);
    await deliverMail(transportConfigOf(config), {
      to: msg.toAddress,
      subject: msg.subject,
      text,
      attachment:
        msg.attachmentData && msg.attachmentName
          ? { name: msg.attachmentName, mime: msg.attachmentMime ?? 'application/octet-stream', base64: msg.attachmentData }
          : null,
    });
  } catch (err) {
    const attempts = msg.attempts + 1;
    const dead = attempts >= msg.maxAttempts;
    const text = safeErrorText(err);
    await tx
      .update(mailMessage)
      .set({
        status: dead ? 'DEAD' : 'FAILED',
        attempts,
        lastError: text.slice(0, LAST_ERROR_MAX),
        availableAt: sql`now() + (${retryDelaySeconds(attempts)} * interval '1 second')`,
        ...(dead ? { secretEncrypted: null } : {}),
        changedBy: 'MAIL.SEND',
        changedAt: new Date(),
      })
      .where(eq(mailMessage.id, msg.id));
    return dead ? 'DEAD' : 'FAILED';
  }

  await tx
    .update(mailMessage)
    .set({
      status: 'SENT',
      sentAt: new Date(),
      secretEncrypted: null,
      lastError: null,
      attempts: msg.attempts + 1,
      changedBy: 'MAIL.SEND',
      changedAt: new Date(),
    })
    .where(eq(mailMessage.id, msg.id));
  return 'SENT';
}

/** Read-only view of the newest messages. Never carries the body, the secret or an attachment. */
export async function listMailQueue(client: string, capabilities: string[], limit = 50): Promise<MailQueueRow[]> {
  requireDefine(capabilities);
  const rows = await withTenant(client, (tx) =>
    tx
      .select({
        id: mailMessage.id,
        createdAt: mailMessage.createdAt,
        toAddress: mailMessage.toAddress,
        subject: mailMessage.subject,
        status: mailMessage.status,
        attempts: mailMessage.attempts,
        maxAttempts: mailMessage.maxAttempts,
        availableAt: mailMessage.availableAt,
        lastError: mailMessage.lastError,
      })
      .from(mailMessage)
      .where(eq(mailMessage.client, client))
      .orderBy(desc(mailMessage.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200)),
  );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), availableAt: r.availableAt.toISOString() }));
}
