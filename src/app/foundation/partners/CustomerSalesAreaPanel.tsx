'use client';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import { saveCustomerSalesAreaAction } from './customer-sales-area-actions';
export interface SalesAreaFields{deliveringPlant:string;pricingProcedure:string;salesDistrict:string;completeDelivery:boolean;orderCombination:boolean;isBlocked:boolean;version:number;salesStatus:string}
export function CustomerSalesAreaPanel({partner,area,initial,plants,editable}:{partner:string;area:{org:string;channel:string;division:string;name:string;organisation:string;companyCode:string;currency:string};initial:SalesAreaFields;plants:Array<{code:string;name:string}>;editable:boolean}){
  const [state,action,pending]=useActionState(saveCustomerSalesAreaAction,{ok:true});
  const areaLabel=`${area.org} / ${area.channel} / ${area.division}`;
  const status=t(`bp.status.${initial.isBlocked?'BLOCKED':initial.salesStatus}`);
  if(!editable)return <section className="panel p-4"><p>{t('auth.readOnly',{authority:'SALES.CUSTOMER.SALESAREA.MAINTAIN'})}</p><dl className="mt-3 grid gap-2 sm:grid-cols-3"><Value label={t('csa.area')} value={areaLabel}/><Value label={t('csa.plant')} value={initial.deliveringPlant||'—'}/><Value label={t('csa.procedure')} value={initial.pricingProcedure||'—'}/><Value label={t('csa.district')} value={initial.salesDistrict||'—'}/><Value label={t('csa.completeDelivery')} value={initial.completeDelivery?'✓':'—'}/><Value label={t('csa.status')} value={status}/></dl></section>;
  return <section className="panel p-4"><h2 className="panel-title mb-3">{t('csa.title')}</h2>{state.message&&<div role="status" className={`mb-3 border p-3 text-sm ${state.ok?'border-signal-ok/30 bg-signal-ok-soft text-signal-ok':'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}><p>{state.message}</p>{state.remedy&&<p>{state.remedy}</p>}</div>}
    <form key={initial.version} action={action} className="space-y-4"><input type="hidden" name="partnerNumber" value={partner}/><input type="hidden" name="salesOrg" value={area.org}/><input type="hidden" name="distributionChannel" value={area.channel}/><input type="hidden" name="division" value={area.division}/><input type="hidden" name="expectedVersion" value={state.version??initial.version}/>
      <div className="grid gap-3 sm:grid-cols-3"><Value label={t('csa.org')} value={`${area.org} · ${area.organisation}`}/><Value label={t('csa.company')} value={area.companyCode}/><Value label={t('sc.currency')} value={area.currency}/>
        <label><span className="field-label">{t('csa.plant')}</span><select name="deliveringPlant" defaultValue={initial.deliveringPlant} className="field-input"><option value="">{t('bp.notSet')}</option>{plants.map(row=><option key={row.code} value={row.code}>{row.code} · {row.name}</option>)}</select></label>
        <label><span className="field-label">{t('csa.procedure')}</span><input name="pricingProcedure" defaultValue={initial.pricingProcedure} maxLength={6} pattern="[A-Za-z0-9]{0,6}" className="field-input"/></label>
        <label><span className="field-label">{t('csa.district')}</span><input name="salesDistrict" defaultValue={initial.salesDistrict} maxLength={6} pattern="[A-Za-z0-9]{0,6}" className="field-input"/></label>
        <Value label={t('csa.status')} value={status}/>
      </div>
      <div className="flex flex-wrap gap-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" name="completeDelivery" defaultChecked={initial.completeDelivery} className="accent-accent"/>{t('csa.completeDelivery')}</label><label className="flex items-center gap-2"><input type="checkbox" name="orderCombination" defaultChecked={initial.orderCombination} className="accent-accent"/>{t('csa.orderCombination')}</label><label className="flex items-center gap-2"><input type="checkbox" name="isBlocked" defaultChecked={initial.isBlocked} className="accent-accent"/>{t('csa.blocked')}</label></div>
      <p className="text-2xs text-ink-soft">{t('csa.note')}</p><label className="block"><span className="field-label">{t('bp.reason')}</span><input name="reason" required minLength={3} maxLength={500} className="field-input"/></label><button className="btn btn-primary" disabled={pending}>{pending?t('common.saving'):t('common.save')}</button>
    </form>
  </section>;
}
function Value({label,value}:{label:string;value:string}){return <div><p className="field-label">{label}</p><p>{value}</p></div>;}
