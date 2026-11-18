
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  GOODS_ISSUE_CAPABILITY,
  GOODS_ISSUE_ROUTE,
  MB1A_SCENARIOS,
} from '@/modules/inventory/goods-issue';
import GoodsIssue from './GoodsIssue';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * Goods issue — SCR-136 / INV.GI.POST (MB1A as a search alias only).
 *
 * Stock leaves the plant: 201 charges a cost centre, 551 scraps. A line may name a
 * reservation and withdraw from it, and the stock, the journal, the demand and the
 * document commit together.
 */
export default async function GoodsIssuePage() {
  const session = await requireSession(GOODS_ISSUE_ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('mb1a.title')} code="INV.GI.POST · MB1A" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('mb1a.subtitle')}
    >

      <GoodsIssue
        scenarios={MB1A_SCENARIOS.map((s) => ({
          code: s.code, description: s.description, accountAssignment: s.accountAssignment,
        }))}
        canPost={can(session, GOODS_ISSUE_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
