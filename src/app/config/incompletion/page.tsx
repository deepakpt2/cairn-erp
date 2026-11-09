import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  INCOMPLETION_CAPABILITY,
  listIncompletionConfiguration,
} from '@/modules/sales/incompletion';
import { IncompletionSetup } from './IncompletionSetup';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/incompletion';

export default async function IncompletionPage() {
  const session = await requireSession(ROUTE);
  const configuration = await listIncompletionConfiguration(session.user.client);
  const canMaintain = can(session, INCOMPLETION_CAPABILITY);

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{INCOMPLETION_CAPABILITY} · SD</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Incompletion</h1>
          <Link href="/sales/incomplete" className="btn btn-default min-h-11 sm:min-h-8">
            The worklist
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          What a document has to carry before it counts as complete. A sales order is refused today
          when it is wrong and saved when it is not, and there is no third state; the log of
          incomplete items is that third state. The document stands, it is simply not complete, and
          what it is missing is recorded against it field by field — which is what lets a clerk save
          an order with the customer&apos;s purchase-order number still to come, and what stops the
          warehouse raising a delivery for an order with no date on it.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft">
          Nothing is delivered but the six groups. No procedure, no field, no status group and no
          assignment, so a document written in a tenant that has configured nothing is not judged at
          all — and stays that way until a tenant assigns a procedure to its document type by name.
        </p>
        {!canMaintain && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            Read-only. Maintenance requires an explicit exact-code role grant for{' '}
            {INCOMPLETION_CAPABILITY}; broad wildcard role patterns do not grant it.
          </p>
        )}
      </header>

      <section aria-labelledby="groups" className="border border-line bg-surface p-4">
        <h2 id="groups" className="text-sm font-semibold">The six places a document can be incomplete</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="grid-table text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th>Group</th>
                <th>What it is</th>
                <th>What it holds a document to</th>
              </tr>
            </thead>
            <tbody>
              {configuration.groups.map((row) => (
                <tr key={row.groupCode}>
                  <td className="font-mono">{row.groupCode}</td>
                  <td>{row.name}</td>
                  <td className="text-ink-soft">{row.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="status-groups" className="border border-line bg-surface p-4">
        <h2 id="status-groups" className="text-sm font-semibold">What a missing field stops</h2>
        {configuration.statusGroups.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No status group stands, so no field can be maintained and no document is judged.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Group</th>
                  <th>What it is called</th>
                  <th>Delivery</th>
                  <th>Goods issue</th>
                  <th>Billing</th>
                  <th>Output</th>
                  <th>Fields naming it</th>
                </tr>
              </thead>
              <tbody>
                {configuration.statusGroups.map((row) => (
                  <tr key={row.statusGroup}>
                    <td className="font-mono">{row.statusGroup}</td>
                    <td>{row.name}</td>
                    <td>{row.blocksDelivery ? 'Stopped' : '—'}</td>
                    <td>{row.blocksGoodsIssue ? 'Stopped' : '—'}</td>
                    <td>{row.blocksBilling ? 'Stopped' : '—'}</td>
                    <td>{row.blocksOutput ? 'Stopped' : '—'}</td>
                    <td className="font-mono">{row.fields}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="procedures" className="border border-line bg-surface p-4">
        <h2 id="procedures" className="text-sm font-semibold">The procedures, and the fields they check</h2>
        {configuration.procedures.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No procedure stands, so no document type can be judged.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Procedure</th>
                  <th>Group</th>
                  <th>What it is called</th>
                  <th>The fields, in the order they are reported</th>
                </tr>
              </thead>
              <tbody>
                {configuration.procedures.map((row) => (
                  <tr key={row.procedureCode}>
                    <td className="font-mono">{row.procedureCode}</td>
                    <td className="font-mono">{row.groupCode}</td>
                    <td>{row.name}</td>
                    <td>
                      {row.fields.length === 0 ? (
                        <span className="text-ink-faint">Checks nothing yet</span>
                      ) : (
                        <ol className="list-decimal pl-4">
                          {row.fields.map((field) => (
                            <li key={`${field.tableName}.${field.fieldName}`}>
                              {field.name}
                              <span className="text-ink-faint">
                                {' '}· {field.statusGroup}
                                {field.isWarning ? ' · warning' : ''}
                              </span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="assignments" className="border border-line bg-surface p-4">
        <h2 id="assignments" className="text-sm font-semibold">Which document types are judged</h2>
        {configuration.assignments.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No document type is assigned a procedure, so nothing is checked and nothing is recorded.
            That is the state every tenant is in until an assignment is made here.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Category</th>
                  <th>Document type</th>
                  <th>Judged by</th>
                  <th>Group</th>
                </tr>
              </thead>
              <tbody>
                {configuration.assignments.map((row) => (
                  <tr key={`${row.documentCategory}/${row.documentType}/${row.procedureCode}`}>
                    <td>{row.documentCategory === 'ORDER' ? 'Sales order' : 'Delivery'}</td>
                    <td className="font-mono">
                      {row.documentType}
                      {row.documentTypeName ? <span className="text-ink-faint"> · {row.documentTypeName}</span> : null}
                    </td>
                    <td className="font-mono">
                      {row.procedureCode}
                      {row.procedureName ? <span className="text-ink-faint"> · {row.procedureName}</span> : null}
                    </td>
                    <td className="font-mono">{row.groupCode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canMaintain && (
        <IncompletionSetup
          statusGroups={configuration.statusGroups}
          procedures={configuration.procedures}
          assignments={configuration.assignments}
          checkable={configuration.checkable}
          documentTypes={configuration.documentTypes}
        />
      )}
    </main>
  );
}
