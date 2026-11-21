
import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import { t } from '@/platform/i18n';
import {
  QUOTATION_CAPABILITY,
  QUOTATION_ROUTE,
  listRecentQuotationRequests,
  openQuotation,
} from '@/modules/purchasing/quotation';
import Quotation from './Quotation';
import { displayOnlyRemedy } from '@/ui/lock/remedy';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

/**
 * Quotation — SCR-157.
 *
 * One screen maintains a quotation against one standing request. A request
 * number opens the asked lines and the standing quotation, if one exists.
 * Neither the open nor a check creates a document. The search alias stays in
 * the catalogue. This screen does not compare.
 */
export default async function PurchasingQuotationPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(QUOTATION_ROUTE);
  const params = await searchParams;
  const requested = last(params.request).toUpperCase();
  const opened = requested ? await openQuotation(session.user.client, requested, { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => null) : null;
  const recent = await listRecentQuotationRequests(session.user.client, { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => []);
  const canMaintain = can(session, QUOTATION_CAPABILITY);
  const changeLock = opened && canMaintain
    ? await openChangeForSession(session, {
        lockObject: 'SUPPLIER_QUOTATION',
        argument: requested,
        transactionCode: 'PROC.RFQ.QUOTATION',
      })
    : null;

  return (
    <Page
      title={t('quotation.title')} code={t('quotation.code')} back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('quotation.subtitle')}</p>
        </>
      }
      actions={
        <>
          <LinkButton href="/purchasing/rfq">{t('quotation.toRequest')}</LinkButton>
          <LinkButton href="/">{t('nav.launchpad')}</LinkButton>
        </>
      }
    >

      {changeLock?.mode === 'CHANGE' && (
        <ChangeLock lockObject="SUPPLIER_QUOTATION" argument={requested} />
      )}
      <LockNotice message={changeLock ? displayOnlyMessage(changeLock) : null} remedy={displayOnlyRemedy(changeLock)} />
      <Quotation
        key={requested}
        opened={opened}
        requested={requested}
        recent={recent}
        canMaintain={canMaintain && changeLock?.mode !== 'DISPLAY'}
      />
    </Page>
  );
}
