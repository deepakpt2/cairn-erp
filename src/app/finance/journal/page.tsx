import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { t } from '@/platform/i18n';
import { withTenant } from '@/platform/db/client';
import { requireSession } from '@/platform/auth/current';

export const dynamic = 'force-dynamic';

interface JournalRow {
  document_number: string;
  display_number: string;
  fiscal_year: number;
  document_type: string;
  company_code: string;
  posting_date: string;
  posting_period: number;
  currency: string;
  header_text: string | null;
  status: string;
  reversed_by: string | null;
  total: string;
  line_count: string;
}

/**
 * Accounting document list — FIN.JOURNAL.DISPLAY
 *
 * Shows the invariant rather than claiming it: every document here was accepted
 * only because its debits equalled its credits, and that was checked twice — once
 * by the engine, once by the database at commit.
 */
export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; document?: string }>;
}) {
  const params = await searchParams;
  // The tenant comes from the session, never from the query string. A `?client=`
  // override here would let a signed-in user of one tenant read another's books.
  const session = await requireSession();
  const client = session.user.client;

  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`
      select h.document_number, h.display_number, h.fiscal_year, h.document_type, h.company_code,
             h.posting_date, h.posting_period, h.document_currency as currency,
             h.header_text, h.status, h.reversed_by,
             coalesce(sum(case when l.debit_credit = 'S' then l.amount_local end), 0)::text as total,
             count(l.line_number)::text as line_count
      from journal_entry h
      left join journal_entry_line l
        on l.client = h.client
       and l.document_number = h.document_number
       and l.fiscal_year = h.fiscal_year
      where h.client = ${client}
      group by h.document_number, h.display_number, h.fiscal_year, h.document_type, h.company_code,
               h.posting_date, h.posting_period, h.document_currency, h.header_text,
               h.status, h.reversed_by
      order by h.posting_date desc, h.document_number desc
      limit 200
    `),
  )) as unknown as JournalRow[];

  const detail = params.document
    ? await withTenant(client, async (tx) => {
        const header = (await tx.execute(sql`
          select * from journal_entry
          where client = ${client} and document_number = ${params.document}
          limit 1
        `)) as unknown as Array<Record<string, string>>;

        if (header.length === 0) return null;

        const lines = (await tx.execute(sql`
          select line_number, gl_account, debit_credit, amount_local, currency,
                 cost_center, profit_center, business_partner, line_text
          from journal_entry_line
          where client = ${client} and document_number = ${params.document}
          order by line_number
        `)) as unknown as Array<Record<string, string>>;

        return { header: header[0], lines };
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-4 border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.JOURNAL.DISPLAY</span>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{t('journal.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('journal.subtitle')}</p>
      </header>

      {detail && (
        <section className="panel mb-4 overflow-hidden">
          <div className="panel-header">
            <h2 className="panel-title">
              {t('journal.details')} · <span className="code">{detail.header.display_number || detail.header.document_number}</span>
            </h2>
            <Link href={`/finance/journal`} className="text-sm text-accent hover:underline">
              {t('common.close')}
            </Link>
          </div>
          <div className="grid gap-3 border-b border-line p-3 sm:grid-cols-4">
            <Field label={t('journal.type')} value={detail.header.document_type} />
            <Field label={t('cc.code')} value={detail.header.company_code} />
            <Field label={t('journal.date')} value={detail.header.posting_date} />
            <Field label={t('journal.period')} value={`${detail.header.posting_period} / ${detail.header.fiscal_year}`} />
          </div>
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-12">#</th>
                <th className="w-24">{t('gl.number')}</th>
                <th className="w-16">D/C</th>
                <th className="w-32 text-end">{t('journal.amount')}</th>
                <th className="w-28">Cost centre</th>
                <th>Text</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((line) => (
                <tr key={line.line_number}>
                  <td className="tabular text-ink-faint">{line.line_number}</td>
                  <td className="code">{line.gl_account}</td>
                  <td>
                    <span className={line.debit_credit === 'S' ? 'text-signal-info' : 'text-signal-warn'}>
                      {line.debit_credit === 'S' ? 'Debit' : 'Credit'}
                    </span>
                  </td>
                  <td className="tabular text-end">
                    {Number(line.amount_local).toFixed(2)}
                  </td>
                  <td className="code text-ink-soft">{line.cost_center ?? '—'}</td>
                  <td className="text-ink-soft">{line.line_text ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-line bg-sunken px-3 py-2 text-2xs text-ink-faint">
            Balances because debits equal credits. The database refuses the commit if they do not —
            an unbalanced document cannot exist, even if written directly in SQL.
          </p>
        </section>
      )}

      {rows.length === 0 ? (
        <div className="panel p-8 text-center">
          <p className="text-sm font-medium">{t('journal.empty')}</p>
          <p className="mt-1 text-sm text-ink-soft">{t('journal.emptyHint')}</p>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          <div className="panel-header">
            <h2 className="panel-title">{t('journal.title')}</h2>
            <span className="text-2xs text-ink-faint">{rows.length}</span>
          </div>
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-44">{t('journal.number')}</th>
                <th className="w-20">{t('cc.code')}</th>
                <th className="w-16">{t('journal.type')}</th>
                <th className="w-32">{t('journal.date')}</th>
                <th className="w-20">{t('journal.period')}</th>
                <th>{t('journal.lines')}</th>
                <th className="w-32 text-end">{t('journal.amount')}</th>
                <th className="w-24">{t('journal.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.document_number}-${row.fiscal_year}`}>
                  <td>
                    <Link
                      href={`/finance/journal?document=${encodeURIComponent(row.document_number)}`}
                      className="code text-accent hover:underline"
                    >
                      {row.display_number || row.document_number}
                    </Link>
                  </td>
                  <td className="code text-ink-soft">{row.company_code}</td>
                  <td className="code text-ink-soft">{row.document_type}</td>
                  <td className="tabular text-ink-soft">{row.posting_date}</td>
                  <td className="tabular text-ink-soft">{row.posting_period}</td>
                  <td className="text-ink-soft">{row.header_text ?? '—'}</td>
                  <td className="tabular text-end">{Number(row.total).toFixed(2)}</td>
                  <td>
                    <span className={`chip ${row.status === 'POSTED' ? 'chip-ok' : 'chip-warn'}`}>
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="code">{value}</p>
    </div>
  );
}
