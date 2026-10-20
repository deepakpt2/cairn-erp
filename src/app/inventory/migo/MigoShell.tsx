'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import {
  MIGO_ACTIONS, MIGO_REFERENCES, resolveMigoCell,
} from '@/modules/inventory/migo';
import { postMigoAction, type MigoActionState } from './actions';

const INITIAL: MigoActionState = { ok: false, message: '' };
const LINES = [1, 2, 3, 4];

export default function MigoShell({ canPost, today }: { canPost: boolean; today: string }) {
  const [state, action, posting] = useActionState(postMigoAction, INITIAL);
  const [migoAction, setAction] = useState('A07');
  const [reference, setReference] = useState('R08');
  const [requestKey] = useState(() => Math.random().toString(36).slice(2) + Date.now().toString(36));
  const cell = resolveMigoCell(migoAction, reference);

  return (
    <>
      <section aria-labelledby="movement-select" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="movement-select" className="text-sm font-semibold">{t('migo.selectHeader')}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t('migo.selectHint')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">{t('migo.action')}</span>
            <select
              name="migoAction"
              className="input w-full"
              value={migoAction}
              onChange={(event) => setAction(event.target.value)}
              data-migo-action={migoAction}
            >
              {MIGO_ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>{a.value} · {a.label} — {a.meaning}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="field-label">{t('migo.reference')}</span>
            <select
              name="migoReference"
              className="input w-full"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              data-migo-reference={reference}
            >
              {MIGO_REFERENCES.map((r) => (
                <option key={r.value} value={r.value}>{r.value} · {r.label} — {r.meaning}</option>
              ))}
            </select>
          </label>
        </div>

        {cell && (
          <div className="mt-3 rounded-card border border-line bg-surface p-3 text-sm" data-cell={cell.kind}>
            <p className="font-medium">{cell.title}</p>
            {cell.kind === 'POST_HERE' && (
              <p className="mt-1 text-ink-soft">{t('migo.postsHere')} · {cell.movement}</p>
            )}
            {cell.kind === 'ELSEWHERE' && (
              <p className="mt-1 text-ink-soft">
                {cell.reason}{' '}
                <Link className="text-accent hover:underline" href={cell.route}>
                  {t('migo.open')} {cell.capability}
                </Link>
              </p>
            )}
            {cell.kind === 'REFUSED' && (
              <p className="mt-1 text-ink-soft">
                {cell.reason}
                {cell.deliveredBy ? ` ${t('migo.deliveredBy')} ${cell.deliveredBy}.` : ''}
              </p>
            )}
          </div>
        )}
      </section>

      {cell?.kind === 'POST_HERE' && (
        <section aria-labelledby="movement-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="movement-items" className="text-sm font-semibold">{t('migo.itemsHeader')}</h2>
          <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
            {state.message}{state.remedy ? ` ${state.remedy}` : ''}
          </p>
          <form action={action}>
            <input type="hidden" name="requestKey" value={requestKey} />
            <input type="hidden" name="migoAction" value={migoAction} />
            <input type="hidden" name="migoReference" value={reference} />
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="field-label">{t('migo.orderNumber')}</span>
                <input name="orderNumber" className="input w-full" placeholder="PRD-…" required />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.postingDate')}</span>
                <input type="date" name="postingDate" className="input w-full" defaultValue={today} required />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.documentDate')}</span>
                <input type="date" name="documentDate" className="input w-full" defaultValue={today} required />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.headerText')}</span>
                <input name="headerText" className="input w-full" maxLength={25} />
              </label>
            </div>

            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-1">{t('migo.columnLine')}</th>
                  <th className="py-1">{t('migo.columnMaterial')}</th>
                  <th className="py-1">{t('migo.columnPlant')}</th>
                  <th className="py-1">{t('migo.columnLocation')}</th>
                  <th className="py-1 text-right">{t('migo.columnQuantity')}</th>
                  <th className="py-1">{t('migo.columnItem')}</th>
                </tr>
              </thead>
              <tbody>
                {LINES.map((n) => (
                  <tr key={n} className="border-t border-line" data-migo-line={n}>
                    <td className="py-1">{n}</td>
                    <td className="py-1"><input name={`material-${n}`} className="input w-full" placeholder="MAT-…" /></td>
                    <td className="py-1"><input name={`plant-${n}`} className="input w-24" placeholder="1000" /></td>
                    <td className="py-1"><input name={`sloc-${n}`} className="input w-24" placeholder="0001" /></td>
                    <td className="py-1">
                      <input name={`quantity-${n}`} type="number" step="0.001" min="0.001" className="input w-24 text-right" />
                    </td>
                    <td className="py-1">
                      <input name={`orderItem-${n}`} className="input w-20" placeholder="10" aria-label={`${t('migo.columnItem')} ${n}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || posting}>
                {posting ? t('migo.posting') : t('migo.post')}
              </button>
              {!canPost && <p className="text-sm text-ink-soft">{t('migo.noPost')}</p>}
            </div>
          </form>

          {state.document && (
            <section aria-labelledby="movement-result" className="mt-3 rounded-card border border-line bg-surface p-3">
              <h3 id="movement-result" className="text-sm font-semibold">
                {t('migo.document')} <span className="code" data-material-document={state.document.materialDocumentNumber}>{state.document.materialDocumentNumber}</span>
              </h3>
              <p className="mt-1 text-sm text-ink-soft">
                {state.document.movementCode} · {state.document.movementType} · {t('migo.journal')}{' '}
                {state.document.journalDocumentNumber ? (
                  <Link
                    className="code text-accent hover:underline"
                    href={`/finance/journal/document?document=${encodeURIComponent(state.document.journalDocumentNumber)}`}
                  >
                    {state.document.journalDocumentNumber}
                  </Link>
                ) : '—'}
                {' · '}
                <Link
                  className="text-accent hover:underline"
                  href={`/inventory/material-documents?document=${encodeURIComponent(state.document.materialDocumentNumber)}&fiscalYear=${state.document.documentYear}`}
                >
                  {t('migo.openDocument')}
                </Link>
              </p>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th className="py-1">{t('migo.columnLine')}</th>
                    <th className="py-1">{t('migo.columnMaterial')}</th>
                    <th className="py-1">{t('migo.columnQuantity')}</th>
                    <th className="py-1">{t('migo.columnValue')}</th>
                    <th className="py-1">{t('migo.columnOrderOpen')}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.document.lines.map((line) => (
                    <tr key={line.materialNumber + line.quantity} className="border-t border-line" data-line={line.materialNumber}>
                      <td className="py-1">{line.materialNumber}</td>
                      <td className="py-1">{line.plant}</td>
                      <td className="py-1 text-right tabular">{line.quantity} {line.unit}</td>
                      <td className="py-1 text-right tabular">{line.value}</td>
                      <td className="py-1 tabular" data-order-open={line.orderOpenAfter ?? ''}>{line.orderOpenAfter ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </section>
      )}
    </>
  );
}
