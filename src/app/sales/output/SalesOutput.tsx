'use client';

import { useActionState } from 'react';

import type {
  SalesOutputRow,
  listOutputConditionRecords,
  salesOutputTypeChoices,
} from '@/modules/sales/output';
import {
  dispatchSalesOutputAction,
  reissueSalesOutputAction,
  runSalesOutputAction,
  saveOutputConditionAction,
  setOutputConditionStatusAction,
  setSalesOutputRecipientAction,
  type SalesOutputActionState,
} from './actions';

const EMPTY: SalesOutputActionState = { ok: false };

/** SAP's VSTAT digit beside the word, and the digits NAST uses for the medium and the dispatch time. */
const STATUS_ALIAS: Record<string, string> = { PENDING: '0', PROCESSED: '1', ERROR: '2' };
const MEDIUM_ALIAS: Record<string, string> = { PRINT: '1', EMAIL: '5' };
const DISPATCH_ALIAS: Record<string, string> = { IMMEDIATE: '1', PERIODIC: '3' };
const CATEGORY_LABEL: Record<string, string> = {
  SALES_ORDER: 'Order', DELIVERY: 'Delivery', BILLING: 'Billing',
};

/**
 * The access sequence, most specific first. It stands here as well as in the service so the screen can
 * show it without pulling the service — and the database behind it — into the browser.
 */
const ACCESS_SEQUENCE: Array<{ access: number; name: string; holds: string }> = [
  { access: 1, name: 'Sales area, document type and customer', holds: 'sales org + channel + division + doc. type + customer' },
  { access: 2, name: 'Sales area and document type', holds: 'sales org + channel + division + doc. type' },
  { access: 3, name: 'Sales area', holds: 'sales org + channel + division' },
  { access: 4, name: 'Sales organisation', holds: 'sales org' },
  { access: 5, name: 'General', holds: 'nothing named' },
];

interface Props {
  rows: SalesOutputRow[];
  counts: { pending: number; processed: number; failed: number; truncated: boolean };
  conditions: Awaited<ReturnType<typeof listOutputConditionRecords>>;
  types: Awaited<ReturnType<typeof salesOutputTypeChoices>>;
  canProcess: boolean;
  canAdmin: boolean;
  today: string;
}

function Notice({ state, label }: { state: SalesOutputActionState; label?: string }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      {label ? <p className="text-xs text-ink-faint">{label}</p> : null}
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
    </div>
  );
}

export default function SalesOutput({ rows, counts, conditions, types, canProcess, canAdmin, today }: Props) {
  const [runState, runAction, running] = useActionState(runSalesOutputAction, EMPTY);
  const [oneState, oneAction, dispatching] = useActionState(dispatchSalesOutputAction, EMPTY);
  const [reissueState, reissueSubmit, reissuing] = useActionState(reissueSalesOutputAction, EMPTY);
  const [recipientState, recipientSubmit, saving] = useActionState(setSalesOutputRecipientAction, EMPTY);
  const [saveState, saveSubmit, savingRecord] = useActionState(saveOutputConditionAction, EMPTY);
  const [statusState, statusSubmit, changingStatus] = useActionState(setOutputConditionStatusAction, EMPTY);

  return (
    <>
      <section aria-labelledby="sales-output-run" className="panel p-4">
        <h2 id="sales-output-run" className="text-sm font-semibold">The run</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Determination happens as a document is written, so nothing that stands today is missing its output.
          The run is what fills the past: it determines what stands missing and dispatches what is pending —
          the periodic path, since the package carries no scheduler.
        </p>
        {canProcess ? (
          <form action={runAction} className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="field-label">Documents</span>
              <select name="runCategory" className="input w-56" defaultValue="">
                <option value="">Orders, deliveries and invoices</option>
                <option value="SALES_ORDER">Sales orders</option>
                <option value="DELIVERY">Deliveries</option>
                <option value="BILLING">Billing documents</option>
              </select>
            </label>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={running}>
              {running ? 'Running…' : 'Determine and dispatch'}
            </button>
          </form>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">
            This session can read what was sent but not send it: dispatching needs SALES.OUTPUT.PROCESS.
          </p>
        )}
        <Notice state={runState} />
      </section>

      <section aria-labelledby="sales-output-queue" className="panel p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="sales-output-queue" className="text-sm font-semibold">
            Output queue <span className="text-ink-faint">({rows.length})</span>
          </h2>
          <p className="text-xs text-ink-soft">
            pending {counts.pending} · processed {counts.processed} · error {counts.failed}
          </p>
        </div>

        <Notice state={oneState} />
        <Notice state={reissueState} />
        <Notice state={recipientState} />

        <div className="mt-2 overflow-x-auto">
          <table className="grid-table text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th>Document</th>
                <th>Date</th>
                <th>Customer</th>
                <th>Output</th>
                <th>Medium</th>
                <th>Dispatch</th>
                <th>Status</th>
                <th className="text-right">Sends</th>
                <th>Recipient</th>
                <th>Last processed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.documentCategory}/${row.documentNumber}/${row.outputType}/${row.transmissionMedium}/${row.issueNumber}`}
                  data-document={row.documentNumber}
                  data-category={row.documentCategory}
                  data-output={row.outputType}
                  data-medium={row.transmissionMedium}
                  data-status={row.status}
                  data-issue={row.issueNumber}
                  data-sends={row.sendCount}
                  className="align-top"
                >
                  <td>
                    <span className="code">{row.documentNumber}</span>
                    <div className="text-xs text-ink-faint">{CATEGORY_LABEL[row.documentCategory] ?? row.documentCategory}</div>
                  </td>
                  <td className="code text-xs">{row.documentDate ?? '—'}</td>
                  <td className="code text-xs">{row.customerNumber ?? '—'}</td>
                  <td>
                    {row.outputType} <span className="text-ink-soft">{row.outputTypeDescription}</span>
                    {row.issueNumber > 1 ? (
                      <div className="text-xs text-ink-faint">issue {row.issueNumber}{row.reissueReason ? ` · ${row.reissueReason}` : ''}</div>
                    ) : null}
                  </td>
                  <td>{row.transmissionMedium} <span className="text-ink-faint">({MEDIUM_ALIAS[row.transmissionMedium] ?? '?'})</span></td>
                  <td>{row.dispatchTime} <span className="text-ink-faint">({DISPATCH_ALIAS[row.dispatchTime] ?? '?'})</span></td>
                  <td>
                    <span data-status-code={STATUS_ALIAS[row.status] ?? '?'}>{row.status}</span>
                    <span className="ms-1 text-ink-faint">({STATUS_ALIAS[row.status] ?? '?'})</span>
                    {row.errorText ? <div className="text-xs text-red-700">{row.errorText}</div> : null}
                  </td>
                  <td className="text-right tabular-nums">{row.sendCount}</td>
                  <td>{row.recipient ?? '—'}</td>
                  <td className="code text-xs">{row.lastProcessedAt ?? '—'}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-4 text-sm text-ink-soft">
                    Nothing has been sent. A document earns an output only where a condition record stands for its
                    sales area, document type and customer on the day it bears — no record, no output.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {canProcess ? (
          <div className="mt-3 space-y-3">
            {rows.map((row) => (
              <details
                key={`actions-${row.documentCategory}/${row.documentNumber}/${row.outputType}/${row.transmissionMedium}/${row.issueNumber}`}
                className="panel p-3"
              >
                <summary className="cursor-pointer text-sm font-medium">
                  {row.documentNumber} · {row.outputType} · {row.transmissionMedium} · issue {row.issueNumber} · {row.status}
                </summary>
                <div className="mt-2 flex flex-wrap items-end gap-3">
                  <form action={oneAction}>
                    <input type="hidden" name="documentCategory" value={row.documentCategory} />
                    <input type="hidden" name="documentNumber" value={row.documentNumber} />
                    <input type="hidden" name="outputType" value={row.outputType} />
                    <input type="hidden" name="transmissionMedium" value={row.transmissionMedium} />
                    <input type="hidden" name="issueNumber" value={row.issueNumber} />
                    <button type="submit" className="btn btn-default min-h-9" disabled={dispatching || row.status === 'PROCESSED'}>
                      Dispatch
                    </button>
                  </form>

                  <form action={reissueSubmit} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="documentCategory" value={row.documentCategory} />
                    <input type="hidden" name="documentNumber" value={row.documentNumber} />
                    <input type="hidden" name="outputType" value={row.outputType} />
                    <input type="hidden" name="transmissionMedium" value={row.transmissionMedium} />
                    <label className="block">
                      <span className="field-label">Reason for a second copy</span>
                      <input name="reason" className="input w-64" placeholder="The customer asked for a copy" required />
                    </label>
                    <button type="submit" className="btn btn-default min-h-9" disabled={reissuing}>
                      Issue again
                    </button>
                  </form>

                  <form action={recipientSubmit} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="documentCategory" value={row.documentCategory} />
                    <input type="hidden" name="documentNumber" value={row.documentNumber} />
                    <input type="hidden" name="outputType" value={row.outputType} />
                    <input type="hidden" name="transmissionMedium" value={row.transmissionMedium} />
                    <input type="hidden" name="issueNumber" value={row.issueNumber} />
                    <label className="block">
                      <span className="field-label">Recipient</span>
                      <input
                        name="recipient"
                        className="input w-56"
                        defaultValue={row.recipient ?? ''}
                        placeholder="accounts@customer.example"
                      />
                    </label>
                    <button type="submit" className="btn btn-default min-h-9" disabled={saving}>Set recipient</button>
                  </form>
                </div>
                {row.renderedDocument ? (
                  <pre
                    data-document-preview={row.documentNumber}
                    className="mt-3 overflow-x-auto border border-line bg-surface-muted p-3 text-xs leading-5"
                  >
                    {row.renderedDocument}
                  </pre>
                ) : (
                  <p className="mt-3 text-xs text-ink-faint">
                    Nothing has been rendered for this message yet — a message carries the document as it was sent
                    from the moment it is dispatched.
                  </p>
                )}
              </details>
            ))}
          </div>
        ) : null}

        {counts.truncated ? <p className="mt-2 text-xs text-ink-faint">The queue shows the first 200 rows; narrow it to see the rest.</p> : null}
      </section>

      <section aria-labelledby="sales-output-records" className="panel p-4">
        <h2 id="sales-output-records" className="text-sm font-semibold">Output condition records</h2>
        <p className="mt-1 text-sm text-ink-soft">
          The decision that a customer receives something at all. The most specific record that stands answers, and
          blank means any: a record naming a customer stands over one that names only the sales area that customer
          is sold to.
        </p>

        <table className="grid-table mt-3 text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
              <th>Access</th>
              <th>Output</th>
              <th>Sales area</th>
              <th>Doc. type</th>
              <th>Customer</th>
              <th>Medium</th>
              <th>Dispatch</th>
              <th>Partner</th>
              <th>Validity</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {conditions.map((record) => (
              <tr key={record.conditionNumber} data-condition={record.conditionNumber}>
                <td>
                  {record.access} <span className="text-ink-faint">{record.accessName}</span>
                </td>
                <td>
                  <span className="code">{record.outputType}</span>{' '}
                  <span className="text-ink-soft">{record.outputTypeDescription}</span>
                </td>
                <td className="code text-xs">
                  {record.salesOrg || '—'}/{record.distributionChannel || '—'}/{record.division || '—'}
                </td>
                <td className="code text-xs">{record.documentType || 'any'}</td>
                <td className="code text-xs">{record.customerNumber || 'any'}</td>
                <td>{record.transmissionMedium} <span className="text-ink-faint">({MEDIUM_ALIAS[record.transmissionMedium] ?? '?'})</span></td>
                <td>{record.dispatchTime} <span className="text-ink-faint">({DISPATCH_ALIAS[record.dispatchTime] ?? '?'})</span></td>
                <td className="code text-xs">{record.partnerFunction}</td>
                <td className="code text-xs">{record.validityFrom} → {record.validityTo}</td>
                <td>{record.isActive ? 'active' : 'withdrawn'}</td>
              </tr>
            ))}
            {conditions.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-4 text-sm text-ink-soft">
                  No record stands, so no document earns an output. Maintain one below.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        {canAdmin ? (
          <>
            <form action={saveSubmit} className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <label className="block">
                <span className="field-label">Output type</span>
                <select name="outputType" className="input w-full" defaultValue="RD00">
                  {types.map((type) => (
                    <option key={type.outputType} value={type.outputType}>{type.outputType} · {type.description}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="field-label">Sales organisation</span>
                <input name="salesOrg" className="input w-full" maxLength={4} placeholder="1000" />
              </label>
              <label className="block">
                <span className="field-label">Distribution channel</span>
                <input name="distributionChannel" className="input w-full" maxLength={2} placeholder="10" />
              </label>
              <label className="block">
                <span className="field-label">Division</span>
                <input name="division" className="input w-full" maxLength={2} placeholder="00" />
              </label>
              <label className="block">
                <span className="field-label">Document type</span>
                <input name="documentType" className="input w-full" maxLength={2} placeholder="F2" />
              </label>
              <label className="block">
                <span className="field-label">Customer</span>
                <input name="customerNumber" className="input w-full" maxLength={40} placeholder="any" />
              </label>
              <label className="block">
                <span className="field-label">Medium</span>
                <select name="transmissionMedium" className="input w-full" defaultValue="PRINT">
                  <option value="PRINT">Print (1)</option>
                  <option value="EMAIL">Email (5)</option>
                </select>
              </label>
              <label className="block">
                <span className="field-label">Dispatch time</span>
                <select name="dispatchTime" className="input w-full" defaultValue="IMMEDIATE">
                  <option value="IMMEDIATE">Immediate (1)</option>
                  <option value="PERIODIC">Periodic (3)</option>
                </select>
              </label>
              <label className="block">
                <span className="field-label">Partner function</span>
                <select name="partnerFunction" className="input w-full" defaultValue="BP">
                  <option value="SP">Sold-to</option>
                  <option value="SH">Ship-to</option>
                  <option value="BP">Bill-to</option>
                  <option value="PY">Payer</option>
                </select>
              </label>
              <label className="block">
                <span className="field-label">Valid from</span>
                <input type="date" name="validityFrom" className="input w-full" defaultValue={today} required />
              </label>
              <label className="block">
                <span className="field-label">Valid to</span>
                <input type="date" name="validityTo" className="input w-full" defaultValue="9999-12-31" required />
              </label>
              <div className="flex items-end">
                <button type="submit" className="btn btn-primary min-h-11 w-full sm:min-h-8" disabled={savingRecord}>
                  {savingRecord ? 'Saving…' : 'Maintain record'}
                </button>
              </div>
            </form>
            <Notice state={saveState} />
          </>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">
            This session can read what a customer receives but not change it: maintaining a record needs
            SALES.OUTPUT.ADMIN.
          </p>
        )}

        <h3 className="mt-4 text-sm font-semibold">The access sequence</h3>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-ink-soft">
          {ACCESS_SEQUENCE.map((entry) => (
            <li key={entry.access}>
              <span className="font-medium text-ink">{entry.access}. {entry.name}</span>
              <span className="code ms-1 text-xs">{entry.holds}</span>
            </li>
          ))}
        </ol>

        {canAdmin && conditions.length > 0 ? (
          <form action={statusSubmit} className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="field-label">Record</span>
              <select name="conditionNumber" className="input w-64">
                {conditions.map((record) => (
                  <option key={record.conditionNumber} value={record.conditionNumber}>
                    {record.conditionNumber} · {record.outputType}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="field-label">State</span>
              <select name="isActive" className="input w-40">
                <option value="true">Active</option>
                <option value="false">Withdrawn</option>
              </select>
            </label>
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={changingStatus}>
              Apply
            </button>
          </form>
        ) : null}
        <Notice state={statusState} />
      </section>
    </>
  );
}
