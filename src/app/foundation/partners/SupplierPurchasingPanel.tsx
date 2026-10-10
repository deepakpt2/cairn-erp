'use client';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import { saveSupplierPurchasingAction } from './purchasing-actions';
export interface PurchasingFields{orderCurrency:string;purchasingGroup:string;incotermsCode:string;incotermsLocation:string;paymentTermsCode:string;isBlocked:boolean;version:number;purchasingStatus:string}
export function SupplierPurchasingPanel({partner,org,company,initial,currencies,groups,terms,deliveryCodes,editable}:{partner:string;org:string;company:string;initial:PurchasingFields;currencies:Array<{code:string;name:string}>;groups:Array<{code:string;name:string}>;terms:Array<{code:string;description:string}>;deliveryCodes:readonly string[];editable:boolean}){
  const [state,action,pending]=useActionState(saveSupplierPurchasingAction,{ok:true});
  const select=(name:keyof PurchasingFields,label:string,options:Array<{code:string;text:string}>)=><label><span className="field-label">{t(label)}</span><select name={name} defaultValue={String(initial[name])} className="field-input"><option value="">{t('bp.notSet')}</option>{options.map(row=><option key={row.code} value={row.code}>{row.code} · {row.text}</option>)}</select></label>;
  if(!editable)return <section className="panel p-4"><p>{t('auth.readOnly',{authority:'PROC.SUPPLIER.PURCHASING.MAINTAIN'})}</p><dl className="mt-3 grid gap-2 sm:grid-cols-3">{['orderCurrency','purchasingGroup','incotermsCode','incotermsLocation','paymentTermsCode'].map(key=><Value key={key} label={t(`sp.field.${key}`)} value={String(initial[key as keyof PurchasingFields]||'—')}/>)}</dl></section>;
  return <section className="panel p-4"><h2 className="panel-title mb-3">{t('sp.title')}</h2>{state.message&&<div role="status" className={`mb-3 border p-3 text-sm ${state.ok?'border-signal-ok/30 bg-signal-ok-soft text-signal-ok':'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}><p>{state.message}</p>{state.remedy&&<p>{state.remedy}</p>}</div>}
    <form key={initial.version} action={action} className="space-y-4"><input type="hidden" name="partnerNumber" value={partner}/><input type="hidden" name="purchasingOrg" value={org}/><input type="hidden" name="expectedVersion" value={state.version??initial.version}/>
      <div className="grid gap-3 sm:grid-cols-3"><Value label={t('sp.org')} value={org}/><Value label={t('sc.company')} value={company}/><Value label={t('sp.status')} value={t(`bp.status.${initial.isBlocked?'BLOCKED':initial.purchasingStatus}`)}/>
        {select('orderCurrency','sp.currency',currencies.map(row=>({code:row.code,text:row.name})))}{select('purchasingGroup','sp.group',groups.map(row=>({code:row.code,text:row.name})))}{select('paymentTermsCode','sp.terms',terms.map(row=>({code:row.code,text:row.description})))}
        {select('incotermsCode','sp.deliveryCode',deliveryCodes.map(code=>({code,text:code})))}<label className="sm:col-span-2"><span className="field-label">{t('sp.location')}</span><input name="incotermsLocation" defaultValue={initial.incotermsLocation} maxLength={160} className="field-input"/></label>
      </div><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isBlocked" defaultChecked={initial.isBlocked} className="accent-accent"/>{t('sp.blocked')}</label><p className="text-2xs text-ink-soft">{t('sp.note')}</p><label className="block"><span className="field-label">{t('bp.reason')}</span><input name="reason" required minLength={3} maxLength={500} className="field-input"/></label><button className="btn btn-primary" disabled={pending}>{pending?t('common.saving'):t('common.save')}</button>
    </form>
  </section>;
}
function Value({label,value}:{label:string;value:string}){return <div><p className="field-label">{label}</p><p>{value}</p></div>;}
