import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import {
  DOCUMENT_REVERSE_CAPABILITY,
  DocumentReversalError,
  getDocumentForReversal,
  reverseDocument,
} from '@/modules/finance/document-reversal';
import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession, displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { t } from '@/platform/i18n';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import { displayOnlyRemedy } from '@/ui/lock/remedy';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/document-reversal';

const selectSchema = z.object({
  companyCode: z.string().trim().min(1).max(10),
  documentNumber: z.string().trim().min(1).max(40),
  fiscalYear: z.coerce.number().int().min(1900).max(9999),
});

const reverseSchema = selectSchema.extend({
  reasonCode: z.string().trim().min(2).max(2),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  confirmed: z.enum(['yes']),
  requestKey: z.string().trim().min(1).max(64),
});

const fmt = (value: string) => Number(value).toLocaleString('en-GB', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Reverse accounting document (SCR-072 / FB08 as a search alias only). */
export default async function DocumentReversalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const sp = await searchParams;
  const grant = can(session, DOCUMENT_REVERSE_CAPABILITY);

  const selected = selectSchema.safeParse({
    companyCode: sp.companyCode, documentNumber: sp.documentNumber, fiscalYear: sp.fiscalYear,
  });
  const requestedPostingDate = typeof sp.postingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sp.postingDate)
    ? sp.postingDate
    : undefined;

  let view: Awaited<ReturnType<typeof getDocumentForReversal>> | null = null;
  let loadError: string | null = null;
  if (selected.success) {
    try {
      view = await getDocumentForReversal(session.user.client, {
        ...selected.data,
        reversalPostingDate: requestedPostingDate,
      });
    } catch (e) {
      loadError = e instanceof DocumentReversalError ? e.message : 'The document could not be read.';
    }
  }

  async function doReverse(formData: FormData) {
    'use server';
    const s = await requireSession(ROUTE);
    if (!can(s, DOCUMENT_REVERSE_CAPABILITY)) return;
    const parsed = reverseSchema.safeParse({
      companyCode: formData.get('companyCode'), documentNumber: formData.get('documentNumber'),
      fiscalYear: formData.get('fiscalYear'), reasonCode: formData.get('reasonCode'),
      documentDate: formData.get('documentDate'), postingDate: formData.get('postingDate'),
      confirmed: formData.get('confirmed'), requestKey: formData.get('requestKey'),
    });
    if (!parsed.success) return;
    try {
      await assertChangeForSession(s, {
        lockObject: 'ACCOUNTING_DOCUMENT',
        argument: `${parsed.data.companyCode}/${parsed.data.documentNumber}/${parsed.data.fiscalYear}`,
      });
      const r = await reverseDocument({
        client: s.user.client,
        changedBy: s.user.username,
        companyCode: parsed.data.companyCode,
        documentNumber: parsed.data.documentNumber,
        fiscalYear: parsed.data.fiscalYear,
        reasonCode: parsed.data.reasonCode,
        documentDate: parsed.data.documentDate,
        postingDate: parsed.data.postingDate,
        confirmed: true,
        requestKey: parsed.data.requestKey,
      });
      const q = new URLSearchParams({
        companyCode: r.companyCode,
        documentNumber: r.originalDocumentNumber,
        fiscalYear: String(r.originalFiscalYear),
        reversed: r.reversalDocumentNumber,
        reversalYear: String(r.reversalFiscalYear),
        reversalPeriod: String(r.reversalPostingPeriod),
      });
      redirect(`${ROUTE}?${q}`);
    } catch (e) {
      if (e instanceof DocumentReversalError || e instanceof EnqueueError) {
        const q = new URLSearchParams({
          companyCode: parsed.data.companyCode, documentNumber: parsed.data.documentNumber,
          fiscalYear: String(parsed.data.fiscalYear), postingDate: parsed.data.postingDate,
          error: e.remedy ? `${e.message} ${e.remedy}` : e.message,
        });
        redirect(`${ROUTE}?${q}`);
      }
      throw e;
    }
  }

  const done = typeof sp.reversed === 'string' ? sp.reversed : null;
  const reversalYear = typeof sp.reversalYear === 'string' ? sp.reversalYear : null;
  const reversalPeriod = typeof sp.reversalPeriod === 'string' ? sp.reversalPeriod : null;
  const actionError = typeof sp.error === 'string' ? sp.error : null;
  const today = new Date().toISOString().slice(0, 10);
  const documentDateDefault = typeof sp.documentDate === 'string' ? sp.documentDate : today;
  const postingDateDefault = requestedPostingDate ?? today;
  const reversalKey = view ? `${view.companyCode.trim()}/${view.documentNumber.trim()}/${view.fiscalYear}` : '';
  const changeLock = view && grant && view.canReverse
    ? await openChangeForSession(session, {
        lockObject: 'ACCOUNTING_DOCUMENT',
        argument: reversalKey,
        transactionCode: 'FIN.DOCUMENT.REVERSE',
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.DOCUMENT.REVERSE · FB08</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('documentReversal.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('documentReversal.subtitle')}</p>
      </header>

      {view && changeLock?.mode === 'CHANGE' && (
        <ChangeLock lockObject="ACCOUNTING_DOCUMENT" argument={reversalKey} />
      )}
      <LockNotice message={changeLock?.mode === 'DISPLAY' ? displayOnlyMessage(changeLock) : null} remedy={displayOnlyRemedy(changeLock)} />

      {!grant && (
        <p className="rounded-card border border-line bg-surface p-4 text-sm text-ink-soft" role="note">
          The {DOCUMENT_REVERSE_CAPABILITY} capability stands required to reverse documents.
        </p>
      )}

      <section aria-labelledby="dr-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="dr-selection" className="text-sm font-semibold">Accounting document</h2>
        <form method="get" action={ROUTE} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-full" placeholder="1000" defaultValue={selected.success ? selected.data.companyCode : ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document number</span>
            <input name="documentNumber" className="input w-full" placeholder="1000/2026/1" defaultValue={selected.success ? selected.data.documentNumber : ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Fiscal year</span>
            <input name="fiscalYear" className="input w-full" placeholder="2026" defaultValue={selected.success ? String(selected.data.fiscalYear) : ''} />
          </label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Display document</button>
          </div>
        </form>
        {loadError && <p className="mt-3 text-sm text-danger" role="alert">{loadError}</p>}
      </section>

      {view && (
        <section aria-labelledby="dr-review" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="dr-review" className="text-sm font-semibold">
            {view.documentType} document {view.documentNumber} — {view.status}
          </h2>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs uppercase tracking-wide text-ink-faint">Document date</dt><dd>{view.documentDate}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-ink-faint">Posting date</dt><dd>{view.postingDate}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-ink-faint">Posting period</dt><dd>{view.fiscalYear} / {view.postingPeriod}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-ink-faint">Currency</dt><dd>{view.documentCurrency} (local {view.localCurrency})</dd></div>
          </dl>
          {view.headerText && <p className="mt-2 text-sm text-ink-soft">{view.headerText}</p>}
          {view.reversalOf && (
            <p className="mt-2 text-sm text-ink-soft">This document is a reversal of {view.reversalOf}.</p>
          )}
          {view.standingReversal ? (
            <p className="mt-2 text-sm text-ink-soft">
              Reversed by {view.standingReversal.reversalDocumentNumber} ({view.standingReversal.reversalFiscalYear}),
              reason {view.standingReversal.reasonCode}, posted {view.standingReversal.reversalPostingDate}.
            </p>
          ) : view.reversedBy ? (
            <p className="mt-2 text-sm text-ink-soft">Reversed by {view.reversedBy}.</p>
          ) : null}

          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1 pr-3">Line</th><th className="py-1 pr-3">Account</th>
                <th className="py-1 pr-3">Partner</th><th className="py-1 pr-3">D/C</th>
                <th className="py-1 pr-3 text-right">Amount {view.documentCurrency}</th>
                <th className="py-1 pr-3 text-right">Local {view.localCurrency}</th>
                <th className="py-1 pr-3">Clearing</th>
              </tr>
            </thead>
            <tbody>
              {view.lines.map((l) => (
                <tr key={l.lineNumber} className="border-b border-line/60">
                  <td className="py-1 pr-3">{l.lineNumber}</td>
                  <td className="py-1 pr-3">{l.glAccount}</td>
                  <td className="py-1 pr-3">{l.businessPartner ?? '—'}</td>
                  <td className="py-1 pr-3">{l.debitCredit}</td>
                  <td className="py-1 pr-3 text-right">{fmt(l.amountDocument)}</td>
                  <td className="py-1 pr-3 text-right">{fmt(l.amountLocal)}</td>
                  <td className="py-1 pr-3">{l.clearingDocument ? `${l.clearingDocument}${l.clearingDate ? ` · ${l.clearingDate}` : ''}` : 'Open'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-sm text-ink-soft">
            Debits {fmt(view.debitTotalDocument)} / credits {fmt(view.creditTotalDocument)} {view.documentCurrency};
            {' '}{view.clearedLineCount} cleared line(s), clearing document for {view.clearsItemCount} item(s).
          </p>

          {!view.canReverse && view.refusal && (
            <div className="mt-3">
              <p className="text-sm text-danger" role="alert">{view.refusal}</p>
              {view.refusalRemedy && <p className="mt-1 text-sm text-ink-soft">{view.refusalRemedy}</p>}
            </div>
          )}

          {view.canReverse && grant && (
            <>
              <form method="get" action={ROUTE} className="mt-4 flex flex-wrap items-end gap-3">
                <input type="hidden" name="companyCode" value={view.companyCode} />
                <input type="hidden" name="documentNumber" value={view.documentNumber} />
                <input type="hidden" name="fiscalYear" value={view.fiscalYear} />
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Check posting date</span>
                  <input name="postingDate" type="date" defaultValue={postingDateDefault} className="input" />
                </label>
                <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Derive period</button>
              </form>
              {view.reversalPostingPeriod !== null && (
                <p className="mt-2 text-sm text-ink-soft">
                  Posting date {requestedPostingDate} falls in fiscal year {view.reversalFiscalYear}, period {view.reversalPostingPeriod},
                  derived through the company fiscal-year variant.
                </p>
              )}
              {view.reversalPeriodError && (
                <p className="mt-2 text-sm text-danger" role="alert">{view.reversalPeriodError}</p>
              )}

              {view.reasons.length === 0 ? (
                <p className="mt-4 text-sm text-danger" role="alert">
                  No active reversal reason stands configured for this tenant.
                </p>
              ) : (
                <form action={doReverse} className="mt-4 grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="companyCode" value={view.companyCode} />
                  <input type="hidden" name="documentNumber" value={view.documentNumber} />
                  <input type="hidden" name="fiscalYear" value={view.fiscalYear} />
                  <input type="hidden" name="requestKey" value={`dr-${view.companyCode}-${view.documentNumber}-${view.fiscalYear}`} />
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reversal reason (required)</span>
                    <select name="reasonCode" className="input w-full" required defaultValue={view.reasons[0].code}>
                      {view.reasons.map((r) => (
                        <option key={r.code} value={r.code}>{r.code} — {r.description}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reversal document date</span>
                    <input name="documentDate" type="date" defaultValue={documentDateDefault} className="input w-full" required />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reversal posting date</span>
                    <input name="postingDate" type="date" defaultValue={postingDateDefault} className="input w-full" required />
                  </label>
                  <label className="flex items-end gap-2">
                    <input type="checkbox" name="confirmed" value="yes" required className="size-4" />
                    <span className="text-sm">I confirm the reversal of this document</span>
                  </label>
                  <div className="flex items-end">
                    <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={changeLock?.mode !== 'CHANGE'}>Reverse document</button>
                  </div>
                </form>
              )}
            </>
          )}
          {actionError && <p className="mt-3 text-sm text-danger" role="alert">{actionError}</p>}
        </section>
      )}

      <section aria-labelledby="dr-result" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="dr-result" className="text-sm font-semibold">Reversal</h2>
        {done ? (
          <p className="mt-2 text-sm text-ink-soft">
            Reversal document {done}{reversalYear ? ` (${reversalYear})` : ''} stands posted as type AB
            {reversalPeriod ? ` in period ${reversalPeriod}` : ''}; the original stands marked reversed, and the
            pair stands linked with its reason.
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">
            Reversing posts a new mirror document against the original and never edits or deletes
            a posted document; exactly one reversal ever stands against an original.
          </p>
        )}
      </section>
    </div>
  );
}
