'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import { postGoodsIssueAction, type IssueActionState } from './actions';

const INITIAL: IssueActionState = { ok: false, message: '' };

function IssueLine({ n, chargesCostCentre }: { n: number; chargesCostCentre: boolean }) {
  const [plant, setPlant] = useState('');
  const [company, setCompany] = useState('');
  return (
    <tr>
      <td>{n}</td>
      <td><ConstrainedField kind="material-issue" name={`material-${n}`} context={{ plant }} placeholder="MAT-…" /></td>
      <td>
        <ConstrainedField
          kind="plant"
          name={`plant-${n}`}
          value={plant}
          onChange={setPlant}
          onLoaded={(rows) => {
            const match = rows.find((row) => row.code === plant);
            setCompany(match?.meta ?? '');
          }}
        />
      </td>
      <td><ConstrainedField kind="storage-location" name={`sloc-${n}`} context={{ plant }} /></td>
      <td><input name={`batch-${n}`} maxLength={10} className="input w-24" placeholder="Batch" /></td>
      <td>
        <input name={`quantity-${n}`} type="number" step="0.001" min="0.001" className="input w-24 text-right" />
      </td>
      <td>
        <ConstrainedField kind="cost-center" name={`costCenter-${n}`} context={{ companyCode: company }} disabled={!chargesCostCentre} placeholder={chargesCostCentre ? 'CC1100' : '—'} />
      </td>
      <td>
        <div className="flex gap-1">
          <input name={`reservation-${n}`} className="input w-28" placeholder="RSV-…" />
          <input name={`reservationItem-${n}`} className="input w-14" placeholder="10" aria-label={`${t('mb1a.columnReservation')} ${t('mb1a.columnLine')} ${n}`} />
        </div>
      </td>
    </tr>
  );
}

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
      <section aria-labelledby="issue-header" className="border border-line bg-surface p-4">
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

          <table className="grid-table mt-3 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th>{t('mb1a.columnLine')}</th>
                <th>{t('mb1a.columnMaterial')}</th>
                <th>{t('mb1a.columnPlant')}</th>
                <th>{t('mb1a.columnLocation')}</th>
                <th>Batch</th>
                <th className="text-right">{t('mb1a.columnQuantity')}</th>
                <th>{t('mb1a.columnCostCenter')}</th>
                <th>{t('mb1a.columnReservation')}</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4].map((n) => (
                <IssueLine key={n} n={n} chargesCostCentre={chargesCostCentre} />
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
        <section aria-labelledby="issue-document" className="border border-line bg-surface p-4">
          <h2 id="issue-document" className="text-sm font-semibold">
            {t('mb1a.document')} {state.document.materialDocumentNumber}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {state.document.movementCode} · {state.document.movementType} · {t('mb1a.company')} {state.document.companyCode}
            {' · '}{t('mb1a.journal')}{' '}
            {state.document.journalDocumentNumber ? (
              <Link
                className="code text-accent hover:underline"
                href={`/finance/journal/document?document=${encodeURIComponent(state.document.journalDocumentNumber)}`}
              >
                {state.document.journalDocumentNumber}
              </Link>
            ) : '—'}
            {' · '}{t('mb1a.value')} {state.document.totalValue}
          </p>
          <table className="grid-table mt-2 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th>{t('mb1a.columnLine')}</th>
                <th>{t('mb1a.columnMaterial')}</th>
                <th>{t('mb1a.columnPlant')}</th>
                <th>{t('mb1a.columnLocation')}</th>
                <th className="text-right">{t('mb1a.columnQuantity')}</th>
                <th className="text-right">{t('mb1a.columnValue')}</th>
                <th>{t('mb1a.columnCostCenter')}</th>
                <th>{t('mb1a.columnReservation')}</th>
              </tr>
            </thead>
            <tbody>
              {state.document.lines.map((line) => (
                <tr key={line.lineNumber} data-line={line.lineNumber} data-reservation-open={line.reservationOpenAfter ?? ''}>
                  <td>{line.lineNumber}</td>
                  <td><span className="code">{line.materialNumber}</span></td>
                  <td>{line.plant}</td>
                  <td>{line.storageLocation ?? '—'}</td>
                  <td className="text-right tabular-nums">{line.quantity} {line.unit}</td>
                  <td className="text-right tabular-nums">{line.value}</td>
                  <td>{line.costCenter ?? '—'}</td>
                  <td>
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
