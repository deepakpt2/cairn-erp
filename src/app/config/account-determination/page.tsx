
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  POSTING_EVENTS,
  listAccountDeterminations,
  listDeterminationCharts,
  listDeterminationValuationClasses,
  listGlAccountChoices,
} from '@/modules/foundation/account-determination';
import { AccountDetermination } from './AccountDetermination';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/account-determination';

/**
 * OBYC Define Account Determination (SCR-040; inert since stage 1).
 *
 * The spine of logistics-to-accounting integration, in the product's own
 * event vocabulary: the reference transaction keys are search aliases and
 * never stored (R-89). Nothing derives accounts from these rows yet, and
 * the screen says so.
 */
export default async function AccountDeterminationPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const [rows, charts, valuationClasses, glChoices] = await Promise.all([
    listAccountDeterminations(client),
    listDeterminationCharts(client),
    listDeterminationValuationClasses(client),
    listGlAccountChoices(client),
  ]);

  return (
    <Page
      title={t('acctDet.title')} code={<>{ACTIVITY} · OBYC</>} back={null}
      description={t('acctDet.subtitle')}
      actions={
        <>
          <LinkButton href="/config">
                        {t('nav.workbench')}
                      </LinkButton>
          <LinkButton href="/config/chart-of-accounts">
                        {t('acctDet.chartsLink')}
                      </LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <AccountDetermination
        rows={rows}
        charts={charts}
        valuationClasses={valuationClasses}
        glChoices={glChoices}
        events={POSTING_EVENTS}
        canMaintain={canMaintain}
      />
    </Page>
  );
}
