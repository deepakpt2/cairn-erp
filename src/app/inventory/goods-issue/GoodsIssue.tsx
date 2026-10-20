'use client';

import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import { postGoodsIssueAction, type IssueActionState } from './actions';

const INITIAL: IssueActionState = { ok: false, message: '' };

export default function GoodsIssue({ scenarios, canPost, today }: {
  scenarios: Array<{ code: string; description: string; accountAssignment: string }>;
  canPost: boolean;
  today: string;
}) {
  const [state, action, posting] = useActionState(postGoodsIssueAction, INITIAL);
  const [movement, setMovement] = useState('201');
  const [requestKey] = useState(() => Math.random().toString(36).slice(2) + Date.now().toString(36));
  const chargesCostCentre = scenarios.find((s) => s.code === movement)?.accountAssignment === 'COST_CENTER';

  return (
    <>
      <section aria-labelledby="issue-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="issue-header" className="text-sm font-semibold">{t('mb1a.header')}</h2>
        <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
        <form action={action}>
          <input type="hidden" name="requestKey" value={requestKey} />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="field-label">{t('mb1a.movementType')}</span>
              <select
                name="movementTypeCode"
                className="input w-full"
                value={movement}
                onChange={(event) => setMovement(event.target.value)}
              >
                {scenarios.map((s) => (
                  <option key={s.code} value={s.code}>{s.code} · {s.description}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="field-label">{t('mb1a.postingDate')}</span>
              <input type="date" name="postingDate" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="field-label">{t('mb1a.documentDate')}</span>
              <input type="date" name="documentDate" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="field-label">{t('mb1a.headerText')}</span>
              <input name="headerText" className="input w-full" maxLength={25} />
            </label>
          </div>

          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1">{t('mb1a.columnLine')}</th>
                <th className="py-1">{t('mb1a.columnMaterial')}</th>
                <th className="py-1">{t('mb1a.columnPlant')}</th>
                <th className="py-1">{t('mb1a.columnLocation')}</th>
                <th className="py-1 text-right">{t('mb1a.columnQuantity')}</th>
                <th className="py-1">{t('mb1a.columnCostCenter')}</th>
                <th className="py-1">{t('mb1a.columnReservation')}</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4].map((n) => (
                <tr key={n} className="border-t border-line">
                  <td className="py-1">{n}</td>
                  <td className="py-1"><input name={`material-${n}`} className="input w-full" placeholder="MAT-…" /></td>
                  <td className="py-1"><input name={`plant-${n}`} className="input w-20" placeholder="1000" /></td>
                  <td className="py-1"><input name={`sloc-${n}`} className="input w-20" placeholder="0001" /></td>
                  <td className="py-1">
                    <input name={`quantity-${n}`} type="number" step="0.001" min="0.001" className="input w-24 text-right" />
                  </td>
                  <td className="py-1">
                    <input
                      name={`costCenter-${n}`}
                      className="input w-24"
                      placeholder={chargesCostCentre ? 'CC1100' : '—'}
                      disabled={!chargesCostCentre}
                    />
                  </td>
                  <td className="py-1">
                    <div className="flex gap-1">
                      <input name={`reservation-${n}`} className="input w-28" placeholder="RSV-…" />
                      <input name={`reservationItem-${n}`} className="input w-14" placeholder="10" aria-label={`${t('mb1a.columnReservation')} ${t('mb1a.columnLine')} ${n}`} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || posting}>
              {posting ? t('mb1a.posting') : t('mb1a.post')}
            </button>
            <p className="text-sm text-ink-soft">{t('mb1a.hint')}</p>
          </div>
        </form>
      </section>

      {state.document && (
        <section aria-labelledby="issue-document" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="issue-document" className="text-sm font-semibold">
            {t('mb1a.document')} {state.document.materialDocumentNumber}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {state.document.movementCode} · {state.document.movementType} · {t('mb1a.company')} {state.document.companyCode}
            {' · '}{t('mb1a.journal')} <span className="code">{state.document.journalDocumentNumber ?? '—'}</span>
            {' · '}{t('mb1a.value')} {state.document.totalValue}
          </p>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1">{t('mb1a.columnLine')}</th>
                <th className="py-1">{t('mb1a.columnMaterial')}</th>
                <th className="py-1">{t('mb1a.columnPlant')}</th>
                <th className="py-1">{t('mb1a.columnLocation')}</th>
                <th className="py-1 text-right">{t('mb1a.columnQuantity')}</th>
                <th className="py-1 text-right">{t('mb1a.columnValue')}</th>
                <th className="py-1">{t('mb1a.columnCostCenter')}</th>
                <th className="py-1">{t('mb1a.columnReservation')}</th>
              </tr>
            </thead>
            <tbody>
              {state.document.lines.map((line) => (
                <tr key={line.lineNumber} data-line={line.lineNumber} className="border-t border-line">
                  <td className="py-1">{line.lineNumber}</td>
                  <td className="py-1"><span className="code">{line.materialNumber}</span></td>
                  <td className="py-1">{line.plant}</td>
                  <td className="py-1">{line.storageLocation ?? '—'}</td>
                  <td className="py-1 text-right tabular-nums">{line.quantity} {line.unit}</td>
                  <td className="py-1 text-right tabular-nums">{line.value}</td>
                  <td className="py-1">{line.costCenter ?? '—'}</td>
                  <td className="py-1" data-reservation-open={line.reservationOpenAfter ?? ''}>
                    {line.reservationNumber ? (
                      <>
                        {line.reservationNumber} / {line.reservationItem}
                        {line.reservationOpenAfter ? (
                          <span className="ms-1 text-ink-soft">{t('mb1a.open')} {line.reservationOpenAfter}</span>
                        ) : null}
                      </>
                    ) : '—'}
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
