'use client';

import Link from 'next/link';
import { useActionState, useState, type ReactNode } from 'react';

import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import type { TaxCodeChoice } from '@/modules/purchasing/invoice-verification';
import type { OpenedPark, ParkedInvoiceView } from '@/modules/purchasing/parked-invoice';
import type { ParkedInvoiceActionState } from './actions';
import { checkParkedInvoiceAction, saveParkedInvoiceAction } from './actions';

const ROUTE = '/purchasing/parked-invoice';
const INITIAL: ParkedInvoiceActionState = { ok: false, message: '' };

function newRequestKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-40 flex-1 text-sm">
      <span className="mb-1 block text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function Notice({ state }: { state: ParkedInvoiceActionState }) {
  if (!state.message) return null;
  const preview = state.preview;
  return (
    <div role="status" data-parked-invoice-result className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1">{state.remedy}</p>}
      {state.ok && state.wrote === false && (
        <p data-parked-invoice-nothing-written className="mt-1">{t('parkedInvoice.nothingWritten')}</p>
      )}
      {state.ok && (
        <p data-parked-invoice-no-post className="mt-1">{t('parkedInvoice.noPost')}</p>
      )}
      {preview && preview.lines.length > 0 && (
        <table className="mt-3 w-full text-sm" data-parked-invoice-match>
          <thead>
            <tr className="text-left text-ink-soft">
              <th className="py-1 pr-3">{t('parkedInvoice.item')}</th>
              <th className="py-1 pr-3">{t('parkedInvoice.quantity')}</th>
              <th className="py-1 pr-3">{t('parkedInvoice.received')}</th>
              <th className="py-1 pr-3">{t('parkedInvoice.invoiced')}</th>
              <th className="py-1 pr-3">{t('parkedInvoice.invoiceable')}</th>
              <th className="py-1 pr-3">{t('parkedInvoice.net')}</th>
              <th className="py-1">Expected</th>
            </tr>
          </thead>
          <tbody>
            {preview.lines.map((line) => (
              <tr key={line.itemNumber}>
                <td className="py-1 pr-3">{line.itemNumber}</td>
                <td className="py-1 pr-3">{line.quantity}</td>
                <td className="py-1 pr-3">{line.received}</td>
                <td className="py-1 pr-3" data-parked-invoiced={line.itemNumber}>{line.invoiced}</td>
                <td className="py-1 pr-3">{line.invoiceable}</td>
                <td className="py-1 pr-3">{line.netAmount}</td>
                <td className="py-1">{line.expectedAmount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {preview && preview.notes.length > 0 && (
        <ul className="mt-2 space-y-1" data-parked-invoice-notes>
          {preview.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
      {preview && (
        <p className="mt-1" data-parked-invoice-terms>
          {preview.paymentTerms ? `${preview.paymentTerms} · ${preview.dueDate ?? ''}` : 'Payment terms were not derived.'}
          {` · ${preview.currency} · tax ${preview.taxAmount}`}
        </p>
      )}
      {state.ok && state.wrote && state.parkedNumber && (
        <p className="mt-1">
          <Link href={`${ROUTE}?parked=${state.parkedNumber}`} data-parked-invoice-open className="underline">
            {t('parkedInvoice.openStanding', { number: state.parkedNumber })}
          </Link>
        </p>
      )}
    </div>
  );
}

export default function ParkedInvoice({
  opened,
  standing,
  requestedOrder,
  requestedPark,
  recent,
  taxCodes,
  today,
  canPark,
}: {
  opened: OpenedPark | null;
  standing: ParkedInvoiceView | null;
  requestedOrder: string;
  requestedPark: string;
  recent: Array<{ parkedNumber: string; purchaseOrderNumber: string; supplierReference: string }>;
  taxCodes: TaxCodeChoice[];
  today: string;
  canPark: boolean;
}) {
  const [checkState, checkAction, checking] = useActionState(checkParkedInvoiceAction, INITIAL);
  const [saveState, saveAction, saving] = useActionState(saveParkedInvoiceAction, INITIAL);
  const [requestKey] = useState(newRequestKey);
  const savedLine = (itemNumber: number) => standing?.lines.find((line) => line.itemNumber === itemNumber) ?? null;

  return (
    <>
      <section aria-labelledby="parked-invoice-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="parked-invoice-lookup" className="text-sm font-semibold">{t('parkedInvoice.lookupTitle')}</h2>
        <form method="get" action={ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
          <Field label={t('parkedInvoice.order')}>
            <ConstrainedField kind="purchase-order" name="order" uppercase defaultValue={opened?.orderNumber || requestedOrder} />
          </Field>
          <Field label={t('parkedInvoice.parkedNumber')}>
            <ConstrainedField kind="parked-invoice" name="parked" uppercase defaultValue={standing?.parkedNumber || requestedPark} />
          </Field>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">{t('parkedInvoice.load')}</button>
        </form>
        {requestedOrder && !opened && (
          <p role="status" className="mt-2 text-sm text-red-700">{t('parkedInvoice.notFound', { number: requestedOrder })}</p>
        )}
        {requestedPark && !standing && (
          <p role="status" className="mt-2 text-sm text-red-700">{t('parkedInvoice.parkMissing', { number: requestedPark })}</p>
        )}
        <p className="mt-2 text-xs text-ink-soft" data-parked-invoice-no-post>{t('parkedInvoice.noPost')}</p>
        {recent.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {recent.map((row) => (
              <li key={row.parkedNumber}>
                <Link href={`${ROUTE}?parked=${row.parkedNumber}`} className="underline">
                  {row.parkedNumber} · {row.purchaseOrderNumber} · {row.supplierReference}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {opened && (
        <section aria-labelledby="parked-invoice-maintain" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="parked-invoice-maintain" className="text-sm font-semibold">
            {standing ? standing.parkedNumber : opened.orderNumber}
          </h2>
          <p className="mt-1 text-sm text-ink-soft" data-parked-invoice-identity>
            {opened.orderNumber} · {opened.supplierNumber} · {opened.companyCode} · {opened.currency}
          </p>
          <p className="mt-1 text-xs text-ink-soft">{t('parkedInvoice.identity')}</p>
          {opened.parks.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2 text-sm" data-parked-invoice-existing>
              {opened.parks.map((park) => (
                <li key={park.parkedNumber}>
                  <Link href={`${ROUTE}?parked=${park.parkedNumber}`} className="underline">
                    {park.parkedNumber} · {park.supplierReference} · {park.grossAmount}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <form action={saveAction} className="mt-3 space-y-3">
            <input type="hidden" name="orderNumber" value={opened.orderNumber} />
            {standing && <input type="hidden" name="parkedNumber" value={standing.parkedNumber} />}
            {standing && <input type="hidden" name="expectedChangedAt" value={standing.changedAt} />}
            {!standing && <input type="hidden" name="requestKey" value={requestKey} />}
            <div className="flex flex-wrap items-end gap-3">
              <Field label={t('parkedInvoice.reference')}>
                <input name="supplierReference" className="input w-full" maxLength={16} required defaultValue={standing?.supplierReference ?? ''} />
              </Field>
              <Field label={t('parkedInvoice.invoiceDate')}>
                <input type="date" name="invoiceDate" className="input w-full" required defaultValue={standing?.invoiceDate ?? today} />
              </Field>
              <Field label={t('parkedInvoice.postingDate')}>
                <input type="date" name="postingDate" className="input w-full" required defaultValue={standing?.postingDate ?? today} />
              </Field>
              <Field label={t('parkedInvoice.gross')}>
                <input name="grossAmount" className="input w-full" required defaultValue={standing?.grossAmount ?? ''} />
              </Field>
              <Field label={t('parkedInvoice.headerText')}>
                <input name="headerText" className="input w-full" maxLength={100} defaultValue={standing?.headerText ?? ''} />
              </Field>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th className="px-2 py-2">{t('parkedInvoice.item')}</th>
                    <th className="px-2 py-2">{t('parkedInvoice.received')}</th>
                    <th className="px-2 py-2">{t('parkedInvoice.invoiced')}</th>
                    <th className="px-2 py-2">{t('parkedInvoice.invoiceable')}</th>
                    <th className="px-2 py-2">{t('parkedInvoice.quantity')}</th>
                    <th className="px-2 py-2">{t('parkedInvoice.net')}</th>
                    <th className="px-2 py-2">{t('parkedInvoice.tax')}</th>
                  </tr>
                </thead>
                <tbody>
                  {opened.items.map((item) => {
                    const saved = savedLine(item.itemNumber);
                    return (
                      <tr key={item.itemNumber} className="border-t border-line" data-parked-line={item.itemNumber}>
                        <td className="px-2 py-2">{item.itemNumber} · {item.materialNumber ?? item.shortText}</td>
                        <td className="px-2 py-2" data-received={item.itemNumber}>{item.received}</td>
                        <td className="px-2 py-2" data-invoiced={item.itemNumber}>{item.invoiced}</td>
                        <td className="px-2 py-2" data-invoiceable={item.itemNumber}>{item.invoiceable}</td>
                        <td className="px-2 py-2">
                          {item.eligible ? (
                            <input name={`qty-${item.itemNumber}`} className="input w-24" defaultValue={saved?.quantity ?? (item.invoiceable > 0 ? String(item.invoiceable) : '')} />
                          ) : (
                            <>
                              <span className="text-ink-faint">{item.refusal}</span>
                              {saved && (
                                <>
                                  <input type="hidden" name={`qty-${item.itemNumber}`} value={saved.quantity} />
                                  <input type="hidden" name={`amt-${item.itemNumber}`} value={saved.netAmount} />
                                  <input type="hidden" name={`tax-${item.itemNumber}`} value={saved.taxCode ?? ''} />
                                </>
                              )}
                            </>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {item.eligible && (
                            <input name={`amt-${item.itemNumber}`} className="input w-28" defaultValue={saved?.netAmount ?? ''} />
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {item.eligible && (
                            <select name={`tax-${item.itemNumber}`} className="input w-28" defaultValue={saved?.taxCode ?? item.taxCode}>
                              <option value="">—</option>
                              {taxCodes.map((code) => (
                                <option key={code.code} value={code.code}>{code.code} ({code.ratePercent}%)</option>
                              ))}
                            </select>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-sm text-ink-soft">{t('parkedInvoice.calculated')}</p>
            {standing && (
              <Field label={t('parkedInvoice.reason')}>
                <input name="reason" className="input w-full" maxLength={500} />
              </Field>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="submit" formAction={checkAction} className="btn btn-default min-h-11 sm:min-h-8" disabled={!canPark || checking} data-parked-invoice-check>
                {checking ? t('parkedInvoice.checking') : t('parkedInvoice.check')}
              </button>
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPark || saving} data-parked-invoice-save>
                {saving ? (standing ? t('parkedInvoice.changing') : t('parkedInvoice.saving')) : (standing ? t('parkedInvoice.change') : t('parkedInvoice.save'))}
              </button>
            </div>
          </form>
          <Notice state={checkState} />
          <Notice state={saveState} />
          {standing && standing.history.length > 0 && (
            <div className="mt-4" data-parked-invoice-history>
              <h3 className="text-sm font-semibold">{t('parkedInvoice.history')}</h3>
              <ul className="mt-2 space-y-2 text-sm">
                {standing.history.map((entry) => (
                  <li key={`${entry.changedAt}-${entry.changeType}`}>
                    {entry.changeType} · {entry.changedBy} · {entry.changedAt}
                    {entry.fields.length > 0 && (
                      <span> · {entry.fields.map((field) => field.field).join(', ')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!canPark && <p className="mt-3 text-sm text-red-700">{t('parkedInvoice.capabilityMissing')}</p>}
        </section>
      )}
    </>
  );
}
