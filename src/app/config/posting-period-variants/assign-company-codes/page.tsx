
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listPostingPeriodVariantAssignments,
} from '@/modules/foundation/posting-period-variant-assignment';
import { listPostingPeriodVariants } from '@/modules/foundation/posting-period-variant-definition';
import { PostingPeriodVariantAssignments } from './PostingPeriodVariantAssignments';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/posting-period-variants/assign-company-codes';

/**
 * OBBP Assign Company Code to Posting Period Variant (SCR-033 stage 1: the screen).
 *
 * A distinct activity from OBBO, which defines the variants: this one writes the
 * Company Code, so it shows every Company Code with the variant it posts against
 * and lets the assignment be made here — the journey the OBBO deletion remedy has
 * been pointing at.
 */
export default async function AssignPostingPeriodVariantPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const [rows, variants] = await Promise.all([
    listPostingPeriodVariantAssignments(client),
    listPostingPeriodVariants(client),
  ]);
  const choices = variants.map((row) => ({ variant: row.variant, name: row.name }));

  return (
    <Page
      title={t('ppvAssign.title')} code={<>{ACTIVITY} · OBBP</>} back={null}
      description={t('ppvAssign.subtitle')}
      actions={
        <>
          <LinkButton href="/config">
                        {t('nav.workbench')}
                      </LinkButton>
          <LinkButton href="/config/posting-period-variants">
                        {t('ppvAssign.defineLink')}
                      </LinkButton>
          <LinkButton href="/config/company-codes">
                        {t('ppvAssign.companyCodesLink')}
                      </LinkButton>
          <LinkButton href="/config/posting-periods">
                        {t('ppvAssign.postingPeriodsLink')}
                      </LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <PostingPeriodVariantAssignments rows={rows} choices={choices} canMaintain={canMaintain} />
    </Page>
  );
}
