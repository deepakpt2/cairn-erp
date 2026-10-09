'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { formatNumber } from '@/platform/numbering/format';
import { saveNumberRange } from './actions';

export interface RangeDraft {
  objectCode: string; companyCode: string; subObject: string; fiscalYear: number;
  prefix: string; fromNumber: number; toNumber: number; currentNumber: number;
  numberLength: number; displayStyle: string; status: string;
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
            <select name="objectCode" value={objectCode} className="field-input code" onChange={(e) => { setObjectCode(e.target.value); setCompanyCode(e.target.value === 'JOURNAL_ENTRY' ? companies[0]?.companyCode ?? '' : '*'); }}>
              {objects.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>}
        </Field>
        <Field label={t('nr.scope')}>
          {editing || objectCode !== 'JOURNAL_ENTRY' ? <input name="companyCode" value={companyCode} readOnly className="field-input code bg-sunken" /> :
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
      <Field label={t('nr.reason')}><input name="reason" required minLength={3} maxLength={500} defaultValue={editing ? '' : t('nr.initialReason')} className="field-input" /></Field>
      <p className="text-2xs text-ink-soft">{t('nr.safety')}</p>
      <div className="flex items-center gap-2"><button className="btn btn-primary" disabled={pending || (state.ok && !!state.key)}>{pending ? t('common.saving') : t('common.save')}</button><Link href="/config/number-ranges" className="btn btn-default">{t('common.cancel')}</Link></div>
    </form>
  </section>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="field-label">{label}</span>{children}</label>;
}
