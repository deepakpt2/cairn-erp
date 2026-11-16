import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { getMailConfig, listMailQueue, MAIL_DEFINE_CAPABILITY } from '@/platform/mail/service';
import { NodeForm, TestPanel } from './MailForms';

export const dynamic = 'force-dynamic';

const QUEUE_LIMIT = 50;

export default async function MailPage() {
  const session = await requireSession('/platform/mail');
  const allowed = can(session, MAIL_DEFINE_CAPABILITY);
  const client = session.user.client;
  const caps = session.user.capabilities;
  const config = allowed ? await getMailConfig(client, caps) : null;
  const queue = allowed ? await listMailQueue(client, caps, QUEUE_LIMIT) : [];

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{MAIL_DEFINE_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Mail server configuration</h1>
          <Link href="/" className="btn btn-default">Launchpad</Link>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft">
          One outbound mail node per tenant. Messages are queued and sent by the MAIL.SEND job every five minutes; nothing is sent from a request.
        </p>
      </header>

      {!config ? (
        <p role="alert" className="text-sm text-signal-error">This screen needs {MAIL_DEFINE_CAPABILITY}, which this session does not hold.</p>
      ) : (
        <>
          <NodeForm config={config} />
          <TestPanel config={config} />
          <section className="panel overflow-x-auto">
            <div className="panel-header">
              <h2 className="panel-title">Send queue</h2>
              <span className="text-2xs text-ink-faint tabular">last {QUEUE_LIMIT}</span>
            </div>
            {queue.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">No messages have been queued.</p>
            ) : (
              <table className="grid-table">
                <thead>
                  <tr><th>Created</th><th>To</th><th>Subject</th><th>Status</th><th className="text-end">Attempts</th><th>Last error</th></tr>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </main>
  );
}
