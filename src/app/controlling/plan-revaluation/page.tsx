
import { can, requireSession } from '@/platform/auth/current';
import { listControllingAreas } from '@/modules/foundation/controlling-area-maintenance';
import { PLAN_REVALUATION_CAPABILITY, PLAN_REVALUATION_ROUTE } from '@/modules/foundation/plan-revaluation';
import RevaluationForm from './RevaluationForm';
import { Page } from '@/ui/kit';

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
      <Page
      title="Plan revaluation" width="3xl" back={null}
    >
        <p className="mt-2 text-sm">You do not hold the plan-revaluation create capability (CO.PLANREVAL.CREATE).</p>
      </Page>
    );
  }
  const orderNumber = last((await searchParams).order);
  const areas = await listControllingAreas(session.user.client);

  return (
    <Page
      title="Create plan revaluation" code="CO.PLANREVAL.CREATE · KOP1" width="4xl"
      description="KOP1 saves a definition for internal orders. It does not change planned costs, budgets, or journals. No revaluation percentage is stored. KOPU does not run from this screen."
    >
      <RevaluationForm
        areas={areas.map((row) => ({ controllingArea: row.controllingArea, name: row.name, currency: row.currency.trim() }))}
        orderNumber={orderNumber}
      />
    </Page>
  );
}
