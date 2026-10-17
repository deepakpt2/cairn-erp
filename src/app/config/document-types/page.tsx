import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listDocumentTypes,
  listIntervalChoices,
} from '@/modules/foundation/document-type-definition';
import { DocumentTypes } from './DocumentTypes';

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
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OBA7</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('docType.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
            <Link href="/config/number-ranges" className="btn btn-default min-h-11 sm:min-h-8">
              {t('docType.numberRangesLink')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('docType.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <DocumentTypes rows={rows} intervals={intervals} canMaintain={canMaintain} />
    </div>
  );
}
