
import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  listAccountCategoryReferences,
  listMaterialTypes,
  listTypeValuation,
} from '@/modules/inventory/material-type-definition';
import { listMaterialRangeGroupOptions } from '@/modules/inventory/material-number-range-groups';
import { t } from '@/platform/i18n';
import MaterialTypes from './MaterialTypes';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/material-types';

/**
 * Material type definition (SCR-048 / OMS2; inert since stage 1).
 *
 * The master-detail shape the master-data screens share: the tenant's
 * material types in a grid, a detail panel per type, the account
 * category references those types are judged against, and the
 * quantity/value updating rows per plant. The material type table
 * already stands from the materials build — this screen is where it
 * gains its missing definition fields and its maintenance service.
 */
export default async function MaterialTypesPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const client = session.user.client;
  const [types, references, valuation, rangeGroups] = await Promise.all([
    listMaterialTypes(client),
    listAccountCategoryReferences(client),
    listTypeValuation(client),
    listMaterialRangeGroupOptions(client),
  ]);

  return (
    <Page
      title={t('materialType.title')} code={<>{ACTIVITY} · OMS2</>} back={null}
      description={t('materialType.subtitle')}
      actions={
        <>
          <LinkButton href="/config/valuation-classes">
                        Valuation classes
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

      <MaterialTypes
        types={types}
        references={references}
        valuation={valuation}
        rangeGroups={rangeGroups}
        canMaintain={canMaintain}
      />
    </Page>
  );
}
