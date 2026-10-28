'use client';

import Link from 'next/link';
import { useActionState, useId } from 'react';

import type { LotView } from '@/modules/quality/lot';
import { openLotAction, type LotActionState } from './actions';

const EMPTY: LotActionState = { ok: false };

interface Props {
  lots: Awaited<ReturnType<typeof import('@/modules/quality/lot').listLots>>;
  candidates: Awaited<ReturnType<typeof import('@/modules/quality/lot').listInspectableLines>>;
  selected: LotView | null;
  documentNumber: string;
  canCreate: boolean;
}

function quantity(value: string): string {
  return value === '' ? '—' : Number(value).toFixed(3);
}

/** The state a lot is in is read from the receipt it names, so the wording says which document answered. */
function State({ state }: { state: LotView['state'] }) {
  return state === 'OPEN'
    ? <span className="text-sm">Open</span>
    : <span className="text-sm text-ink-soft">Source reversed</span>;
}

function Notice({ state }: { state: LotActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.ok && state.lotNumber ? (
        <p className="mt-2">
          <Link className="link" href={`/quality/lots?lot=${state.lotNumber}`}>Open lot {state.lotNumber}</Link>
        </p>
      ) : null}
    </div>
  );
}

/** The line picker: only goods that were received, still stand, and carry no lot yet. */
function OpenLot({
  candidates, allowed,
}: { candidates: Props['candidates']; allowed: boolean }) {
  const [state, action, pending] = useActionState(openLotAction, EMPTY);
  const id = useId();
  if (!allowed) {
    return (
      <p className="mt-2 text-sm text-ink-soft">
        Lots are read-only for this session: opening one needs QM.LOT.CREATE, which the receiving role
        carries.
      </p>
    );
  }
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Open inspection lot">
      <p className="text-sm font-medium">Open a lot against a receipt line</p>
      {candidates.length === 0 ? (
        <p className="text-sm text-ink-soft">
          No received line stands open to inspection right now. A lot is opened against a line a posted goods
          receipt wrote — and a line a reversal has undone is not goods to examine.
        </p>
      ) : (
        <fieldset className="space-y-1">
          <legend className="text-xs text-ink-faint">Choose the line the goods arrived on</legend>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs font-medium text-ink-soft sm:grid-cols-7">
            <span>Lot</span><span>Material</span><span>Plant</span><span>Batch</span>
            <span className="text-right">Quantity</span><span>Stock</span><span>Movement</span>
          </div>
          {candidates.map((line) => (
            <label
              key={`${line.materialDocumentNumber}-${line.lineNumber}`}
              className="grid cursor-pointer grid-cols-2 items-center gap-2 border-t border-line py-1 text-sm sm:grid-cols-7"
              htmlFor={`${id}-${line.materialDocumentNumber}-${line.lineNumber}`}
            >
              <span className="flex items-center gap-2">
                <input
                  className="h-4 w-4" id={`${id}-${line.materialDocumentNumber}-${line.lineNumber}`}
                  type="radio" name="line" required
                  value={`${line.materialDocumentNumber}#${line.lineNumber}`}
                />
                <span className="code text-xs">{line.materialDocumentNumber} / {line.lineNumber}</span>
              </span>
              <span>{line.materialNumber}</span>
              <span>{line.plant}</span>
              <span>{line.batchNumber || '—'}</span>
              <span className="text-right">{quantity(line.baseQuantity)} {line.baseUnit}</span>
              <span>{line.stockType}</span>
              <span>{line.movementType}</span>
            </label>
          ))}
        </fieldset>
      )}
      <label className="block max-w-xl text-xs text-ink-soft" htmlFor={`${id}-note`}>
        What is to be examined (free text — it is not a result and nothing reads it as one)
        <input
          className="input mt-1" id={`${id}-note`} name="inspectionNote" maxLength={200}
          placeholder="Visual check of the pallets, certificates with the delivery note" autoComplete="off"
        />
      </label>
      <input type="hidden" name="requestKey" value={`QL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
      <div className="flex items-center gap-3">
        <button className="btn btn-primary min-h-11 sm:min-h-9" type="submit" disabled={pending || candidates.length === 0}>
          {pending ? 'Opening…' : 'Open lot'}
        </button>
        <span className="text-xs text-ink-faint">
          Nothing is posted. The goods keep the segment and the batch status the receipt left them in.
        </span>
      </div>
      <Notice state={state} />
    </form>
  );
}

function LotDetail({ lot }: { lot: LotView }) {
  const source = lot.source;
  return (
    <section className="panel p-4" aria-label={`Lot ${lot.lotNumber}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Lot {lot.lotNumber}</h2>
        <span className="text-xs text-ink-faint">opened by {lot.openedBy} on {lot.openedAt.slice(0, 10)}</span>
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        <State state={lot.state} />
        {source.documentStatus === 'POSTED'
          ? ' — the receipt it names stands, so the request stands with it.'
          : ` — the material document stands ${source.documentStatus.toLowerCase()}, and a lot reads that rather than keeping a state of its own.`}
      </p>
      {source.reversedOutBy ? (
        <p className="mt-2 panel panel-danger p-3 text-sm">
          Line {source.lineNumber} of {source.materialDocumentNumber} was reversed by {source.reversedOutBy}. The
          lot is kept as the record that inspection was asked for; those goods no longer stand where it was opened.
        </p>
      ) : null}

      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-faint">Material document</dt>
          <dd>
            <Link
              className="link"
              href={`/inventory/material-documents?document=${source.materialDocumentNumber}&fiscalYear=${source.documentYear}`}
            >
              {source.materialDocumentNumber} / {source.lineNumber}
            </Link>
            <span className="text-ink-faint"> · {source.documentDate}, posted {source.postingDate}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Movement</dt>
          <dd>{source.movementType}<span className="text-ink-faint"> · {source.lineDirection.toLowerCase()}</span></dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Material</dt>
          <dd>{source.materialNumber}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Plant / storage location</dt>
          <dd>{source.plant} / {source.storageLocation || '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Batch</dt>
          <dd>{source.batchNumber || '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Stock segment</dt>
          <dd>{source.stockType}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Quantity received (base)</dt>
          <dd className="text-right tabular-nums">{quantity(source.baseQuantity)} {source.baseUnit}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Entered on the document</dt>
          <dd className="text-right tabular-nums">{quantity(source.entryQuantity)} {source.entryUnit}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Purchase order</dt>
          <dd>
            {source.purchaseOrderNumber
              ? (
                  <Link className="link" href={`/purchasing/purchase-order-display?order=${source.purchaseOrderNumber}`}>
                    {source.purchaseOrderNumber}
                    {source.purchaseOrderItem ? ` / ${source.purchaseOrderItem}` : ''}
                  </Link>
                )
              : '—'}
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-sm">
        <span className="text-xs text-ink-faint">Note</span>
        <br />
        {lot.inspectionNote || 'No note was written when this lot was opened.'}
      </p>
      <p className="mt-3 text-xs text-ink-soft">
        No results are recorded on a lot, no sampling rule decides anything, and no usage decision exists yet:
        the decision path is the next slice, and quarantine at receipt is still open as DI-022. A lot is the
        request, not the outcome.
      </p>
    </section>
  );
}

export default function Lots(props: Props) {
  return (
    <div className="space-y-4">
      <OpenLot candidates={props.candidates} allowed={props.canCreate} />

      <section className="panel p-4" aria-label="Inspection lots">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium">
            {props.documentNumber ? `Lots of material document ${props.documentNumber}` : 'Inspection lots'}
          </p>
          <form method="get" action="/quality/lots" className="flex items-center gap-2">
            <label className="text-xs text-ink-soft" htmlFor="lots-document">
              Filter by document
              <input
                className="input ml-2 w-40" id="lots-document" name="document"
                defaultValue={props.documentNumber} placeholder="MD-0000001" autoComplete="off"
              />
            </label>
            <button className="btn btn-default min-h-11 sm:min-h-8" type="submit">Apply</button>
          </form>
        </div>
        {props.lots.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            {props.documentNumber
              ? 'No lot stands against this document yet.'
              : 'No inspection lot has been opened in this tenant yet.'}
          </p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="py-1">Lot</th><th>Document / line</th><th>Material</th><th>Plant</th>
                <th>Batch</th><th className="text-right">Quantity</th><th>Stock</th>
                <th>Movement</th><th>State</th><th>Opened by</th>
              </tr>
            </thead>
            <tbody>
              {props.lots.map((row) => (
                <tr key={row.lotNumber} className="border-t border-line align-top">
                  <td className="py-1">
                    <Link className="link" href={`/quality/lots?lot=${row.lotNumber}`}>{row.lotNumber}</Link>
                  </td>
                  <td>
                    <Link
                      className="link"
                      href={`/inventory/material-documents?document=${row.materialDocumentNumber}`}
                    >
                      {row.materialDocumentNumber} / {row.materialDocumentLine}
                    </Link>
                  </td>
                  <td>{row.materialNumber}</td>
                  <td>{row.plant}</td>
                  <td>{row.batchNumber || '—'}</td>
                  <td className="text-right tabular-nums">{quantity(row.baseQuantity)} {row.baseUnit}</td>
                  <td>{row.stockType}</td>
                  <td>{row.movementType}</td>
                  <td><State state={row.state} /></td>
                  <td>{row.openedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {props.selected ? <LotDetail lot={props.selected} /> : null}
    </div>
  );
}
