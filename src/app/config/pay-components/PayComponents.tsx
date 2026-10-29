'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { PayComponentKind, PayComponentMappingView, PayComponentRow, PayComponentView } from '@/modules/people/pay-components';
import {
  changeComponentAction,
  changeMappingAction,
  defineComponentAction,
  defineMappingAction,
  type PayActionState,
} from './actions';

type Props = {
  components: PayComponentRow[];
  selected: PayComponentView | null;
  charts: Array<{ chartOfAccounts: string; name: string }>;
  mappingChart: string;
  debitAccounts: Array<{ accountNumber: string; name: string; requiresCostObject: boolean }>;
  creditAccounts: Array<{ accountNumber: string; name: string; requiresCostObject: boolean }>;
  centres: Array<{ controllingArea: string; costCenter: string; name: string }>;
  query: string;
  canWrite: boolean;
};

const EMPTY: PayActionState = { ok: false };

const KINDS: Array<{ value: PayComponentKind; label: string; hint: string }> = [
  { value: 'EARNING', label: 'Earning', hint: 'debits an expense account; changes what the employee is paid' },
  { value: 'DEDUCTION', label: 'Deduction', hint: 'credits a payable; changes what the employee is paid' },
  { value: 'EMPLOYER_CONTRIBUTION', label: 'Employer contribution', hint: 'debits an expense and credits a payable' },
  { value: 'EOS_PROVISION', label: 'End-of-service provision', hint: 'debits an expense and credits a provision' },
];

const KIND_NAMES: Record<PayComponentKind, string> = {
  EARNING: 'Earning',
  DEDUCTION: 'Deduction',
  EMPLOYER_CONTRIBUTION: 'Employer contribution',
  EOS_PROVISION: 'End-of-service provision',
};

/**
 * The pay structure screen: components, and one mapping per component per chart.
 *
 * Three things the markup carries deliberately. The kind is asked for once, on the component, because it
 * decides which side of a mapping must be filled — the screen says which sides the chosen kind has, so an
 * operator is not left to guess why a field is refused. A mapping is written or corrected, never removed, and
 * the screen says so where a reader would look for a Delete. And the cost object is a choice with three
 * answers rather than a free-text centre, because a centre belongs to a controlling area and half a pair is a
 * mapping that cannot be charged.
 */
export default function PayComponents(props: Props) {
  const [defineState, defineAction, definePending] = useActionState(defineComponentAction, EMPTY);
  const [changeState, changeAction, changePending] = useActionState(changeComponentAction, EMPTY);
  const [defineMappingState, defineMappingAction_, defineMappingPending] = useActionState(defineMappingAction, EMPTY);
  const [changeMappingState, changeMappingAction_, changeMappingPending] = useActionState(changeMappingAction, EMPTY);
  const { components, selected, charts, mappingChart, debitAccounts, creditAccounts, centres, query, canWrite } = props;

  const standing = selected && mappingChart
    ? selected.mappings.find((row) => row.chartOfAccounts === mappingChart) ?? null
    : null;

  return (
    <div className="space-y-4">
      <Notice state={defineState} />

      <section className="panel p-4" aria-label="Define a pay component">
        <h2 className="text-sm font-semibold">Define a pay component</h2>
        {canWrite ? (
          <form action={defineAction} className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="Code" name="code" hint="One to ten capitals or digits, starting with a letter." />
            <Field label="Name" name="name" hint="As the payslip would read it, up to 60 characters." />
            <label className="block text-sm">
              <span className="font-medium">Kind</span>
              <select className="input mt-1" name="componentKind" defaultValue="EARNING" required>
                {KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-ink-faint">{KINDS[0]?.hint}</span>
            </label>
            <Field label="Description" name="description" optional hint="What the tenant pays or owes under this name." />
            <div className="sm:col-span-2">
              <button className="btn btn-primary min-h-11 sm:min-h-9" type="submit" disabled={definePending}>
                {definePending ? 'Writing…' : 'Define component'}
              </button>
              <span className="ml-3 text-xs text-ink-faint">
                A component is named, then mapped; nothing is calculated here, and nothing is deleted.
              </span>
            </div>
          </form>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">
            CFG.PEOPLE.PAYCOMPONENT.DEFINE maintains the pay structure; until this session holds it, the screen
            reads. Define what the components are in the tenant&apos;s own words — the accounts come from the
            chart of accounts, already defined for the company.
          </p>
        )}
      </section>

      <section className="panel p-4" aria-label="Pay components">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-sm font-semibold">Components ({components.length})</h2>
          <form action="/config/pay-components" method="get" className="flex items-end gap-2" aria-label="Search">
            <label className="text-sm">
              <span className="block text-xs text-ink-faint">Find a component</span>
              <input className="input w-44 py-1 text-xs" name="q" defaultValue={query} placeholder="code or name" />
            </label>
            <button className="btn btn-default min-h-11 px-2 text-xs sm:min-h-8" type="submit">Search</button>
          </form>
        </div>
        {components.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">
            No pay component is defined{query ? ` for “${query}”` : ''}. Until one is, nothing has an account to
            move through, and a payroll result would have nothing to cite.
          </p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs text-ink-faint">
              <tr>
                <th className="py-1 pr-2 font-medium">Code</th>
                <th className="py-1 pr-2 font-medium">Name</th>
                <th className="py-1 pr-2 font-medium">Kind</th>
                <th className="py-1 pr-2 font-medium">Net pay</th>
                <th className="py-1 pr-2 font-medium">Mappings</th>
                <th className="py-1 pr-2 font-medium">Validity</th>
              </tr>
            </thead>
            <tbody>
              {components.map((row) => (
                <tr key={row.code} className="border-t border-line">
                  <td className="py-1 pr-2">
                    <Link className="link" href={`/config/pay-components?component=${row.code}`}>
                      {row.code}
                    </Link>
                  </td>
                  <td className="py-1 pr-2">{row.name}</td>
                  <td className="py-1 pr-2">{KIND_NAMES[row.componentKind]}</td>
                  <td className="py-1 pr-2">{row.affectsNetPay ? 'changes it' : 'does not'}</td>
                  <td className="py-1 pr-2">{row.mappings}</td>
                  <td className="py-1 pr-2">{row.isValid ? 'valid' : 'retired'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected ? (
        <>
          <Notice state={changeState} />
          <Notice state={defineMappingState} />
          <Notice state={changeMappingState} />

          <section className="panel p-4" aria-label="This pay component">
            <h2 className="text-sm font-semibold">
              <span className="code">{selected.code}</span> · {selected.name}
            </h2>
            <p className="mt-1 text-sm text-ink-soft">
              {KIND_NAMES[selected.componentKind]} — {selected.affectsNetPay ? 'it changes what the employee is paid' : 'it is the tenant’s own cost'}.{' '}
              {selected.description ? `${selected.description}. ` : ''}
              {selected.isValid
                ? 'Open for new mappings.'
                : 'Retired: no new mapping, and every mapping that stands still stands.'}
            </p>
            {selected.mappings.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">
                No chart has mapped this component yet, so nothing could be posted for it.
              </p>
            ) : (
              <table className="mt-3 w-full text-sm">
                <thead className="text-left text-xs text-ink-faint">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Chart</th>
                    <th className="py-1 pr-2 font-medium">Debit</th>
                    <th className="py-1 pr-2 font-medium">Credit</th>
                    <th className="py-1 pr-2 font-medium">Charged</th>
                    <th className="py-1 pr-2 font-medium">Changed by</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.mappings.map((row) => (
                    <tr key={row.chartOfAccounts} className="border-t border-line">
                      <td className="py-1 pr-2">
                        <Link
                          className="link"
                          href={`/config/pay-components?component=${selected.code}&chart=${row.chartOfAccounts}`}
                        >
                          {row.chartOfAccounts}
                        </Link>
                      </td>
                      <td className="py-1 pr-2">{account(row, 'debitAccount', 'debitAccountName')}</td>
                      <td className="py-1 pr-2">{account(row, 'creditAccount', 'creditAccountName')}</td>
                      <td className="py-1 pr-2">{charge(row)}</td>
                      <td className="py-1 pr-2">{row.changedBy ?? row.createdBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {canWrite ? (
              <form action={changeAction} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
                <input type="hidden" name="code" value={selected.code} />
                <label className="text-sm">
                  <span className="block text-xs text-ink-faint">Name</span>
                  <input className="input w-52 py-1 text-xs" name="name" defaultValue={selected.name} maxLength={60} />
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-ink-faint">Validity</span>
                  <select className="input py-1 text-xs" name="isValid" defaultValue="">
                    <option value="">leave as is</option>
                    <option value="yes">open for new mappings</option>
                    <option value="no">retire</option>
                  </select>
                </label>
                <button className="btn btn-default min-h-11 px-2 text-xs sm:min-h-8" type="submit" disabled={changePending}>
                  {changePending ? 'Writing…' : 'Change component'}
                </button>
                <span className="text-xs text-ink-faint">The kind stays: it is what the mappings were written for.</span>
              </form>
            ) : null}
          </section>

          <section className="panel p-4" aria-label={standing ? 'Change the mapping' : 'Define the mapping'}>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 className="text-sm font-semibold">
                {standing ? `Mapping of ${selected.code} in chart ${mappingChart}` : `Map ${selected.code} in chart ${mappingChart}`}
              </h2>
              {charts.length > 0 ? (
                <form action="/config/pay-components" method="get" className="flex items-end gap-2" aria-label="Chart">
                  <input type="hidden" name="component" value={selected.code} />
                  <label className="text-sm">
                    <span className="block text-xs text-ink-faint">Chart to map within</span>
                    <select className="input py-1 text-xs" name="chart" defaultValue={mappingChart}>
                      {charts.map((chart) => (
                        <option key={chart.chartOfAccounts} value={chart.chartOfAccounts}>
                          {chart.chartOfAccounts} — {chart.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="btn btn-default min-h-11 px-2 text-xs sm:min-h-8" type="submit">Choose chart</button>
                </form>
              ) : (
                <p className="text-xs text-ink-faint">This tenant has no chart of accounts, so nothing can be mapped.</p>
              )}
            </div>

            {!canWrite ? (
              <p className="mt-2 text-sm text-ink-soft">
                A session without CFG.PEOPLE.PAYCOMPONENT.DEFINE reads the mapping; the accounts it shows were
                written by whoever holds it.
              </p>
            ) : !mappingChart ? (
              <p className="mt-2 text-sm text-ink-soft">
                Define a chart of accounts first: a mapping is always within one chart, because an account number
                means nothing outside the chart that issued it.
              </p>
            ) : (
              <>
                <p className="mt-1 text-xs text-ink-faint">
                  {selected.componentKind === 'EARNING'
                    ? 'An earning debits an expense account. The credit that balances it is the payroll run’s own payable, not something a component carries.'
                    : selected.componentKind === 'DEDUCTION'
                      ? 'A deduction credits the payable owed to whoever receives it. It charges nothing of the tenant’s.'
                      : 'A contribution or a provision both costs the tenant and owes someone, so both sides are mapped.'}
                </p>
                <form
                  action={standing ? changeMappingAction_ : defineMappingAction_}
                  className="mt-3 grid gap-3 sm:grid-cols-2"
                >
                  <input type="hidden" name="componentCode" value={selected.code} />
                  <input type="hidden" name="chart" value={mappingChart} />
                  <AccountSelect
                    label="Debit account (expense)"
                    name="debitAccount"
                    accounts={debitAccounts}
                    standing={standing?.debitAccount ?? null}
                    blank={standing ? 'leave as it stands' : 'no debit'}
                    extra={standing?.debitAccount ? [standing.debitAccount] : []}
                  />
                  <AccountSelect
                    label="Credit account (payable)"
                    name="creditAccount"
                    accounts={creditAccounts}
                    standing={standing?.creditAccount ?? null}
                    blank={standing ? 'leave as it stands' : 'no credit'}
                    extra={standing?.creditAccount ? [standing.creditAccount] : []}
                  />
                  <label className="block text-sm">
                    <span className="font-medium">Cost object</span>
                    <select className="input mt-1" name="costReceiverCategory" defaultValue={standing?.costReceiverCategory ?? 'ASSIGNMENT'}>
                      <option value="ASSIGNMENT">Charge the employee’s assignment centre</option>
                      <option value="FIXED">Charge one fixed cost centre</option>
                      <option value="NONE">Charge nothing</option>
                    </select>
                    <span className="mt-1 block text-xs text-ink-faint">
                      A centre an expense account demands cannot be left out; an account that takes none is
                      charged to nothing.
                    </span>
                  </label>
                  <label className="block text-sm">
                    <span className="font-medium">Fixed cost centre</span>
                    <select className="input mt-1" name="costCenter" defaultValue={standing?.costCenter ? `${standing.controllingArea}/${standing.costCenter}` : ''}>
                      <option value="">{standing ? 'leave as it stands' : 'none'}</option>
                      <option value="NONE">no fixed centre</option>
                      {centres.map((row) => (
                        <option key={`${row.controllingArea}/${row.costCenter}`} value={`${row.controllingArea}/${row.costCenter}`}>
                          {row.controllingArea}/{row.costCenter} — {row.name}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1 block text-xs text-ink-faint">Read as of today: a mapping has no dates of its own.</span>
                  </label>
                  <div className="sm:col-span-2">
                    <button className="btn btn-primary min-h-11 sm:min-h-9" type="submit" disabled={defineMappingPending || changeMappingPending}>
                      {standing
                        ? changeMappingPending ? 'Writing…' : 'Save mapping'
                        : defineMappingPending ? 'Writing…' : 'Define mapping'}
                    </button>
                    <span className="ml-3 text-xs text-ink-faint">
                      A mapping is corrected in place; the row is keyed by component and chart, and nothing here deletes it.
                    </span>
                  </div>
                </form>
              </>
            )}
          </section>
        </>
      ) : (
        <section className="panel p-4" aria-label="Mapping">
          <h2 className="text-sm font-semibold">Mapping</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Pick a component above to see its accounts. A mapping is one row per component per chart: the
            expense side, the payable side, and where the charge goes — which is all §15.2’s posting example
            asks of a component, and all this screen promises.
          </p>
        </section>
      )}
    </div>
  );
}

function AccountSelect(props: {
  label: string;
  name: string;
  accounts: Array<{ accountNumber: string; name: string; requiresCostObject: boolean }>;
  standing: string | null;
  blank: string;
  extra: string[];
}) {
  const { label, name, accounts, standing, blank, extra } = props;
  const known = new Set(accounts.map((row) => row.accountNumber));
  return (
    <label className="block text-sm">
      <span className="font-medium">{label}</span>
      <select className="input mt-1" name={name} defaultValue={standing ?? ''}>
        <option value="">{blank}</option>
        <option value="NONE">no account on this side</option>
        {extra.filter((code) => !known.has(code)).map((code) => (
          <option key={code} value={code}>
            {code} — mapped, no longer offered (blocked or of another type)
          </option>
        ))}
        {accounts.map((row) => (
          <option key={row.accountNumber} value={row.accountNumber}>
            {row.accountNumber} — {row.name}
            {row.requiresCostObject ? ' (needs a cost object)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

function account(row: PayComponentMappingView, code: 'debitAccount' | 'creditAccount', name: 'debitAccountName' | 'creditAccountName') {
  const number = row[code];
  if (!number) return <span className="text-ink-faint">—</span>;
  const label = row[name];
  return (
    <span>
      <span className="code">{number}</span>
      {label ? <span className="text-ink-faint"> · {label}</span> : null}
    </span>
  );
}

function charge(row: PayComponentMappingView): string {
  if (row.costReceiverCategory === 'ASSIGNMENT') return 'the assignment’s centre';
  if (row.costReceiverCategory === 'FIXED') return `${row.controllingArea}/${row.costCenter}${row.costCenterName ? ` · ${row.costCenterName}` : ''}`;
  return 'nothing';
}

function Field(props: { label: string; name: string; hint?: string; optional?: boolean }) {
  const { label, name, hint, optional } = props;
  return (
    <label className="block text-sm">
      <span className="font-medium">
        {label}
        {optional ? <span className="text-ink-faint"> (optional)</span> : null}
      </span>
      <input className="input mt-1" name={name} maxLength={name === 'description' ? 200 : 60} />
      {hint ? <span className="mt-1 block text-xs text-ink-faint">{hint}</span> : null}
    </label>
  );
}

function Notice({ state }: { state: PayActionState }) {
  if (!state.message) return null;
  const href = state.component
    ? `/config/pay-components?component=${state.component}${state.chart ? `&chart=${state.chart}` : ''}`
    : null;
  return (
    <div className={state.ok ? 'panel panel-success p-3 text-sm' : 'panel panel-danger p-3 text-sm'} role="status">
      <p>{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.ok && href ? (
        <p className="mt-2">
          <Link className="link" href={href}>
            Read it back
          </Link>
        </p>
      ) : null}
    </div>
  );
}
