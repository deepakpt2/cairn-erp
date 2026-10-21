'use client';

import Link from 'next/link';
import { useActionState, type ReactNode } from 'react';

import { t } from '@/platform/i18n';
import type { InfoRecordChoiceLists, InfoRecordDocument } from '@/modules/purchasing/info-record';
import {
  changeInfoRecordAction,
  checkInfoRecordAction,
  createInfoRecordAction,
  type InfoRecordActionState,
} from './actions';

const INITIAL: InfoRecordActionState = { ok: false, message: '' };
const ROUTE = '/purchasing/info-record';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-40 flex-1">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

function Notice({ state }: { state: InfoRecordActionState }) {
  if (!state.message) return null;
  const standing = state.message.match(/IR-\d{7}/)?.[0];
  return (
    <div role="status" data-info-record-result className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-ink-soft">{state.remedy}</p>}
      {state.ok && state.wrote === false && <p data-info-record-preview className="mt-1">{t('infoRecord.previewNote')}</p>}
      {standing && !state.wrote && (
        <p className="mt-2">
          <Link href={`${ROUTE}?record=${standing}`} data-info-record-open className="underline">{t('infoRecord.openStanding', { number: standing })}</Link>
        </p>
      )}
      {state.wrote && state.infoRecordNumber && (
        <p className="mt-2">
          <Link href={`${ROUTE}?record=${state.infoRecordNumber}`} className="underline">{t('infoRecord.openStanding', { number: state.infoRecordNumber })}</Link>
        </p>
      )}
    </div>
  );
}

/**
 * One screen. The category is Standard, shown as text. Check writes nothing. A change of the
 * same record is not another transaction. The search aliases are not identifiers on this form.
 */
export default function InfoRecordWorkbench({
  record,
  requestedNumber,
  requestedSupplier,
  requestedMaterial,
  namedExisting,
  choices,
  canMaintain,
}: {
  record: InfoRecordDocument | null;
  requestedNumber: string;
  requestedSupplier: string;
  requestedMaterial: string;
  namedExisting: string | null;
  choices: InfoRecordChoiceLists;
  canMaintain: boolean;
}) {
  const [checkState, checkAction, checking] = useActionState(checkInfoRecordAction, INITIAL);
  const [createState, createAction, creating] = useActionState(createInfoRecordAction, INITIAL);
  const [changeState, changeAction, changing] = useActionState(changeInfoRecordAction, INITIAL);

  return (
    <>
      <section aria-labelledby="info-record-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="info-record-lookup" className="text-sm font-semibold">{t('infoRecord.lookupTitle')}</h2>
        <form method="get" action={ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
          <Field label={t('infoRecord.number')}>
            <input name="record" className="input w-full" defaultValue={record?.infoRecordNumber ?? requestedNumber} />
          </Field>
          <Field label={t('infoRecord.supplier')}>
            <input name="supplier" className="input w-full" list="info-record-suppliers" defaultValue={requestedSupplier} />
          </Field>
          <Field label={t('infoRecord.material')}>
            <input name="material" className="input w-full" list="info-record-materials" defaultValue={requestedMaterial} />
          </Field>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">{t('infoRecord.load')}</button>
          <Link href={ROUTE} className="btn btn-default min-h-11 sm:min-h-8">{t('infoRecord.newRecord')}</Link>
        </form>
        {requestedNumber && !record && (
          <p role="status" className="mt-2 text-sm text-red-700">{t('infoRecord.notFound', { number: requestedNumber })}</p>
        )}
        {namedExisting && record && (
          <p className="mt-2 text-sm text-ink-soft">{t('infoRecord.namedExisting', { number: record.infoRecordNumber })}</p>
        )}
        {choices.records.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {choices.records.map((row) => (
              <li key={row.infoRecordNumber}>
                <Link href={`${ROUTE}?record=${row.infoRecordNumber}`} className="underline">
                  {row.infoRecordNumber} · {row.partnerNumber} · {row.materialNumber}{row.markedForDeletion ? ` · ${t('infoRecord.inactive')}` : ''}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {record && (
        <section aria-labelledby="info-record-standing" data-info-record-standing className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="info-record-standing" className="text-sm font-semibold">{record.infoRecordNumber}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            {record.partnerNumber} {record.partnerName} · {record.materialNumber} {record.materialDescription}
          </p>
          <p className="mt-1 text-sm">
            <span data-info-record-category="STANDARD">{t('infoRecord.categoryStandard')}</span>
            {' · '}
            {t('infoRecord.version', { version: record.version })}
            {record.markedForDeletion ? ` · ${t('infoRecord.inactive')}` : ''}
          </p>
          <form action={changeAction} className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="infoRecordNumber" value={record.infoRecordNumber} />
            <input type="hidden" name="expectedVersion" value={record.version} />
            <Field label={t('infoRecord.reason')}>
              <input name="reason" className="input w-full" required minLength={3} maxLength={500} />
            </Field>
            {record.markedForDeletion ? (
              <button type="submit" name="intent" value="reactivate-record" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || changing} data-info-record-reactivate>
                {t('infoRecord.reactivate')}
              </button>
            ) : (
              <button type="submit" name="intent" value="deactivate-record" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || changing} data-info-record-deactivate>
                {t('infoRecord.deactivate')}
              </button>
            )}
          </form>

          <div className="mt-4 space-y-4">
            {record.segments.map((segment) => (
              <article key={segment.segmentNumber} data-info-record-segment={segment.segmentNumber} className="border-t border-line pt-3">
                <h3 className="text-sm font-semibold">
                  {t('infoRecord.segment', { segment: segment.segmentNumber })} · {segment.purchasingOrg}
                  {segment.plant ? ` · ${segment.plant}` : ` · ${t('infoRecord.organisationLevel')}`}
                  {segment.markedForDeletion ? ` · ${t('infoRecord.inactive')}` : ''}
                  {' · '}{t('infoRecord.version', { version: segment.version })}
                </h3>
                <p className="mt-1 text-sm text-ink-soft">
                  {t('infoRecord.leadTime')}: {segment.plannedDeliveryDays ?? '—'}
                  {' · '}{t('infoRecord.minimum')}: {segment.minimumOrderQuantity ?? '—'} {segment.minimumOrderUnit ?? ''}
                  {' · '}{t('infoRecord.orderUnit')}: {segment.orderUnit ?? '—'}
                </p>
                <table className="mt-2 w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                      <th>{t('infoRecord.price')}</th>
                      <th>{t('infoRecord.amount')}</th>
                      <th>{t('infoRecord.validity')}</th>
                      <th>{t('infoRecord.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {segment.prices.map((price) => (
                      <tr key={price.priceSequence} data-info-record-price={price.priceSequence}>
                        <td className="py-1">{price.priceSequence}</td>
                        <td>{price.amount} {price.currency} / {price.priceUnit} {price.priceUnitOfMeasure}</td>
                        <td>{price.validFrom} – {price.validTo}</td>
                        <td>{price.markedForDeletion ? t('infoRecord.inactive') : t('infoRecord.active')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <form action={changeAction} className="mt-3 space-y-3">
                  <input type="hidden" name="infoRecordNumber" value={record.infoRecordNumber} />
                  <input type="hidden" name="expectedVersion" value={record.version} />
                  <input type="hidden" name="segmentNumber" value={segment.segmentNumber} />
                  <input type="hidden" name="expectedSegmentVersion" value={segment.version} />
                  <div className="flex flex-wrap gap-3">
                    <Field label={t('infoRecord.leadTime')}>
                      <input name="plannedDeliveryDays" className="input w-full" inputMode="numeric" defaultValue={segment.plannedDeliveryDays ?? ''} />
                    </Field>
                    <Field label={t('infoRecord.minimum')}>
                      <input name="minimumOrderQuantity" className="input w-full" inputMode="decimal" defaultValue={segment.minimumOrderQuantity ?? ''} />
                    </Field>
                    <Field label={t('infoRecord.minimumUnit')}>
                      <input name="minimumOrderUnit" className="input w-full" list="info-record-units" defaultValue={segment.minimumOrderUnit ?? ''} />
                    </Field>
                    <Field label={t('infoRecord.orderUnit')}>
                      <input name="orderUnit" className="input w-full" list="info-record-units" defaultValue={segment.orderUnit ?? ''} />
                    </Field>
                  </div>
                  <p className="text-xs text-ink-soft">{t('infoRecord.newPriceHint')}</p>
                  <div className="flex flex-wrap gap-3">
                    <Field label={t('infoRecord.amount')}>
                      <input name="amount" className="input w-full" inputMode="decimal" />
                    </Field>
                    <Field label={t('infoRecord.currency')}>
                      <input name="currency" className="input w-full" list="info-record-currencies" defaultValue={segment.prices.at(-1)?.currency ?? ''} />
                    </Field>
                    <Field label={t('infoRecord.priceUnit')}>
                      <input name="priceUnit" className="input w-full" inputMode="numeric" defaultValue="1" />
                    </Field>
                    <Field label={t('infoRecord.priceUnitOfMeasure')}>
                      <input name="priceUnitOfMeasure" className="input w-full" list="info-record-units" defaultValue={segment.prices.at(-1)?.priceUnitOfMeasure ?? ''} />
                    </Field>
                    <Field label={t('infoRecord.validFrom')}>
                      <input type="date" name="validFrom" className="input w-full" />
                    </Field>
                    <Field label={t('infoRecord.validTo')}>
                      <input type="date" name="validTo" className="input w-full" />
                    </Field>
                  </div>
                  <Field label={t('infoRecord.reason')}>
                    <input name="reason" className="input w-full" required minLength={3} maxLength={500} />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <button type="submit" name="intent" value="change" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canMaintain || changing} data-info-record-change>
                      {t('infoRecord.saveChange')}
                    </button>
                    {segment.markedForDeletion ? (
                      <button type="submit" name="intent" value="reactivate-segment" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || changing}>
                        {t('infoRecord.reactivateSegment')}
                      </button>
                    ) : (
                      <button type="submit" name="intent" value="deactivate-segment" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || changing} data-info-record-deactivate-segment>
                        {t('infoRecord.deactivateSegment')}
                      </button>
                    )}
                  </div>
                </form>
                <div className="mt-2 flex flex-wrap gap-2">
                  {segment.prices.map((price) => (
                    <form key={price.priceSequence} action={changeAction}>
                      <input type="hidden" name="infoRecordNumber" value={record.infoRecordNumber} />
                      <input type="hidden" name="expectedVersion" value={record.version} />
                      <input type="hidden" name="segmentNumber" value={segment.segmentNumber} />
                      <input type="hidden" name="expectedSegmentVersion" value={segment.version} />
                      <input type="hidden" name="priceSequence" value={price.priceSequence} />
                      <input type="hidden" name="intent" value={price.markedForDeletion ? 'reactivate-price' : 'deactivate-price'} />
                      <Field label={t('infoRecord.reason')}>
                        <input name="reason" className="input w-full" required minLength={3} maxLength={500} />
                      </Field>
                      <button type="submit" className="btn btn-default mt-2 min-h-11 sm:min-h-8" disabled={!canMaintain || changing} data-info-record-price-mark={price.priceSequence}>
                        {price.markedForDeletion ? t('infoRecord.reactivatePrice', { sequence: price.priceSequence }) : t('infoRecord.deactivatePrice', { sequence: price.priceSequence })}
                      </button>
                    </form>
                  ))}
                </div>
              </article>
            ))}
          </div>
          <Notice state={changeState} />
        </section>
      )}

      <section aria-labelledby="info-record-create" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="info-record-create" className="text-sm font-semibold">
          {record ? t('infoRecord.addSegment', { number: record.infoRecordNumber }) : t('infoRecord.createTitle')}
        </h2>
        <p className="mt-1 text-sm text-ink-soft">{t('infoRecord.createHint')}</p>
        <p className="mt-1 text-sm" data-info-record-category="STANDARD">{t('infoRecord.categoryStandard')}</p>
        <form className="mt-3 space-y-3">
          {record && (
            <>
              <input type="hidden" name="infoRecordNumber" value={record.infoRecordNumber} />
              <input type="hidden" name="expectedVersion" value={record.version} />
            </>
          )}
          <div className="flex flex-wrap gap-3">
            <Field label={t('infoRecord.supplier')}>
              <input name="partnerNumber" className="input w-full" list="info-record-suppliers" required defaultValue={record?.partnerNumber ?? requestedSupplier} readOnly={Boolean(record)} />
            </Field>
            <Field label={t('infoRecord.material')}>
              <input name="materialNumber" className="input w-full" list="info-record-materials" required defaultValue={record?.materialNumber ?? requestedMaterial} readOnly={Boolean(record)} />
            </Field>
            <Field label={t('infoRecord.purchasingOrg')}>
              <input name="purchasingOrg" className="input w-full" list="info-record-orgs" required />
            </Field>
            <Field label={t('infoRecord.plant')}>
              <input name="plant" className="input w-full" list="info-record-plants" />
            </Field>
          </div>
          <p className="text-xs text-ink-soft">{t('infoRecord.plantHint')}</p>
          <div className="flex flex-wrap gap-3">
            <Field label={t('infoRecord.amount')}>
              <input name="amount" className="input w-full" inputMode="decimal" required />
            </Field>
            <Field label={t('infoRecord.currency')}>
              <input name="currency" className="input w-full" list="info-record-currencies" required />
            </Field>
            <Field label={t('infoRecord.priceUnit')}>
              <input name="priceUnit" className="input w-full" inputMode="numeric" defaultValue="1" required />
            </Field>
            <Field label={t('infoRecord.priceUnitOfMeasure')}>
              <input name="priceUnitOfMeasure" className="input w-full" list="info-record-units" required />
            </Field>
            <Field label={t('infoRecord.validFrom')}>
              <input type="date" name="validFrom" className="input w-full" required />
            </Field>
            <Field label={t('infoRecord.validTo')}>
              <input type="date" name="validTo" className="input w-full" required />
            </Field>
          </div>
          <div className="flex flex-wrap gap-3">
            <Field label={t('infoRecord.leadTime')}>
              <input name="plannedDeliveryDays" className="input w-full" inputMode="numeric" />
            </Field>
            <Field label={t('infoRecord.minimum')}>
              <input name="minimumOrderQuantity" className="input w-full" inputMode="decimal" />
            </Field>
            <Field label={t('infoRecord.minimumUnit')}>
              <input name="minimumOrderUnit" className="input w-full" list="info-record-units" />
            </Field>
            <Field label={t('infoRecord.orderUnit')}>
              <input name="orderUnit" className="input w-full" list="info-record-units" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" formAction={checkAction} className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || checking} data-info-record-check>
              {checking ? t('infoRecord.checking') : t('infoRecord.check')}
            </button>
            <button type="submit" formAction={createAction} className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canMaintain || creating} data-info-record-create>
              {creating ? t('infoRecord.saving') : t('infoRecord.save')}
            </button>
          </div>
          <Notice state={checkState} />
          <Notice state={createState} />
        </form>
        {!canMaintain && <p className="mt-3 text-sm text-red-700">{t('infoRecord.capabilityMissing')}</p>}
      </section>

      <datalist id="info-record-suppliers">
        {choices.suppliers.map((row) => (
          <option key={`${row.partnerNumber}-${row.purchasingOrg}`} value={row.partnerNumber}>{row.name} · {row.purchasingOrg} · {row.orderCurrency ?? ''}</option>
        ))}
      </datalist>
      <datalist id="info-record-materials">
        {choices.materials.map((row) => <option key={row.materialNumber} value={row.materialNumber}>{row.description}</option>)}
      </datalist>
      <datalist id="info-record-orgs">
        {choices.purchasingOrgs.map((row) => <option key={row.purchasingOrg} value={row.purchasingOrg}>{row.name}</option>)}
      </datalist>
      <datalist id="info-record-plants">
        {choices.plants.map((row) => <option key={`${row.purchasingOrg}-${row.plant}`} value={row.plant}>{row.name} · {row.purchasingOrg}</option>)}
      </datalist>
      <datalist id="info-record-currencies">
        {choices.currencies.map((code) => <option key={code} value={code} />)}
      </datalist>
      <datalist id="info-record-units">
        {choices.units.map((code) => <option key={code} value={code} />)}
      </datalist>
    </>
  );
}
