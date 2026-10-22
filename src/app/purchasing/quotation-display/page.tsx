import Link from 'next/link';
import type { ReactNode } from 'react';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { QUOTATION_CAPABILITY, QUOTATION_ROUTE } from '@/modules/purchasing/quotation';
import {
  QUOTATION_DISPLAY_CAPABILITY,
  QUOTATION_DISPLAY_ROUTE,
  displayQuotation,
  displayQuotationForRequest,
  listRecentDisplayedQuotations,
  type DisplayedQuotation,
  type QuotationDisplayResult,
} from '@/modules/purchasing/quotation-display';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-40 flex-1 text-sm">
      <span className="mb-1 block text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function miss(result: QuotationDisplayResult): string {
  if (result.found) return '';
  if (result.reason === 'request') return t('quotationDisplay.requestMissing', { number: result.number });
  if (result.reason === 'no-offer') return t('quotationDisplay.noOffer', { number: result.number });
  return t('quotationDisplay.notFound', { number: result.number });
}

function QuotationView({
  quotation,
  canMaintain,
}: {
  quotation: DisplayedQuotation;
  canMaintain: boolean;
}) {
  return (
    <section aria-labelledby="quotation-display" className="rounded-card border border-line bg-surface p-4 shadow-card" data-quotation-display>
      <h2 id="quotation-display" className="text-sm font-semibold" data-quotation-number>{quotation.quotationNumber}</h2>
      <p className="mt-1 text-sm" data-quotation-identity>
        <span data-quotation-request>{quotation.rfqNumber}</span>
        {' · '}
        <span data-quotation-supplier>{quotation.partnerNumber}{quotation.partnerName ? ` · ${quotation.partnerName}` : ''}</span>
        {' · '}
        <span data-quotation-currency>{quotation.currency}</span>
        {' · '}
        <span data-quotation-deadline>{quotation.quotationDeadline}</span>
      </p>
      <p className="mt-1 text-xs text-ink-soft" data-quotation-name-current>{t('quotationDisplay.nameCurrent')}</p>
      <p className="mt-1 text-xs text-ink-soft" data-quotation-no-status>{t('quotationDisplay.noStatus')}</p>
      <p className="mt-1 text-xs text-ink-soft" data-quotation-no-revision>{t('quotationDisplay.noRevision')}</p>
      <p className="mt-1 text-xs text-ink-soft" data-quotation-no-condition>{t('quotationDisplay.noCondition')}</p>
      <p className="mt-1 text-xs text-ink-soft" data-quotation-no-award>{t('quotationDisplay.noAward')}</p>
      <p className="mt-1 text-xs text-ink-soft" data-quotation-still-visible>{t('quotationDisplay.stillVisible')}</p>
      <p className="mt-1 text-xs text-ink-soft" data-quotation-nothing-written>{t('quotationDisplay.nothingWritten')}</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-ink-soft">{t('quotationDisplay.event')}</dt><dd>{quotation.eventNumber}</dd></div>
        <div><dt className="text-ink-soft">{t('quotationDisplay.purchasingOrg')}</dt><dd>{quotation.purchasingOrg}</dd></div>
        <div><dt className="text-ink-soft">{t('quotationDisplay.purchasingGroup')}</dt><dd>{quotation.purchasingGroup}</dd></div>
        <div><dt className="text-ink-soft">{t('quotationDisplay.rfqDate')}</dt><dd>{quotation.rfqDate}</dd></div>
        <div>
          <dt className="text-ink-soft">{t('quotationDisplay.collective')}</dt>
          <dd data-quotation-collective>{quotation.collectiveNumber ?? t('quotationDisplay.collectiveAbsent')}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">{t('quotationDisplay.company')}</dt>
          <dd data-quotation-company>{quotation.companyCodes.join(', ') || t('quotationDisplay.companyAbsent')}</dd>
        </div>
        <div><dt className="text-ink-soft">{t('quotationDisplay.saved')}</dt><dd data-quotation-saved>{quotation.savedBy} · {quotation.savedAt}</dd></div>
      </dl>
      <p className="mt-2 text-xs text-ink-soft" data-quotation-company-note>{t('quotationDisplay.companyNote')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link href={`/purchasing/rfq?event=${quotation.rfqNumber}`} className="btn btn-default min-h-11 sm:min-h-8" data-display-request>
          {t('quotationDisplay.toRequest')}
        </Link>
        {canMaintain && (
          <Link href={`${QUOTATION_ROUTE}?request=${quotation.rfqNumber}`} className="btn btn-default min-h-11 sm:min-h-8" data-display-maintain>
            {t('quotationDisplay.toMaintain')}
          </Link>
        )}
      </div>
      <table className="mt-4 w-full text-sm" data-quotation-lines>
        <thead>
          <tr className="text-left text-ink-soft">
            <th className="py-1 pr-3">{t('quotationDisplay.item')}</th>
            <th className="py-1 pr-3">{t('quotationDisplay.asked')}</th>
            <th className="py-1 pr-3">{t('quotationDisplay.offered')}</th>
            <th className="py-1 pr-3">{t('quotationDisplay.netPrice')}</th>
            <th className="py-1 pr-3">{t('quotationDisplay.priceUnit')}</th>
            <th className="py-1 pr-3">{t('quotationDisplay.perUnit')}</th>
            <th className="py-1">{t('quotationDisplay.delivery')}</th>
          </tr>
        </thead>
        <tbody>
          {quotation.lines.map((line) => (
            <tr key={line.itemNumber} data-quotation-line={line.itemNumber}>
              <td className="py-1 pr-3">{line.itemNumber} · {line.shortText}</td>
              <td className="py-1 pr-3" data-quotation-asked={line.itemNumber}>{line.askedQuantity} {line.askedUnit} · {line.askedDelivery}</td>
              <td className="py-1 pr-3">
                {line.offer
                  ? <span data-quotation-offered={line.itemNumber}>{line.offer.quantity} {line.offer.unit}</span>
                  : <span data-quotation-unquoted={line.itemNumber}>{t('quotationDisplay.lineAbsent', { item: String(line.itemNumber) })}</span>}
              </td>
              <td className="py-1 pr-3">{line.offer ? line.offer.netPrice : t('quotationDisplay.notProvided')}</td>
              <td className="py-1 pr-3">{line.offer ? line.offer.priceUnit : t('quotationDisplay.notProvided')}</td>
              <td className="py-1 pr-3">
                {line.offer
                  ? <span data-quotation-per-unit={line.itemNumber}>{line.offer.pricePerUnit}</span>
                  : t('quotationDisplay.notProvided')}
              </td>
              <td className="py-1">{line.offer ? `${line.offer.deliveryDate}${line.offer.remark ? ` · ${line.offer.remark}` : ''}` : t('quotationDisplay.notProvided')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-ink-soft" data-quotation-calculated>{t('quotationDisplay.calculated')}</p>
      <h3 className="mt-4 text-sm font-semibold">{t('quotationDisplay.changes')}</h3>
      <table className="mt-2 w-full text-sm" data-quotation-history>
        <thead>
          <tr className="text-left text-ink-soft">
            <th className="py-1 pr-3">{t('quotationDisplay.changeField')}</th>
            <th className="py-1 pr-3">{t('quotationDisplay.oldValue')}</th>
            <th className="py-1 pr-3">{t('quotationDisplay.newValue')}</th>
            <th className="py-1">{t('quotationDisplay.changedBy')}</th>
          </tr>
        </thead>
        <tbody>
          {quotation.changes.map((row, index) => (
            <tr key={`${row.changedAt}-${row.fieldName ?? index}`}>
              <td className="py-1 pr-3">{row.fieldName ?? row.changeType}</td>
              <td className="py-1 pr-3">{row.oldValue ?? t('quotationDisplay.notProvided')}</td>
              <td className="py-1 pr-3">{row.newValue ?? t('quotationDisplay.notProvided')}</td>
              <td className="py-1">{row.changedBy}{row.reason ? ` · ${row.reason}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Display quotation — SCR-158.
 *
 * One screen reads a standing quotation. A quotation number is the key. A
 * request number resolves that quotation and is not the key. Nothing is written.
 */
export default async function PurchasingQuotationDisplayPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(QUOTATION_DISPLAY_ROUTE);
  const params = await searchParams;
  const quotationNumber = last(params.quotation).toUpperCase();
  const rfqNumber = last(params.request).toUpperCase();
  const canDisplay = can(session, QUOTATION_DISPLAY_CAPABILITY);
  const canMaintain = can(session, QUOTATION_CAPABILITY);
  const result = canDisplay && quotationNumber
    ? await displayQuotation(session.user.client, quotationNumber)
    : canDisplay && rfqNumber
      ? await displayQuotationForRequest(session.user.client, rfqNumber)
      : null;
  const recent = canDisplay ? await listRecentDisplayedQuotations(session.user.client) : [];
  const opened = result?.found ? result.quotation : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('quotationDisplay.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('quotationDisplay.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('quotationDisplay.subtitle')}</p>
      </header>

      {!canDisplay && (
        <p className="text-sm text-red-700" role="alert">{t('quotationDisplay.capabilityMissing')}</p>
      )}

      {canDisplay && (
        <section aria-labelledby="quotation-display-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="quotation-display-lookup" className="text-sm font-semibold">{t('quotationDisplay.lookupTitle')}</h2>
          <form method="get" action={QUOTATION_DISPLAY_ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
            <Field label={t('quotationDisplay.quotation')}>
              <ConstrainedField kind="quotation-number" name="quotation" uppercase defaultValue={opened?.quotationNumber || quotationNumber} />
            </Field>
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" data-quotation-open>{t('quotationDisplay.openQuotation')}</button>
          </form>
          <form method="get" action={QUOTATION_DISPLAY_ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
            <Field label={t('quotationDisplay.request')}>
              <ConstrainedField kind="quotation-request" name="request" uppercase defaultValue={rfqNumber} />
            </Field>
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" data-request-open>{t('quotationDisplay.openRequest')}</button>
          </form>
          <p className="mt-2 text-xs text-ink-soft" data-quotation-not-interchangeable>{t('quotationDisplay.notInterchangeable')}</p>
          {result && !result.found && (
            <p role="status" className="mt-2 text-sm text-red-700" data-quotation-miss={result.reason}>{miss(result)}</p>
          )}
          {recent.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2 text-sm">
              {recent.map((row) => (
                <li key={row.quotationNumber}>
                  <Link href={`${QUOTATION_DISPLAY_ROUTE}?quotation=${row.quotationNumber}`} className="underline">
                    {row.quotationNumber} · {row.rfqNumber} · {row.partnerNumber}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {opened && <QuotationView quotation={opened} canMaintain={canMaintain} />}
    </div>
  );
}
