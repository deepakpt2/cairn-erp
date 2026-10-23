import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOriginalBudget } from '@/modules/foundation/internal-order-budget-display';
import {
  InternalOrderBudgetError,
  ORIGINAL_BUDGET_DISPLAY_CAPABILITY,
  type OriginalBudgetView,
} from '@/modules/foundation/internal-order-budget';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** KO23. Display only. There is no save. */
export default async function OriginalBudgetDisplayPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession('/controlling/original-budget-display');
  if (!can(session, ORIGINAL_BUDGET_DISPLAY_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Display original budget</h1>
        <p className="mt-2 text-sm">You do not hold the original-budget display capability (CO.BUDGET.ORIGINAL.DISPLAY).</p>
      </main>
    );
  }
  const requested = last((await searchParams).order);
  let message = '';
  let budget: OriginalBudgetView | null = null;
  if (requested) {
    try {
      budget = await displayOriginalBudget({ client: session.user.client, orderNumber: requested });
    } catch (error) {
      message = error instanceof InternalOrderBudgetError ? error.message : 'The budget could not be displayed.';
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">CO.BUDGET.ORIGINAL.DISPLAY · KO23</span>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Display original budget</h1>
        <p className="mt-1 text-sm text-ink-soft">KO23 shows the original budget. It does not save, post, supplement, or settle. Availability control is not executed.</p>
      </header>
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Internal order</span>
          <input className="input" name="order" defaultValue={requested} maxLength={20} />
        </label>
        <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit">Display</button>
      </form>
      {message && <p className="text-sm text-red-700" role="alert">{message}</p>}
      {budget && (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-ink-soft">Order</dt><dd>{budget.orderNumber} · {budget.description}</dd></div>
          <div><dt className="text-ink-soft">Type</dt><dd>{budget.orderType}</dd></div>
          <div><dt className="text-ink-soft">Controlling area</dt><dd>{budget.controllingArea}</dd></div>
          <div><dt className="text-ink-soft">Company code</dt><dd>{budget.companyCode}</dd></div>
          <div><dt className="text-ink-soft">Currency</dt><dd>{budget.currency}</dd></div>
          <div><dt className="text-ink-soft">Profile</dt><dd>{budget.budgetProfile ?? 'None'}</dd></div>
          <div><dt className="text-ink-soft">Overall original budget</dt><dd>{budget.overallAmount ?? 'None'}</dd></div>
          <div><dt className="text-ink-soft">Current budget</dt><dd>Not calculated. Supplements, returns, and carryforward are not configured.</dd></div>
          <div><dt className="text-ink-soft">Availability control</dt><dd>{budget.availabilityControl ? 'Marked on the profile. Not executed.' : 'Not active.'}</dd></div>
          <div><dt className="text-ink-soft">Journal lines</dt><dd>{budget.journalCount}. Display did not treat them as consumption.</dd></div>
        </dl>
      )}
      {budget && budget.annual.length > 0 && (
        <ul className="text-sm">
          {budget.annual.map((row) => <li key={row.fiscalYear}>{row.fiscalYear} · {row.amount}</li>)}
        </ul>
      )}
      {budget && budget.documents.length > 0 && (
        <ul className="text-sm">
          {budget.documents.map((row) => <li key={row.documentNumber}>{row.documentNumber} · {row.documentDate} · {row.overallAmount ?? 'no overall'}</li>)}
        </ul>
      )}
      {budget && (
        <p className="text-sm">
          <Link className="underline" href={`/controlling/original-budget?order=${encodeURIComponent(budget.orderNumber)}`}>KO22 change</Link>
        </p>
      )}
    </main>
  );
}
