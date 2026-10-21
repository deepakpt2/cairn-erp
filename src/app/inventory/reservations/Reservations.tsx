'use client';

import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import type { ReservationView } from '@/modules/inventory/reservations';
import {
  completeItemAction, createReservationAction, withdrawReservationAction,
  type ReservationActionState,
} from './actions';

const INITIAL: ReservationActionState = { ok: false, message: '' };

function ReservationLine({ line, onCompany }: { line: number; onCompany: (company: string) => void }) {
  const [plant, setPlant] = useState('');
  return (
    <tr className="border-t border-line">
      <td className="py-1">{line}</td>
      <td className="py-1">
        <ConstrainedField kind="material-issue" name={`material-${line}`} context={{ plant }} placeholder="MAT-…" />
      </td>
      <td className="py-1">
        <ConstrainedField
          kind="plant"
          name={`plant-${line}`}
          value={plant}
          onChange={setPlant}
          onLoaded={(rows) => {
            const company = rows.find((row) => row.code === plant)?.meta;
            if (company) onCompany(company);
          }}
        />
      </td>
      <td className="py-1">
        <input name={`quantity-${line}`} type="number" step="0.001" min="0.001" className="input w-full text-right" />
      </td>
      <td className="py-1">
        <ConstrainedField kind="storage-location" name={`sloc-${line}`} context={{ plant }} />
      </td>
      <td className="py-1 text-center">
        <input type="checkbox" name={`allowed-${line}`} defaultChecked aria-label={`${t('mb21.columnAllowed')} ${line}`} />
      </td>
    </tr>
  );
}

function newRequestKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function Reservations({ reservation, scenarios, canPost, today }: {
  reservation: ReservationView | null;
  scenarios: Array<{ code: string; description: string }>;
  canPost: boolean;
  today: string;
}) {
  const [createState, createAction, creating] = useActionState(createReservationAction, INITIAL);
  const [withdrawState, withdrawAction, withdrawing] = useActionState(withdrawReservationAction, INITIAL);
  const [completeState, completeAction, completing] = useActionState(completeItemAction, INITIAL);
  const [requestKey] = useState(newRequestKey);
  const [companyCode, setCompanyCode] = useState('');

  return (
    <>
      <section aria-labelledby="reservation-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="reservation-lookup" className="text-sm font-semibold">{t('mb21.lookup')}</h2>
        <form method="get" action="/inventory/reservations" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb21.reservation')}</span>
            <input name="reservation" className="input" placeholder={t('mb21.reservationPlaceholder')} defaultValue={reservation?.reservationNumber ?? ''} />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">{t('mb21.load')}</button>
        </form>
      </section>

      <section aria-labelledby="reservation-create" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="reservation-create" className="text-sm font-semibold">{t('mb21.create')}</h2>
        {createState.message && (
          <p role="status" className={`mt-2 text-sm ${createState.ok ? 'text-ink' : 'text-red-700'}`}>
            {createState.message}{createState.remedy ? ` ${createState.remedy}` : ''}
          </p>
        )}
        <form action={createAction}>
          <input type="hidden" name="requestKey" value={requestKey} />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb21.movementType')}</span>
              <select name="movementTypeCode" className="input w-full" defaultValue="201">
                {scenarios.map((s) => (
                  <option key={s.code} value={s.code}>{s.code} · {s.description}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb21.baseDate')}</span>
              <input type="date" name="baseDate" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb21.costCenter')}</span>
              <ConstrainedField kind="cost-center" name="costCenter" placeholder="CC1000" context={{ companyCode }} />
            </label>
          </div>

          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1">{t('mb21.columnLine')}</th>
                <th className="py-1">{t('mb21.columnMaterial')}</th>
                <th className="py-1">{t('mb21.columnPlant')}</th>
                <th className="py-1 text-right">{t('mb21.columnQuantity')}</th>
                <th className="py-1">{t('mb21.columnLocation')}</th>
                <th className="py-1">{t('mb21.columnAllowed')}</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3].map((line) => (
                <ReservationLine key={line} line={line} onCompany={setCompanyCode} />
              ))}
            </tbody>
          </table>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || creating}>
              {creating ? t('mb21.creating') : t('mb21.createAction')}
            </button>
            <p className="text-sm text-ink-soft">{t('mb21.createHint')}</p>
          </div>
        </form>
      </section>

      {reservation && (
        <section aria-labelledby="reservation-document" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="reservation-document" className="text-sm font-semibold">
            {t('mb21.reservation')} {reservation.reservationNumber}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {reservation.movementCode ? `${reservation.movementCode} · ` : ''}{reservation.movementType}
            {' · '}{t('mb21.baseDateShort')} {reservation.baseDate}
            {reservation.costCenter ? ` · ${t('mb21.costCenterShort')} ${reservation.costCenter}` : ''}
            {' · '}<span data-open-items={reservation.hasOpenItems}>{reservation.hasOpenItems ? t('mb21.active') : t('mb21.closed')}</span>
          </p>

          {withdrawState.message && (
            <p role="status" className={`mt-2 text-sm ${withdrawState.ok ? 'text-ink' : 'text-red-700'}`}>
              {withdrawState.message}{withdrawState.remedy ? ` ${withdrawState.remedy}` : ''}
            </p>
          )}
          {completeState.message && (
            <p role="status" className={`mt-2 text-sm ${completeState.ok ? 'text-ink' : 'text-red-700'}`}>
              {completeState.message}{completeState.remedy ? ` ${completeState.remedy}` : ''}
            </p>
          )}

          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1">{t('mb21.columnLine')}</th>
                <th className="py-1">{t('mb21.columnMaterial')}</th>
                <th className="py-1">{t('mb21.columnPlant')}</th>
                <th className="py-1">{t('mb21.columnLocation')}</th>
                <th className="py-1 text-right">{t('mb21.columnRequired')}</th>
                <th className="py-1 text-right">{t('mb21.columnWithdrawn')}</th>
                <th className="py-1 text-right">{t('mb21.columnOpen')}</th>
                <th className="py-1">{t('mb21.columnState')}</th>
                <th className="py-1">{t('mb21.columnActions')}</th>
              </tr>
            </thead>
            <tbody>
              {reservation.items.map((item) => (
                <tr key={item.itemNumber} data-item={item.itemNumber} data-open={item.openQuantity} data-completed={item.isCompleted} className="border-t border-line">
                  <td className="py-1">{item.itemNumber}</td>
                  <td className="py-1">{item.materialNumber}</td>
                  <td className="py-1">{item.plant}</td>
                  <td className="py-1">{item.storageLocation ?? '—'}</td>
                  <td className="py-1 text-right tabular-nums">{Number(item.requiredQuantity).toFixed(3)} {item.unit}</td>
                  <td className="py-1 text-right tabular-nums">{Number(item.withdrawnQuantity).toFixed(3)}</td>
                  <td className="py-1 text-right tabular-nums">{Number(item.openQuantity).toFixed(3)}</td>
                  <td className="py-1">
                    {item.isCompleted ? t('mb21.completed') : item.movementAllowed ? t('mb21.open') : t('mb21.forbidden')}
                  </td>
                  <td className="py-1">
                    {!item.isCompleted && (
                      <div className="flex flex-wrap items-center gap-2">
                        <form action={withdrawAction} className="flex items-center gap-1">
                          <input type="hidden" name="reservationNumber" value={reservation.reservationNumber} />
                          <input type="hidden" name="itemNumber" value={item.itemNumber} />
                          <input
                            name="quantity" type="number" step="0.001" min="0.001"
                            className="input w-24 text-right"
                            aria-label={`${t('mb21.withdraw')} ${item.itemNumber}`}
                            required
                          />
                          <button type="submit" className="btn btn-default min-h-9" disabled={withdrawing || !item.movementAllowed}>
                            {t('mb21.withdraw')}
                          </button>
                        </form>
                        <form action={completeAction}>
                          <input type="hidden" name="reservationNumber" value={reservation.reservationNumber} />
                          <input type="hidden" name="itemNumber" value={item.itemNumber} />
                          <button type="submit" className="btn btn-default min-h-9" disabled={completing}>
                            {t('mb21.complete')}
                          </button>
                        </form>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
