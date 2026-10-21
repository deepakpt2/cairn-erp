'use client';

import Link from 'next/link';
import { useActionState, useState, type ReactNode } from 'react';

import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import type { StandingRfqEvent } from '@/modules/purchasing/rfq';
import type { RfqActionState } from './actions';
import { checkRfqAction, createRfqAction } from './actions';

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

export default function RequestForQuotation({
  opened,
  requestedEvent,
  recent,
  canMaintain,
}: {
  opened: StandingRfqEvent | null;
  requestedEvent: string;
  recent: Array<{ eventNumber: string; purchasingOrg: string; quotationDeadline: string; collectiveNumber: string | null }>;
  canMaintain: boolean;
}) {
  const [org, setOrg] = useState('');
  const [suppliers, setSuppliers] = useState([0]);
  const [lines, setLines] = useState<Array<{ plant: string; material: string }>>([{ plant: '', material: '' }]);
  const [checkState, checkAction, checking] = useActionState(checkRfqAction, INITIAL);
  const [createState, createAction, creating] = useActionState(createRfqAction, INITIAL);

  return (
    <>
      <section aria-labelledby="rfq-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="rfq-lookup" className="text-sm font-semibold">{t('requestForQuotation.lookupTitle')}</h2>
        <form method="get" action={ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
          <Field label={t('requestForQuotation.event')}>
            <input name="event" className="input w-full" defaultValue={opened?.eventNumber ?? requestedEvent} />
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
                <th className="py-1">{t('requestForQuotation.deliveryDate')}</th>
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
                  <td className="py-1">{line.deliveryDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="mt-3 space-y-2 text-sm">
            {opened.requests.map((request) => (
              <li key={request.rfqNumber} data-rfq-request={request.rfqNumber}>
                {request.rfqNumber} · {request.partnerNumber}
                <span className="ml-2 text-ink-soft">{request.lines.map((line) => line.shortText).join(', ')}</span>
              </li>
            ))}
          </ul>
        </section>
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
