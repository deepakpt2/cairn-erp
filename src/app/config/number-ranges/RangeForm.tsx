'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { formatNumber } from '@/platform/numbering/format';
import { adjustNumberRangeCurrentAction, saveNumberRange } from './actions';

export interface RangeDraft {
  objectCode: string; companyCode: string; subObject: string; fiscalYear: number;
  prefix: string; fromNumber: number; toNumber: number; currentNumber: number;
  numberLength: number; displayStyle: string; status: string;
  isExternal?: boolean; isBuffered?: boolean; bufferSize?: number;
}

export function RangeForm({ initial, companies, objects, editing }: {
  initial: RangeDraft;
  companies: Array<{ companyCode: string; name: string }>;
  objects: readonly string[];
  editing: boolean;
}) {
  const [state, action, pending] = useActionState(saveNumberRange, { ok: true });
  const [objectCode, setObjectCode] = useState(initial.objectCode);
  const [companyCode, setCompanyCode] = useState(initial.companyCode);
  const [prefix, setPrefix] = useState(initial.prefix);
  const [year, setYear] = useState(initial.fiscalYear);
  const [width, setWidth] = useState(initial.numberLength);
  const [style, setStyle] = useState(initial.displayStyle);
  const [from, setFrom] = useState(initial.fromNumber);
  const [buffered, setBuffered] = useState(false);
  const preview = formatNumber({ value: editing ? initial.currentNumber + 1 : from, prefix,
    fiscalYear: year || new Date().getUTCFullYear(), length: width, style });

  return <section className="panel p-4" aria-labelledby="range-form-title">
    <h2 id="range-form-title" className="panel-title mb-3">{t(editing ? 'nr.edit' : 'nr.create')}</h2>
    {state.message && <div role="status" className={`mb-3 border p-3 text-sm ${state.ok ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok' : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}>
      <p>{state.message}</p>{state.remedy && <p className="mt-1 text-ink-soft">{state.remedy}</p>}
      {state.ok && <Link className="mt-2 inline-block underline" href="/config/number-ranges">{t('nr.refresh')}</Link>}
    </div>}
    <form action={action} className="space-y-3">
      <input type="hidden" name="mode" value={editing ? 'CHANGE' : 'CREATE'} />
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label={t('nr.object')}>
          {editing ? <input name="objectCode" value={objectCode} readOnly className="field-input code bg-sunken" /> :
            <select name="objectCode" value={objectCode} className="field-input code" onChange={(e) => { setObjectCode(e.target.value); setCompanyCode(e.target.value === 'RF_BELEG' ? companies[0]?.companyCode ?? '' : '*'); }}>
              {objects.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>}
        </Field>
        <Field label={t('nr.scope')}>
          {editing || objectCode !== 'RF_BELEG' ? <input name="companyCode" value={companyCode} readOnly className="field-input code bg-sunken" /> :
            <select name="companyCode" value={companyCode} onChange={(e) => setCompanyCode(e.target.value)} className="field-input code" required>
              {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode} · {c.name}</option>)}
            </select>}
        </Field>
        <Field label={t('nr.subObject')}><input name="subObject" defaultValue={initial.subObject} readOnly={editing} required maxLength={24} pattern="[A-Z0-9_*.-]+" className="field-input code" /></Field>
        <Field label={t('nr.year')}><input name="fiscalYear" type="number" min={0} max={9999} value={year} readOnly={editing} required onChange={(e) => setYear(Number(e.target.value))} className="field-input tabular" /><p className="mt-1 text-2xs text-ink-faint">{t('nr.yearHint')}</p></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label={t('nr.from')}><input name="fromNumber" type="number" min={1} max={Number.MAX_SAFE_INTEGER} value={from} readOnly={editing} onChange={(e) => setFrom(Number(e.target.value))} required className="field-input tabular" /></Field>
        <Field label={t('nr.to')}><input name="toNumber" type="number" min={editing ? Math.max(from, initial.currentNumber) : from} max={Number.MAX_SAFE_INTEGER} defaultValue={initial.toNumber} required className="field-input tabular" /></Field>
        <Field label={t('nr.current')}><div className="field-input code bg-sunken" aria-readonly="true">{editing ? initial.currentNumber : '—'}</div><p className="mt-1 text-2xs text-ink-faint">{t('nr.currentHint')}</p></Field>
        <Field label={t('nr.status')}><select name="status" defaultValue={initial.status} className="field-input"><option value="ACTIVE">{t('nr.active')}</option><option value="BLOCKED">{t('nr.blocked')}</option></select></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label={t('nr.prefix')}><input name="prefix" maxLength={12} value={prefix} readOnly={editing} onChange={(e) => setPrefix(e.target.value)} className="field-input code" pattern="[A-Z0-9-]*" /></Field>
        <Field label={t('nr.width')}><input name="numberLength" type="number" min={1} max={16} value={width} readOnly={editing} onChange={(e) => setWidth(Number(e.target.value))} required className="field-input tabular" /></Field>
        <Field label={t('nr.style')}>{editing ? <input name="displayStyle" value={style} readOnly className="field-input code bg-sunken" /> : <select name="displayStyle" value={style} onChange={(e) => setStyle(e.target.value)} className="field-input"><option value="READABLE">{t('nr.readable')}</option><option value="CLASSIC">{t('nr.classic')}</option></select>}</Field>
        <Field label={t('nr.preview')}><output className="field-input code border-accent-line bg-accent-soft">{preview}</output></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label={t('nr.assignment')}>
          {editing ? <input value={initial.isExternal ? t('nr.assignmentExternal') : t('nr.assignmentInternal')} readOnly className="field-input bg-sunken" /> : (
            <select name="isExternal" className="field-input">
              <option value="">{t('nr.assignmentInternal')}</option>
              <option value="external">{t('nr.assignmentExternal')}</option>
            </select>
          )}
        </Field>
        <Field label={t('nr.buffered')}>
          {editing ? <input value={initial.isBuffered ? `${t('nr.buffered')} · ${initial.bufferSize ?? 0}` : '—'} readOnly className="field-input bg-sunken" /> : (
            <select name="isBuffered" className="field-input" onChange={(e) => setBuffered(e.target.value === 'buffered')}>
              <option value="">—</option>
              <option value="buffered">{t('nr.buffered')}</option>
            </select>
          )}
        </Field>
        {!editing && buffered && (
          <Field label={t('nr.bufferSize')}>
            <input name="bufferSize" type="number" min={1} max={100000} defaultValue={10} required className="field-input tabular" />
          </Field>
        )}
        {editing && (
          <>
            <input type="hidden" name="isExternal" value={initial.isExternal ? 'external' : ''} />
            <input type="hidden" name="isBuffered" value={initial.isBuffered ? 'buffered' : ''} />
            <input type="hidden" name="bufferSize" value={initial.bufferSize ?? 0} />
          </>
        )}
      </div>
      {!editing && buffered && <p className="text-2xs text-ink-soft">{t('nr.bufferedHint')}</p>}
      <Field label={t('nr.reason')}><input name="reason" required minLength={3} maxLength={500} defaultValue={editing ? '' : t('nr.initialReason')} className="field-input" /></Field>
      <p className="text-2xs text-ink-soft">{t('nr.safety')}</p>
      <div className="flex items-center gap-2"><button className="btn btn-primary" disabled={pending || (state.ok && !!state.key)}>{pending ? t('common.saving') : t('common.save')}</button><Link href="/config/number-ranges" className="btn btn-default">{t('common.cancel')}</Link></div>
    </form>
  </section>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="field-label">{label}</span>{children}</label>;
}

/** The guarded current-number act (SCR-050): its own form, its own reason. */
export function AdjustCurrentForm({ initial }: { initial: RangeDraft }) {
  const [state, action, pending] = useActionState(adjustNumberRangeCurrentAction, { ok: true });
  return (
    <section className="panel p-4" aria-labelledby="adjust-current-title">
      <h2 id="adjust-current-title" className="panel-title mb-3">{t('nr.adjustTitle')}</h2>
      <p className="mb-3 text-2xs text-ink-soft">{t('nr.adjustHint')}</p>
      {state.message && (
        <div role="status" className={`mb-3 border p-3 text-sm ${state.ok ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok' : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}>
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1 text-ink-soft">{state.remedy}</p>}
        </div>
      )}
      <form action={action} className="space-y-3">
        <input type="hidden" name="objectCode" value={initial.objectCode} />
        <input type="hidden" name="companyCode" value={initial.companyCode} />
        <input type="hidden" name="subObject" value={initial.subObject} />
        <input type="hidden" name="fiscalYear" value={initial.fiscalYear} />
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={t('nr.current')}>
            <input name="currentNumber" type="number" min={0} max={Number.MAX_SAFE_INTEGER} defaultValue={initial.currentNumber} required className="field-input tabular" />
          </Field>
          <div className="sm:col-span-3">
            <Field label={t('nr.reason')}>
              <input name="reason" required minLength={3} maxLength={500} className="field-input" />
            </Field>
          </div>
        </div>
        <button className="btn btn-primary" disabled={pending}>{pending ? t('common.saving') : t('nr.adjustSave')}</button>
      </form>
    </section>
  );
}
