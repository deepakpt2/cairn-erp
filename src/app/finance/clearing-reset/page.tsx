import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { CLEARING_RESET_CAPABILITY, ClearingResetError, getClearingDocument, resetClearing } from '@/modules/finance/clearing-reset';
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/clearing-reset';

const selectSchema = z.object({
  companyCode: z.string().trim().min(1).max(10),
  clearingDocument: z.string().trim().min(1).max(40),
  fiscalYear: z.coerce.number().int().min(1900).max(9999),
});

const resetSchema = selectSchema.extend({
  reason: z.string().trim().min(1).max(500),
  requestKey: z.string().trim().min(1).max(64),
});

/** Reset cleared items (SCR-071 / FBRA as a search alias only). */
export default async function ClearingResetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const sp = await searchParams;
  const grant = can(session, CLEARING_RESET_CAPABILITY);

  const selected = selectSchema.safeParse({
    companyCode: sp.companyCode, clearingDocument: sp.clearingDocument, fiscalYear: sp.fiscalYear,
  });

  let view: Awaited<ReturnType<typeof getClearingDocument>> | null = null;
  let loadError: string | null = null;
  if (selected.success) {
    try {
      view = await getClearingDocument(session.user.client, selected.data);
    } catch (e) {
      loadError = e instanceof ClearingResetError ? e.message : 'The clearing could not be read.';
    }
  }

  async function doReset(formData: FormData) {
    'use server';
    const s = await requireSession(ROUTE);
    if (!can(s, CLEARING_RESET_CAPABILITY)) return;
    const parsed = resetSchema.safeParse({
      companyCode: formData.get('companyCode'), clearingDocument: formData.get('clearingDocument'),
      fiscalYear: formData.get('fiscalYear'), reason: formData.get('reason'), requestKey: formData.get('requestKey'),
    });
    if (!parsed.success) return;
    try {
      const r = await resetClearing({
        client: s.user.client, changedBy: s.user.username, ...parsed.data,
      });
      redirect(`${ROUTE}?companyCode=${encodeURIComponent(r.companyCode)}&clearingDocument=${encodeURIComponent(r.clearingDocument)}&fiscalYear=${r.fiscalYear}&reset=${encodeURIComponent(r.resetNumber)}`);
    } catch (e) {
      if (e instanceof ClearingResetError) {
        const q = new URLSearchParams({
          companyCode: parsed.data.companyCode, clearingDocument: parsed.data.clearingDocument,
          fiscalYear: String(parsed.data.fiscalYear), error: e.message,
        });
        redirect(`${ROUTE}?${q}`);
      }
      throw e;
    }
  }

  const done = typeof sp.reset === 'string' ? sp.reset : null;
  const actionError = typeof sp.error === 'string' ? sp.error : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.CLEARING.RESET · FBRA</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('clearingReset.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('clearingReset.subtitle')}</p>
      </header>

      {!grant && (
        <p className="rounded-card border border-line bg-surface p-4 text-sm text-ink-soft" role="note">
          The {CLEARING_RESET_CAPABILITY} capability stands required to reset cleared items.
        </p>
      )}

      <section aria-labelledby="cr-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cr-selection" className="text-sm font-semibold">Clearing document</h2>
        <form method="get" action={ROUTE} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-full" placeholder="1000" defaultValue={selected.success ? selected.data.companyCode : ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Clearing document</span>
            <input name="clearingDocument" className="input w-full" placeholder="1000/2026/1" defaultValue={selected.success ? selected.data.clearingDocument : ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Fiscal year</span>
            <input name="fiscalYear" className="input w-full" placeholder="2026" defaultValue={selected.success ? String(selected.data.fiscalYear) : ''} />
          </label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Display clearing</button>
          </div>
        </form>
        {loadError && <p className="mt-3 text-sm text-danger" role="alert">{loadError}</p>}
      </section>

      {view && (
        <section aria-labelledby="cr-review" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="cr-review" className="text-sm font-semibold">
            Cleared items — {view.documentType} document, posted {view.postingDate}, cleared on {view.clearingDate}
          </h2>
          {view.alreadyResetBy ? (
            <p className="mt-2 text-sm text-ink-soft">
              This clearing already stands reset by {view.alreadyResetBy}; the items stand open again.
            </p>
          ) : (
            <>
              <table className="mt-3 w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th className="py-1 pr-3">Document</th><th className="py-1 pr-3">Partner</th>
                    <th className="py-1 pr-3">Account</th><th className="py-1 pr-3">D/C</th>
                    <th className="py-1 pr-3 text-right">Amount {view.items[0]?.currency}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.items.map((i) => (
                    <tr key={`${i.documentNumber}-${i.lineNumber}`} className="border-b border-line/60">
                      <td className="py-1 pr-3">{i.documentNumber} / {i.lineNumber}</td>
                      <td className="py-1 pr-3">{i.businessPartner ?? '—'}</td>
                      <td className="py-1 pr-3">{i.glAccount}</td>
                      <td className="py-1 pr-3">{i.debitCredit}</td>
                      <td className="py-1 pr-3 text-right">{Number(i.amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-sm text-ink-soft">{view.items.length} cleared item(s) would stand open again.</p>

              {grant && (
                <form action={doReset} className="mt-4 grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="companyCode" value={view.companyCode} />
                  <input type="hidden" name="clearingDocument" value={view.clearingDocument} />
                  <input type="hidden" name="fiscalYear" value={view.fiscalYear} />
                  <input type="hidden" name="requestKey" value={`cr-${view.companyCode}-${view.clearingDocument}-${view.fiscalYear}`} />
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason (required)</span>
                    <input name="reason" className="input w-full" maxLength={500} required />
                  </label>
                  <div className="flex items-end">
                    <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Reset clearing</button>
                  </div>
                </form>
              )}
            </>
          )}
          {actionError && <p className="mt-3 text-sm text-danger" role="alert">{actionError}</p>}
        </section>
      )}

      <section aria-labelledby="cr-result" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cr-result" className="text-sm font-semibold">Reset</h2>
        {done ? (
          <p className="mt-2 text-sm text-ink-soft">
            Reset {done} stands recorded. The cleared items stand open again; the clearing
            document itself stands unchanged, and the reset stands on record with its reason.
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">
            Resetting lifts the clearing stamp from every item the document cleared; the items stand open again.
            No journal posts and no document changes — the reset itself stands on record with its reason.
          </p>
        )}
      </section>
    </div>
  );
}
