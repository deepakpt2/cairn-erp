import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { listControllingAreas } from '@/modules/foundation/controlling-area-maintenance';
import { PLAN_REVALUATION_CAPABILITY, PLAN_REVALUATION_ROUTE } from '@/modules/foundation/plan-revaluation';
import RevaluationForm from './RevaluationForm';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** KOP1. Creates a definition. It does not revalue plan data. */
export default async function PlanRevaluationPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PLAN_REVALUATION_ROUTE);
  if (!can(session, PLAN_REVALUATION_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Plan revaluation</h1>
        <p className="mt-2 text-sm">You do not hold the plan-revaluation create capability (CO.PLANREVAL.CREATE).</p>
      </main>
    );
  }
  const orderNumber = last((await searchParams).order);
  const areas = await listControllingAreas(session.user.client);

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">CO.PLANREVAL.CREATE · KOP1</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Create plan revaluation</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          KOP1 saves a definition for internal orders. It does not change planned costs, budgets, or journals. No revaluation percentage is stored. KOPU does not run from this screen.
        </p>
      </header>
      <RevaluationForm
        areas={areas.map((row) => ({ controllingArea: row.controllingArea, name: row.name, currency: row.currency.trim() }))}
        orderNumber={orderNumber}
      />
    </main>
  );
}
