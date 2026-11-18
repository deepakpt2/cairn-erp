
import { can, requireSession } from '@/platform/auth/current';
import { listCompanyCodes } from '@/modules/foundation/services';
import {
  RETAINED_EARNINGS_ACTIVITY,
} from '@/modules/foundation/retained-earnings-vocabulary';
import { listRetainedEarnings } from '@/modules/foundation/retained-earnings';
import { RetainedEarnings } from './RetainedEarnings';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/retained-earnings';

/**
 * Retained earnings account definition (SCR-121; OB53 as a
 * search alias only).
 */
export default async function RetainedEarningsPage() {
  const session = await requireSession(ROUTE);
  const rows = await listRetainedEarnings(session.user.client);
  const companies = await listCompanyCodes(session.user.client);
  const charts = [...new Map(
    companies.filter((c) => c.chartOfAccounts)
      .map((c) => [c.chartOfAccounts as string, { chartOfAccounts: c.chartOfAccounts as string, name: c.chartOfAccounts as string }]),
  ).values()];

  return (
    <Page
      title="Retained Earnings Account" code={<>{RETAINED_EARNINGS_ACTIVITY} · OB53</>} back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">
              Per chart of accounts, the retained earnings account each indicator closes to: the P&amp;L accounts carrying an
              indicator transfer their balance to its retained earnings account at balance carryforward.
            </p>
        </>
      }
      actions={
        <>
          <LinkButton href="/config">Configuration workbench</LinkButton>
        </>
      }
    >

      <RetainedEarnings rows={rows} charts={charts} canMaintain={can(session, RETAINED_EARNINGS_ACTIVITY)} />
    </Page>
  );
}
