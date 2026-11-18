
import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  listMaterialPeriodControl,
} from '@/modules/inventory/material-period-control';
import { t } from '@/platform/i18n';
import MaterialPeriodControl from './MaterialPeriodControl';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/material-period-control';

/**
 * Material period control (SCR-054 / OMSY; inert since stage 1).
 *
 * The MM period gate per company code: the current and previous
 * material posting periods and their backposting indicators, with the
 * initialize, indicator and shift acts (SCR-054, live since stage 3).
 */
export default async function MaterialPeriodControlPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const rows = await listMaterialPeriodControl(session.user.client);

  return (
    <Page
      title={t('materialPeriod.title')} code={<>{ACTIVITY} · OMSY</>} back={null}
      description={t('materialPeriod.subtitle')}
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

      <MaterialPeriodControl rows={rows} canMaintain={canMaintain} />
    </Page>
  );
}
