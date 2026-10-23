'use client';

import Link from 'next/link';
import { useActionState, useState, type ReactNode } from 'react';

import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import type { StandingRfq, StandingRfqEvent } from '@/modules/purchasing/rfq';
import type { RfqActionState } from './actions';
import { changeRfqAction, checkChangeRfqAction, checkRfqAction, createRfqAction } from './actions';

const ROUTE = '/purchasing/rfq';
const INITIAL: RfqActionState = { ok: false, message: '' };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-40 flex-1 text-sm">
      <span className="mb-1 block text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function Notice({ state }: { state: RfqActionState }) {
  if (!state.message) return null;
  return (
    <div role="status" data-rfq-result className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1">{state.remedy}</p>}
      {state.ok && state.wrote === false && (
        <p data-rfq-preview className="mt-1">{t('requestForQuotation.previewNote')}</p>
      )}
      {state.ok && state.wrote === false && (
        <p data-rfq-nothing-created className="mt-1">{t('requestForQuotation.nothingCreated')}</p>
      )}
      {state.ok && state.wrote === false && state.currency && (
        <p className="mt-1">{t('requestForQuotation.currency', { currency: state.currency })}</p>
      )}
      {state.lines && state.lines.length > 0 && (
        <table className="mt-3 w-full text-sm" data-rfq-preview-lines>
          <thead>
            <tr className="text-left text-ink-soft">
              <th className="py-1 pr-3">{t('requestForQuotation.item')}</th>
              <th className="py-1 pr-3">{t('requestForQuotation.shortText')}</th>
              <th className="py-1 pr-3">{t('requestForQuotation.quantity')}</th>
              <th className="py-1 pr-3">{t('requestForQuotation.unit')}</th>
              <th className="py-1">{t('requestForQuotation.plant')}</th>
            </tr>
          </thead>
          <tbody>
            {state.lines.map((line) => (
              <tr key={line.itemNumber}>
                <td className="py-1 pr-3">{line.itemNumber}</td>
                <td className="py-1 pr-3">{line.shortText}</td>
                <td className="py-1 pr-3">{line.quantity}</td>
                <td className="py-1 pr-3">{line.unit}</td>
                <td className="py-1">{line.plant}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {state.requests && state.requests.length > 0 && (
        <ul className="mt-2 space-y-1" data-rfq-preview-requests>
          {state.requests.map((request) => (
            <li key={request.partnerNumber}>{request.partnerNumber} · {request.rfqNumber ?? t('requestForQuotation.numberNotDrawn')}</li>
          ))}
        </ul>
      )}
      {state.ok && state.wrote && state.eventNumber && (
        <p className="mt-1">
          <Link href={`${ROUTE}?event=${state.eventNumber}`} data-rfq-open className="underline">
            {t('requestForQuotation.openStanding', { number: state.eventNumber })}
          </Link>
        </p>
      )}
    </div>
  );
}

function changedFields(state: RfqActionState): Array<{ field: string; before: string; after: string }> {
  const change = state.change;
  if (!change) return [];
  const rows: Array<{ field: string; before: string; after: string }> = [];
  if (change.header.purchasingGroup.before !== change.header.purchasingGroup.after) {
    rows.push({ field: t('requestForQuotation.purchasingGroup'), before: change.header.purchasingGroup.before, after: change.header.purchasingGroup.after });
  }
  if (change.header.quotationDeadline.before !== change.header.quotationDeadline.after) {
    rows.push({ field: t('requestForQuotation.deadline'), before: change.header.quotationDeadline.before, after: change.header.quotationDeadline.after });
  }
  if (change.header.collectiveNumber.before !== change.header.collectiveNumber.after) {
    rows.push({
      field: t('requestForQuotation.collective'),
      before: change.header.collectiveNumber.before ?? '',
      after: change.header.collectiveNumber.after ?? '',
    });
  }
  for (const line of change.lines) {
    const pairs: Array<[string, string, string]> = [
      [t('requestForQuotation.shortText'), line.before.shortText, line.after.shortText],
      [t('requestForQuotation.quantity'), line.before.quantity, line.after.quantity],
      [t('requestForQuotation.unit'), line.before.unit, line.after.unit],
      [t('requestForQuotation.plant'), line.before.plant, line.after.plant],
      [t('requestForQuotation.storage'), line.before.storageLocation ?? '', line.after.storageLocation ?? ''],
      [t('requestForQuotation.deliveryDate'), line.before.deliveryDate, line.after.deliveryDate],
    ];
    for (const [label, before, after] of pairs) {
      if (before !== after) rows.push({ field: `${line.itemNumber} ${label}`, before, after });
    }
  }
  return rows;
}

function ChangeNotice({ state }: { state: RfqActionState }) {
  if (!state.message) return null;
  const rows = changedFields(state);
  return (
    <div role="status" data-rfq-change-result className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1">{state.remedy}</p>}
      {state.ok && state.wrote === false && state.change?.headerIsTheEvents && (
        <p data-rfq-header-shared className="mt-1">{t('requestForQuotation.headerIsTheEvents')}</p>
      )}
      {state.ok && state.wrote === false && (
        <p data-rfq-change-preview className="mt-1">{t('requestForQuotation.nothingWritten')}</p>
      )}
      {rows.length > 0 && (
        <ul className="mt-2 space-y-1" data-rfq-change-diff>
          {rows.map((row) => (
            <li key={row.field}>{row.field}: {row.before} → {row.after}</li>
          ))}
        </ul>
      )}
      {state.ok && state.wrote && state.eventNumber && state.rfqNumber && (
        <p className="mt-1">
          <Link href={`${ROUTE}?event=${state.eventNumber}&request=${state.rfqNumber}`} className="underline">
            {t('requestForQuotation.openStanding', { number: state.rfqNumber })}
          </Link>
        </p>
      )}
    </div>
  );
}

function ChangeRequest({
  opened,
  request,
  canMaintain,
}: {
  opened: StandingRfqEvent;
  request: StandingRfq;
  canMaintain: boolean;
}) {
  const [plants, setPlants] = useState(request.lines.map((line) => line.plant));
  const [checkState, checkAction, checking] = useActionState(checkChangeRfqAction, INITIAL);
  const [changeState, changeAction, changing] = useActionState(changeRfqAction, INITIAL);
  // The form refreshes when the loaded time changes, so the next save carries the
  // standing token. The notice stays outside that refresh, or a successful save
  // would remount away the result the user is waiting to read.
  const formKey = `${request.rfqNumber}:${request.changedAt ?? ''}:${opened.changedAt ?? ''}`;
  return (
    <section aria-labelledby="rfq-change" data-rfq-change className="rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 id="rfq-change" className="text-sm font-semibold">{t('requestForQuotation.changeTitle')}</h2>
      {lockMessage && <p role="status" className="mt-2 border border-signal-warn/40 bg-amber-50 p-3 text-sm text-amber-800">{lockMessage}</p>}
      <p className="mt-1 text-xs text-ink-soft">{t('requestForQuotation.changeHint')}</p>
      <p className="mt-1 text-xs text-ink-soft" data-rfq-header-note>{t('requestForQuotation.headerIsTheEvents')}</p>
      <form key={formKey} action={changeAction} className="mt-3 space-y-3">
        <input type="hidden" name="rfqNumber" value={request.rfqNumber} />
        <input type="hidden" name="eventNumber" value={opened.eventNumber} />
        <input type="hidden" name="expectedEventChangedAt" value={opened.changedAt ?? ''} />
        <input type="hidden" name="expectedRequestChangedAt" value={request.changedAt ?? ''} />
        <input type="hidden" name="lineCount" value={request.lines.length} />
        <div className="flex flex-wrap gap-3 text-sm">
          <p><span className="text-ink-soft">{t('requestForQuotation.event')}</span> {opened.eventNumber}</p>
          <p data-rfq-selected={request.rfqNumber}><span className="text-ink-soft">{t('requestForQuotation.request')}</span> {request.rfqNumber}</p>
          <p><span className="text-ink-soft">{t('requestForQuotation.supplier')}</span> {request.partnerNumber}</p>
          <p><span className="text-ink-soft">{t('requestForQuotation.purchasingOrg')}</span> {opened.purchasingOrg}</p>
          <p><span className="text-ink-soft">{t('requestForQuotation.rfqDate')}</span> {opened.rfqDate}</p>
          <p><span className="text-ink-soft">{t('requestForQuotation.currency', { currency: opened.currency })}</span></p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Field label={t('requestForQuotation.purchasingGroup')}>
            <ConstrainedField kind="purchasing-group" name="purchasingGroup" required defaultValue={opened.purchasingGroup} context={{ purchasingOrg: opened.purchasingOrg }} />
          </Field>
          <Field label={t('requestForQuotation.deadline')}>
            <input name="quotationDeadline" type="date" className="input w-full" required defaultValue={opened.quotationDeadline} />
          </Field>
          <Field label={t('requestForQuotation.collective')}>
            <input name="collectiveNumber" className="input w-full" maxLength={10} defaultValue={opened.collectiveNumber ?? ''} />
          </Field>
          <Field label={t('requestForQuotation.reason')}>
            <input name="reason" className="input w-full" required minLength={3} maxLength={500} />
          </Field>
        </div>
        <div className="space-y-3">
          {request.lines.map((line, index) => (
            <div key={line.itemNumber} className="flex flex-wrap items-end gap-3 border-t border-line pt-3" data-rfq-change-line={line.itemNumber}>
              <input type="hidden" name={`line${index}Item`} value={line.itemNumber} />
              <p className="min-w-40 flex-1 text-sm"><span className="mb-1 block text-ink-soft">{t('requestForQuotation.material')}</span>{line.materialNumber ?? line.shortText}</p>
              <Field label={t('requestForQuotation.shortText')}>
                <input name={`line${index}Text`} className="input w-full" maxLength={40} required defaultValue={line.shortText} />
              </Field>
              <Field label={t('requestForQuotation.quantity')}>
                <input name={`line${index}Quantity`} type="number" min="0.001" step="0.001" className="input w-full" required defaultValue={line.quantity} />
              </Field>
              <Field label={t('requestForQuotation.unit')}>
                <ConstrainedField kind="unit" name={`line${index}Unit`} required uppercase defaultValue={line.unit} context={{ materialNumber: line.materialNumber ?? '' }} />
              </Field>
              <Field label={t('requestForQuotation.plant')}>
                <ConstrainedField
                  kind="plant"
                  name={`line${index}Plant`}
                  required
                  value={plants[index] ?? line.plant}
                  onChange={(plant) => setPlants((current) => current.map((entry, at) => at === index ? plant : entry))}
                  context={{ purchasingOrg: opened.purchasingOrg }}
                />
              </Field>
              <Field label={t('requestForQuotation.storage')}>
                <ConstrainedField kind="storage-location" name={`line${index}Storage`} defaultValue={line.storageLocation ?? ''} context={{ plant: plants[index] ?? line.plant }} />
              </Field>
              <Field label={t('requestForQuotation.deliveryDate')}>
                <input name={`line${index}Delivery`} type="date" className="input w-full" required defaultValue={line.deliveryDate} />
              </Field>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" formAction={checkAction} className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || checking} data-rfq-change-check>
            {checking ? t('requestForQuotation.checking') : t('requestForQuotation.check')}
          </button>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canMaintain || changing} data-rfq-change-save>
            {changing ? t('requestForQuotation.saving') : t('requestForQuotation.save')}
          </button>
        </div>
      </form>
      <ChangeNotice state={checkState} />
      <ChangeNotice state={changeState} />
    </section>
  );
}

export default function RequestForQuotation({
  opened,
  requestedEvent,
  selectedRequest,
  recent,
  canMaintain,
  lockMessage = null,
}: {
  opened: StandingRfqEvent | null;
  requestedEvent: string;
  selectedRequest: string;
  recent: Array<{ eventNumber: string; purchasingOrg: string; quotationDeadline: string; collectiveNumber: string | null }>;
  canMaintain: boolean;
  lockMessage?: string | null;
}) {
  const [org, setOrg] = useState('');
  const [suppliers, setSuppliers] = useState([0]);
  const [lines, setLines] = useState<Array<{ plant: string; material: string }>>([{ plant: '', material: '' }]);
  const [checkState, checkAction, checking] = useActionState(checkRfqAction, INITIAL);
  const [createState, createAction, creating] = useActionState(createRfqAction, INITIAL);
  const selected = opened?.requests.find((request) => request.rfqNumber === selectedRequest) ?? null;

  return (
    <>
      <section aria-labelledby="rfq-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="rfq-lookup" className="text-sm font-semibold">{t('requestForQuotation.lookupTitle')}</h2>
        <form method="get" action={ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
          <Field label={t('requestForQuotation.event')}>
            <input name="event" className="input w-full" defaultValue={opened?.eventNumber || selectedRequest || requestedEvent} />
          </Field>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">{t('requestForQuotation.load')}</button>
          <Link href={ROUTE} className="btn btn-default min-h-11 sm:min-h-8">{t('requestForQuotation.newRequest')}</Link>
        </form>
        {requestedEvent && !opened && (
          <p role="status" className="mt-2 text-sm text-red-700">{t('requestForQuotation.notFound', { number: requestedEvent })}</p>
        )}
        <p className="mt-2 text-xs text-ink-soft">{t('requestForQuotation.scopeHint')}</p>
        {recent.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {recent.map((row) => (
              <li key={row.eventNumber}>
                <Link href={`${ROUTE}?event=${row.eventNumber}`} className="underline">
                  {row.eventNumber} · {row.purchasingOrg} · {row.quotationDeadline}
                  {row.collectiveNumber ? ` · ${row.collectiveNumber}` : ''}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {opened && (
        <section aria-labelledby="rfq-standing" data-rfq-standing className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="rfq-standing" className="text-sm font-semibold">{opened.eventNumber}</h2>
          <p className="mt-1 text-sm text-ink-soft" data-rfq-identity>
            {opened.purchasingOrg} · {opened.purchasingGroup} · {opened.rfqDate} · {opened.quotationDeadline} · {opened.currency}
            {opened.collectiveNumber ? ` · ${opened.collectiveNumber}` : ''}
          </p>
          <p className="mt-1 text-xs text-ink-soft">{t('requestForQuotation.standingHint')}</p>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-ink-soft">
                <th className="py-1 pr-3">{t('requestForQuotation.item')}</th>
                <th className="py-1 pr-3">{t('requestForQuotation.shortText')}</th>
                <th className="py-1 pr-3">{t('requestForQuotation.quantity')}</th>
                <th className="py-1 pr-3">{t('requestForQuotation.unit')}</th>
                <th className="py-1 pr-3">{t('requestForQuotation.plant')}</th>
                <th className="py-1 pr-3">{t('requestForQuotation.deliveryDate')}</th>
                <th className="py-1">{t('requestForQuotation.requisition')}</th>
              </tr>
            </thead>
            <tbody>
              {opened.lines.map((line) => (
                <tr key={line.itemNumber} data-rfq-line={line.itemNumber}>
                  <td className="py-1 pr-3">{line.itemNumber}</td>
                  <td className="py-1 pr-3">{line.shortText}</td>
                  <td className="py-1 pr-3">{line.quantity}</td>
                  <td className="py-1 pr-3">{line.unit}</td>
                  <td className="py-1 pr-3">{line.plant}</td>
                  <td className="py-1 pr-3">{line.deliveryDate}</td>
                  <td className="py-1">{line.requisitionNumber ? `${line.requisitionNumber} / ${line.requisitionItem}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="mt-3 space-y-2 text-sm">
            {opened.requests.map((request) => (
              <li key={request.rfqNumber} data-rfq-request={request.rfqNumber}>
                <Link href={`${ROUTE}?event=${opened.eventNumber}&request=${request.rfqNumber}`} className="underline" data-rfq-change-link={request.rfqNumber}>
                  {t('requestForQuotation.changeCopy', { number: request.rfqNumber })}
                </Link>
                <Link href={`/purchasing/quotation?request=${request.rfqNumber}`} className="ml-3 underline" data-rfq-quotation={request.rfqNumber}>
                  {t('requestForQuotation.toQuotation')}
                </Link>
                <span className="ml-2">{request.partnerNumber}</span>
                <span className="ml-2 text-ink-soft">{request.lines.map((line) => `${line.shortText} ${line.quantity}`).join(', ')}</span>
              </li>
            ))}
          </ul>
          {selectedRequest && !selected && (
            <p role="status" className="mt-2 text-sm text-red-700">{t('requestForQuotation.notFound', { number: selectedRequest })}</p>
          )}
          {!selected && <p className="mt-2 text-xs text-ink-soft">{t('requestForQuotation.chooseRequest')}</p>}
        </section>
      )}

      {opened && selected && (
        <ChangeRequest key={selected.rfqNumber} opened={opened} request={selected} canMaintain={canMaintain} />
      )}

      <section aria-labelledby="rfq-create" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="rfq-create" className="text-sm font-semibold">{t('requestForQuotation.createTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('requestForQuotation.createHint')}</p>
        <form action={createAction} className="mt-3 space-y-3">
          <input type="hidden" name="supplierCount" value={suppliers.length} />
          <input type="hidden" name="lineCount" value={lines.length} />
          <div className="flex flex-wrap gap-3">
            <Field label={t('requestForQuotation.purchasingOrg')}>
              <ConstrainedField kind="purchasing-org" name="purchasingOrg" required value={org} onChange={setOrg} />
            </Field>
            <Field label={t('requestForQuotation.purchasingGroup')}>
              <ConstrainedField kind="purchasing-group" name="purchasingGroup" required context={{ purchasingOrg: org }} />
            </Field>
            <Field label={t('requestForQuotation.rfqDate')}>
              <input name="rfqDate" type="date" className="input w-full" required />
            </Field>
            <Field label={t('requestForQuotation.deadline')}>
              <input name="quotationDeadline" type="date" className="input w-full" required />
            </Field>
            <Field label={t('requestForQuotation.collective')}>
              <input name="collectiveNumber" className="input w-full" maxLength={10} />
            </Field>
          </div>
          <div className="space-y-3">
            {suppliers.map((key, index) => (
              <div key={key} className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
                <Field label={t('requestForQuotation.supplier')}>
                  <ConstrainedField kind="supplier-purchasing" name={`supplier${index}Partner`} required context={{ purchasingOrg: org }} />
                </Field>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setSuppliers((current) => [...current, current.length])}>
            {t('requestForQuotation.addSupplier')}
          </button>
          <div className="space-y-3">
            {lines.map((line, index) => (
              <div key={index} className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
                <Field label={t('requestForQuotation.material')}>
                  <ConstrainedField
                    kind="material-rfq"
                    name={`line${index}Material`}
                    context={{ plant: line.plant }}
                    onChange={(material) => setLines((current) => current.map((entry, at) => at === index ? { ...entry, material } : entry))}
                  />
                </Field>
                <Field label={t('requestForQuotation.shortText')}>
                  <input name={`line${index}Text`} className="input w-full" maxLength={40} />
                </Field>
                <Field label={t('requestForQuotation.quantity')}>
                  <input name={`line${index}Quantity`} type="number" min="0.001" step="0.001" className="input w-full" required />
                </Field>
                <Field label={t('requestForQuotation.unit')}>
                  <ConstrainedField kind="unit" name={`line${index}Unit`} required uppercase context={{ materialNumber: line.material }} />
                </Field>
                <Field label={t('requestForQuotation.plant')}>
                  <ConstrainedField
                    kind="plant"
                    name={`line${index}Plant`}
                    required
                    value={line.plant}
                    onChange={(plant) => setLines((current) => current.map((entry, at) => at === index ? { ...entry, plant } : entry))}
                    context={{ purchasingOrg: org }}
                  />
                </Field>
                <Field label={t('requestForQuotation.storage')}>
                  <ConstrainedField kind="storage-location" name={`line${index}Storage`} context={{ plant: line.plant }} />
                </Field>
                <Field label={t('requestForQuotation.deliveryDate')}>
                  <input name={`line${index}Delivery`} type="date" className="input w-full" required />
                </Field>
                <Field label={t('requestForQuotation.requisition')}>
                  <input name={`line${index}Requisition`} className="input w-full" maxLength={10} />
                </Field>
                <Field label={t('requestForQuotation.requisitionItem')}>
                  <input name={`line${index}RequisitionItem`} className="input w-full" inputMode="numeric" />
                </Field>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setLines((current) => [...current, { plant: '', material: '' }])}>
            {t('requestForQuotation.addLine')}
          </button>
          <div className="flex flex-wrap gap-2">
            <button type="submit" formAction={checkAction} className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || checking} data-rfq-check>
              {checking ? t('requestForQuotation.checking') : t('requestForQuotation.check')}
            </button>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canMaintain || creating} data-rfq-create>
              {creating ? t('requestForQuotation.saving') : t('requestForQuotation.save')}
            </button>
          </div>
          <Notice state={checkState} />
          <Notice state={createState} />
        </form>
        {!canMaintain && <p className="mt-3 text-sm text-red-700">{t('requestForQuotation.capabilityMissing')}</p>}
      </section>
    </>
  );
}
