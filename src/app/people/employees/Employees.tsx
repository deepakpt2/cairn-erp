'use client';

import Link from 'next/link';
import { useActionState, useId, useMemo, useState } from 'react';

import type { EmployeeView } from '@/modules/people/employee-master';
import type { RecordFieldDefinition, RecordTypeDefinition } from '@/modules/people/record-types';
import {
  changeEmployeeAction,
  changeRecordValuesAction,
  createEmployeeAction,
  createRecordAction,
  delimitRecordAction,
  type EmployeeActionState,
} from './actions';

const EMPTY: EmployeeActionState = { ok: false };

interface Props {
  employees: Array<Omit<EmployeeView, 'records'> & { recordCount: number }>;
  types: RecordTypeDefinition[];
  selected: EmployeeView | null;
  query: string;
  canCreateMaster: boolean;
  canMaintainRecords: boolean;
}

function Notice({ state }: { state: EmployeeActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.ok && state.personnelNumber ? (
        <p className="mt-2">
          <Link className="link" href={`/people/employees?employee=${state.personnelNumber}`}>
            Open {state.personnelNumber}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/** The field name a record answer arrives under: the type&apos;s configuration decides how it is stored. */
function fieldInputName(fieldCode: string): string {
  return `f_${fieldCode}`;
}

function FieldAnswer({ field, initial, idSuffix }: { field: RecordFieldDefinition; initial?: string; idSuffix: string }) {
  const id = useId();
  return (
    <label className="block text-xs text-ink-soft" htmlFor={`${id}-${idSuffix}-${field.code}`}>
      {field.label}
      {field.isRequired ? <span className="ml-1 text-ink-faint">required</span> : null}
      <input
        className="input mt-1"
        id={`${id}-${idSuffix}-${field.code}`}
        name={fieldInputName(field.code)}
        defaultValue={initial ?? ''}
        autoComplete="off"
        inputMode={field.valueKind === 'NUMBER' ? 'decimal' : undefined}
        placeholder={field.valueKind === 'DATE' ? '2026-10-28' : field.valueKind === 'NUMBER' ? '200000.00' : 'the answer as written'}
        maxLength={field.valueKind === 'TEXT' ? 500 : 60}
      />
    </label>
  );
}

function CreateEmployee({ allowed }: { allowed: boolean }) {
  const [state, action, pending] = useActionState(createEmployeeAction, EMPTY);
  const id = useId();
  if (!allowed) {
    return (
      <p className="text-sm text-ink-soft">
        The master is read-only for this session: writing it needs PEOPLE.EMPLOYEE.CREATE, and maintaining its
        records needs PEOPLE.RECORD.MAINTAIN.
      </p>
    );
  }
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Create employee">
      <p className="text-sm font-medium">Create an employee</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-number`}>
          Personnel number (yours to choose — no interval is drawn, so a payroll provider&apos;s numbering carries over)
          <input className="input mt-1" id={`${id}-number`} name="personnelNumber" required maxLength={20} autoComplete="off" />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-name`}>
          Name as the contract writes it
          <input className="input mt-1" id={`${id}-name`} name="fullName" required maxLength={60} autoComplete="off" />
        </label>
      </div>
      <input type="hidden" name="requestKey" value={`EMP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
      <div className="flex items-center gap-3">
        <button className="btn btn-primary min-h-11 sm:min-h-9" type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create employee'}
        </button>
        <span className="text-xs text-ink-faint">The employee is created in use, with no record yet.</span>
      </div>
      <Notice state={state} />
    </form>
  );
}

function ChangeMaster({ employee, allowed }: { employee: EmployeeView; allowed: boolean }) {
  const [state, action, pending] = useActionState(changeEmployeeAction, EMPTY);
  const id = useId();
  if (!allowed) return null;
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Change master data">
      <p className="text-sm font-medium">Change the master</p>
      <p className="text-xs text-ink-soft">
        Only the name and whether the number is in use. Employment data is a record: changing it there would
        rewrite a history, which this module does not do.
      </p>
      <input type="hidden" name="personnelNumber" value={employee.personnelNumber} />
      <label className="block max-w-xl text-xs text-ink-soft" htmlFor={`${id}-full`}>
        Name
        <input className="input mt-1" id={`${id}-full`} name="fullName" defaultValue={employee.fullName} maxLength={60} />
      </label>
      <label className="flex items-center gap-2 text-sm" htmlFor={`${id}-active`}>
        <input className="h-4 w-4" id={`${id}-active`} type="checkbox" name="isActive" defaultChecked={employee.isActive} />
        Personnel number in use
      </label>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary min-h-11 sm:min-h-9" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save master'}
        </button>
      </div>
      <Notice state={state} />
    </form>
  );
}

/** One record: its span, who wrote it, the answers it holds, and the two acts history leaves open. */
function RecordRow({
  employee, record, type, allowed,
}: {
  employee: EmployeeView; record: EmployeeView['records'][number]; type: RecordTypeDefinition | undefined; allowed: boolean;
}) {
  const [delimitState, delimitAction, delimitPending] = useActionState(delimitRecordAction, EMPTY);
  const [valuesState, valuesAction, valuesPending] = useActionState(changeRecordValuesAction, EMPTY);
  const [correcting, setCorrecting] = useState(false);
  const id = useId();
  const answered = new Map(record.values.map((v) => [v.fieldCode, v.value]));
  const openFields = (type?.fields ?? []).filter((f) => !record.values.some((v) => v.fieldCode === f.code));

  return (
    <li className="border-t border-line py-2 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span>
          <span className="font-medium">{record.validFrom}</span>
          <span className="text-ink-soft"> → </span>
          <span className="font-medium">{record.validTo ?? 'open'}</span>
          {record.isCurrent ? <span className="ml-2 code text-xs">current</span> : null}
        </span>
        <span className="text-xs text-ink-faint">written by {record.createdBy}</span>
      </div>
      <table className="mt-2 w-full text-xs">
        <tbody>
          {record.values.length === 0 ? (
            <tr><td className="py-1 text-ink-soft">This record holds no answer.</td></tr>
          ) : record.values.map((value) => (
            <tr key={value.fieldCode}>
              <td className="py-1 pr-2 text-ink-soft">{value.label}</td>
              <td className="py-1 font-medium">{value.value}</td>
              <td className="py-1 text-right text-ink-faint">{value.valueKind}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {allowed ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {record.isCurrent ? (
            <>
              <button
                className="btn btn-default min-h-11 px-2 text-xs sm:min-h-8"
                type="button"
                onClick={() => setCorrecting((now) => !now)}
              >
                {correcting ? 'Cancel correction' : 'Correct this record'}
              </button>
              <form action={delimitAction} className="flex items-center gap-2" aria-label="End record">
                <input type="hidden" name="personnelNumber" value={employee.personnelNumber} />
                <input type="hidden" name="recordType" value={record.recordType} />
                <input type="hidden" name="validFrom" value={record.validFrom} />
                <label className="text-xs text-ink-soft" htmlFor={`${id}-to`}>
                  ends on
                  <input className="input ml-1 w-32 py-1 text-xs" id={`${id}-to`} name="validTo" required placeholder="2026-10-31" />
                </label>
                <button className="btn btn-default min-h-11 px-2 text-xs sm:min-h-8" type="submit" disabled={delimitPending}>
                  {delimitPending ? 'Ending…' : 'End record'}
                </button>
              </form>
            </>
          ) : (
            <span className="text-xs text-ink-faint">
              Replaced by a newer record of this type — it stands as it was written and is not corrected in place.
            </span>
          )}
          <Notice state={delimitState} />
        </div>
      ) : null}
      {allowed && correcting && type ? (
        <form action={valuesAction} className="panel mt-2 space-y-3 p-3" aria-label="Correct record values">
          <input type="hidden" name="personnelNumber" value={employee.personnelNumber} />
          <input type="hidden" name="recordType" value={record.recordType} />
          <input type="hidden" name="validFrom" value={record.validFrom} />
          <div className="grid gap-3 sm:grid-cols-2">
            {type.fields.map((field) => (
              <FieldAnswer key={field.code} field={field} initial={answered.get(field.code)} idSuffix="edit" />
            ))}
          </div>
          {openFields.length > 0 ? (
            <p className="text-xs text-ink-soft">
              {openFields.map((f) => f.label).join(', ')} — the field the type has gained since this record was written; an answer
              may be added, and a value already given cannot be withdrawn.
            </p>
          ) : null}
          <div className="flex items-center gap-3">
            <button className="btn btn-primary min-h-11 px-3 text-sm sm:min-h-9" type="submit" disabled={valuesPending}>
              {valuesPending ? 'Saving…' : 'Save the answers'}
            </button>
            <span className="text-xs text-ink-faint">Leaving a box empty keeps the answer it holds today.</span>
          </div>
          <Notice state={valuesState} />
        </form>
      ) : null}
    </li>
  );
}

function NewRecord({
  employee, types, allowed,
}: { employee: EmployeeView; types: RecordTypeDefinition[]; allowed: boolean }) {
  const [state, action, pending] = useActionState(createRecordAction, EMPTY);
  const id = useId();
  const usable = useMemo(() => types.filter((t) => t.isValid), [types]);
  const [typeCode, setTypeCode] = useState(usable[0]?.code ?? '');
  const type = usable.find((t) => t.code === typeCode) ?? usable[0];
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  if (!allowed) {
    return (
      <p className="text-sm text-ink-soft">
        Records are read-only for this session: writing one needs PEOPLE.RECORD.MAINTAIN.
      </p>
    );
  }
  if (usable.length === 0) {
    return (
      <p className="text-sm text-ink-soft">
        No record type is defined, so nothing can be recorded about this employee. Define what the tenant keeps
        about a person on the record-type screen first.
      </p>
    );
  }
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Write a dated record">
      <p className="text-sm font-medium">Write a record</p>
      <input type="hidden" name="personnelNumber" value={employee.personnelNumber} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-type`}>
          Record type
          <select
            className="input mt-1" id={`${id}-type`} name="recordType" value={type?.code ?? ''}
            onChange={(event) => setTypeCode(event.target.value)}
          >
            {usable.map((t) => (
              <option key={t.code} value={t.code}>{t.code} — {t.name} ({t.fields.length} field{t.fields.length === 1 ? '' : 's'})</option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-from`}>
          Applies from (the day it becomes true; a change is a new record from its own day)
          <input className="input mt-1" id={`${id}-from`} name="validFrom" type="date" required defaultValue={today} />
        </label>
      </div>
      {type ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {type.fields.map((field) => (
            <FieldAnswer key={field.code} field={field} idSuffix="new" />
          ))}
        </div>
      ) : null}
      <input type="hidden" name="requestKey" value={`REC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
      <div className="flex items-center gap-3">
        <button className="btn btn-primary min-h-11 sm:min-h-9" type="submit" disabled={pending}>
          {pending ? 'Writing…' : 'Write record'}
        </button>
        <span className="text-xs text-ink-faint">
          Refused if another record of {type?.code ?? 'the type'} already covers that day — the record in the way has to be ended first.
        </span>
      </div>
      <Notice state={state} />
    </form>
  );
}

export default function Employees({
  employees, types, selected, query, canCreateMaster, canMaintainRecords,
}: Props) {
  const id = useId();
  const grouped = useMemo(() => {
    if (!selected) return [] as Array<{ type: RecordTypeDefinition | undefined; records: EmployeeView['records'] }>;
    const byType = new Map<string, EmployeeView['records']>();
    for (const record of selected.records) {
      const list = byType.get(record.recordType) ?? [];
      list.push(record);
      byType.set(record.recordType, list);
    }
    return [...byType.entries()].map(([code, records]) => ({
      type: types.find((t) => t.code === code),
      records,
    }));
  }, [selected, types]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
      <div className="space-y-4">
        <CreateEmployee allowed={canCreateMaster} />
        <section className="panel p-4" aria-label="Employees">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Employees ({employees.length})</h2>
            <form action="/people/employees" className="flex items-center gap-2" role="search">
              <label className="sr-only" htmlFor={`${id}-q`}>Search</label>
              <input className="input w-44 py-1 text-xs" id={`${id}-q`} name="q" defaultValue={query} placeholder="number or name" />
              <button className="btn btn-default min-h-11 px-3 text-xs sm:min-h-8" type="submit">Search</button>
            </form>
          </div>
          {employees.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">
              No employee of this tenant matches. A person is created once, then everything else about them
              arrives as a dated record.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-line text-sm">
              {employees.map((row) => (
                <li key={row.personnelNumber} className="flex items-baseline justify-between gap-2 py-1">
                  <Link className="link" href={`/people/employees?employee=${row.personnelNumber}`}>
                    <span className="code">{row.personnelNumber}</span> · {row.fullName}
                  </Link>
                  <span className="text-xs text-ink-faint">
                    {row.recordCount} record{row.recordCount === 1 ? '' : 's'}{row.isActive ? '' : ' · not in use'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="space-y-4">
        {selected ? (
          <>
            <section className="panel p-4" aria-label="Employee">
              <h2 className="text-lg font-semibold">
                <span className="code">{selected.personnelNumber}</span> · {selected.fullName}
              </h2>
              <p className="mt-1 text-xs text-ink-soft">
                {selected.isActive ? 'In use.' : 'The number is no longer in use; the records below keep standing as they were written.'}
                {' '}Created by {selected.createdBy}.
              </p>
            </section>
            <ChangeMaster employee={selected} allowed={canCreateMaster} />
            <NewRecord employee={selected} types={types} allowed={canMaintainRecords} />
            {grouped.length === 0 ? (
              <p className="text-sm text-ink-soft">This employee holds no record yet.</p>
            ) : grouped.map((group) => (
              <section className="panel p-4" key={group.type?.code ?? 'unknown'} aria-label={`${group.type?.name ?? 'Record'} records`}>
                <h3 className="text-sm font-semibold">
                  {group.type?.name ?? group.records[0]?.recordTypeName}
                  <span className="ml-2 code text-xs">{group.records[0]?.recordType}</span>
                  {group.type && !group.type.isValid ? <span className="ml-2 text-xs text-ink-faint">retired</span> : null}
                </h3>
                <ul className="mt-2 text-sm">
                  {group.records.map((record) => (
                    <RecordRow
                      key={`${record.recordType}-${record.validFrom}`}
                      employee={selected}
                      record={record}
                      type={group.type}
                      allowed={canMaintainRecords}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </>
        ) : (
          <p className="text-sm text-ink-soft">
            Pick an employee to read their records, or create one to begin. A record is written against the
            employee, so the person exists before anything can be known about them.
          </p>
        )}
      </div>
    </div>
  );
}
