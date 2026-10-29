import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  PAY_COMPONENT_CAPABILITY,
  PAY_COMPONENT_ROUTE,
  PayComponentError,
  getPayComponent,
  listAccountsForSide,
  listChartsForMapping,
  listCostCentresForMapping,
  listPayComponents,
} from '@/modules/people/pay-components';
import PayComponents from './PayComponents';

export const dynamic = 'force-dynamic';

/** A deep link to a component that no longer exists reads as none selected, not as an error page. */
async function loadComponent(client: string, code: string) {
  if (code === '') return null;
  try {
    return await getPayComponent(client, code);
  } catch (error) {
    if (error instanceof PayComponentError) return null;
    throw error;
  }
}

/**
 * The pay structure: pay components and the GL and cost mapping each one carries.
 *
 * This is CAIRN.md §8.10's "pay_component, pay_component_config | Pay structure and its GL/cost mapping" and
 * §15.1's "Pay components (wage-type equivalent) with their accounting mapping", the pair CFG.PEOPLE.PAYCOMPONENT
 * .DEFINE has named since the design with nothing behind it. Reading the screen before using it, two things
 * are worth holding:
 *
 * **The kind decides the accounts, and that is all it decides.** An earning debits an expense account, a
 * deduction credits a payable, a contribution or a provision does both — the six lines of §15.2's posting
 * example, and no more than they say. Nothing on this screen computes: no basis, no formula, no rate. R-11
 * keeps payroll simplified and DV-001 refuses to ship guessed statutory rules, so an amount arrives from a
 * payroll result, imported or later calculated by §15.3's rules, and this screen is what tells a posting run
 * where it goes.
 *
 * **The mapping is checked against the tenant's own masters.** Only charts the tenant has, only accounts of
 * that chart that are open for posting and of the type the side needs, and a cost object where the expense
 * account's own master asks for one. A fixed centre is checked as of today, because a mapping carries no dates:
 * §15.1 asks for validity dates on the Assignment alone, and 9194's structure is undated for the same reason.
 *
 * What is deliberately not here: deduction rules (their conditions are jurisdiction decisions), per-employee
 * amounts (a dated record of a configured type is what 9193 built for exactly that), payroll runs, results,
 * payslips, salary payments and end-of-service accrual postings (D-013 and D-022: posting and long-running
 * work are not this slice), and deletion of anything — a component is retired and a mapping corrected, which
 * is why no row here can be removed.
 */
export default async function PayComponentsPage({ searchParams }: {
  searchParams: Promise<{ component?: string; chart?: string; q?: string }>;
}) {
  const session = await requireSession(PAY_COMPONENT_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const component = (params.component ?? '').trim().toUpperCase();
  const askedChart = (params.chart ?? '').trim().toUpperCase();
  const query = (params.q ?? '').trim();

  const [components, charts, centres, selected] = await Promise.all([
    listPayComponents(client, query),
    listChartsForMapping(client),
    listCostCentresForMapping(client),
    loadComponent(client, component),
  ]);

  // The chart whose accounts the mapping form offers: the one the query named, when the tenant has it, else
  // the selected component's own mapping, else its first chart. A form should be looking at what the operator
  // asked for, and an account select that lists another chart's numbers is how a wrong mapping gets written.
  const mappingChart = charts.some((chart) => chart.chartOfAccounts === askedChart)
    ? askedChart
    : (selected?.mappings[0]?.chartOfAccounts ?? charts[0]?.chartOfAccounts ?? '');

  const [debitAccounts, creditAccounts] = mappingChart
    ? await Promise.all([
        listAccountsForSide(client, mappingChart, 'DEBIT'),
        listAccountsForSide(client, mappingChart, 'CREDIT'),
      ])
    : [[], []];

  const canWrite = can(session, PAY_COMPONENT_CAPABILITY);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{PAY_COMPONENT_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Pay components</h1>
          <div className="flex gap-2">
            <Link href="/people/assignments" className="btn btn-default min-h-11 sm:min-h-8">Assignments</Link>
            <Link href="/people/employees" className="btn btn-default min-h-11 sm:min-h-8">Employees</Link>
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Configuration</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          What the tenant calls a kind of pay, which account of which chart it moves, and whether a cost
          centre carries it. The screen defines and corrects; it calculates nothing and posts nothing — payroll
          runs, results and their postings are unbuilt by design (R-11, DV-001), and this is the structure they
          would read.
        </p>
      </header>
      <PayComponents
        components={components}
        selected={selected}
        charts={charts}
        mappingChart={mappingChart}
        debitAccounts={debitAccounts}
        creditAccounts={creditAccounts}
        centres={centres}
        query={query}
        canWrite={canWrite}
      />
    </div>
  );
}
