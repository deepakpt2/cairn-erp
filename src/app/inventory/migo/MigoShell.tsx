'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';

import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import {
  MIGO_ACTIONS, MIGO_REFERENCES, resolveMigoCell,
} from '@/modules/inventory/migo';
import {
  postMigoAction, postReceiptAction, postReversalAction, postTransferAction,
  type MigoActionState, type ReceiptActionState, type ReversalActionState, type TransferActionState,
} from './actions';

const INITIAL: MigoActionState = { ok: false, message: '' };
const INITIAL_RECEIPT: ReceiptActionState = { ok: false, message: '' };
const INITIAL_TRANSFER: TransferActionState = { ok: false, message: '' };
const INITIAL_REVERSAL: ReversalActionState = { ok: false, message: '' };
const TRANSFER_MEANINGS: Record<string, string> = {
  '311': 'storage location to storage location',
  '301': 'plant to plant',
  '321': 'quality inspection to unrestricted',
};
const LINES = [1, 2, 3, 4];

function StockLine({ n }: { n: number }) {
  const [plant, setPlant] = useState('');
  return (
    <tr className="border-t border-line" data-migo-line={n}>
      <td className="py-1">{n}</td>
      <td className="py-1"><ConstrainedField kind="material-stock" name={`material-${n}`} context={{ plant }} placeholder="MAT-…" /></td>
      <td className="py-1"><ConstrainedField kind="plant" name={`plant-${n}`} value={plant} onChange={setPlant} /></td>
      <td className="py-1"><ConstrainedField kind="storage-location" name={`sloc-${n}`} context={{ plant }} /></td>
      <td className="py-1">
        <input name={`quantity-${n}`} type="number" step="0.001" min="0.001" className="input w-24 text-right" />
      </td>
      <td className="py-1">
        <ConstrainedField kind="unit" name={`unit-${n}`} uppercase maxLength={6} />
      </td>
      <td className="py-1">
        <input name={`orderItem-${n}`} className="input w-20" placeholder="10" aria-label={`${t('migo.columnItem')} ${n}`} />
      </td>
    </tr>
  );
}

export default function MigoShell({ canPost, today }: { canPost: boolean; today: string }) {
  const [issuingPlant, setIssuingPlant] = useState('');
  const [receivingPlant, setReceivingPlant] = useState('');
  const [state, action, posting] = useActionState(postMigoAction, INITIAL);
  const [receipt, receiptAction, receiving] = useActionState(postReceiptAction, INITIAL_RECEIPT);
  const [transfer, transferAction, transferring] = useActionState(postTransferAction, INITIAL_TRANSFER);
  const [reversal, reversalAction, reversing] = useActionState(postReversalAction, INITIAL_REVERSAL);
  const [migoAction, setAction] = useState('A07');
  const [reference, setReference] = useState('R08');
  /**
   * SCR-145: the idempotency key moves once a posting succeeds. A key fixed for the life of the
   * page made a second posting from the same page — a second transfer, a second issue — replay
   * the first and post nothing, which is exactly what a retry guard must not do to a new request.
   */
  const [seed] = useState(() => Math.random().toString(36).slice(2) + Date.now().toString(36));
  const [round, setRound] = useState(0);
  const anyPosted = state.ok || receipt.ok || transfer.ok || reversal.ok;
  useEffect(() => {
    if (anyPosted) setRound((r) => r + 1);
  }, [anyPosted]);
  const requestKey = `${seed}-${round}`;
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

      {cell?.kind === 'POST_HERE' && cell.form === 'REVERSE' && (
        <section aria-labelledby="movement-reversal" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="movement-reversal" className="text-sm font-semibold">{t('migo.reversalHeader')}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t('migo.reversalHint')}</p>
          <p role="status" className={`mt-2 text-sm ${reversal.ok ? 'text-ink' : 'text-red-700'}`}>
            {reversal.message}{reversal.remedy ? ` ${reversal.remedy}` : ''}
          </p>
          <form action={reversalAction}>
            <input type="hidden" name="requestKey" value={requestKey} />
            <input type="hidden" name="migoAction" value={migoAction} />
            <input type="hidden" name="migoReference" value={reference} />
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="field-label">{t('migo.originalDocument')}</span>
                <input name="materialDocumentNumber" className="input w-full" placeholder="MD-…" required />
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
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || reversing}>
                {reversing ? t('migo.posting') : t('migo.reversalPost')}
              </button>
              {!canPost && <p className="text-sm text-ink-soft">{t('migo.noPost')}</p>}
            </div>
          </form>
          {reversal.document && (
            <section aria-labelledby="movement-reversal-result" className="mt-3 rounded-card border border-line bg-surface p-3">
              <h3 id="movement-reversal-result" className="text-sm font-semibold">
                {t('migo.document')}{' '}
                <span className="code" data-reversal-document={reversal.document.materialDocumentNumber}>
                  {reversal.document.materialDocumentNumber}
                </span>
              </h3>
              <p className="mt-1 text-sm text-ink-soft">
                {t('migo.reverses')}{' '}
                <span className="code" data-reverses={reversal.document.reversalOf ?? ''}>{reversal.document.reversalOf}</span>
              </p>
            </section>
          )}
        </section>
      )}

      {cell?.kind === 'POST_HERE' && cell.form === 'TRANSFER' && (
        <section aria-labelledby="movement-transfer" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="movement-transfer" className="text-sm font-semibold">{t('migo.transferHeader')}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t('migo.transferHint')}</p>
          <p role="status" className={`mt-2 text-sm ${transfer.ok ? 'text-ink' : 'text-red-700'}`}>
            {transfer.message}{transfer.remedy ? ` ${transfer.remedy}` : ''}
          </p>
          <form action={transferAction}>
            <input type="hidden" name="requestKey" value={requestKey} />
            <input type="hidden" name="migoAction" value={migoAction} />
            <input type="hidden" name="migoReference" value={reference} />
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="field-label">{t('migo.transferMovement')}</span>
                <select name="movementTypeCode" className="input w-full" defaultValue={cell.movements?.[0]}>
                  {(cell.movements ?? []).map((code) => (
                    <option key={code} value={code}>{code} — {TRANSFER_MEANINGS[code] ?? ''}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="field-label">{t('migo.columnMaterial')}</span>
                <ConstrainedField kind="material-stock" name="materialNumber" required placeholder="MAT-…" context={{ plant: issuingPlant }} />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.transferQuantity')}</span>
                <input name="quantity" type="number" step="0.001" min="0.001" className="input w-full text-right" required />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.entryUnit')}</span>
                <ConstrainedField kind="unit" name="unit" uppercase maxLength={6} placeholder="PC" />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.headerText')}</span>
                <input name="headerText" className="input w-full" maxLength={25} />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.issuingPlant')}</span>
                <ConstrainedField kind="plant" name="issuingPlant" required value={issuingPlant} onChange={setIssuingPlant} />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.issuingLocation')}</span>
                <ConstrainedField kind="storage-location" name="issuingStorageLocation" required context={{ plant: issuingPlant }} />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.receivingPlant')}</span>
                <ConstrainedField kind="plant" name="receivingPlant" required value={receivingPlant} onChange={setReceivingPlant} />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.receivingLocation')}</span>
                <ConstrainedField kind="storage-location" name="receivingStorageLocation" required context={{ plant: receivingPlant }} />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.postingDate')}</span>
                <input type="date" name="postingDate" className="input w-full" defaultValue={today} required />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.documentDate')}</span>
                <input type="date" name="documentDate" className="input w-full" defaultValue={today} required />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || transferring}>
                {transferring ? t('migo.posting') : t('migo.transferPost')}
              </button>
              {!canPost && <p className="text-sm text-ink-soft">{t('migo.noPost')}</p>}
            </div>
          </form>

          {transfer.document && (
            <section aria-labelledby="movement-transfer-result" className="mt-3 rounded-card border border-line bg-surface p-3">
              <h3 id="movement-transfer-result" className="text-sm font-semibold">
                {t('migo.document')}{' '}
                <span className="code" data-transfer-document={transfer.document.materialDocumentNumber}>{transfer.document.materialDocumentNumber}</span>
              </h3>
              <p className="mt-1 text-sm text-ink-soft">
                {t('migo.journal')}{' '}
                {transfer.document.journalDocumentNumber ? (
                  <Link
                    className="code text-accent hover:underline"
                    href={`/finance/journal/document?document=${encodeURIComponent(transfer.document.journalDocumentNumber)}`}
                  >
                    {transfer.document.journalDocumentNumber}
                  </Link>
                ) : t('migo.transferNoJournal')}
                {' · '}
                <Link
                  className="text-accent hover:underline"
                  href={`/inventory/material-documents?document=${encodeURIComponent(transfer.document.materialDocumentNumber)}&fiscalYear=${transfer.document.documentYear}`}
                >
                  {t('migo.openDocument')}
                </Link>
              </p>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th className="py-1">{t('migo.columnLine')}</th>
                    <th className="py-1">{t('migo.columnMaterial')}</th>
                    <th className="py-1">{t('migo.columnPlant')}</th>
                    <th className="py-1">{t('migo.columnLocation')}</th>
                    <th className="py-1 text-right">{t('migo.columnQuantity')}</th>
                    <th className="py-1 text-right">{t('migo.columnValue')}</th>
                  </tr>
                </thead>
                <tbody>
                  {transfer.document.lines.map((line) => (
                    <tr key={line.lineNumber} className="border-t border-line" data-line={line.materialNumber}>
                      <td className="py-1">{line.lineNumber}</td>
                      <td className="py-1">{line.materialNumber}</td>
                      <td className="py-1">{line.plant}</td>
                      <td className="py-1">{line.storageLocation ?? '—'}</td>
                      <td className="py-1 text-right tabular">{line.quantity} {line.unit}</td>
                      <td className="py-1 text-right tabular">{line.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </section>
      )}

      {cell?.kind === 'POST_HERE' && cell.form === 'RECEIPT' && (
        <section aria-labelledby="movement-receipt" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="movement-receipt" className="text-sm font-semibold">{t('migo.receiptHeader')}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t('migo.receiptHint')}</p>
          <p role="status" className={`mt-2 text-sm ${receipt.ok ? 'text-ink' : 'text-red-700'}`}>
            {receipt.message}{receipt.remedy ? ` ${receipt.remedy}` : ''}
          </p>
          <form action={receiptAction}>
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
              <label className="block">
                <span className="field-label">{t('migo.columnLocation')}</span>
                <input name="storageLocation" className="input w-full" placeholder="0001" required />
              </label>
              <label className="block">
                <span className="field-label">Batch</span>
                <input name="batch" maxLength={10} className="input w-full" placeholder="Batch" />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.receiptQuantity')}</span>
                <input name="quantity" type="number" step="0.001" min="0.001" className="input w-full text-right" required />
              </label>
              <label className="block">
                <span className="field-label">{t('migo.entryUnit')}</span>
                <ConstrainedField kind="unit" name="unit" uppercase maxLength={6} placeholder="PC" />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || receiving}>
                {receiving ? t('migo.posting') : t('migo.receiptPost')}
              </button>
              {!canPost && <p className="text-sm text-ink-soft">{t('migo.noPost')}</p>}
            </div>
          </form>

          {receipt.document && (
            <section aria-labelledby="movement-receipt-result" className="mt-3 rounded-card border border-line bg-surface p-3">
              <h3 id="movement-receipt-result" className="text-sm font-semibold">
                {t('migo.document')} <span className="code" data-receipt-document={receipt.document.materialDocumentNumber}>{receipt.document.materialDocumentNumber}</span>
              </h3>
              <p className="mt-1 text-sm text-ink-soft">
                {receipt.document.movementCode} · {receipt.document.movementType} · {t('migo.journal')}{' '}
                {receipt.document.journalDocumentNumber ? (
                  <Link
                    className="code text-accent hover:underline"
                    href={`/finance/journal/document?document=${encodeURIComponent(receipt.document.journalDocumentNumber)}`}
                  >
                    {receipt.document.journalDocumentNumber}
                  </Link>
                ) : '—'}
                {' · '}
                <Link
                  className="text-accent hover:underline"
                  href={`/inventory/material-documents?document=${encodeURIComponent(receipt.document.materialDocumentNumber)}&fiscalYear=${receipt.document.documentYear}`}
                >
                  {t('migo.openDocument')}
                </Link>
              </p>
              <p className="mt-1 text-sm text-ink-soft">
                {t('migo.receiptValue')} {receipt.document.totalValue} · {t('migo.receiptReceived')}{' '}
                <span data-received-after={receipt.document.receivedAfter}>{receipt.document.receivedAfter}</span>{' '}
                / {receipt.document.orderQuantity} · {t('migo.columnOrderOpen')}{' '}
                <span data-order-open={receipt.document.lines[0]?.orderOpenAfter ?? ''}>{receipt.document.lines[0]?.orderOpenAfter ?? '—'}</span>
              </p>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th className="py-1">{t('migo.columnLine')}</th>
                    <th className="py-1">{t('migo.columnMaterial')}</th>
                    <th className="py-1">{t('migo.columnLocation')}</th>
                    <th className="py-1 text-right">{t('migo.columnQuantity')}</th>
                    <th className="py-1 text-right">{t('migo.columnValue')}</th>
                  </tr>
                </thead>
                <tbody>
                  {receipt.document.lines.map((line) => (
                    <tr key={line.lineNumber} className="border-t border-line" data-line={line.materialNumber}>
                      <td className="py-1">{line.lineNumber}</td>
                      <td className="py-1">{line.materialNumber}</td>
                      <td className="py-1">{line.storageLocation ?? '—'}</td>
                      <td className="py-1 text-right tabular">{line.quantity} {line.unit}</td>
                      <td className="py-1 text-right tabular">{line.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </section>
      )}

      {cell?.kind === 'POST_HERE' && cell.form === 'ISSUE' && (
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
                  <th className="py-1">{t('migo.entryUnit')}</th>
                  <th className="py-1">{t('migo.columnItem')}</th>
                </tr>
              </thead>
              <tbody>
                {LINES.map((n) => <StockLine key={n} n={n} />)}
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
