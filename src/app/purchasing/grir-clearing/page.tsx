import Link from 'next/link';
import type { ReactNode } from 'react';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import {
  GRIR_CLEARING_CAPABILITY,
  GRIR_CLEARING_POST_CAPABILITY,
  GRIR_CLEARING_REVERSE_CAPABILITY,
  GRIR_CLEARING_ROUTE,
  GrIrClearingError,
  listGrIrMaintenance,
  listGrIrResiduals,
  type GrIrMaintenanceRow,
  type GrIrResidual,
} from '@/modules/purchasing/grir-clearing';

import { ClearResidualForm, ReverseClearingForm } from './GrirClearingForms';

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

/**
 * Maintain GR/IR clearing — SCR-163.
 *
 * The list is a calculation. A check writes nothing. A post writes one
 * journal and does not move stock. The search alias stays in the catalogue.
 */
export default async function GrIrClearingPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(GRIR_CLEARING_ROUTE);
  const params = await searchParams;
  const companyFrom = last(params.companyFrom).toUpperCase();
  const companyTo = last(params.companyTo).toUpperCase();
  const orderFrom = last(params.orderFrom).toUpperCase();
  const orderTo = last(params.orderTo).toUpperCase();
  const itemNumber = last(params.itemNumber);
  const plantFrom = last(params.plantFrom).toUpperCase();
  const plantTo = last(params.plantTo).toUpperCase();
  const keyDate = last(params.keyDate);
  const surplus = last(params.surplus).toUpperCase() || 'BOTH';
  const notice = last(params.notice);
  const canView = can(session, GRIR_CLEARING_CAPABILITY);
  const canPost = can(session, GRIR_CLEARING_POST_CAPABILITY);
  const canReverse = can(session, GRIR_CLEARING_REVERSE_CAPABILITY);
  let rows: GrIrResidual[] = [];
  let posted: GrIrMaintenanceRow[] = [];
  let listError: string | null = null;
  if (canView && companyFrom && keyDate) {
    try {
      const selection = { client: session.user.client, companyFrom, companyTo, orderFrom, orderTo, itemNumber, plantFrom, plantTo, keyDate, surplus };
      rows = await listGrIrResiduals(selection);
      posted = await listGrIrMaintenance(selection);
    } catch (error) {
      listError = error instanceof GrIrClearingError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The GR/IR residuals could not be read.';
    }
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('grirClearing.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('grirClearing.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/purchasing/invoice-overview" className="btn btn-default min-h-11 sm:min-h-8">{t('invoiceOverview.title')}</Link>
            <Link href="/inventory/material-document-list" className="btn btn-default min-h-11 sm:min-h-8">{t('grirClearing.history')}</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('grirClearing.subtitle')}</p>
        {notice && <p className="mt-3 text-sm" role="status" data-grir-notice>{notice}</p>}
      </header>

      {!canView && <p className="text-sm text-red-700" role="alert">{t('grirClearing.capabilityMissing')}</p>}

      <section aria-labelledby="grir-clearing-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="grir-clearing-selection" className="text-sm font-semibold">{t('grirClearing.selection')}</h2>
        <p className="mt-1 text-xs text-ink-soft" data-grir-check-writes-nothing>{t('grirClearing.checkWritesNothing')}</p>
        <form method="get" action={GRIR_CLEARING_ROUTE} className="mt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('grirClearing.companyFrom')}>
              <ConstrainedField kind="company" name="companyFrom" defaultValue={companyFrom} />
            </Field>
            <Field label={t('grirClearing.companyTo')}>
              <ConstrainedField kind="company" name="companyTo" defaultValue={companyTo} />
            </Field>
            <Field label={t('grirClearing.orderFrom')}>
              <ConstrainedField kind="purchase-order" name="orderFrom" uppercase defaultValue={orderFrom} />
            </Field>
            <Field label={t('grirClearing.orderTo')}>
              <ConstrainedField kind="purchase-order" name="orderTo" uppercase defaultValue={orderTo} />
            </Field>
            <Field label={t('grirClearing.item')}>
              <input name="itemNumber" className="input w-full" defaultValue={itemNumber} maxLength={5} inputMode="numeric" />
            </Field>
            <Field label={t('grirClearing.plantFrom')}>
              <ConstrainedField kind="plant" name="plantFrom" defaultValue={plantFrom} />
            </Field>
            <Field label={t('grirClearing.plantTo')}>
              <ConstrainedField kind="plant" name="plantTo" defaultValue={plantTo} />
            </Field>
            <Field label={t('grirClearing.keyDate')}>
              <input name="keyDate" type="date" className="input w-full" required defaultValue={keyDate} />
            </Field>
            <Field label={t('grirClearing.surplus')}>
              <select name="surplus" className="input w-full" defaultValue={surplus}>
                <option value="BOTH">{t('grirClearing.both')}</option>
                <option value="DELIVERY">{t('grirClearing.delivery')}</option>
                <option value="INVOICE">{t('grirClearing.invoice')}</option>
              </select>
            </Field>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" data-grir-list>{t('grirClearing.list')}</button>
          </div>
        </form>
        {listError && <p className="mt-3 text-sm text-red-700" role="alert" data-grir-error>{listError}</p>}
      </section>

      <section aria-labelledby="grir-clearing-residuals" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="grir-clearing-residuals" className="text-sm font-semibold">{t('grirClearing.residuals')}</h2>
        <p className="mt-1 text-xs text-ink-soft" data-grir-no-stock>{t('grirClearing.noStock')}</p>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft" data-grir-empty>{t('grirClearing.empty')}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-soft">
                  <th className="px-2 py-2">{t('grirClearing.order')}</th>
                  <th className="px-2 py-2">{t('grirClearing.material')}</th>
                  <th className="px-2 py-2">{t('grirClearing.quantities')}</th>
                  <th className="px-2 py-2">{t('grirClearing.residual')}</th>
                  <th className="px-2 py-2">{t('grirClearing.accounts')}</th>
                  <th className="px-2 py-2">{t('grirClearing.clear')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.orderNumber}-${row.itemNumber}`} className="border-t border-line align-top" data-grir-row={row.orderNumber} data-grir-item={row.itemNumber}>
                    <td className="px-2 py-2">
                      {row.orderNumber} / {row.itemNumber}
                      <div className="text-ink-soft">{row.companyCode} · {row.plant} · {row.supplier}</div>
                    </td>
                    <td className="px-2 py-2">{row.materialNumber ?? '—'}<div className="text-ink-soft">{row.shortText}</div></td>
                    <td className="px-2 py-2">
                      {row.receivedQuantity} / {row.invoicedQuantity} {row.unit}
                      <div className="text-ink-soft">{t('grirClearing.openQuantity')} {row.openQuantity}</div>
                    </td>
                    <td className="px-2 py-2">
                      {row.remaining.toFixed(2)} {row.currency}
                      <div className="text-ink-soft">{row.surplus === 'DELIVERY' ? t('grirClearing.delivery') : t('grirClearing.invoice')} · {row.category === 'QUANTITY' ? t('grirClearing.quantityResidual') : t('grirClearing.valueResidual')}</div>
                      {row.furtherActivity && <div className="text-ink-soft" data-grir-further>{row.furtherActivity}</div>}
                      {row.refusal && <div className="text-red-700" data-grir-refusal>{row.refusal}</div>}
                    </td>
                    <td className="px-2 py-2">{row.grIrAccount ?? '—'} / {row.offsetAccount ?? '—'}</td>
                    <td className="px-2 py-2">
                      {canPost && row.eligible ? (
                        <ClearResidualForm
                          orderNumber={row.orderNumber}
                          itemNumber={row.itemNumber}
                          keyDate={keyDate}
                          fingerprint={row.fingerprint}
                          postingDateLabel={t('grirClearing.postingDate')}
                          reasonLabel={t('grirClearing.reason')}
                          checkLabel={t('grirClearing.check')}
                          postLabel={t('grirClearing.post')}
                          checkingLabel={t('grirClearing.checking')}
                          postingLabel={t('grirClearing.posting')}
                          acknowledgeLabel={t('grirClearing.acknowledge')}
                        />
                      ) : (
                        <span className="text-ink-soft">{row.refusal ?? t('grirClearing.notEligible')}</span>
                      )}
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        <Link className="underline" href={`/purchasing/invoice-overview?companyFrom=${encodeURIComponent(row.companyCode)}&fiscalYear=${keyDate.slice(0, 4)}&orderFrom=${encodeURIComponent(row.orderNumber)}&orderTo=${encodeURIComponent(row.orderNumber)}`}>{t('invoiceOverview.title')}</Link>
                        <Link className="underline" href={`/inventory/material-document-list?purchaseOrderFrom=${encodeURIComponent(row.orderNumber)}&purchaseOrderTo=${encodeURIComponent(row.orderNumber)}&postingDateFrom=2000-01-01&postingDateTo=${encodeURIComponent(keyDate)}`}>{t('grirClearing.history')}</Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="grir-clearing-posted" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="grir-clearing-posted" className="text-sm font-semibold">{t('grirClearing.posted')}</h2>
        {posted.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft" data-grir-posted-empty>{t('grirClearing.noPosting')}</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {posted.map((row) => (
              <li key={`${row.documentNumber}-${row.fiscalYear}`} className="border-t border-line pt-3" data-grir-posted={row.documentNumber}>
                <div className="text-sm">
                  <Link className="underline" href={`/finance/journal/document?document=${encodeURIComponent(row.documentNumber)}&company=${encodeURIComponent(row.companyCode)}&year=${row.fiscalYear}`}>{row.documentNumber}</Link>
                  {' · '}{row.orderNumber}/{row.itemNumber} · {row.allocatedAmount} {row.currency} · {row.createdBy}
                  {row.reversedBy ? ` · ${t('grirClearing.reversedBy')} ${row.reversedBy}` : ''}
                </div>
                <p className="text-xs text-ink-soft">{row.comment}</p>
                {canReverse && !row.reversedBy && (
                  <div className="mt-2">
                    <ReverseClearingForm
                      documentNumber={row.documentNumber}
                      fiscalYear={row.fiscalYear}
                      reversalDateLabel={t('grirClearing.reversalDate')}
                      reasonLabel={t('grirClearing.reason')}
                      reverseLabel={t('grirClearing.reverse')}
                      reversingLabel={t('grirClearing.reversing')}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
