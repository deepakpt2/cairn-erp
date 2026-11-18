
import { can, requireSession } from '@/platform/auth/current';
import { getMailConfig, listMailQueue, MAIL_DEFINE_CAPABILITY } from '@/platform/mail/service';
import { isSelfServiceResetEnabled } from '@/modules/platform/user-admin';
import { withTenant } from '@/platform/db/client';
import { DeleteMessageButton, FlushButton, NodeForm, PasswordResetPanel, TestPanel } from './MailForms';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const QUEUE_LIMIT = 50;

export default async function MailPage() {
  const session = await requireSession('/platform/mail');
  const allowed = can(session, MAIL_DEFINE_CAPABILITY);
  const client = session.user.client;
  const caps = session.user.capabilities;
  const config = allowed ? await getMailConfig(client, caps) : null;
  const queue = allowed ? await listMailQueue(client, caps, QUEUE_LIMIT) : [];
  const selfService = allowed ? await withTenant(client, (tx) => isSelfServiceResetEnabled(tx, client)) : false;

  return (
    <Page
      title="Mail server configuration" code={MAIL_DEFINE_CAPABILITY} back={null}
      description="One outbound mail node per tenant. Messages are queued and sent by the MAIL.SEND job every five minutes, or at once with Flush queue."
      actions={
        <>
          <LinkButton href="/">Launchpad</LinkButton>
        </>
      }
    >

      {!config ? (
        <p role="alert" className="text-sm text-signal-error">This screen needs {MAIL_DEFINE_CAPABILITY}, which this session does not hold.</p>
      ) : (
        <>
          <NodeForm config={config} />
          <TestPanel config={config} />
          <PasswordResetPanel enabled={selfService} canMaintain={can(session, 'CFG.PLT.USER.MAINTAIN')} mailEnabled={config.isEnabled} />
          <section className="panel overflow-x-auto">
            <div className="panel-header">
              <h2 className="panel-title">Send queue</h2>
              <FlushButton />
              <span className="text-2xs text-ink-faint tabular">last {QUEUE_LIMIT}</span>
            </div>
            {queue.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">No messages have been queued.</p>
            ) : (
              <table className="grid-table">
                <thead>
                  <tr><th>Created</th><th>To</th><th>Subject</th><th>Status</th><th className="text-end">Attempts</th><th>Last error</th><th></th></tr>
                </thead>
                <tbody>
                  {queue.map((m) => (
                    <tr key={m.id}>
                      <td className="tabular whitespace-nowrap">{m.createdAt.slice(0, 19).replace('T', ' ')}</td>
                      <td>{m.toAddress}</td>
                      <td>{m.subject}</td>
                      <td><span className={`chip ${m.status === 'SENT' ? 'chip-ok' : m.status === 'QUEUED' ? 'chip-neutral' : 'chip-error'}`}>{m.status}</span></td>
                      <td className="text-end tabular">{m.attempts}/{m.maxAttempts}</td>
                      <td className="text-xs text-ink-soft">{m.lastError ?? '—'}</td>
                      <td><DeleteMessageButton messageId={m.id} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </Page>
  );
}
