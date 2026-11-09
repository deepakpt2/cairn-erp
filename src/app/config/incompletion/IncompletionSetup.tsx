'use client';

import { useActionState, useState } from 'react';

import {
  assignIncompletionProcedureAction, saveIncompletionProcedureAction,
  saveIncompletionProcedureFieldAction, saveIncompletionStatusGroupAction,
  changeIncompletionStatusGroupAction, withdrawIncompletionAssignmentAction,
  withdrawIncompletionProcedureFieldAction, type IncompletionActionState,
} from './actions';
import type {
  CheckableFieldView, IncompletionAssignmentRow, IncompletionProcedureRow,
  IncompletionStatusGroupRow,
} from '@/modules/sales/incompletion';

const INITIAL: IncompletionActionState = { ok: false, message: '' };

function Notice({ state }: { state: IncompletionActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}
      {state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

function Field({ label, help, children }: {
  label: string; help?: string; children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {help ? <span className="mt-1 block text-xs text-ink-faint">{help}</span> : null}
    </label>
  );
}

/**
 * Maintaining what a complete document is.
 *
 * The four acts SAP keeps apart as OVA0, OVA2, VUA2 and VUA4, in the order a tenant performs them:
 * name what a missing field stops, name a list of fields, and assign the list to a document type.
 */
export function IncompletionSetup({
  statusGroups, procedures, assignments, checkable, documentTypes,
}: {
  statusGroups: IncompletionStatusGroupRow[];
  procedures: IncompletionProcedureRow[];
  assignments: IncompletionAssignmentRow[];
  checkable: CheckableFieldView[];
  documentTypes: Array<{ documentType: string; name: string | null }>;
}) {
  const [groupState, groupForm, groupPending] = useActionState(saveIncompletionStatusGroupAction, INITIAL);
  const [groupOffState, groupOffForm, groupOffPending] = useActionState(changeIncompletionStatusGroupAction, INITIAL);
  const [procedureState, procedureForm, procedurePending] = useActionState(saveIncompletionProcedureAction, INITIAL);
  const [fieldState, fieldForm, fieldPending] = useActionState(saveIncompletionProcedureFieldAction, INITIAL);
  const [dropState, dropForm, dropPending] = useActionState(withdrawIncompletionProcedureFieldAction, INITIAL);
  const [assignState, assignForm, assignPending] = useActionState(assignIncompletionProcedureAction, INITIAL);
  const [withdrawState, withdrawForm, withdrawPending] = useActionState(withdrawIncompletionAssignmentAction, INITIAL);

  const [procedureCode, setProcedureCode] = useState('');
  const [assignGroup, setAssignGroup] = useState('A');
  const procedure = procedures.find((candidate) => candidate.procedureCode === procedureCode) ?? null;
  const offered = checkable.filter((candidate) => candidate.group === (procedure?.groupCode ?? assignGroup));

  return (
    <div className="space-y-4">
      <section aria-labelledby="incompletion-group" className="border border-line bg-surface p-4">
        <h2 id="incompletion-group" className="text-sm font-semibold">Name what a missing field stops</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          A status group is the whole of the consequence. It is not that a field is important — it is
          that a named function will not run for a document missing it. Leave all four boxes empty and
          the group means <em>record this, stop nothing</em>, which is what a warning is.
        </p>
        <form action={groupForm} className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Status group" help="One or two capital letters or digits.">
            <input name="statusGroup" maxLength={2} pattern="[A-Za-z0-9]{1,2}" className="field-input code" placeholder="01" />
          </Field>
          <Field label="What it is called">
            <input name="name" maxLength={40} className="field-input" placeholder="Stops delivery" />
          </Field>
          <fieldset className="sm:col-span-3">
            <legend className="mb-1 text-sm font-medium">What a field named by this group stops</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              {[
                ['blocksDelivery', 'Delivery'],
                ['blocksGoodsIssue', 'Goods issue'],
                ['blocksBilling', 'Billing'],
                ['blocksOutput', 'Output'],
              ].map(([name, label]) => (
                <label key={name} className="flex items-center gap-2">
                  <input type="checkbox" name={name} className="h-4 w-4" />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={groupPending}>
              {groupPending ? 'Saving…' : 'Name the status group'}
            </button>
          </div>
        </form>
        <Notice state={groupState} />

        {statusGroups.length > 0 ? (
          <form action={groupOffForm} className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <Field label="Withdraw a status group">
              <select name="statusGroup" className="field-input code">
                <option value="">Choose a status group</option>
                {statusGroups.map((row) => (
                  <option key={row.statusGroup} value={row.statusGroup}>
                    {row.statusGroup} · {row.name}
                  </option>
                ))}
              </select>
            </Field>
            <input type="hidden" name="isActive" value="false" />
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={groupOffPending}>
              {groupOffPending ? 'Saving…' : 'Withdraw it'}
            </button>
          </form>
        ) : null}
        <Notice state={groupOffState} />
      </section>

      <section aria-labelledby="incompletion-procedure" className="border border-line bg-surface p-4">
        <h2 id="incompletion-procedure" className="text-sm font-semibold">Name a procedure</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          A procedure is a list of the fields a document of one group must carry. It belongs to one
          group, because a header check and an item check are not the same question, and it judges
          nothing until it is given fields and assigned to a document type.
        </p>
        <form action={procedureForm} className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Procedure" help="Up to four capital letters or digits.">
            <input name="procedureCode" maxLength={4} pattern="[A-Za-z0-9]{1,4}" className="field-input code" placeholder="ZORD" />
          </Field>
          <Field label="What it judges">
            <select
              name="groupCode"
              value={assignGroup}
              onChange={(event) => setAssignGroup(event.currentTarget.value)}
              className="field-input"
            >
              <option value="A">A — sales header</option>
              <option value="B">B — sales item</option>
              <option value="C">C — sales schedule line</option>
              <option value="D">D — partner</option>
              <option value="G">G — delivery header</option>
              <option value="H">H — delivery item</option>
            </select>
          </Field>
          <Field label="What it is called">
            <input name="name" maxLength={40} className="field-input" placeholder="Order completeness" />
          </Field>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={procedurePending}>
            {procedurePending ? 'Saving…' : 'Name the procedure'}
          </button>
        </form>
        <Notice state={procedureState} />
      </section>

      <section aria-labelledby="incompletion-field" className="border border-line bg-surface p-4">
        <h2 id="incompletion-field" className="text-sm font-semibold">Give a procedure the fields it checks</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Only the fields this package knows how to judge are offered. A field nothing evaluates would
          leave a document silently never complete, and the log would say so forever with nobody able
          to fix it. The sequence is the order a clerk is told to fill them in.
        </p>
        <form action={fieldForm} className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="The procedure">
            <select
              name="procedureCode"
              value={procedureCode}
              onChange={(event) => setProcedureCode(event.currentTarget.value)}
              className="field-input code"
            >
              <option value="">Choose a procedure</option>
              {procedures.map((candidate) => (
                <option key={candidate.procedureCode} value={candidate.procedureCode}>
                  {candidate.procedureCode} · {candidate.name} ({candidate.groupCode})
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="The field"
            help={procedure ? `Only ${procedure.groupCode}-group fields are offered.` : 'Choose the procedure first.'}
          >
            <select name="field" className="field-input">
              <option value="">Choose a field</option>
              {offered.map((candidate) => (
                <option key={`${candidate.table}.${candidate.field}`} value={`${candidate.table}.${candidate.field}`}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reported at position" help="Numbered from one, in the order it should be filled in.">
            <input name="sequence" type="number" min={1} step={1} defaultValue={1} className="field-input code" />
          </Field>
          <Field label="Status group" help="What its absence stops.">
            <input name="statusGroup" maxLength={2} className="field-input code" placeholder="01" />
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="isWarning" className="h-4 w-4" />
            A warning only: record it on the worklist and stop nothing
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              className="btn btn-primary min-h-11 sm:min-h-8"
              disabled={fieldPending || !procedureCode}
            >
              {fieldPending ? 'Saving…' : 'Add the field'}
            </button>
          </div>
        </form>
        <Notice state={fieldState} />

        {procedure && procedure.fields.length > 0 ? (
          <form action={dropForm} className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <input type="hidden" name="procedureCode" value={procedure.procedureCode} />
            <Field label={`Take a field out of ${procedure.procedureCode}`}>
              <select name="field" className="field-input">
                <option value="">Choose a field</option>
                {procedure.fields.map((candidate) => (
                  <option
                    key={`${candidate.tableName}.${candidate.fieldName}`}
                    value={`${candidate.tableName}.${candidate.fieldName}`}
                  >
                    {candidate.sequence}. {candidate.name}
                    {candidate.isWarning ? ' (warning)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={dropPending}>
              {dropPending ? 'Saving…' : 'Take it out'}
            </button>
          </form>
        ) : null}
        <Notice state={dropState} />
      </section>

      <section aria-labelledby="incompletion-assign" className="border border-line bg-surface p-4">
        <h2 id="incompletion-assign" className="text-sm font-semibold">Assign a procedure to a document type</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          This is the act that makes any of it bite. A document type with no assignment is not checked
          at all — which is why every document in the books today is unaffected until a tenant does
          this by name.
        </p>
        <form action={assignForm} className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Document category">
            <select name="documentCategory" className="field-input">
              <option value="ORDER">Sales order</option>
              <option value="DELIVERY">Delivery</option>
            </select>
          </Field>
          <Field label="Document type">
            <select name="documentType" className="field-input code">
              <option value="">Choose a document type</option>
              {documentTypes.map((row) => (
                <option key={row.documentType} value={row.documentType}>
                  {row.documentType}{row.name ? ` · ${row.name}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Procedure">
            <select name="procedureCode" className="field-input code">
              <option value="">Choose a procedure</option>
              {procedures.map((candidate) => (
                <option key={candidate.procedureCode} value={candidate.procedureCode}>
                  {candidate.procedureCode} · {candidate.name}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={assignPending}>
            {assignPending ? 'Saving…' : 'Assign it'}
          </button>
        </form>
        <Notice state={assignState} />

        {assignments.length > 0 ? (
          <form action={withdrawForm} className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <Field label="Withdraw an assignment">
              <select name="documentType" className="field-input code">
                <option value="">Choose an assignment</option>
                {assignments.map((row) => (
                  <option
                    key={`${row.documentCategory}/${row.documentType}/${row.procedureCode}`}
                    value={row.documentType}
                  >
                    {row.documentCategory} {row.documentType} · {row.procedureCode}
                    {row.procedureName ? ` · ${row.procedureName}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <select name="documentCategory" className="field-input code" aria-label="Document category">
              <option value="ORDER">ORDER</option>
              <option value="DELIVERY">DELIVERY</option>
            </select>
            <Field label="Procedure">
              <select name="procedureCode" className="field-input code">
                <option value="">Choose a procedure</option>
                {procedures.map((candidate) => (
                  <option key={candidate.procedureCode} value={candidate.procedureCode}>
                    {candidate.procedureCode}
                  </option>
                ))}
              </select>
            </Field>
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={withdrawPending}>
              {withdrawPending ? 'Saving…' : 'Withdraw it'}
            </button>
          </form>
        ) : null}
        <Notice state={withdrawState} />
      </section>
    </div>
  );
}
