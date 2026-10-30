'use client';

import { useActionState, useState, useEffect } from 'react';

import type { CharacteristicRow, ResultRow } from '@/modules/quality/inspection-results';
import type { DecisionWithLot } from '@/modules/quality/usage-decision';
import {
  recordResultAction,
  saveCharacteristicAction,
  decideAction,
  type InspectionActionState,
} from './actions';

interface Workbench {
  lot: any;
  characteristics: CharacteristicRow[];
  results: ResultRow[];
  decision: DecisionWithLot | null;
  summary: any;
}

interface Props {
  workbench: Workbench;
  canRecord: boolean;
  canDecide: boolean;
  canOpenLot: boolean;
  viewOnly?: boolean;
  lockMessage?: string | null;
}

function ResultStatus({ status }: { status: string }) {
  const style = status === 'ACCEPTED'
    ? 'text-xs font-medium text-green-700'
    : status === 'REJECTED'
      ? 'text-xs font-medium text-red-700'
      : 'text-xs text-ink-soft';
  return <span className={style}>{status}</span>;
}

function formatQty(value: string): string {
  return value === '' ? '—' : Number(value).toFixed(3);
}

export default function InspectionWorkbench({
  workbench, canRecord, canDecide, canOpenLot, viewOnly = false, lockMessage = null,
}: Props) {
  const { lot, characteristics, results, decision, summary } = workbench;

  const [resultState, resultAction, resultPending] = useActionState(recordResultAction, { ok: false } as InspectionActionState);
  const [charState, charAction, charPending] = useActionState(saveCharacteristicAction, { ok: false } as InspectionActionState);
  const [decideState, decideActionFn, decidePending] = useActionState(decideAction, { ok: false } as InspectionActionState);

  const [newCharCode, setNewCharCode] = useState('');
  const [newCharDesc, setNewCharDesc] = useState('');
  const [newCharType, setNewCharType] = useState('QUANTITATIVE');
  const [newTolPlus, setNewTolPlus] = useState('');
  const [newTolMinus, setNewTolMinus] = useState('');
  const [newUnit, setNewUnit] = useState('');

  const [resultChar, setResultChar] = useState('');
  const [resultValue, setResultValue] = useState('');
  const [resultUnit, setResultUnit] = useState('');

  useEffect(() => {
    if (characteristics.length > 0 && !resultChar) {
      setResultChar(characteristics[0].characteristicCode);
    }
  }, [characteristics, resultChar]);

  const lotsResultsByCharacteristic = new Map(
    results.map((r) => [r.characteristicCode, r])
  );

  const resultMessage = resultState.message ? (
    <p className={`mt-2 text-sm ${resultState.ok ? 'text-green-700' : 'text-red-700'}`}>
      {resultState.message}
    </p>
  ) : null;

  const decideMessage = decideState.message ? (
    <p className={`mt-2 text-sm ${decideState.ok ? 'text-green-700' : 'text-red-700'}`}>
      {decideState.message}
    </p>
  ) : null;

  const charMessage = charState.message ? (
    <p className={`mt-2 text-sm ${charState.ok ? 'text-green-700' : 'text-red-700'}`}>
      {charState.message}
    </p>
  ) : null;

  return (
    <div className="space-y-4">
      {/* Lot header */}
      <section className="panel p-4" aria-label="Lot identity">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Lot {lot.lotNumber}
            </h2>
            <p className="mt-1 text-sm text-ink-soft">
              Opened by {lot.openedBy} on {lot.openedAt.slice(0, 10)}
            </p>
          </div>
          <span className="text-xs font-medium">
            {lot.state === 'OPEN' ? 'Open' : 'Source reversed'}
          </span>
        </div>

        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs text-ink-faint">Material document / line</dt>
            <dd>{lot.source.materialDocumentNumber} / {lot.source.lineNumber}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">Movement</dt>
            <dd>{lot.source.movementType} · {lot.source.lineDirection.toLowerCase()}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">Material</dt>
            <dd>{lot.source.materialNumber}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">Plant / storage location</dt>
            <dd>{lot.source.plant} / {lot.source.storageLocation || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">Batch</dt>
            <dd>{lot.source.batchNumber || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">Stock segment</dt>
            <dd>{lot.source.stockType}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">Quantity received (base)</dt>
            <dd className="text-right tabular-nums">{formatQty(lot.source.baseQuantity)} {lot.source.baseUnit}</dd>
          </div>
        </dl>

        {lockMessage && (
          <p className="mt-3 border border-signal-warn/40 bg-amber-50 p-3 text-sm text-amber-800">
            {lockMessage}
          </p>
        )}
      </section>

      {/* Results summary */}
      {summary && (
        <section className="panel p-4" aria-label="Inspection summary">
          <h3 className="text-sm font-semibold mb-2">Inspection summary</h3>
          <div className="grid gap-3 sm:grid-cols-4 text-sm">
            <div className="border-b border-line p-2">
              <div className="text-xs text-ink-faint">Characteristics</div>
              <div className="font-medium">{summary.totalCharacteristics}</div>
            </div>
            <div className="border-b border-line p-2">
              <div className="text-xs text-ink-faint">Results recorded</div>
              <div className="font-medium">{summary.resultsRecorded}</div>
            </div>
            <div className="border-b border-line p-2">
              <div className="text-xs text-ink-faint">Accepted</div>
              <div className="font-medium text-green-700">{summary.resultsAccepted}</div>
            </div>
            <div className="border-b border-line p-2">
              <div className="text-xs text-ink-faint">Rejected</div>
              <div className="font-medium text-red-700">{summary.resultsRejected}</div>
            </div>
          </div>
          <p className="mt-2 text-xs text-ink-soft">
            {summary.allMandatoryComplete
              ? 'All characteristics have a result — the lot is ready for a usage decision.'
              : `${summary.totalCharacteristics - summary.resultsRecorded} characteristic(s) still need a result.`}
          </p>
        </section>
      )}

      {/* Characteristic maintenance */}
      {canRecord && (
        <section className="panel p-4" aria-label="Maintain characteristics">
          <h3 className="text-sm font-semibold mb-2">Characteristics</h3>
          {charMessage}
          <form action={charAction} className="grid gap-3 sm:grid-cols-5" disabled={viewOnly}>
            <input
              className="input"
              placeholder="Code (e.g. DIM01)"
              value={newCharCode}
              onChange={(e) => setNewCharCode(e.target.value)}
              name="characteristicCode"
              required
            />
            <input
              className="input"
              placeholder="Description"
              value={newCharDesc}
              onChange={(e) => setNewCharDesc(e.target.value)}
              name="description"
              required
            />
            <select
              className="input"
              value={newCharType}
              onChange={(e) => setNewCharType(e.target.value as 'QUANTITATIVE' | 'QUALITATIVE')}
              name="characteristicType"
            >
              <option value="QUANTITATIVE">Quantitative</option>
              <option value="QUALITATIVE">Qualitative</option>
            </select>
            <input
              className="input"
              placeholder="Tol +"
              value={newTolPlus}
              onChange={(e) => setNewTolPlus(e.target.value)}
              name="tolerancePlus"
            />
            <input
              className="input"
              placeholder="Tol −"
              value={newTolMinus}
              onChange={(e) => setNewTolMinus(e.target.value)}
              name="toleranceMinus"
            />
            <input
              className="input"
              placeholder="Unit (quantitative)"
              value={newUnit}
              onChange={(e) => setNewUnit(e.target.value.toUpperCase())}
              name="unit"
            />
            <button
              className="btn btn-primary min-h-11 sm:min-h-8"
              type="submit"
              disabled={charPending || viewOnly}
            >
              Save
            </button>
          </form>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-faint">
                  <th className="py-1">Code</th><th>Description</th><th>Type</th>
                  <th className="text-right">Tolerance +</th><th className="text-right">Tolerance −</th>
                  <th>Unit</th>
                </tr>
              </thead>
              <tbody>
                {characteristics.map((c) => (
                  <tr key={c.characteristicCode} className="border-t border-line align-top">
                    <td className="py-1">{c.characteristicCode}</td>
                    <td>{c.description}</td>
                    <td>{c.characteristicType}</td>
                    <td className="text-right">{c.tolerancePlus ?? '—'}</td>
                    <td className="text-right">{c.toleranceMinus ?? '—'}</td>
                    <td>{c.unit ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Result entry */}
      {canRecord && characteristics.length > 0 && (
        <section className="panel p-4" aria-label="Record results">
          <h3 className="text-sm font-semibold mb-2">Record results</h3>
          {resultMessage}
          <form action={resultAction} className="grid gap-3 sm:grid-cols-6" disabled={viewOnly}>
            <input type="hidden" name="lotNumber" value={lot.lotNumber} />
            <input type="hidden" name="requestKey" value={`QA32-${Date.now()}`} />

            <select
              className="input"
              value={resultChar}
              onChange={(e) => setResultChar(e.target.value)}
              name="characteristicCode"
              required
              disabled={viewOnly}
            >
              {characteristics.map((c) => (
                <option key={c.characteristicCode} value={c.characteristicCode}>
                  {c.characteristicCode} — {c.description}
                </option>
              ))}
            </select>

            <input
              className="input"
              placeholder="Result value"
              value={resultValue}
              onChange={(e) => setResultValue(e.target.value)}
              name="resultValue"
              required
              disabled={viewOnly}
            />

            <input
              className="input"
              placeholder="Unit (quantitative only)"
              value={resultUnit}
              onChange={(e) => setResultUnit(e.target.value.toUpperCase())}
              name="measuredUnit"
              disabled={viewOnly}
            />

            <select
              className="input"
              name="resultStatus"
              defaultValue="RECORDED"
              disabled={viewOnly}
            >
              <option value="RECORDED">Recorded</option>
              <option value="ACCEPTED">Accepted</option>
              <option value="REJECTED">Rejected</option>
            </select>

            <button
              className="btn btn-primary min-h-11 sm:min-h-8"
              type="submit"
              disabled={resultPending || viewOnly}
            >
              Record result
            </button>
          </form>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-faint">
                  <th className="py-1">Characteristic</th><th>Description</th><th>Type</th>
                  <th className="text-right">Value</th><th>Unit</th>
                  <th>Status</th><th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {characteristics.map((c) => {
                  const r = lotsResultsByCharacteristic.get(c.characteristicCode);
                  return (
                    <tr key={c.characteristicCode} className="border-t border-line align-top">
                      <td className="py-1">{c.characteristicCode}</td>
                      <td>{c.description}</td>
                      <td>{c.characteristicType}</td>
                      <td className="text-right">{r ? r.resultValue : '—'}</td>
                      <td>{r?.measuredUnit ?? c.unit ?? '—'}</td>
                      <td>{r ? <ResultStatus status={r.resultStatus} /> : <span className="text-ink-faint">—</span>}</td>
                      <td>{r ? r.recordedAt.slice(0, 16) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Usage decision */}
      {canDecide && (
        <section className="panel p-4" aria-label="Usage decision">
          <h3 className="text-sm font-semibold mb-2">Usage decision (QE51N)</h3>
          {decideMessage}

          {!decision && summary && !summary.allMandatoryComplete && (
            <p className="mt-2 text-sm text-ink-soft">
              Cannot decide yet: {summary.totalCharacteristics - summary.resultsRecorded}
              result(s) still missing. Record results first.
            </p>
          )}

          {!decision && summary && summary.allMandatoryComplete && (
            <form action={decideActionFn} className="space-y-3" disabled={viewOnly}>
              <input type="hidden" name="lotNumber" value={lot.lotNumber} />
              <input type="hidden" name="requestKey" value={`QE51N-${Date.now()}`} />

              <p className="text-sm text-ink-soft">
                All results are recorded. Choose the decision for this lot.
              </p>

              <div className="grid gap-2 sm:grid-cols-4">
                <button
                  type="submit"
                  name="decisionCode"
                  value="ACCEPT"
                  className="btn btn-success min-h-11 sm:min-h-8 text-sm"
                  disabled={viewOnly || decidePending}
                >
                  Accept (quality → unrestricted)
                </button>
                <button
                  type="submit"
                  name="decisionCode"
                  value="REJECT"
                  className="btn btn-danger min-h-11 sm:min-h-8 text-sm"
                  disabled={viewOnly || decidePending}
                >
                  Reject (quality → blocked)
                </button>
                <button
                  type="submit"
                  name="decisionCode"
                  value="BLOCK"
                  className="btn btn-default min-h-11 sm:min-h-8 text-sm"
                  disabled={viewOnly || decidePending}
                >
                  Block stock
                </button>
                <button
                  type="submit"
                  name="decisionCode"
                  value="REWORK"
                  className="btn btn-default min-h-11 sm:min-h-8 text-sm"
                  disabled={viewOnly || decidePending}
                >
                  Rework (stay in quality)
                </button>
              </div>
            </form>
          )}

          {decision && (
            <section className="mt-3 border-t border-line pt-3">
              <h4 className="text-xs text-ink-faint mb-1">Decision recorded</h4>
              <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-ink-faint">Decision</dt>
                  <dd className="font-medium">{decision.decisionCode}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-faint">Date</dt>
                  <dd>{decision.decisionDate}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-faint">Decided by</dt>
                  <dd>{decision.decidedBy}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-faint">Stock posted</dt>
                  <dd>{decision.stockPosted ? 'Yes' : 'No'}</dd>
                </div>
                {decision.stockDocumentNumber && (
                  <div>
                    <dt className="text-xs text-ink-faint">Stock document</dt>
                    <dd>{decision.stockDocumentNumber} / {decision.stockDocumentLine}</dd>
                  </div>
                )}
              </dl>
            </section>
          )}
        </section>
      )}

      {!canRecord && !canDecide && (
        <p className="mt-2 text-sm text-ink-soft">
          No inspection capability: you can view this lot but cannot record results or make decisions.
          Ask for QM.INSPECTION.RECORD or QM.USAGE.DECIDE.
        </p>
      )}
    </div>
  );
}
