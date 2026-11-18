
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listDocumentTypes,
  listIntervalChoices,
} from '@/modules/foundation/document-type-definition';
import { DocumentTypes } from './DocumentTypes';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/document-types';

/**
 * OBA7 Define Document Types (SCR-038; live since stage 3).
 *
 * The standard package delivers the working set of document types into every
 * tenant; journals have posted against them since the first posting. This
 * screen is where they become maintainable — the classification a document
 * carries, the interval its number comes from, and the accounts it may
 * post to.
 */
export default async function DocumentTypesPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const [rows, intervals] = await Promise.all([
    listDocumentTypes(client),
    listIntervalChoices(client),
  ]);

  return (
    <Page
      title={t('docType.title')} code={<>{ACTIVITY} · OBA7</>} back={null}
      description={t('docType.subtitle')}
      actions={
        <>
          <LinkButton href="/config">
                        {t('nav.workbench')}
                      </LinkButton>
          <LinkButton href="/config/number-ranges">
                        {t('docType.numberRangesLink')}
                      </LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <DocumentTypes rows={rows} intervals={intervals} canMaintain={canMaintain} />
    </Page>
  );
}
