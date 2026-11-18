
import { can, requireSession } from '@/platform/auth/current';
import { ACTIVITY, listIndustrySectors } from '@/modules/inventory/industry-sector-definition';
import { t } from '@/platform/i18n';
import IndustrySectors from './IndustrySectors';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/industry-sectors';

/**
 * Industry sector definition (SCR-052 / OMS3; inert since stage 1).
 *
 * The sector master the material master judges against: delivered
 * standard sectors per tenant, maintained here in the standing master
 * shape (SCR-052 stage 3).
 */
export default async function IndustrySectorsPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const sectors = await listIndustrySectors(session.user.client);

  return (
    <Page
      title={t('industrySector.title')} code={<>{ACTIVITY} · OMS3</>} back={null}
      description={t('industrySector.subtitle')}
      actions={
        <>
          <LinkButton href="/config">
                        {t('nav.workbench')}
                      </LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <IndustrySectors sectors={sectors} canMaintain={canMaintain} />
    </Page>
  );
}
