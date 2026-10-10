'use client';
import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import type { PartnerInput } from '@/modules/foundation/business-partners';
import { savePartnerAction } from './actions';
export type PartnerDraft=Omit<PartnerInput,'client'|'changedBy'|'expectedVersion'|'reason'>;
export function PartnerForm({initial,version,creating,countries}:{initial:PartnerDraft;version:number;creating:boolean;countries:Array<{code:string;name:string}>}){
  const [state,action,pending]=useActionState(savePartnerAction,{ok:true});
  const field=(name:keyof PartnerDraft,label:string,maxLength:number,type='text')=><label><span className="field-label">{t(label)}</span><input name={name} defaultValue={String(initial[name]??'')} maxLength={maxLength} type={type} className="field-input" /></label>;
  return <section className="panel p-4"><h2 className="panel-title mb-3">{t('bp.general')}</h2>
    {state.message&&<div role="status" className={`mb-3 border p-3 text-sm ${state.ok?'border-signal-ok/30 bg-signal-ok-soft text-signal-ok':'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}><p>{state.message}</p>{state.remedy&&<p>{state.remedy}</p>}{state.ok&&state.number&&<Link className="mt-2 inline-block underline" href={`/foundation/partners?partner=${encodeURIComponent(state.number)}`}>{t('bp.open')}</Link>}</div>}
    <form key={version} action={action} className="space-y-4">
      <input type="hidden" name="expectedVersion" value={creating?0:state.version??version}/>
      <div className="grid gap-3 sm:grid-cols-3"><label><span className="field-label">{t('bp.number')}</span><input name="partnerNumber" defaultValue={initial.partnerNumber} readOnly={!creating} required maxLength={40} pattern="[A-Z0-9][A-Z0-9_.-]*" onInput={(e)=>{e.currentTarget.value=e.currentTarget.value.toUpperCase();}} className="field-input code" /></label>
        <label><span className="field-label">{t('bp.category')}</span>{creating?<select name="category" defaultValue={initial.category} className="field-input"><option value="ORGANIZATION">{t('bp.category.ORGANIZATION')}</option><option value="PERSON">{t('bp.category.PERSON')}</option></select>:<input name="category" value={initial.category} readOnly className="field-input code bg-sunken"/>}</label>
        {field('searchTerm','bp.searchTerm',40)}
        {field('name','bp.name',160)}{field('name2','bp.name2',160)}
      </div>
      <fieldset className="flex flex-wrap gap-4"><legend className="field-label">{t('bp.roles')}</legend>{(['SUPPLIER','CUSTOMER'] as const).map((role)=><label key={role} className="flex items-center gap-2 text-sm"><input type="checkbox" name="roles" value={role} defaultChecked={initial.roles.includes(role)} className="accent-accent"/>{t(`bp.role.${role}`)}</label>)}</fieldset>
      <div className="grid gap-3 sm:grid-cols-3"><label><span className="field-label">{t('bp.country')}</span><select name="country" defaultValue={initial.country} className="field-input"><option value="">{t('bp.notSet')}</option>{countries.map((c)=><option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}</select></label>{field('region','bp.region',80)}{field('city','bp.city',100)}{field('street','bp.street',180)}{field('postalCode','bp.postalCode',20)}{field('taxNumber','bp.taxNumber',40)}{field('email','bp.email',254,'email')}{field('phone','bp.phone',40)}</div>
      <label className="flex items-center gap-2 text-sm"><input name="isBlocked" type="checkbox" defaultChecked={initial.isBlocked} className="accent-accent"/>{t('bp.blocked')}</label>
      <p className="text-2xs text-ink-soft">{t('bp.stagedNote')}</p>
      <label className="block"><span className="field-label">{t('bp.reason')}</span><input name="reason" required minLength={3} maxLength={500} className="field-input"/></label>
      <div className="flex gap-2"><button className="btn btn-primary" disabled={pending}>{pending?t('common.saving'):t('common.save')}</button><Link className="btn btn-default" href="/foundation/partners">{t('common.cancel')}</Link></div>
    </form>
  </section>;
}
