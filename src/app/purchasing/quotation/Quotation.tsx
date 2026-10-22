'use client';

import Link from 'next/link';
import { useActionState, type ReactNode } from 'react';

import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import type { OpenedQuotation } from '@/modules/purchasing/quotation';
import type { QuotationActionState } from './actions';
import { checkQuotationAction, saveQuotationAction } from './actions';

const ROUTE = '/purchasing/quotation';
const INITIAL: QuotationActionState = { ok: false, message: '' };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-40 flex-1 text-sm">
      <span className="mb-1 block text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function Notice({ state }: { state: QuotationActionState }) {
  if (!state.message) return null;
  const preview = state.preview;
  return (
    <div role="status" data-quotation-result className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1">{state.remedy}</p>}
      {state.ok && state.wrote === false && (
        <p data-quotation-nothing-written className="mt-1">{t('quotation.nothingWritten')}</p>
      )}
      {state.ok && state.wrote === false && !preview?.quotationNumber && (
        <p data-quotation-number-not-drawn className="mt-1">{t('quotation.numberNotDrawn')}</p>
      )}
      {preview && (
        <p className="mt-1" data-quotation-currency>{preview.currencyNote}</p>
      )}
      {preview && preview.lines.length > 0 && (
        <table className="mt-3 w-full text-sm" data-quotation-preview>
          <thead>
            <tr className="text-left text-ink-soft">
              <th className="py-1 pr-3">{t('quotation.item')}</th>
              <th className="py-1 pr-3">{t('quotation.asked')}</th>
              <th className="py-1 pr-3">{t('quotation.quantity')}</th>
              <th className="py-1 pr-3">{t('quotation.unit')}</th>
              <th className="py-1 pr-3">{t('quotation.netPrice')}</th>
              <th className="py-1 pr-3">{t('quotation.priceUnit')}</th>
              <th className="py-1 pr-3">{t('quotation.perUnit')}</th>
              <th className="py-1">{t('quotation.deliveryDate')}</th>
            </tr>
          </thead>
          <tbody>
            {preview.lines.map((line) => (
              <tr key={line.itemNumber}>
                <td className="py-1 pr-3">{line.itemNumber}</td>
                <td className="py-1 pr-3">{line.asked.quantity} · {line.asked.deliveryDate}</td>
                <td className="py-1 pr-3">{line.before && line.before.quantity !== line.after.quantity ? `${line.before.quantity} → ${line.after.quantity}` : line.after.quantity}</td>
                <td className="py-1 pr-3">{line.after.unit}</td>
                <td className="py-1 pr-3">{line.before && line.before.netPrice !== line.after.netPrice ? `${line.before.netPrice} → ${line.after.netPrice}` : line.after.netPrice}</td>
                <td className="py-1 pr-3">{line.after.priceUnit}</td>
                <td className="py-1 pr-3" data-quotation-per-unit={line.itemNumber}>{line.after.pricePerUnit}</td>
                <td className="py-1">{line.before && line.before.deliveryDate !== line.after.deliveryDate ? `${line.before.deliveryDate} → ${line.after.deliveryDate}` : line.after.deliveryDate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {preview && preview.unquoted.length > 0 && (
        <ul className="mt-2 space-y-1" data-quotation-unquoted>
          {preview.unquoted.map((line) => (
            <li key={line.itemNumber}>{t('quotation.noOffer', { item: String(line.itemNumber) })}</li>
          ))}
        </ul>
      )}
      {state.ok && state.wrote && state.rfqNumber && (
        <p className="mt-1">
          <Link href={`${ROUTE}?request=${state.rfqNumber}`} data-quotation-open className="underline">
            {t('quotation.openStanding', { number: state.quotationNumber ?? state.rfqNumber })}
          </Link>
        </p>
      )}
    </div>
  );
}

export default function Quotation({
  opened,
  requested,
  recent,
  canMaintain,
}: {
  opened: OpenedQuotation | null;
  requested: string;
  recent: Array<{ rfqNumber: string; partnerNumber: string; quotationDeadline: string; quotationNumber: string | null }>;
  canMaintain: boolean;
}) {
  const [checkState, checkAction, checking] = useActionState(checkQuotationAction, INITIAL);
  const [saveState, saveAction, saving] = useActionState(saveQuotationAction, INITIAL);
  const standing = opened?.quotation ?? null;

  return (
    <>
      <section aria-labelledby="quotation-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="quotation-lookup" className="text-sm font-semibold">{t('quotation.lookupTitle')}</h2>
        <form method="get" action={ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
          <Field label={t('quotation.request')}>
            <ConstrainedField kind="quotation-request" name="request" uppercase defaultValue={opened?.rfqNumber || requested} />
          </Field>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">{t('quotation.load')}</button>
        </form>
        {requested && !opened && (
          <p role="status" className="mt-2 text-sm text-red-700">{t('quotation.notFound', { number: requested })}</p>
        )}
        <p className="mt-2 text-xs text-ink-soft" data-quotation-no-comparison>{t('quotation.noComparison')}</p>
        {recent.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {recent.map((row) => (
              <li key={row.rfqNumber}>
                <Link href={`${ROUTE}?request=${row.rfqNumber}`} className="underline">
                  {row.rfqNumber} · {row.partnerNumber} · {row.quotationDeadline}
                  {row.quotationNumber ? ` · ${row.quotationNumber}` : ''}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {opened && (
        <section aria-labelledby="quotation-maintain" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="quotation-maintain" className="text-sm font-semibold">
            {standing ? standing.quotationNumber : t('quotation.newOffer')}
          </h2>
          <p className="mt-1 text-sm text-ink-soft" data-quotation-identity>
            {opened.rfqNumber} · {opened.partnerNumber}{opened.partnerName ? ` · ${opened.partnerName}` : ''} · {opened.quotationDeadline} · {opened.currency}
          </p>
          <p className="mt-1 text-xs text-ink-soft">{t('quotation.maintainHint')}</p>
          <form action={saveAction} className="mt-3 space-y-3">
            <input type="hidden" name="rfqNumber" value={opened.rfqNumber} />
            <input type="hidden" name="lineCount" value={opened.lines.length} />
            {standing && <input type="hidden" name="expectedChangedAt" value={standing.changedAt ?? ''} />}
            {standing && <input type="hidden" name="quotationNumber" value={standing.quotationNumber} />}
            {opened.lines.map((line, index) => {
              const offer = standing?.lines.find((row) => row.itemNumber === line.itemNumber) ?? null;
              return (
                <div key={line.itemNumber} className="space-y-2 border-t border-line pt-3" data-quotation-line={line.itemNumber}>
                  {offer && <input type="hidden" name={`line${index}Standing`} value="1" />}
                  <input type="hidden" name={`line${index}Item`} value={line.itemNumber} />
                  <p className="text-sm">
                    {line.itemNumber} · {line.shortText} · {t('quotation.asked')} {line.quantity} {line.unit} · {line.deliveryDate}
                  </p>
                  <div className="flex flex-wrap items-end gap-3">
                    <Field label={t('quotation.quantity')}>
                      <input name={`line${index}Quantity`} className="input w-full" defaultValue={offer?.quantity ?? line.quantity} />
                    </Field>
                    <Field label={t('quotation.unit')}>
                      <ConstrainedField
                        kind="unit"
                        name={`line${index}Unit`}
                        uppercase
                        defaultValue={offer?.unit ?? line.unit}
                        context={{ materialNumber: line.materialNumber ?? '', askedUnit: line.unit }}
                      />
                    </Field>
                    <Field label={t('quotation.netPrice')}>
                      <input name={`line${index}NetPrice`} className="input w-full" defaultValue={offer?.netPrice ?? ''} />
                    </Field>
                    <Field label={t('quotation.priceUnit')}>
                      <input name={`line${index}PriceUnit`} className="input w-full" defaultValue={offer?.priceUnit ?? ''} />
                    </Field>
                    <Field label={t('quotation.deliveryDate')}>
                      <input name={`line${index}Delivery`} type="date" className="input w-full" defaultValue={offer?.deliveryDate ?? line.deliveryDate} />
                    </Field>
                    <Field label={t('quotation.remark')}>
                      <input name={`line${index}Remark`} className="input w-full" maxLength={80} defaultValue={offer?.remark ?? ''} />
                    </Field>
                  </div>
                </div>
              );
            })}
            {standing && (
              <Field label={t('quotation.reason')}>
                <input name="reason" className="input w-full" maxLength={500} />
              </Field>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="submit" formAction={checkAction} className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || checking} data-quotation-check>
                {checking ? t('quotation.checking') : t('quotation.check')}
              </button>
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canMaintain || saving} data-quotation-save>
                {saving ? t('quotation.saving') : t('quotation.save')}
              </button>
            </div>
          </form>
          <Notice state={checkState} />
          <Notice state={saveState} />
          {!canMaintain && <p className="mt-3 text-sm text-red-700">{t('quotation.capabilityMissing')}</p>}
        </section>
      )}
    </>
  );
}
