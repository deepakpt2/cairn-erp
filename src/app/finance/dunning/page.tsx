import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  DUNNING_CAPABILITY, DunningError, cancelDunningRun, excludeDunningAccount,
  finalizeDunningRun, getDunningRun, listDunningRuns, proposeDunningRun,
  type DunningRunView,
} from '@/modules/finance/dunning';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/dunning';

const paramsSchema = z.object({
  runDate: z.string().trim().min(1).max(10),
  runId: z.string().trim().min(1).max(6),
  dunningDate: z.string().trim().min(1).max(10),
  postedThrough: z.string().trim().min(1).max(10),
  companyCodes: z.string().trim().min(1).max(120),
  customerFrom: z.string().trim().max(10).optional(),
  customerTo: z.string().trim().max(10).optional(),
});

function backTo(data: Record<string, string>, extra: Record<string, string>): never {
  const q = new URLSearchParams({ ...data, ...extra });
  redirect(`${ROUTE}?${q}`);
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
  const client = session.user.client;

  const selected = paramsSchema.safeParse({
    runDate: sp.runDate, runId: sp.runId, dunningDate: sp.dunningDate,
    postedThrough: sp.postedThrough, companyCodes: sp.companyCodes,
    customerFrom: sp.customerFrom || undefined, customerTo: sp.customerTo || undefined,
  });

  let view: DunningRunView | null = null;
  if (typeof sp.runDate === 'string' && typeof sp.runId === 'string') {
    view = await getDunningRun(client, sp.runDate, sp.runId.toUpperCase());
  }
  const runs = await listDunningRuns(client);

  async function doPropose(formData: FormData) {
    'use server';
    const s = await requireSession(ROUTE);
    if (!can(s, DUNNING_CAPABILITY)) return;
    const parsed = paramsSchema.extend({ confirmed: z.enum(['yes']) }).safeParse({
      runDate: formData.get('runDate'), runId: formData.get('runId'),
      dunningDate: formData.get('dunningDate'), postedThrough: formData.get('postedThrough'),
      companyCodes: formData.get('companyCodes'),
      customerFrom: formData.get('customerFrom') || undefined,
      customerTo: formData.get('customerTo') || undefined,
      confirmed: formData.get('confirmed'),
    });
    if (!parsed.success) return;
    const base = {
      runDate: parsed.data.runDate, runId: parsed.data.runId.toUpperCase(),
      dunningDate: parsed.data.dunningDate, postedThrough: parsed.data.postedThrough,
      companyCodes: parsed.data.companyCodes,
      customerFrom: parsed.data.customerFrom ?? '', customerTo: parsed.data.customerTo ?? '',
    };
    try {
      const result = await proposeDunningRun({
        client: s.user.client, changedBy: s.user.username,
        runDate: base.runDate, runId: base.runId, dunningDate: base.dunningDate,
        postedThrough: base.postedThrough,
        companyCodes: base.companyCodes.split(',').map((c) => c.trim()).filter(Boolean),
        customerFrom: parsed.data.customerFrom, customerTo: parsed.data.customerTo,
      });
      backTo(base, { done: `Run ${result.runId} of ${result.runDate} stands proposed: ${result.accounts.filter((a) => a.status === 'PROPOSED').length} account(s) proposed, ${result.accounts.filter((a) => a.status === 'EXCLUDED').length} excluded.` });
    } catch (e) {
      if (e instanceof DunningError) backTo(base, { error: e.remedy ? `${e.message} ${e.remedy}` : e.message });
      throw e;
    }
  }

  async function doFinalize(formData: FormData) {
    'use server';
    const s = await requireSession(ROUTE);
    if (!can(s, DUNNING_CAPABILITY)) return;
    const base = {
      runDate: String(formData.get('runDate') ?? ''), runId: String(formData.get('runId') ?? ''),
      dunningDate: String(formData.get('dunningDate') ?? ''), postedThrough: String(formData.get('postedThrough') ?? ''),
      companyCodes: String(formData.get('companyCodes') ?? ''),
      customerFrom: String(formData.get('customerFrom') ?? ''), customerTo: String(formData.get('customerTo') ?? ''),
    };
    try {
      const result = await finalizeDunningRun({
        client: s.user.client, changedBy: s.user.username,
        runDate: base.runDate, runId: base.runId,
        confirmed: formData.get('confirmed') === 'yes',
      });
      backTo(base, { done: `Run ${result.runId} of ${result.runDate} stands completed: ${result.notices.length} notice(s) written.` });
    } catch (e) {
      if (e instanceof DunningError) backTo(base, { error: e.remedy ? `${e.message} ${e.remedy}` : e.message });
      throw e;
    }
  }

  async function doExclude(formData: FormData) {
    'use server';
    const s = await requireSession(ROUTE);
    if (!can(s, DUNNING_CAPABILITY)) return;
    const base = {
      runDate: String(formData.get('runDate') ?? ''), runId: String(formData.get('runId') ?? ''),
      dunningDate: String(formData.get('dunningDate') ?? ''), postedThrough: String(formData.get('postedThrough') ?? ''),
      companyCodes: String(formData.get('companyCodes') ?? ''),
      customerFrom: String(formData.get('customerFrom') ?? ''), customerTo: String(formData.get('customerTo') ?? ''),
    };
    try {
      await excludeDunningAccount({
        client: s.user.client, changedBy: s.user.username,
        runDate: base.runDate, runId: base.runId,
        companyCode: String(formData.get('companyCode') ?? ''),
        customer: String(formData.get('customer') ?? ''),
      });
      backTo(base, { done: `Account ${String(formData.get('customer') ?? '')} stands excluded from run ${base.runId}.` });
    } catch (e) {
      if (e instanceof DunningError) backTo(base, { error: e.message });
      throw e;
    }
  }

  async function doCancel(formData: FormData) {
    'use server';
    const s = await requireSession(ROUTE);
    if (!can(s, DUNNING_CAPABILITY)) return;
    const base = {
      runDate: String(formData.get('runDate') ?? ''), runId: String(formData.get('runId') ?? ''),
      dunningDate: String(formData.get('dunningDate') ?? ''), postedThrough: String(formData.get('postedThrough') ?? ''),
      companyCodes: String(formData.get('companyCodes') ?? ''),
      customerFrom: String(formData.get('customerFrom') ?? ''), customerTo: String(formData.get('customerTo') ?? ''),
    };
    try {
      await cancelDunningRun({
        client: s.user.client, changedBy: s.user.username, runDate: base.runDate, runId: base.runId,
      });
      backTo(base, { done: `Run ${base.runId} of ${base.runDate} stands cancelled; its proposal is preserved.` });
    } catch (e) {
      if (e instanceof DunningError) backTo(base, { error: e.message });
      throw e;
    }
  }

  const done = typeof sp.done === 'string' ? sp.done : null;
  const actionError = typeof sp.error === 'string' ? sp.error : null;
  const today = new Date().toISOString().slice(0, 10);
  const paramDefaults = {
    runDate: view?.runDate ?? (selected.success ? selected.data.runDate : today),
    runId: view?.runId ?? (selected.success ? selected.data.runId : ''),
    dunningDate: view?.dunningDate ?? (selected.success ? selected.data.dunningDate : today),
    postedThrough: view?.postedThroughDate ?? (selected.success ? selected.data.postedThrough : today),
    companyCodes: view ? view.companies.join(',') : (selected.success ? selected.data.companyCodes : ''),
    customerFrom: view?.customerFrom ?? (selected.success ? (selected.data.customerFrom ?? '') : ''),
    customerTo: view?.customerTo ?? (selected.success ? (selected.data.customerTo ?? '') : ''),
  };
  const hiddenParams = (
    <>
      <input type="hidden" name="runDate" value={paramDefaults.runDate} />
      <input type="hidden" name="runId" value={paramDefaults.runId} />
      <input type="hidden" name="dunningDate" value={paramDefaults.dunningDate} />
      <input type="hidden" name="postedThrough" value={paramDefaults.postedThrough} />
      <input type="hidden" name="companyCodes" value={paramDefaults.companyCodes} />
      <input type="hidden" name="customerFrom" value={paramDefaults.customerFrom} />
      <input type="hidden" name="customerTo" value={paramDefaults.customerTo} />
    </>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
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
            <input name="runDate" type="date" className="input w-full" defaultValue={paramDefaults.runDate} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Identification (max 6)</span>
            <input name="runId" className="input w-full" placeholder="DUN001" maxLength={6} defaultValue={paramDefaults.runId} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Dunning date</span>
            <input name="dunningDate" type="date" className="input w-full" defaultValue={paramDefaults.dunningDate} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Documents posted up to</span>
            <input name="postedThrough" type="date" className="input w-full" defaultValue={paramDefaults.postedThrough} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company codes (comma separated)</span>
            <input name="companyCodes" className="input w-full" placeholder="1000" defaultValue={paramDefaults.companyCodes} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer from</span>
            <input name="customerFrom" className="input w-full" placeholder="C10000" defaultValue={paramDefaults.customerFrom} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer to</span>
            <input name="customerTo" className="input w-full" placeholder="C99999" defaultValue={paramDefaults.customerTo} />
          </label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Load run</button>
          </div>
        </form>

        {grant && !view && (
          <form action={doPropose} className="mt-4 flex flex-wrap items-end gap-3">
            {hiddenParams}
            <label className="flex items-end gap-2">
              <input type="checkbox" name="confirmed" value="yes" required className="size-4" />
              <span className="text-sm">I confirm this dunning run</span>
            </label>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Execute run</button>
          </form>
        )}
        {done && <p className="mt-3 text-sm" role="status">{done}</p>}
        {actionError && <p className="mt-3 text-sm text-danger" role="alert">{actionError}</p>}
      </section>

      {view && (
        <section aria-labelledby="dn-proposal" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="dn-proposal" className="text-sm font-semibold">
            Run {view.runId} of {view.runDate} — {view.status}
          </h2>
          <p className="mt-2 text-sm text-ink-soft">
            Dunning date {view.dunningDate}; documents posted up to {view.postedThroughDate};
            companies {view.companies.join(', ')}. Levels advance only at finalization; a
            completed run is never overwritten.
          </p>

          {view.accounts.length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">No account stands proposed or excluded on this run.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th className="px-2 py-2">Company</th><th className="px-2 py-2">Customer</th>
                    <th className="px-2 py-2">Level</th><th className="px-2 py-2">Overdue</th>
                    <th className="px-2 py-2">Status</th><th className="px-2 py-2">Exception / act</th>
                  </tr>
                </thead>
                <tbody>
                  {view.accounts.map((a) => (
                    <tr key={`${a.companyCode}|${a.customer}`} className="border-t border-line">
                      <td className="px-2 py-2">{a.companyCode}</td>
                      <td className="px-2 py-2">{a.customer}</td>
                      <td className="px-2 py-2">{a.proposedLevel ?? '—'}</td>
                      <td className="px-2 py-2">{a.totalOverdue} {a.currency ?? ''}</td>
                      <td className="px-2 py-2">{a.status}</td>
                      <td className="px-2 py-2">
                        {a.status === 'PROPOSED' && view.status === 'PROPOSED' && grant ? (
                          <form action={doExclude}>
                            {hiddenParams}
                            <input type="hidden" name="companyCode" value={a.companyCode} />
                            <input type="hidden" name="customer" value={a.customer} />
                            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Exclude account</button>
                          </form>
                        ) : (a.exceptionReason ?? '—')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {view.items.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th className="px-2 py-2">Customer</th><th className="px-2 py-2">Document</th>
                    <th className="px-2 py-2">Due date</th><th className="px-2 py-2">Days overdue</th>
                    <th className="px-2 py-2">Amount</th><th className="px-2 py-2">Level</th>
                    <th className="px-2 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {view.items.map((i) => (
                    <tr key={`${i.companyCode}|${i.customer}|${i.documentNumber}|${i.lineNumber}`} className="border-t border-line">
                      <td className="px-2 py-2">{i.customer}</td>
                      <td className="px-2 py-2">{i.documentNumber}</td>
                      <td className="px-2 py-2">{i.dueDate}</td>
                      <td className="px-2 py-2">{i.daysOverdue}</td>
                      <td className="px-2 py-2">{i.overdueAmount} {i.currency}</td>
                      <td className="px-2 py-2">{i.proposedLevel}</td>
                      <td className="px-2 py-2">{i.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {view.notices.length > 0 && (
            <p className="mt-3 text-sm">
              Notices: {view.notices.map((n) => `${n.noticeNumber} (level ${n.dunningLevel}, ${n.amount} ${n.currency})`).join('; ')}
            </p>
          )}

          {grant && view.status === 'PROPOSED' && (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <form action={doFinalize} className="flex flex-wrap items-end gap-3">
                {hiddenParams}
                <label className="flex items-end gap-2">
                  <input type="checkbox" name="confirmed" value="yes" required className="size-4" />
                  <span className="text-sm">I confirm finalization</span>
                </label>
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Finalize run</button>
              </form>
              <form action={doCancel}>
                {hiddenParams}
                <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Cancel run</button>
              </form>
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="dn-runs" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="dn-runs" className="text-sm font-semibold">Dunning runs</h2>
        {runs.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No dunning run stands yet. A completed run is history: its parameters, proposal,
            exceptions and notices stand preserved, never overwritten.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Run</th><th className="px-2 py-2">Dunning date</th>
                  <th className="px-2 py-2">Status</th><th className="px-2 py-2">Accounts</th>
                  <th className="px-2 py-2">Notices</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={`${r.runDate}|${r.runId}`} className="border-t border-line">
                    <td className="px-2 py-2">
                      <Link className="underline" href={`${ROUTE}?runDate=${r.runDate}&runId=${r.runId}&dunningDate=${r.dunningDate}&postedThrough=${r.postedThroughDate}&companyCodes=${r.companies.join(',')}`}>
                        {r.runId} of {r.runDate}
                      </Link>
                    </td>
                    <td className="px-2 py-2">{r.dunningDate}</td>
                    <td className="px-2 py-2">{r.status}</td>
                    <td className="px-2 py-2">{r.accounts.length}</td>
                    <td className="px-2 py-2">{r.notices.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
