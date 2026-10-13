'use client';

import Link from 'next/link';
import { useState, useActionState } from 'react';
import { t } from '@/platform/i18n';
import { saveSalesOrgDefinitionAction, type SalesOrgMaintenanceActionState } from './actions';

export type SalesOrgDefinitionDraft = {
  salesOrg: string;
  name: string;
  formText: string;
  currency: string;
  factoryCalendar: string;
  addressNumber: string;
  country: string;
  purchasingOrganization: string;
  referenceSalesOrg: string;
  alePurchaseOrders: boolean;
  rebateProcessingActive: boolean;
  searchTerm1: string;
  searchTerm2: string;
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
  region: string;
  poBox: string;
  poBoxPostalCode: string;
  companyPostalCode: string;
  telephone: string;
  telephoneExtension: string;
  mobilePhone: string;
  faxNumber: string;
  faxExtension: string;
  emailAddress: string;
  intercompanyBillingCustomer: string;
  intercompanyBillingVendor: string;
};

type Choice = { code: string; name: string; displayCode?: string };
const emptyState: SalesOrgMaintenanceActionState = { ok: true };

function Field({ label, name, value, maxLength, required = false, readOnly = false, type = 'text' }: {
  label: string; name: string; value: string; maxLength: number; required?: boolean; readOnly?: boolean; type?: string;
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="field-label">{label}{required ? ' *' : ''}</span>
      <input
        className="field-input min-h-11 sm:min-h-0"
        type={type}
        name={name}
        defaultValue={value}
        maxLength={maxLength}
        required={required}
        readOnly={readOnly}
        aria-label={label}
      />
    </label>
  );
}

export function SalesOrgDefinitionForm({
  mode,
  initial,
  version,
  languageKey,
  currencies,
  countries,
  purchasingOrganizations,
  referenceSalesOrganizations,
  factoryCalendars,
  customers,
  vendors,
}: {
  mode: 'CREATE' | 'CHANGE';
  initial: SalesOrgDefinitionDraft;
  version: number;
  languageKey: string;
  currencies: Choice[];
  countries: Choice[];
  purchasingOrganizations: Choice[];
  referenceSalesOrganizations: Choice[];
  factoryCalendars: Choice[];
  customers: Choice[];
  vendors: Choice[];
}) {
  const [state, action, pending] = useActionState<SalesOrgMaintenanceActionState, FormData>(saveSalesOrgDefinitionAction, emptyState);
  const [addressDialogOpen, setAddressDialogOpen] = useState(false);
  const editing = mode === 'CHANGE';
  const savedCode = state.salesOrg ?? initial.salesOrg;
  const savedHref = `/config/sales-orgs?salesOrg=${encodeURIComponent(savedCode)}`;
  const labels = {
    salesOrg: t('salesOrg.code'),
    name: t('salesOrg.name'),
    formText: t('salesOrg.formText'),
    currency: t('salesOrg.currency'),
    country: t('salesOrg.country'),
    purchasingOrganization: t('salesOrg.purchasingOrganization'),
    referenceSalesOrg: t('salesOrg.referenceSalesOrg'),
    factoryCalendar: t('salesOrg.factoryCalendar'),
    alePurchaseOrders: t('salesOrg.alePurchaseOrders'),
    rebateProcessingActive: t('salesOrg.rebateProcessingActive'),
    searchTerm1: t('salesOrg.searchTerm1'),
    searchTerm2: t('salesOrg.searchTerm2'),
    street: t('salesOrg.street'),
    houseNumber: t('salesOrg.houseNumber'),
    postalCode: t('salesOrg.postalCode'),
    city: t('salesOrg.city'),
    region: t('salesOrg.region'),
    poBox: t('salesOrg.poBox'),
    poBoxPostalCode: t('salesOrg.poBoxPostalCode'),
    companyPostalCode: t('salesOrg.companyPostalCode'),
    telephone: t('salesOrg.telephone'),
    telephoneExtension: t('salesOrg.telephoneExtension'),
    mobilePhone: t('salesOrg.mobilePhone'),
    faxNumber: t('salesOrg.faxNumber'),
    faxExtension: t('salesOrg.faxExtension'),
    emailAddress: t('salesOrg.emailAddress'),
    intercompanyBillingCustomer: t('salesOrg.intercompanyBillingCustomer'),
    intercompanyBillingVendor: t('salesOrg.vendor'),
  };

  if (state.ok && state.message) {
    return (
      <section className="panel p-4">
        <p role="status" className="text-sm text-signal-ok">{state.message}</p>
        {state.addressNumber && <p className="mt-1 text-xs text-ink-soft">{t('salesOrg.addressNumber')}: <span className="code">{state.addressNumber}</span></p>}
        <div className="mt-3 flex gap-4 text-sm">
          <Link className="text-accent underline" href={savedHref}>{t('salesOrg.openSaved')}</Link>
          <Link className="text-accent underline" href="/config/sales-orgs">{t('salesOrg.backToOverview')}</Link>
        </div>
      </section>
    );
  }

  return (
    <form action={action} className="panel space-y-5 p-4 sm:p-5">
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="expectedVersion" value={version} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="panel-title">{editing ? t('salesOrg.changeTitle') : t('salesOrg.newTitle')}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t('salesOrg.assignmentSeparationNote')}</p>
        </div>
        <Link href="/config/sales-orgs" className="text-sm text-accent underline">{t('salesOrg.backToOverview')}</Link>
      </div>

      {state.message && (
        <div role={state.ok ? 'status' : 'alert'} className={`rounded border px-3 py-2 text-sm ${state.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
          <p>{state.message}</p>
          {!state.ok && state.remedy && <p className="mt-1 text-xs">{state.remedy}</p>}
        </div>
      )}

      <section className="grid gap-4 border-b border-line pb-5 sm:grid-cols-2">
        <label className="block space-y-1 text-sm">
          <span className="field-label">{labels.salesOrg} *</span>
          <input
            className="field-input min-h-11 font-mono uppercase sm:min-h-0"
            name="salesOrg"
            defaultValue={initial.salesOrg}
            maxLength={4}
            minLength={4}
            pattern="[A-Z0-9]{4}"
            required
            readOnly={editing}
            aria-label={labels.salesOrg}
            onChange={(event) => { event.currentTarget.value = event.currentTarget.value.toUpperCase(); }}
          />
        </label>
        <div className="space-y-1">
          <Field label={labels.name} name="name" value={initial.name} maxLength={35} required />
          <p className="text-xs text-ink-soft">{t('salesOrg.nameLanguageNote', { language: languageKey })}</p>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="field-label">{labels.currency}</span>
          <select className="field-input min-h-11 sm:min-h-0" name="currency" defaultValue={initial.currency} aria-label={labels.currency}>
            <option value="">{t('salesOrg.chooseCurrency')}</option>
            {currencies.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}
          </select>
          <span className="text-xs text-ink-soft">{t('salesOrg.currencyNote')}</span>
        </label>
        <div className="space-y-1">
          <Field label={labels.formText} name="formText" value={initial.formText} maxLength={12} />
          <p className="text-xs text-ink-soft">{t('salesOrg.formTextNote')}</p>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="field-label flex items-center gap-2">
            {labels.factoryCalendar}<span className="font-normal normal-case tracking-normal text-ink-faint">({t('salesOrg.optional')})</span>
          </span>
          <select className="field-input min-h-11 font-mono sm:min-h-0" name="factoryCalendar" defaultValue={initial.factoryCalendar} aria-label={labels.factoryCalendar}>
            <option value="">{t('salesOrg.noFactoryCalendar')}</option>
            {factoryCalendars.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}
          </select>
          <span className="text-xs text-ink-soft">{factoryCalendars.length ? t('salesOrg.factoryCalendarNote') : t('salesOrg.noFactoryCalendarData')}</span>
        </label>
        <label className="block space-y-1 text-sm">
          <span className="field-label flex items-center gap-2">
            {labels.purchasingOrganization}<span className="font-normal normal-case tracking-normal text-ink-faint">({t('salesOrg.optional')})</span>
          </span>
          <select className="field-input min-h-11 sm:min-h-0" name="purchasingOrganization" defaultValue={initial.purchasingOrganization} aria-label={labels.purchasingOrganization}>
            <option value="">{t('salesOrg.noPurchasingOrganization')}</option>
            {purchasingOrganizations.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span className="field-label flex items-center gap-2">
            {labels.intercompanyBillingVendor}<span className="font-normal normal-case tracking-normal text-ink-faint">({t('salesOrg.optional')})</span>
          </span>
          <select className="field-input min-h-11 sm:min-h-0" name="intercompanyBillingVendor" defaultValue={initial.intercompanyBillingVendor} aria-label={labels.intercompanyBillingVendor}>
            <option value="">{t('salesOrg.noVendor')}</option>
            {vendors.map((item) => <option key={item.code} value={item.code}>{item.displayCode ?? item.code} · {item.name}</option>)}
          </select>
          <span className="text-xs text-ink-soft">{t('salesOrg.vendorNote')}</span>
        </label>
        <label className="block space-y-1 text-sm">
          <span className="field-label flex items-center gap-2">
            {labels.referenceSalesOrg}<span className="font-normal normal-case tracking-normal text-ink-faint">({t('salesOrg.optional')})</span>
          </span>
          <select className="field-input min-h-11 sm:min-h-0" name="referenceSalesOrg" defaultValue={initial.referenceSalesOrg} aria-label={labels.referenceSalesOrg}>
            <option value="">{t('salesOrg.noReferenceSalesOrg')}</option>
            {referenceSalesOrganizations.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-3 border border-line bg-surface px-3 text-sm sm:min-h-0">
          <input type="checkbox" name="alePurchaseOrders" value="X" defaultChecked={initial.alePurchaseOrders} className="h-5 w-5 shrink-0" />
          <span className="font-medium">{labels.alePurchaseOrders}</span>
        </label>
        <label className="flex min-h-11 items-center gap-3 border border-line bg-surface px-3 text-sm sm:min-h-0">
          <input type="checkbox" name="rebateProcessingActive" value="X" defaultChecked={initial.rebateProcessingActive} className="h-5 w-5 shrink-0" />
          <span className="font-medium">{labels.rebateProcessingActive}</span>
        </label>
        <span className="text-xs text-ink-soft sm:col-span-2">{t('salesOrg.alePurchaseOrdersNote')}</span>
        <label className="block space-y-1 text-sm sm:col-span-2">
          <span className="field-label flex items-center gap-2">
            {labels.intercompanyBillingCustomer}<span className="font-normal normal-case tracking-normal text-ink-faint">({t('salesOrg.optional')})</span>
          </span>
          <select className="field-input min-h-11 sm:min-h-0" name="intercompanyBillingCustomer" defaultValue={initial.intercompanyBillingCustomer} aria-label={labels.intercompanyBillingCustomer}>
            <option value="">{t('salesOrg.noIntercompanyCustomer')}</option>
            {customers.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}
          </select>
          <span className="text-xs text-ink-soft">{t('salesOrg.intercompanyCustomerNote')}</span>
        </label>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold">{t('salesOrg.addressHeading')}</h3>
          <p className="text-xs text-ink-soft">{t('salesOrg.addressDialogNote')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 border border-line bg-surface px-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="field-label">{t('salesOrg.addressNumber')}</p>
            <p className="code text-sm">{initial.addressNumber || t('salesOrg.noAddressAssigned')}</p>
          </div>
          <button type="button" className="btn btn-default min-h-11 px-4 sm:min-h-0" onClick={() => setAddressDialogOpen(true)}>
            {initial.addressNumber ? t('salesOrg.changeAddress') : t('salesOrg.maintainAddress')}
          </button>
        </div>
        {/* B-157: the wrapper must be truly hidden when closed. The HTML `hidden`
            attribute loses to any author `display` utility (the closed overlay kept
            `display:flex` and intercepted every pointer event over the whole form — found
            by SCR-020 browser acceptance). The display class is conditional instead:
            display:none while closed, so nothing is clickable, while the dialog's inputs
            stay mounted so a captured address still submits with the form. */}
        <div
          className={addressDialogOpen ? 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6' : 'hidden'}
          aria-hidden={!addressDialogOpen}
        >
          <section role="dialog" aria-modal={addressDialogOpen} aria-labelledby="sales-org-address-dialog-title" className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-md border border-line bg-white p-4 shadow-xl sm:p-6">
            <div className="flex items-start justify-between gap-3 border-b border-line pb-3">
              <div>
                <h3 id="sales-org-address-dialog-title" className="text-lg font-semibold">{t('salesOrg.addressDialogTitle')}</h3>
                <p className="mt-1 text-xs text-ink-soft">{t('salesOrg.addressCountryRequiredNote')}</p>
              </div>
              <button type="button" className="btn btn-default min-h-11 px-3 sm:min-h-0" onClick={() => setAddressDialogOpen(false)}>{t('salesOrg.closeAddressDialog')}</button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block space-y-1 text-sm">
                <span className="field-label">{labels.country}</span>
                <select className="field-input min-h-11 sm:min-h-0" name="addressCountry" defaultValue={initial.country} aria-label={labels.country}>
                  <option value="">{t('salesOrg.chooseCountry')}</option>
                  {countries.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}
                </select>
              </label>
              <Field label={labels.searchTerm1} name="searchTerm1" value={initial.searchTerm1} maxLength={20} />
              <Field label={labels.searchTerm2} name="searchTerm2" value={initial.searchTerm2} maxLength={20} />
              <Field label={labels.street} name="street" value={initial.street} maxLength={60} />
              <Field label={labels.houseNumber} name="houseNumber" value={initial.houseNumber} maxLength={10} />
              <Field label={labels.postalCode} name="postalCode" value={initial.postalCode} maxLength={10} />
              <Field label={labels.city} name="city" value={initial.city} maxLength={40} />
              <Field label={labels.region} name="region" value={initial.region} maxLength={3} />
              <Field label={labels.poBox} name="poBox" value={initial.poBox} maxLength={10} />
              <Field label={labels.poBoxPostalCode} name="poBoxPostalCode" value={initial.poBoxPostalCode} maxLength={10} />
              <Field label={labels.companyPostalCode} name="companyPostalCode" value={initial.companyPostalCode} maxLength={10} />
              <Field label={labels.telephone} name="telephone" value={initial.telephone} maxLength={30} />
              <Field label={labels.telephoneExtension} name="telephoneExtension" value={initial.telephoneExtension} maxLength={10} />
              <Field label={labels.mobilePhone} name="mobilePhone" value={initial.mobilePhone} maxLength={30} />
              <Field label={labels.faxNumber} name="faxNumber" value={initial.faxNumber} maxLength={30} />
              <Field label={labels.faxExtension} name="faxExtension" value={initial.faxExtension} maxLength={10} />
              <Field label={labels.emailAddress} name="emailAddress" value={initial.emailAddress} maxLength={241} />
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              <button type="button" className="btn btn-default min-h-11 px-4 sm:min-h-0" onClick={() => setAddressDialogOpen(false)}>{t('salesOrg.closeAddressDialog')}</button>
            </div>
          </section>
        </div>
      </section>

      <label className="block space-y-1 text-sm">
        <span className="field-label">{t('salesOrg.changeReason')}</span>
        <input className="field-input min-h-11 sm:min-h-0" name="reason" maxLength={500} placeholder={t('salesOrg.changeReasonOptional')} />
      </label>
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        <button type="submit" className="btn btn-primary min-h-11 px-4 sm:min-h-0" disabled={pending}>{pending ? t('common.saving') : t('common.save')}</button>
        <Link href="/config/sales-orgs" className="btn btn-default min-h-11 px-4 sm:min-h-0">{t('common.cancel')}</Link>
      </div>
    </form>
  );
}
