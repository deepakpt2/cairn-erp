/**
 * MAIL-01 — mail node configuration (SCOT) and the outbound queue (SOST).
 *
 * The transport is mocked: these tests prove what the service stores and what it hands the transport,
 * never that an SMTP server answered. Everything else runs against the real erp_test database.
 */
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/platform/mail/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/platform/mail/transport')>();
  return { ...actual, deliverMail: vi.fn(), probeConnection: vi.fn() };
});

import { withTenant } from '../src/platform/db/client';
import { mailMessage, mailServerConfig } from '../src/platform/tables/system';
import { deliverMail, MailTransportError } from '../src/platform/mail/transport';
import {
  enqueueMail,
  getMailConfig,
  MailError,
  retryDelaySeconds,
  saveMailConfig,
  sendOneMail,
  sendTestMail,
  listMailQueue,
} from '../src/platform/mail/service';
import { mailSendJob } from '../src/platform/mail/jobs/send';
import { createTenant, destroyTenant } from './helpers';

const CAP = ['CFG.PLT.MAIL.DEFINE'];
const PASSWORD = 'Sup3r-Secret-Relay-Pw';
const SECRET = 'https://erp.example/reset?token=ONE-TIME-TOKEN-123';
const ACTOR = 'MAIL-TEST';
const deliver = vi.mocked(deliverMail);

let client = '';
let other = '';
const saved: Record<string, string | undefined> = {};

function node(overrides: Record<string, unknown> = {}) {
  return {
    client, changedBy: ACTOR, host: 'smtp.example', port: 587, encryption: 'STARTTLS' as const,
    username: 'relay', password: PASSWORD, clearPassword: false,
    senderAddress: 'erp@example.com', senderName: 'ERP', isEnabled: true, ...overrides,
  };
}

const configRow = () => withTenant(client, async (tx) => (await tx.select().from(mailServerConfig).where(eq(mailServerConfig.client, client)))[0]);
const messageRow = (id: string) => withTenant(client, async (tx) => (await tx.select().from(mailMessage).where(eq(mailMessage.id, id)))[0]);
const send = (id: string) => withTenant(client, (tx) => sendOneMail(tx, client, id));
const enqueue = (overrides: Record<string, unknown> = {}) =>
  withTenant(client, (tx) =>
    enqueueMail(tx, { client, toAddress: 'user@example.com', subject: 'Hello', bodyText: 'Body', changedBy: ACTOR, ...overrides }),
  );
const enqueueReset = () => enqueue({ bodyText: 'Open this: {link}', secret: SECRET });

beforeAll(async () => {
  saved.ring = process.env.CAIRN_BANK_DATA_KEYRING_JSON;
  process.env.CAIRN_BANK_DATA_KEYRING_JSON = JSON.stringify({ activeKeyId: 'k1', keys: { k1: randomBytes(32).toString('base64url') } });
  client = (await createTenant('mail-a')).client;
  other = (await createTenant('mail-b')).client;
});

afterAll(async () => {
  if (saved.ring === undefined) delete process.env.CAIRN_BANK_DATA_KEYRING_JSON;
  else process.env.CAIRN_BANK_DATA_KEYRING_JSON = saved.ring;
  await destroyTenant(client);
  await destroyTenant(other);
});

beforeEach(async () => {
  deliver.mockReset();
  deliver.mockResolvedValue(undefined);
  await withTenant(client, async (tx) => {
    // cairn_app cannot delete from the queue (by design); retire earlier tests' rows so none is claimable.
    await tx.update(mailMessage).set({ status: 'DEAD' }).where(eq(mailMessage.client, client));
    await tx.delete(mailServerConfig).where(eq(mailServerConfig.client, client));
  });
});

describe('node configuration', () => {
  it('1. stores an encrypted password that does not contain the plaintext', async () => {
    await saveMailConfig(node(), CAP);
    const row = await configRow();
    expect(row.passwordEncrypted).toBeTruthy();
    expect(row.passwordEncrypted).not.toContain(PASSWORD);
  });

  it('2. an empty password keeps the stored value; clearPassword removes it', async () => {
    await saveMailConfig(node(), CAP);
    const first = (await configRow()).passwordEncrypted;
    await saveMailConfig(node({ password: '', host: 'smtp2.example' }), CAP);
    expect((await configRow()).passwordEncrypted).toBe(first);
    await saveMailConfig(node({ password: '', clearPassword: true }), CAP);
    expect((await configRow()).passwordEncrypted).toBeNull();
  });

  it('3. the view never carries the password and hasPassword tracks it', async () => {
    await saveMailConfig(node(), CAP);
    const view = await getMailConfig(client, CAP);
    expect(view.hasPassword).toBe(true);
    expect(JSON.stringify(view)).not.toContain(PASSWORD);
    expect(Object.keys(view)).not.toContain('passwordEncrypted');
    await saveMailConfig(node({ password: '', clearPassword: true }), CAP);
    expect((await getMailConfig(client, CAP)).hasPassword).toBe(false);
  });

  it('3b. the change document records passwordSet and no value', async () => {
    await saveMailConfig(node(), CAP);
    const rows = (await withTenant(client, (tx) =>
      tx.execute(sql`select i.field_name, i.old_value, i.new_value from change_document_item i
                      join change_document d on d.id = i.change_document_id
                     where d.client = ${client} and d.object_class = 'mail_server_config'`),
    )) as unknown as Array<{ field_name: string; old_value: string | null; new_value: string | null }>;
    expect(rows.find((r) => r.field_name === 'passwordSet')?.new_value).toBe('true');
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });

  it('4. isEnabled is refused without a host and without a sender address', async () => {
    await expect(saveMailConfig(node({ host: '' }), CAP)).rejects.toMatchObject({ code: 'MAIL_HOST_REQUIRED' });
    await expect(saveMailConfig(node({ senderAddress: '' }), CAP)).rejects.toMatchObject({ code: 'MAIL_SENDER_REQUIRED' });
  });

  it('requires CFG.PLT.MAIL.DEFINE on every entry point', async () => {
    await expect(getMailConfig(client, [])).rejects.toMatchObject({ code: 'MAIL_FORBIDDEN' });
    await expect(saveMailConfig(node(), [])).rejects.toMatchObject({ code: 'MAIL_FORBIDDEN' });
    await expect(listMailQueue(client, [])).rejects.toMatchObject({ code: 'MAIL_FORBIDDEN' });
    await expect(sendTestMail({ client, changedBy: ACTOR, toAddress: 'a@b.co' }, [])).rejects.toMatchObject({ code: 'MAIL_FORBIDDEN' });
  });
});

describe('enqueue', () => {
  it('5. refuses MAIL_NOT_CONFIGURED with no row, and with is_enabled = false', async () => {
    await expect(enqueue()).rejects.toMatchObject({ code: 'MAIL_NOT_CONFIGURED' });
    await saveMailConfig(node({ isEnabled: false }), CAP);
    await expect(enqueue()).rejects.toMatchObject({ code: 'MAIL_NOT_CONFIGURED' });
  });

  it('refuses an invalid address', async () => {
    await saveMailConfig(node(), CAP);
    for (const bad of ['', 'no-at-sign', 'a b@c.d', 'a@b.co, c@d.co', `${'x'.repeat(200)}@e.co`]) {
      await expect(enqueue({ toAddress: bad })).rejects.toBeInstanceOf(MailError);
      await expect(enqueue({ toAddress: bad })).rejects.toMatchObject({ code: 'MAIL_ADDRESS_INVALID' });
    }
  });

  it('6. with a secret the body holds {link} and the secret is only stored encrypted', async () => {
    await saveMailConfig(node(), CAP);
    const row = await messageRow(await enqueueReset());
    expect(row.bodyText).toContain('{link}');
    expect(row.bodyText).not.toContain('ONE-TIME-TOKEN');
    expect(row.secretEncrypted).toBeTruthy();
    expect(row.secretEncrypted).not.toContain('ONE-TIME-TOKEN');
    expect(JSON.stringify(row)).not.toContain('ONE-TIME-TOKEN');
  });

  it('sendTestMail queues and does not send inline', async () => {
    await saveMailConfig(node(), CAP);
    const { messageId } = await sendTestMail({ client, changedBy: ACTOR, toAddress: 'owner@example.com' }, CAP);
    expect(deliver).not.toHaveBeenCalled();
    expect((await messageRow(messageId)).status).toBe('QUEUED');
    expect((await configRow()).lastTestResult).toContain(messageId);
  });
});

describe('send and retry', () => {
  it('7. success -> SENT, secret nulled, and the substituted body reached the transport', async () => {
    await saveMailConfig(node(), CAP);
    const id = await enqueueReset();
    expect(await send(id)).toBe('SENT');
    const row = await messageRow(id);
    expect(row.status).toBe('SENT');
    expect(row.sentAt).not.toBeNull();
    expect(row.secretEncrypted).toBeNull();
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0][1].text).toBe(`Open this: ${SECRET}`);
    expect(deliver.mock.calls[0][0].password).toBe(PASSWORD);
    // a terminal row is not sent twice
    expect(await send(id)).toBe('SKIPPED');
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('8. failure -> FAILED, attempts 1, available_at in the future, secret kept, error free of the password', async () => {
    await saveMailConfig(node(), CAP);
    deliver.mockRejectedValue(new MailTransportError('EAUTH: 535 authentication failed'));
    const id = await enqueueReset();
    expect(await send(id)).toBe('FAILED');
    const row = await messageRow(id);
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(1);
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.secretEncrypted).not.toBeNull();
    expect(row.lastError).toContain('EAUTH');
    expect(row.lastError).not.toContain(PASSWORD);
  });

  it('an unrecognised error is stored as a generic code, never its message', async () => {
    await saveMailConfig(node(), CAP);
    deliver.mockRejectedValue(new Error(`boom with ${PASSWORD}`));
    const id = await enqueue();
    await send(id);
    const row = await messageRow(id);
    expect(row.lastError).toBe('MAIL_SEND_FAILED');
  });

  it('9. exhausted attempts -> DEAD and the secret is nulled', async () => {
    await saveMailConfig(node(), CAP);
    deliver.mockRejectedValue(new MailTransportError('ETIMEDOUT'));
    const id = await enqueue({ bodyText: 'x {link}', secret: SECRET, maxAttempts: 2 });
    expect(await send(id)).toBe('FAILED');
    expect(await send(id)).toBe('DEAD');
    const row = await messageRow(id);
    expect(row.status).toBe('DEAD');
    expect(row.attempts).toBe(2);
    expect(row.secretEncrypted).toBeNull();
    expect(await send(id)).toBe('SKIPPED');
  });

  it('10. the claim does not pick up a row whose available_at is in the future', async () => {
    await saveMailConfig(node(), CAP);
    const future = await enqueue({ subject: 'later' });
    const due = await enqueue({ subject: 'now' });
    await withTenant(client, (tx) =>
      tx.update(mailMessage).set({ availableAt: sql`now() + interval '1 hour'` }).where(eq(mailMessage.id, future)),
    );
    const result = await mailSendJob.chunk({ client, chunkSize: 25, cursor: null } as never);
    expect(result.processed).toBe(1);
    expect((await messageRow(due)).status).toBe('SENT');
    expect((await messageRow(future)).status).toBe('QUEUED');
  });

  it('a FAILED row whose time has come is claimed again, and one poisoned row does not stop the chunk', async () => {
    await saveMailConfig(node(), CAP);
    deliver.mockRejectedValueOnce(new MailTransportError('ECONNECTION'));
    const first = await enqueue({ subject: 'first' });
    const second = await enqueue({ subject: 'second' });
    await withTenant(client, (tx) => tx.update(mailMessage).set({ availableAt: sql`now() - interval '1 minute'` }).where(eq(mailMessage.id, second)));
    await mailSendJob.chunk({ client, chunkSize: 25, cursor: null } as never);
    const failed = (await messageRow(first)).status === 'FAILED' ? first : second;
    const ok = failed === first ? second : first;
    expect((await messageRow(ok)).status).toBe('SENT');
    await withTenant(client, (tx) => tx.update(mailMessage).set({ availableAt: sql`now() - interval '1 second'` }).where(eq(mailMessage.id, failed)));
    await mailSendJob.chunk({ client, chunkSize: 25, cursor: null } as never);
    expect((await messageRow(failed)).status).toBe('SENT');
  });

  it('11. the whole retry window is well under the 60-minute token lifetime', () => {
    expect([1, 2, 3, 4, 5].map(retryDelaySeconds)).toEqual([30, 60, 120, 240, 300]);
    const window = [1, 2, 3, 4].reduce((sum, n) => sum + retryDelaySeconds(n), 0);
    expect(window).toBeLessThan(30 * 60);
  });
});

describe('isolation and grants', () => {
  it('12. a message in one tenant is invisible to another', async () => {
    await saveMailConfig(node(), CAP);
    const id = await enqueue();
    const seen = await withTenant(other, (tx) => tx.select().from(mailMessage).where(eq(mailMessage.id, id)));
    expect(seen).toHaveLength(0);
    expect(await listMailQueue(other, CAP)).toHaveLength(0);
    expect((await listMailQueue(client, CAP)).map((r) => r.id)).toContain(id);
  });

  it('13. cairn_app holds SELECT, INSERT, UPDATE on mail_message and no DELETE', async () => {
    const rows = (await withTenant(client, (tx) =>
      tx.execute(sql`select privilege_type from information_schema.role_table_grants
                      where table_name = 'mail_message' and grantee = 'cairn_app' order by 1`),
    )) as unknown as Array<{ privilege_type: string }>;
    expect(rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });
});
