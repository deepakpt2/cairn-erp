import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock } from '@/ui/lock/ChangeLock';
import {
  getOriginalBudget,
  ORIGINAL_BUDGET_CHANGE_CAPABILITY,
  ORIGINAL_BUDGET_ROUTE,
} from '@/modules/foundation/internal-order-budget';
import BudgetForm from './BudgetForm';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** KO22. Original budget only. This is not a supplement, a return, or a posting. */
export default async function OriginalBudgetPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ORIGINAL_BUDGET_ROUTE);
  if (!can(session, ORIGINAL_BUDGET_CHANGE_CAPABILITY)) {
    return (
      <Page
      title="Original budget" width="3xl" back={null}
    >
        <p className="mt-2 text-sm">You do not hold the original-budget change capability (CO.BUDGET.ORIGINAL.CHANGE).</p>
      </Page>
    );
  }
  const orderNumber = last((await searchParams).order);
  const budget = orderNumber ? await getOriginalBudget(session.user.client, orderNumber) : null;
  const changeLock = budget
    ? await openChangeForSession(session, {
        lockObject: 'INTERNAL_ORDER',
        argument: budget.orderNumber,
        transactionCode: 'KO22',
      })
    : null;

  return (
    <Page
      title="Change original budget" code="CO.BUDGET.ORIGINAL.CHANGE · KO22" width="4xl"
      description="KO22 changes the original budget. It does not enter a supplement or a return, post a journal, or settle the order. KO23 displays the budget and does not save. Availability control is not executed."
    >
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Internal order</span>
          <input className="input" name="order" defaultValue={orderNumber} maxLength={20} />
        </label>
        <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit">Open</button>
      </form>
      {orderNumber && !budget && <p className="text-sm text-signal-error" role="alert">Internal order {orderNumber} does not exist.</p>}
      {budget && (
        <section className="space-y-1 text-sm">
          <p>{budget.orderNumber} · {budget.orderType} · {budget.description}</p>
          <p>{budget.controllingArea} · {budget.companyCode} · {budget.currency}</p>
          <p>Current original budget {budget.overallAmount ?? 'none'}. Current budget is not calculated.</p>
          <p>Journal lines citing this order: {budget.journalCount}. They are not budget consumption.</p>
          <p>
            <Link className="underline" href={`/controlling/original-budget-display?order=${encodeURIComponent(budget.orderNumber)}`}>KO23 display</Link>
            {' · '}
            <Link className="underline" href={`/controlling/internal-orders?order=${encodeURIComponent(budget.orderNumber)}`}>KO02 order</Link>
          </p>
        </section>
      )}
      {changeLock?.mode === 'DISPLAY' && <p className="text-sm text-ink-soft">{displayOnlyMessage(changeLock)}</p>}
      {changeLock?.mode === 'CHANGE' && budget && <ChangeLock lockObject="INTERNAL_ORDER" argument={budget.orderNumber} />}
      {budget && changeLock?.mode !== 'DISPLAY' && <BudgetForm budget={budget} />}
      {budget && budget.documents.length > 0 && (
        <ul className="text-sm">
          {budget.documents.map((row) => (
            <li key={row.documentNumber}>{row.documentNumber} · {row.documentDate} · {row.overallAmount ?? 'no overall'}</li>
          ))}
        </ul>
      )}
    </Page>
  );
}
