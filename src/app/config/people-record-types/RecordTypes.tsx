'use client';

import Link from 'next/link';
import { useActionState, useId, useState } from 'react';

import type { RecordTypeDefinition } from '@/modules/people/record-types';
import {
  addRecordFieldAction,
  changeRecordFieldAction,
  changeRecordTypeAction,
  defineRecordTypeAction,
  type RecordTypeActionState,
} from './actions';

/** The state each form starts from. Kept here rather than imported from the actions module, because a
 * `use server` file may export async functions only — see the note beside the same constant there. */
const EMPTY: RecordTypeActionState = { ok: false };

interface Props {
  types: RecordTypeDefinition[];
  selected: RecordTypeDefinition | null;
  wanted: string;
  allowed: boolean;
}

function Notice({ state }: { state: RecordTypeActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
    </div>
  );
}

function KindChoices({ id, name }: { id: string; name: string }) {
  return (
    <select className="input mt-1" id={id} name={name} defaultValue="TEXT">
      <option value="TEXT">Text — words, up to 500 characters</option>
      <option value="NUMBER">Number — up to two decimals</option>
      <option value="DATE">Date — one day</option>
    </select>
  );
}

function DefineType() {
  const [state, action, pending] = useActionState(defineRecordTypeAction, EMPTY);
  const id = useId();
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Define record type">
      <p className="text-sm font-medium">Define a record type</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-code`}>
          Code (two to six capitals — the name a record is filed under)
          <input className="input mt-1" id={`${id}-code`} name="code" required maxLength={6} placeholder="PERSGR" autoComplete="off" />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-name`}>
          Name a payroll clerk would recognise
          <input className="input mt-1" id={`${id}-name`} name="name" required maxLength={60} placeholder="Personal data" autoComplete="off" />
        </label>
      </div>
      <label className="block text-xs text-ink-soft" htmlFor={`${id}-description`}>
        What it is for (optional — it is shown on the employee screen so the next clerk knows why the type exists)
        <input className="input mt-1" id={`${id}-description`} name="description" maxLength={200} autoComplete="off" />
      </label>
      <fieldset className="border-t border-line pt-3">
        <legend className="text-xs text-ink-faint">Its first field — the rest can be added once the type stands</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <label className="block text-xs text-ink-soft" htmlFor={`${id}-fcode`}>
            Field code
            <input className="input mt-1" id={`${id}-fcode`} name="fieldCode" required maxLength={30} placeholder="NACHN" autoComplete="off" />
          </label>
          <label className="block text-xs text-ink-soft" htmlFor={`${id}-flabel`}>
            Label the employee screen shows
            <input className="input mt-1" id={`${id}-flabel`} name="fieldLabel" required maxLength={60} placeholder="Last name" autoComplete="off" />
          </label>
          <label className="block text-xs text-ink-soft" htmlFor={`${id}-fkind`}>
            Kind of answer
            <KindChoices id={`${id}-fkind`} name="valueKind" />
          </label>
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm" htmlFor={`${id}-freq`}>
          <input className="h-4 w-4" id={`${id}-freq`} type="checkbox" name="fieldRequired" />
          A record of this type must answer it
        </label>
      </fieldset>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary min-h-11 sm:min-h-9" type="submit" disabled={pending}>
          {pending ? 'Defining…' : 'Define type'}
        </button>
        <span className="text-xs text-ink-faint">A type is retired, never deleted: no record of it can be lost by removing the definition.</span>
      </div>
      <Notice state={state} />
    </form>
  );
}

function TypeRow({ type, expandedId }: { type: RecordTypeDefinition; expandedId: string }) {
  const [state, action, pending] = useActionState(changeRecordTypeAction, EMPTY);
  const [adding, setAdding] = useState(false);
  const id = useId();
  const fieldsState = useActionState(addRecordFieldAction, EMPTY);
  return (
    <li className="border-t border-line py-2 text-sm first:border-t-0" id={expandedId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span>
          <Link className="link code" href={`/config/people-record-types?type=${type.code}`}>{type.code}</Link>
          {' '}· {type.name}
          {!type.isValid ? <span className="ml-2 text-xs text-ink-faint">retired</span> : null}
        </span>
        <span className="text-xs text-ink-faint">
          {type.fields.length} field{type.fields.length === 1 ? '' : 's'} · {type.recordsStanding} record{type.recordsStanding === 1 ? '' : 's'} standing
        </span>
      </div>
      {type.description ? <p className="mt-1 text-xs text-ink-soft">{type.description}</p> : null}
      <ul className="mt-2 space-y-1 text-xs">
        {type.fields.length === 0 ? <li className="text-ink-soft">No field is defined, so nothing can be recorded with this type.</li> : null}
        {type.fields.map((field) => (
          <FieldRow key={field.code} type={type} field={field} />
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {adding ? (
          <form action={fieldsState[1]} className="flex flex-wrap items-end gap-2" aria-label={`Add a field to ${type.code}`}>
            <input type="hidden" name="recordType" value={type.code} />
            <label className="block text-xs text-ink-soft">
              Code
              <input className="input mt-1 w-28 py-1 text-xs" name="fieldCode" required maxLength={30} />
            </label>
            <label className="block text-xs text-ink-soft">
              Label
              <input className="input mt-1 w-40 py-1 text-xs" name="fieldLabel" required maxLength={60} />
            </label>
            <label className="block text-xs text-ink-soft">
              Kind
              <span className="block"><KindChoices id={`${id}-add-kind`} name="valueKind" /></span>
            </label>
            <label className="flex items-center gap-1 pb-2 text-xs" htmlFor={`${id}-add-required`}>
              <input className="h-4 w-4" id={`${id}-add-required`} type="checkbox" name="fieldRequired" /> required
            </label>
            <button className="btn btn-primary min-h-11 px-2 text-xs sm:min-h-8" type="submit" disabled={fieldsState[2]}>
              {fieldsState[2] ? 'Adding…' : 'Add field'}
            </button>
            <button className="btn btn-default min-h-11 px-2 text-xs sm:min-h-8" type="button" onClick={() => setAdding(false)}>Cancel</button>
          </form>
        ) : (
          <>
            <button className="btn btn-default min-h-11 px-2 text-xs sm:min-h-8" type="button" onClick={() => setAdding(true)}>Add a field</button>
            <form action={action} className="flex items-center gap-2" aria-label={`Change ${type.code}`}>
              <input type="hidden" name="code" value={type.code} />
              {type.isValid ? (
                <button className="btn btn-default min-h-11 px-2 text-xs text-ink-soft sm:min-h-8" type="submit" disabled={pending} name="retire" value="1">
                  {pending ? 'Retiring…' : 'Retire type'}
                </button>
              ) : (
                <button className="btn btn-default min-h-11 px-2 text-xs sm:min-h-8" type="submit" disabled={pending} name="restore" value="1">
                  {pending ? 'Restoring…' : 'Restore type'}
                </button>
              )}
            </form>
          </>
        )}
      </div>
      {adding ? <Notice state={fieldsState[0]} /> : null}
      <Notice state={state} />
    </li>
  );
}

function FieldRow({ type, field }: { type: RecordTypeDefinition; field: RecordTypeDefinition['fields'][number] }) {
  const [state, action, pending] = useActionState(changeRecordFieldAction, EMPTY);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-l-2 border-line pl-2">
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="code">{field.code}</span>
        <span>{field.label}</span>
        <span className="text-ink-faint">{field.valueKind}</span>
        {field.isRequired ? <span className="text-ink-faint">required</span> : null}
        {field.valuesStanding > 0 ? (
          <span className="text-ink-faint">{field.valuesStanding} answered · kind fixed while any stand</span>
        ) : null}
      </span>
      <form action={action} className="flex items-center gap-2">
        <input type="hidden" name="recordType" value={type.code} />
        <input type="hidden" name="code" value={field.code} />
        <input type="hidden" name="label" value={field.label} />
        <button
          className="btn btn-default min-h-11 px-2 text-xs sm:min-h-8" type="submit" disabled={pending}
          name="required" value={field.isRequired ? '' : '1'}
          title={field.isRequired ? 'A record may leave this unanswered' : 'A record must answer this'}
        >
          {pending ? 'Saving…' : field.isRequired ? 'make optional' : 'make required'}
        </button>
      </form>
      <Notice state={state} />
    </li>
  );
}

export default function RecordTypes({ types, selected, wanted, allowed }: Props) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="space-y-4">
        {allowed ? <DefineType /> : (
          <p className="text-sm text-ink-soft">
            The registry is read-only for this session: defining a type needs CFG.PEOPLE.RECORDTYPE.DEFINE.
          </p>
        )}
        <section className="panel p-4" aria-label="Defined record types">
          <h2 className="text-sm font-semibold">Defined types ({types.length})</h2>
          {types.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">
              Nothing is defined yet, so no employee can hold a record. Define what the tenant keeps about a
              person — a family status, a bank detail, an address — as one type with its fields.
            </p>
          ) : (
            <ul className="mt-2">
              {types.map((type) => (
                <TypeRow key={type.code} type={type} expandedId={`type-${type.code}`} />
              ))}
            </ul>
          )}
        </section>
      </div>
      <div className="space-y-4">
        {wanted && !selected ? (
          <div className="panel panel-danger p-3 text-sm" role="status">
            <p className="font-medium">No record type “{wanted}” is defined in this tenant.</p>
            <p className="mt-1 text-ink-soft">Choose one of the types on the left, or define it.</p>
          </div>
        ) : null}
        {selected ? (
          <section className="panel space-y-2 p-4" aria-label="Selected record type">
            <h2 className="text-sm font-semibold">
              <span className="code">{selected.code}</span> · {selected.name}
            </h2>
            <p className="text-xs text-ink-soft">
              {selected.isValid ? 'Open for new records.' : 'Retired: no new record may be written, and every record already standing stays readable.'}
              {' '}{selected.recordsStanding} employee record{selected.recordsStanding === 1 ? '' : 's'} cite{selected.recordsStanding === 1 ? 's' : ''} this type
              {selected.recordsStanding > 0 ? ', so it cannot be removed — only retired.' : '.'}
            </p>
            <ul className="text-xs">
              {selected.fields.map((field) => (
                <li key={field.code} className="flex justify-between gap-2 border-t border-line py-1">
                  <span><span className="code">{field.code}</span> {field.label}</span>
                  <span className="text-ink-faint">{field.valueKind}{field.isRequired ? ' · required' : ''}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-ink-soft">
              On the employee screen these are the boxes a dated record fills;{' '}
              {selected.fields.filter((f) => f.isRequired).length} of them have to be answered for the record to stand.
            </p>
            <Link className="link text-xs" href={`/people/employees`}>Write a record of this type →</Link>
          </section>
        ) : (
          <p className="text-sm text-ink-soft">
            A field&apos;s kind cannot be changed once records answer it — the answer lives in the column its kind
            picks, and re-typing the field would strand what is already written. Add a field under a new code
            instead, and let the old one stand as history.
          </p>
        )}
      </div>
    </div>
  );
}
