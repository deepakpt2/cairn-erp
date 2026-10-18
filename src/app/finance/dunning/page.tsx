import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/dunning';
export const DUNNING_CAPABILITY = 'FIN.AR.DUNNING.RUN';

const paramsSchema = z.object({
  runDate: z.string().trim().min(1).max(10),
  runId: z.string().trim().min(1).max(6),
  dunningDate: z.string().trim().min(1).max(10),
  postedThrough: z.string().trim().min(1).max(10),
  companyCodes: z.string().trim().min(1).max(120),
  customerFrom: z.string().trim().max(10).optional(),
  customerTo: z.string().trim().max(10).optional(),
});

const executeSchema = paramsSchema.extend({
  confirmed: z.enum(['yes']),
});

// The dunning service lands in a later stage (R-122). Until it stands,
// the screen renders, takes run parameters and displays nothing
// persisted, and every attempt is refused by name instead of dialling out.
export class DunningNotConnected extends Error {
  constructor() {
    super('The dunning service is not yet connected; this screen stands inert until the service lands.');
  }
}

/** Dunning programme (SCR-074 / F150 as a search alias only). */
export default async function DunningPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const sp = await searchParams;
  const grant = can(session, DUNNING_CAPABILITY);

  const selected = paramsSchema.safeParse({
    runDate: sp.runDate, runId: sp.runId, dunningDate: sp.dunningDate,
    postedThrough: sp.postedThrough, companyCodes: sp.companyCodes,
    customerFrom: sp.customerFrom || undefined, customerTo: sp.customerTo || undefined,
  });

  let notConnected = false;
  if (selected.success) {
    // G01: no database access until the service stage lands.
    notConnected = true;
  }

  async function doExecute(formData: FormData) {
    'use server';
    const s = await requireSession(ROUTE);
    if (!can(s, DUNNING_CAPABILITY)) return;
    const parsed = executeSchema.safeParse({
      runDate: formData.get('runDate'), runId: formData.get('runId'),
      dunningDate: formData.get('dunningDate'), postedThrough: formData.get('postedThrough'),
      companyCodes: formData.get('companyCodes'),
      customerFrom: formData.get('customerFrom') || undefined,
      customerTo: formData.get('customerTo') || undefined,
      confirmed: formData.get('confirmed'),
    });
    if (!parsed.success) return;
    try {
      throw new DunningNotConnected();
    } catch (e) {
      if (e instanceof DunningNotConnected) {
        const q = new URLSearchParams({
          runDate: parsed.data.runDate, runId: parsed.data.runId,
          dunningDate: parsed.data.dunningDate, postedThrough: parsed.data.postedThrough,
          companyCodes: parsed.data.companyCodes, error: e.message,
        });
        redirect(`${ROUTE}?${q}`);
      }
      throw e;
    }
  }

  const actionError = typeof sp.error === 'string' ? sp.error : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AR.DUNNING.RUN · F150</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('dunningRun.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('dunningRun.subtitle')}</p>
      </header>

      {!grant && (
        <p className="rounded-card border border-line bg-surface p-4 text-sm text-ink-soft" role="note">
          The {DUNNING_CAPABILITY} capability stands required to run dunning.
        </p>
      )}

      <section aria-labelledby="dn-parameters" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="dn-parameters" className="text-sm font-semibold">Run parameters</h2>
        <form method="get" action={ROUTE} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Run date</span>
            <input name="runDate" type="date" className="input w-full" defaultValue={selected.success ? selected.data.runDate : today} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Identification (max 6)</span>
            <input name="runId" className="input w-full" placeholder="DUN001" maxLength={6} defaultValue={selected.success ? selected.data.runId : ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Dunning date</span>
            <input name="dunningDate" type="date" className="input w-full" defaultValue={selected.success ? selected.data.dunningDate : today} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Documents posted up to</span>
            <input name="postedThrough" type="date" className="input w-full" defaultValue={selected.success ? selected.data.postedThrough : today} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company codes (comma separated)</span>
            <input name="companyCodes" className="input w-full" placeholder="1000" defaultValue={selected.success ? selected.data.companyCodes : ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer from</span>
            <input name="customerFrom" className="input w-full" placeholder="C10000" defaultValue={selected.success ? (selected.data.customerFrom ?? '') : ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer to</span>
            <input name="customerTo" className="input w-full" placeholder="C99999" defaultValue={selected.success ? (selected.data.customerTo ?? '') : ''} />
          </label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Maintain parameters</button>
          </div>
        </form>
        {notConnected && (
          <p className="mt-3 text-sm text-ink-soft" role="note">
            The dunning service is not yet connected; no run can be proposed or finalized yet.
          </p>
        )}
        {actionError && <p className="mt-3 text-sm text-danger" role="alert">{actionError}</p>}
      </section>

      {selected.success && (
        <section aria-labelledby="dn-proposal" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="dn-proposal" className="text-sm font-semibold">
            Proposal for run {selected.data.runId} of {selected.data.runDate}
          </h2>
          <p className="mt-2 text-sm text-ink-soft">
            Selection gathers the customers' overdue items as of the dunning date — posted by the
            cutoff, uncleared, standing debit — and proposes the next dunning level from each
            item's completed history. An account carrying no dunning procedure stands excluded
            with its reason, never silently skipped. Finalization stands separate: it revalidates
            every item, writes one notice per account, and only then do levels advance. A dunning
            run posts no journal.
          </p>

          {grant && (
            <form action={doExecute} className="mt-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="runDate" value={selected.data.runDate} />
              <input type="hidden" name="runId" value={selected.data.runId} />
              <input type="hidden" name="dunningDate" value={selected.data.dunningDate} />
              <input type="hidden" name="postedThrough" value={selected.data.postedThrough} />
              <input type="hidden" name="companyCodes" value={selected.data.companyCodes} />
              <input type="hidden" name="customerFrom" value={selected.data.customerFrom ?? ''} />
              <input type="hidden" name="customerTo" value={selected.data.customerTo ?? ''} />
              <label className="flex items-end gap-2">
                <input type="checkbox" name="confirmed" value="yes" required className="size-4" />
                <span className="text-sm">I confirm this dunning run</span>
              </label>
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Execute run</button>
            </form>
          )}
        </section>
      )}

      <section aria-labelledby="dn-runs" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="dn-runs" className="text-sm font-semibold">Dunning runs</h2>
        <p className="mt-2 text-sm text-ink-soft">
          A completed run is history: its parameters, proposal, exceptions and notices stand
          preserved, never overwritten; a rerun stands as a new run identity.
        </p>
      </section>
    </div>
  );
}
