
import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { t } from '@/platform/i18n';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import {
  PHYSICAL_INVENTORY_RECOUNT_CAPABILITY,
  PHYSICAL_INVENTORY_RECOUNT_ROUTE,
  getRecountSource,
} from '@/modules/inventory/physical-inventory-recount';
import RecountWorkbench from './RecountWorkbench';
import { displayOnlyRemedy } from '@/ui/lock/remedy';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = PHYSICAL_INVENTORY_RECOUNT_ROUTE;

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

/**
 * Recount — SCR-150.
 *
 * The search alias stays in the catalogue. This screen creates a new document for the items
 * the person selects. It does not enter the recount quantity, post a difference, or reverse.
 */
export default async function PhysicalInventoryRecountPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const documentNumber = last(params.doc).toUpperCase();
  const fiscalYear = Number(last(params.year) || '0');
  const document = documentNumber && fiscalYear
    ? await getRecountSource(session.user.client, { documentNumber, fiscalYear }, { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => null)
    : null;
  const today = new Date().toISOString().slice(0, 10);
  const canRecount = can(session, PHYSICAL_INVENTORY_RECOUNT_CAPABILITY);
  const recountKey = document ? `${document.documentNumber.trim()}/${document.fiscalYear}` : '';
  const changeLock = document && canRecount
    ? await openChangeForSession(session, {
        lockObject: 'PHYSICAL_INVENTORY',
        argument: recountKey,
        transactionCode: 'INV.PHYINV.RECOUNT',
      })
    : null;

  return (
    <Page
      title={t('recount.title')} code={t('recount.code')} back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('recount.subtitle')}</p>
        </>
      }
      actions={
        <>
          <LinkButton href="/inventory/physical-inventory-differences">
                        {t('recount.toList')}
                      </LinkButton>
          <LinkButton href="/inventory/physical-inventory-count">
                        {t('recount.toCounts')}
                      </LinkButton>
          <LinkButton href="/inventory/physical-inventory">
                        {t('recount.toDocuments')}
                      </LinkButton>
          <LinkButton href="/">{t('nav.launchpad')}</LinkButton>
        </>
      }
    >

      {document && changeLock?.mode === 'CHANGE' && (
        <ChangeLock lockObject="PHYSICAL_INVENTORY" argument={recountKey} />
      )}
      <LockNotice message={changeLock?.mode === 'DISPLAY' ? displayOnlyMessage(changeLock) : null} remedy={displayOnlyRemedy(changeLock)} />
      <RecountWorkbench
        document={document}
        requestedNumber={documentNumber}
        requestedYear={last(params.year)}
        canRecount={canRecount}
        displayOnly={changeLock?.mode === 'DISPLAY'}
        today={today}
      />
    </Page>
  );
}
