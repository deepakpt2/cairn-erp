'use client';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import { saveCustomerCompanyAction } from './customer-company-actions';
export interface CompanyFields{reconciliationAccount:string;paymentTermsCode:string;isBlocked:boolean;version:number;companyStatus:string}
export function CustomerCompanyPanel({partner,company,initial,chart,currency,accounts,terms,editable}:{partner:string;company:string;initial:CompanyFields;chart:string;currency:string;accounts:Array<{number:string;name:string}>;terms:Array<{code:string;description:string}>;editable:boolean}){
  const [state,action,pending]=useActionState(saveCustomerCompanyAction,{ok:true});
  if(!editable)return <section className="panel p-4"><p>{t('auth.readOnly',{authority:'FIN.CUSTOMER.COMPANY.MAINTAIN'})}</p><dl className="mt-3 grid gap-2 sm:grid-cols-3"><Value label={t('custco.account')} value={initial.reconciliationAccount||'—'}/><Value label={t('sc.terms')} value={initial.paymentTermsCode||'—'}/><Value label={t('sc.chart')} value={chart}/><Value label={t('sc.currency')} value={currency}/><Value label={t('sc.status')} value={t(`bp.status.${initial.isBlocked?'BLOCKED':initial.companyStatus}`)}/></dl></section>;
  return <section className="panel p-4"><h2 className="panel-title mb-3">{t('custco.title')}</h2>{state.message&&<div role="status" className={`mb-3 border p-3 text-sm ${state.ok?'border-signal-ok/30 bg-signal-ok-soft text-signal-ok':'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}><p>{state.message}</p>{state.remedy&&<p>{state.remedy}</p>}</div>}
    <form key={initial.version} action={action} className="space-y-4"><input type="hidden" name="partnerNumber" value={partner}/><input type="hidden" name="companyCode" value={company}/><input type="hidden" name="expectedVersion" value={state.version??initial.version}/>
      <div className="grid gap-3 sm:grid-cols-3"><Value label={t('sc.company')} value={company}/><Value label={t('sc.chart')} value={chart}/><Value label={t('sc.currency')} value={currency}/>
        <label><span className="field-label">{t('custco.account')}</span><select name="reconciliationAccount" defaultValue={initial.reconciliationAccount} className="field-input"><option value="">{t('bp.notSet')}</option>{accounts.map(row=><option key={row.number} value={row.number}>{row.number} · {row.name}</option>)}</select></label>
        <label><span className="field-label">{t('sc.terms')}</span><select name="paymentTermsCode" defaultValue={initial.paymentTermsCode} className="field-input"><option value="">{t('bp.notSet')}</option>{terms.map(row=><option key={row.code} value={row.code}>{row.code} · {row.description}</option>)}</select></label>
        <Value label={t('sc.status')} value={t(`bp.status.${initial.isBlocked?'BLOCKED':initial.companyStatus}`)}/>
      </div><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isBlocked" defaultChecked={initial.isBlocked} className="accent-accent"/>{t('custco.blocked')}</label><p className="text-2xs text-ink-soft">{t('custco.note')}</p><label className="block"><span className="field-label">{t('bp.reason')}</span><input name="reason" required minLength={3} maxLength={500} className="field-input"/></label><button className="btn btn-primary" disabled={pending}>{pending?t('common.saving'):t('common.save')}</button>
    </form>
  </section>;
}
function Value({label,value}:{label:string;value:string}){return <div><p className="field-label">{label}</p><p>{value}</p></div>;}
