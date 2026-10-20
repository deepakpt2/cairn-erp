import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  GOODS_ISSUE_CAPABILITY,
  GOODS_ISSUE_ROUTE,
  MB1A_SCENARIOS,
} from '@/modules/inventory/goods-issue';
import GoodsIssue from './GoodsIssue';

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
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">INV.GI.POST · MB1A</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('mb1a.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('mb1a.subtitle')}</p>
      </header>

      <GoodsIssue
        scenarios={MB1A_SCENARIOS.map((s) => ({
          code: s.code, description: s.description, accountAssignment: s.accountAssignment,
        }))}
        canPost={can(session, GOODS_ISSUE_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
