'use client';
import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import { BASELINE_SOURCES } from '@/modules/foundation/payment-term-dates';
import type { PaymentTermValues } from '@/modules/foundation/payment-terms';
import { savePaymentTermAction } from './actions';
export function TermsForm({initial,version,creating}:{initial:PaymentTermValues;version:number;creating:boolean}){
  const [state,action,pending]=useActionState(savePaymentTermAction,{ok:true});
  const input=(name:keyof PaymentTermValues,label:string,type='text')=><label><span className="field-label">{t(label)}</span><input name={name} type={type} defaultValue={String(initial[name]??'')} className="field-input" min={type==='number'?0:undefined} max={type==='number'?3650:undefined} step={type==='number'?1:undefined} /></label>;
  return <section className="panel p-4"><h2 className="panel-title mb-3">{t(creating?'pt.create':'pt.edit')}</h2>
    {state.message&&<div role="status" className={`mb-3 border p-3 text-sm ${state.ok?'border-signal-ok/30 bg-signal-ok-soft text-signal-ok':'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}><p>{state.message}</p>{state.remedy&&<p>{state.remedy}</p>}{state.ok&&state.code&&<Link className="mt-2 inline-block underline" href={`/config/payment-terms?code=${encodeURIComponent(state.code)}`}>{t('pt.open')}</Link>}</div>}
    <form key={version} action={action} className="space-y-4">
      <input type="hidden" name="expectedVersion" value={creating?0:state.version??version} />
      <div className="grid gap-3 sm:grid-cols-3"><label><span className="field-label">{t('pt.code')}</span><input name="termsCode" defaultValue={initial.termsCode} readOnly={!creating} required maxLength={12} pattern="[A-Z0-9][A-Z0-9_-]*" onInput={(e)=>{e.currentTarget.value=e.currentTarget.value.toUpperCase();}} className="field-input code" /></label>
        <label><span className="field-label">{t('pt.baseline')}</span><select name="baselineSource" defaultValue={initial.baselineSource} className="field-input">{BASELINE_SOURCES.map((key)=><option key={key} value={key}>{t(`pt.baseline.${key}`)}</option>)}</select></label>
        {input('netDays','pt.netDays','number')}
      </div>
      <label className="block"><span className="field-label">{t('pt.description')}</span><input name="description" defaultValue={initial.description} required maxLength={160} className="field-input" /></label>
      <div className="grid gap-3 sm:grid-cols-4">{input('discount1Days','pt.discount1Days','number')}{input('discount1Percent','pt.discount1Percent')}{input('discount2Days','pt.discount2Days','number')}{input('discount2Percent','pt.discount2Percent')}</div>
      <p className="text-2xs text-ink-soft">{t('pt.discountHint')}</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isActive" defaultChecked={initial.isActive} className="accent-accent" />{t('pt.active')}</label>
      <label className="block"><span className="field-label">{t('pt.reason')}</span><input name="reason" required minLength={3} maxLength={500} className="field-input" /></label>
      <div className="flex gap-2"><button className="btn btn-primary" disabled={pending}>{pending?t('common.saving'):t('common.save')}</button><Link className="btn btn-default" href="/config/payment-terms">{t('common.cancel')}</Link></div>
    </form>
  </section>;
}
