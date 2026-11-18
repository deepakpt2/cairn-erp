
import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  listTypeReferences,
  listValuationClasses,
  listValuationGaps,
  listValuationReferences,
} from '@/modules/inventory/valuation-class-definition';
import { t } from '@/platform/i18n';
import ValuationClasses from './ValuationClasses';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/valuation-classes';

/**
 * Valuation classes. OMSK is a search alias only.
 * The masters already stand. This screen maintains the reference, the
 * class, and which classes a reference permits. It does not post, and a
 * closed period does not block it.
 */
export default async function ValuationClassesPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const client = session.user.client;
  const [references, classes, types, gaps] = await Promise.all([
    listValuationReferences(client),
    listValuationClasses(client),
    listTypeReferences(client),
    listValuationGaps(client),
  ]);

  return (
    <Page
      title={t('valuationClass.title')} code={<>{ACTIVITY} · OMSK</>} back={null}
      description={t('valuationClass.subtitle')}
      actions={
        <>
          <LinkButton href="/config/material-types">
                        Material types
                      </LinkButton>
          <LinkButton href="/config/account-determination">
                        Account determination
                      </LinkButton>
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

      <ValuationClasses
        references={references}
        classes={classes}
        types={types}
        gaps={gaps}
        canMaintain={canMaintain}
      />
    </Page>
  );
}
