import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/document-reversal';
export const DOCUMENT_REVERSE_CAPABILITY = 'FIN.DOCUMENT.REVERSE';

const selectSchema = z.object({
  companyCode: z.string().trim().min(1).max(10),
  documentNumber: z.string().trim().min(1).max(40),
  fiscalYear: z.coerce.number().int().min(1900).max(9999),
});

const reverseSchema = selectSchema.extend({
  reasonCode: z.string().trim().min(2).max(2),
  documentDate: z.string().trim().min(1).max(10),
  postingDate: z.string().trim().min(1).max(10),
  confirmed: z.enum(['yes']),
  requestKey: z.string().trim().min(1).max(64),
});

// The reversal service lands in a later stage (R-120). Until it stands,
// the screen renders, selects and displays nothing persisted, and every
// attempt is refused by name instead of dialling out.
export class DocumentReversalNotConnected extends Error {
  constructor() {
    super('The reversal service is not yet connected; this screen stands inert until the service lands.');
  }
}

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

  let notConnected = false;
  if (selected.success) {
    // G01: no database access until the service stage lands.
    notConnected = true;
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
      throw new DocumentReversalNotConnected();
    } catch (e) {
      if (e instanceof DocumentReversalNotConnected) {
        const q = new URLSearchParams({
          companyCode: parsed.data.companyCode, documentNumber: parsed.data.documentNumber,
          fiscalYear: String(parsed.data.fiscalYear), error: e.message,
        });
        redirect(`${ROUTE}?${q}`);
      }
      throw e;
    }
  }

  const done = typeof sp.reversed === 'string' ? sp.reversed : null;
  const actionError = typeof sp.error === 'string' ? sp.error : null;

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
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
        {notConnected && (
          <p className="mt-3 text-sm text-ink-soft" role="note">
            The reversal service is not yet connected; the original document cannot be displayed yet.
          </p>
        )}
      </section>

      {selected.success && (
        <section aria-labelledby="dr-review" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="dr-review" className="text-sm font-semibold">
            Reverse document {selected.data.documentNumber} ({String(selected.data.fiscalYear)})
          </h2>
          <p className="mt-2 text-sm text-ink-soft">
            Reversal posts a mirror document of type AB against the original: every line returns
            with debit and credit swapped, and the original stands marked reversed. A document whose
            lines stand cleared, or which itself stands as a clearing document, is refused — reset the
            clearing first (Reset Cleared Items). The reversal posting period follows the posting date
            through the company fiscal-year variant; the document date stands free.
          </p>

          {grant && (
            <form action={doReverse} className="mt-4 grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="companyCode" value={selected.data.companyCode} />
              <input type="hidden" name="documentNumber" value={selected.data.documentNumber} />
              <input type="hidden" name="fiscalYear" value={selected.data.fiscalYear} />
              <input type="hidden" name="requestKey" value={`dr-${selected.data.companyCode}-${selected.data.documentNumber}-${selected.data.fiscalYear}`} />
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reversal reason (required, standing code)</span>
                <input name="reasonCode" className="input w-full" maxLength={2} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reversal document date</span>
                <input name="documentDate" type="date" defaultValue={today} className="input w-full" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reversal posting date</span>
                <input name="postingDate" type="date" defaultValue={today} className="input w-full" required />
              </label>
              <label className="flex items-end gap-2">
                <input type="checkbox" name="confirmed" value="yes" required className="size-4" />
                <span className="text-sm">I confirm the reversal of this document</span>
              </label>
              <div className="flex items-end">
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Reverse document</button>
              </div>
            </form>
          )}
          {actionError && <p className="mt-3 text-sm text-danger" role="alert">{actionError}</p>}
        </section>
      )}

      <section aria-labelledby="dr-result" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="dr-result" className="text-sm font-semibold">Reversal</h2>
        {done ? (
          <p className="mt-2 text-sm text-ink-soft">
            Reversal document {done} stands posted; the original stands marked reversed, and the
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
