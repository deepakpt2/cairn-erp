'use client';

import { useActionState, useState } from 'react';

import {
  changeAccountDeterminationAction,
  defineAccountDeterminationAction,
  type DeterminationActionState,
} from './actions';
import type { AccountDeterminationRow } from '@/modules/sales/account-determination-maintenance';

const INITIAL: DeterminationActionState = { ok: false, message: '' };

function Notice({ state }: { state: DeterminationActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}
      {state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {help ? <span className="mt-1 block text-xs text-ink-faint">{help}</span> : null}
    </label>
  );
}

export function SalesAccountDeterminationSetup({
  rows,
  keys,
  charts,
  organisations,
  accounts,
}: {
  rows: AccountDeterminationRow[];
  keys: Array<{ key: string; name: string; meaning: string }>;
  charts: string[];
  organisations: string[];
  accounts: Array<{ accountNumber: string; name: string; chartOfAccounts: string }>;
}) {
  const [defineState, defineForm, definePending] = useActionState(defineAccountDeterminationAction, INITIAL);
  const [changeState, changeForm, changePending] = useActionState(changeAccountDeterminationAction, INITIAL);
  const [chart, setChart] = useState(charts[0] ?? '');
  const [selected, setSelected] = useState('');

  const key = (row: AccountDeterminationRow) => `${row.chartOfAccounts}/${row.salesOrg}/${row.customerAccountAssignmentGroup}/${row.materialAccountAssignmentGroup}/${row.accountKey}`;
  const row = rows.find((candidate) => key(candidate) === selected);
  const accountsInChart = accounts.filter((account) => account.chartOfAccounts === chart);

  return (
    <div className="space-y-4">
      <section aria-labelledby="determination-maintain" className="border border-line bg-surface p-4">
        <h2 id="determination-maintain" className="text-sm font-semibold">Name the account a key posts to</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          One row per account key, chart, sales organisation and pair of account assignment groups. A part left
          blank answers for every value of that part, and the most specific row that fits is the one that posts.
        </p>
        <form action={defineForm} className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Chart of accounts">
            <select
              name="chartOfAccounts"
              value={chart}
              onChange={(event) => setChart(event.currentTarget.value)}
              className="field-input code"
            >
              {charts.length === 0 ? <option value="">No chart stands</option> : null}
              {charts.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </Field>
          <Field label="Sales organisation" help="Blank answers for every sales organisation.">
            <select name="salesOrg" defaultValue="" className="field-input code">
              <option value="">(any)</option>
              {organisations.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </Field>
          <Field label="Account key">
            <select name="accountKey" defaultValue="ERL" className="field-input code">
              {keys.map((entry) => (
                <option key={entry.key} value={entry.key}>{entry.key} · {entry.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Customer account assignment group" help="Blank answers for customers maintained with none.">
            <input name="customerAccountAssignmentGroup" maxLength={4} className="field-input code" placeholder="(any)" />
          </Field>
          <Field label="Material account assignment group" help="Blank answers for materials maintained with none.">
            <input name="materialAccountAssignmentGroup" maxLength={4} className="field-input code" placeholder="(any)" />
          </Field>
          <Field label="G/L account">
            <select name="glAccount" className="field-input code">
              {accountsInChart.length === 0 ? <option value="">No account stands in this chart</option> : null}
              {accountsInChart.map((account) => (
                <option key={account.accountNumber} value={account.accountNumber}>
                  {account.accountNumber} · {account.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="sm:col-span-3">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={definePending}>
              {definePending ? 'Saving…' : 'Determine the account'}
            </button>
          </div>
        </form>
        <Notice state={defineState} />
      </section>

      <section aria-labelledby="determination-withdraw" className="border border-line bg-surface p-4">
        <h2 id="determination-withdraw" className="text-sm font-semibold">Withdraw a row, or restore one</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          A withdrawn row stops answering, so a document of that key is refused and names this screen. Nothing is
          deleted: a row here is part of the rule an invoice was posted under.
        </p>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">No determination stands, so no sales document can be posted.</p>
        ) : (
          <form action={changeForm} className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="The row">
              <select
                name="row"
                value={selected}
                onChange={(event) => setSelected(event.currentTarget.value)}
                className="field-input code"
              >
                <option value="">Choose a row</option>
                {rows.map((candidate) => (
                  <option key={key(candidate)} value={key(candidate)}>
                    {candidate.accountKey} · {candidate.chartOfAccounts}/{candidate.salesOrg || 'any'}/{
                      candidate.customerAccountAssignmentGroup || 'any'}/{
                      candidate.materialAccountAssignmentGroup || 'any'} → {candidate.glAccount}
                  </option>
                ))}
              </select>
            </Field>
            {row ? (
              <>
                <input type="hidden" name="chartOfAccounts" value={row.chartOfAccounts} />
                <input type="hidden" name="salesOrg" value={row.salesOrg} />
                <input type="hidden" name="customerAccountAssignmentGroup" value={row.customerAccountAssignmentGroup} />
                <input type="hidden" name="materialAccountAssignmentGroup" value={row.materialAccountAssignmentGroup} />
                <input type="hidden" name="accountKey" value={row.accountKey} />
                <input type="hidden" name="isActive" value={row.isActive ? 'false' : 'true'} />
                <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={changePending}>
                  {changePending ? 'Saving…' : row.isActive ? 'Withdraw this row' : 'Let this row answer again'}
                </button>
              </>
            ) : null}
          </form>
        )}
        <Notice state={changeState} />
      </section>
    </div>
  );
}
