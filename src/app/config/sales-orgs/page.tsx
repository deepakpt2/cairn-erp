import Link from 'next/link';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { requireSession, can } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import { withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { country as countryReference, currency as currencyReference } from '@/platform/tables/reference';
import { businessPartner, bpRole } from '@/modules/foundation/business-partner-schema';
import { getSalesOrgDefinitionVersion } from '@/modules/foundation/sales-organization-maintenance';
import { centralAddress, factoryCalendar as factoryCalendarTable, purchasingOrg as purchasingOrgTable, salesOrg as salesOrgTable, salesOrgText } from '@/modules/foundation/schema';
import { t } from '@/platform/i18n';
import { SalesOrgDefinitionForm, type SalesOrgDefinitionDraft } from './SalesOrgDefinitionForm';
import { DeactivateSalesOrgForm } from './DeactivateSalesOrgForm';

export const dynamic = 'force-dynamic';
const SALES_ORG_DEFINE = 'CFG.ORG.SALESORG.DEFINE';
const SALES_ORG_ASSIGN_COMPANY = 'CFG.ORG.SALESORG.ASSIGN_COMPANY';
const SALES_ORG_ASSIGN_DISTCHANNEL = 'CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL';
const SALES_ORG_ASSIGN_DIVISION = 'CFG.ORG.SALESORG.ASSIGN_DIVISION';
const SALES_AREA_DEFINE = 'CFG.ORG.SALESAREA.DEFINE';
type PageParams = { new?: string; edit?: string; salesOrg?: string; history?: string; q?: string; copy?: string };

function detailHref(code: string) { return `/config/sales-orgs?salesOrg=${encodeURIComponent(code)}`; }
function editHref(code: string) { return `/config/sales-orgs?edit=${encodeURIComponent(code)}`; }
function historyHref(code: string) { return `/config/sales-orgs?salesOrg=${encodeURIComponent(code)}&history=1`; }
function copyHref(code: string) { return `/config/sales-orgs?new=1&copy=${encodeURIComponent(code)}`; }
function display(value: string | null | undefined) { return value?.trim() || '—'; }
function displayVendorId(value: string | null | undefined) {
  const code = value?.trim() ?? '';
  return /^[0-9]{1,10}$/.test(code) ? code.padStart(10, '0') : '—';
}

export default async function SalesOrgsPage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;
  const session = await requireSession('/config/sales-orgs');
  const client = session.user.client;
  const canMaintain = can(session, SALES_ORG_DEFINE);
  const canAssignCompany = can(session, SALES_ORG_ASSIGN_COMPANY);
  const canAssignDistributionChannel = can(session, SALES_ORG_ASSIGN_DISTCHANNEL);
  const canAssignDivision = can(session, SALES_ORG_ASSIGN_DIVISION);
  const canDefineSalesArea = can(session, SALES_AREA_DEFINE);
  const languageKey = session.user.logonLanguage ?? 'E';
  const organisationRows = await withTenant(client, (tx) => tx.select().from(salesOrgTable)
    .where(eq(salesOrgTable.client, client)).orderBy(asc(salesOrgTable.salesOrg)));
  const organisationCodes = organisationRows.map((row) => row.salesOrg.trim());
  const addressNumbers = organisationRows.map((row) => row.addressNumber?.trim() ?? '').filter(Boolean);
  const relatedRecords = await withTenant(client, async (tx) => {
    const [texts, addresses] = await Promise.all([
      organisationCodes.length ? tx.select().from(salesOrgText).where(and(
        eq(salesOrgText.client, client), inArray(salesOrgText.salesOrg, organisationCodes),
        inArray(salesOrgText.languageKey, [languageKey, 'E']),
      )) : Promise.resolve([]),
      addressNumbers.length ? tx.select().from(centralAddress).where(and(
        eq(centralAddress.client, client), inArray(centralAddress.addressNumber, addressNumbers),
      )) : Promise.resolve([]),
    ]);
    return { texts, addresses };
  });
  const organisations = organisationRows.map((row) => {
    const localText = relatedRecords.texts.find((text) => text.salesOrg.trim() === row.salesOrg.trim() && text.languageKey.trim() === languageKey);
    const englishText = relatedRecords.texts.find((text) => text.salesOrg.trim() === row.salesOrg.trim() && text.languageKey.trim() === 'E');
    const addressRecord = relatedRecords.addresses.find((address) => address.addressNumber.trim() === row.addressNumber?.trim());
    return {
      ...row,
      localizedText: localText,
      displayName: localText?.name.trim() || englishText?.name.trim() || row.salesOrg.trim(),
      addressRecord,
    };
  });

  const selectionRequested = Boolean(params.edit || params.salesOrg);
  const requestedCode = (params.edit ?? params.salesOrg)?.trim().toUpperCase() ?? '';
  const selected = selectionRequested ? organisations.find((item) => item.salesOrg === requestedCode) : undefined;
  const copying = canMaintain && !selectionRequested && Boolean(params.copy);
  const copySource = copying ? organisations.find((item) => item.salesOrg === params.copy?.trim().toUpperCase() && item.isActive) : undefined;
  const creating = canMaintain && !selectionRequested && (params.new === '1' || copying);
  const changeLock = selected && canMaintain
    ? await openChangeForSession(session, {
        lockObject: 'SALES_ORG',
        argument: selected.salesOrg,
        transactionCode: 'CFG.ORG.SALESORG.DEFINE',
      })
    : null;
  const editing = Boolean(params.edit && selected?.isActive && canMaintain && changeLock?.mode === 'CHANGE');
  const version = canMaintain && selected ? await getSalesOrgDefinitionVersion(client, selected.salesOrg) : 0;

  const emptyDraft: SalesOrgDefinitionDraft = {
    salesOrg: '', name: '', formText: 'STANDARD', currency: '', factoryCalendar: '', country: '', addressNumber: '',
    purchasingOrganization: '', referenceSalesOrg: '', alePurchaseOrders: false, rebateProcessingActive: false,
    searchTerm1: '', searchTerm2: '', street: '', houseNumber: '', postalCode: '', city: '', region: '', poBox: '',
    poBoxPostalCode: '', companyPostalCode: '', telephone: '', telephoneExtension: '', mobilePhone: '', faxNumber: '',
    faxExtension: '', emailAddress: '', intercompanyBillingCustomer: '', intercompanyBillingVendor: '',
  };
  const draftFromRecord = (record: typeof organisations[number]): SalesOrgDefinitionDraft => ({
    salesOrg: record.salesOrg.trim(), name: record.localizedText?.name.trim() ?? '',
    formText: record.localizedText?.formText?.trim() ?? '', currency: record.currency?.trim() ?? '',
    factoryCalendar: record.factoryCalendar?.trim() ?? '', country: record.addressRecord?.country.trim() ?? '',
    addressNumber: record.addressNumber?.trim() ?? '',
    purchasingOrganization: record.purchasingOrganization?.trim() ?? '',
    referenceSalesOrg: record.referenceSalesOrg?.trim() ?? '',
    alePurchaseOrders: record.alePurchaseOrders, rebateProcessingActive: record.rebateProcessingActive,
    searchTerm1: record.addressRecord?.searchTerm1 ?? '', searchTerm2: record.addressRecord?.searchTerm2 ?? '',
    street: record.addressRecord?.street ?? '', houseNumber: record.addressRecord?.houseNumber ?? '',
    postalCode: record.addressRecord?.postalCode ?? '', city: record.addressRecord?.city ?? '',
    region: record.addressRecord?.region ?? '', poBox: record.addressRecord?.poBox ?? '',
    poBoxPostalCode: record.addressRecord?.poBoxPostalCode ?? '', companyPostalCode: record.addressRecord?.companyPostalCode ?? '',
    telephone: record.addressRecord?.telephone ?? '', telephoneExtension: record.addressRecord?.telephoneExtension ?? '',
    mobilePhone: record.addressRecord?.mobilePhone ?? '', faxNumber: record.addressRecord?.faxNumber ?? '',
    faxExtension: record.addressRecord?.faxExtension ?? '', emailAddress: record.addressRecord?.emailAddress ?? '',
    intercompanyBillingCustomer: record.intercompanyBillingCustomer ?? '',
    intercompanyBillingVendor: record.intercompanyBillingVendor ?? '',
  });
  let initial = selected ? draftFromRecord(selected) : emptyDraft;
  if (copySource) {
    const copied = draftFromRecord(copySource);
    initial = { ...copied, salesOrg: '', formText: copied.formText || 'STANDARD', intercompanyBillingCustomer: '', intercompanyBillingVendor: '', addressNumber: '' };
  }

  const editChoices = canMaintain && (creating || editing);
  const currencies = editChoices
    ? await withTenant(client, async (tx) => tx.select({ code: currencyReference.code, name: currencyReference.name })
      .from(currencyReference).where(eq(currencyReference.isActive, true)).orderBy(asc(currencyReference.code)))
      .then((rows) => rows.map((row) => ({ ...row, code: row.code.trim() })))
    : [];
  const countries = editChoices
    ? await withTenant(client, async (tx) => tx.select({ code: countryReference.code, name: countryReference.name })
      .from(countryReference).orderBy(asc(countryReference.code)))
    : [];
  const purchasingOrganizations = editChoices
    ? await withTenant(client, async (tx) => tx.select({ code: purchasingOrgTable.purchasingOrg, name: purchasingOrgTable.name })
      .from(purchasingOrgTable).where(and(
        eq(purchasingOrgTable.client, client), eq(purchasingOrgTable.isActive, true),
      )).orderBy(asc(purchasingOrgTable.purchasingOrg)))
      .then((rows) => rows.filter((row) => /^[A-Z0-9]{4}$/.test(row.code.trim())).map((row) => ({ ...row, code: row.code.trim() })))
    : [];
  const factoryCalendars = editChoices
    ? await withTenant(client, async (tx) => tx.select({ code: factoryCalendarTable.calendarId, name: factoryCalendarTable.name })
      .from(factoryCalendarTable).where(and(
        eq(factoryCalendarTable.client, client), eq(factoryCalendarTable.isActive, true),
      )).orderBy(asc(factoryCalendarTable.calendarId)))
      .then((rows) => rows.map((row) => ({ ...row, code: row.code.trim() })))
    : [];
  const currentFactoryCalendar = selected?.factoryCalendar?.trim() ?? '';
  const factoryCalendarChoices = currentFactoryCalendar && !factoryCalendars.some((item) => item.code === currentFactoryCalendar)
    ? [...factoryCalendars, { code: currentFactoryCalendar, name: t('salesOrg.unavailableFactoryCalendar') }]
    : factoryCalendars;
  if (!selected && !copySource && factoryCalendars.some((item) => item.code === '01')) {
    initial = { ...initial, factoryCalendar: '01' };
  }
  const currentPurchasingOrganization = selected?.purchasingOrganization?.trim() ?? '';
  const purchasingOrganizationChoices = currentPurchasingOrganization && !purchasingOrganizations.some((item) => item.code === currentPurchasingOrganization)
    ? [...purchasingOrganizations, { code: currentPurchasingOrganization, name: t('salesOrg.unavailablePurchasingOrganization') }]
    : purchasingOrganizations;
  const referenceSalesOrganizations = editChoices
    ? organisations.filter((item) => item.isActive).map((item) => ({ code: item.salesOrg.trim(), name: item.displayName }))
    : [];
  const currentReferenceSalesOrg = selected?.referenceSalesOrg?.trim() ?? '';
  const referenceSalesOrganizationChoices = currentReferenceSalesOrg && !referenceSalesOrganizations.some((item) => item.code === currentReferenceSalesOrg)
    ? [...referenceSalesOrganizations, { code: currentReferenceSalesOrg, name: t('salesOrg.unavailableReferenceSalesOrg') }]
    : referenceSalesOrganizations;
  const customers = editChoices
    ? await withTenant(client, async (tx) => tx.select({ code: businessPartner.partnerNumber, name: businessPartner.name })
      .from(businessPartner).innerJoin(bpRole, and(
        eq(bpRole.client, businessPartner.client), eq(bpRole.partnerNumber, businessPartner.partnerNumber),
        eq(bpRole.roleCode, 'CUSTOMER'), eq(bpRole.isActive, true),
      )).where(and(eq(businessPartner.client, client), eq(businessPartner.isBlocked, false))).orderBy(asc(businessPartner.partnerNumber)))
      .then((rows) => rows.filter((row) => row.code.length <= 10))
    : [];
  const vendors = editChoices
    ? await withTenant(client, async (tx) => tx.select({ code: businessPartner.partnerNumber, name: businessPartner.name })
      .from(businessPartner).innerJoin(bpRole, and(
        eq(bpRole.client, businessPartner.client), eq(bpRole.partnerNumber, businessPartner.partnerNumber),
        eq(bpRole.roleCode, 'SUPPLIER'), eq(bpRole.isActive, true),
      )).where(and(eq(businessPartner.client, client), eq(businessPartner.isBlocked, false))).orderBy(asc(businessPartner.partnerNumber)))
      .then((rows) => rows.filter((row) => /^[0-9]{1,10}$/.test(row.code.trim())).map((row) => {
        const code = row.code.trim();
        return { code, name: row.name, displayCode: code.padStart(10, '0') };
      }))
    : [];
  const currentCustomer = selected?.intercompanyBillingCustomer?.trim() ?? '';
  const customerChoices = currentCustomer && !customers.some((item) => item.code === currentCustomer)
    ? [...customers, { code: currentCustomer, name: t('salesOrg.unavailableCustomer') }]
    : customers;
  const currentVendor = selected?.intercompanyBillingVendor?.trim() ?? '';
  const vendorChoices = currentVendor && !vendors.some((item) => item.code === currentVendor)
    ? [...vendors, {
      code: currentVendor,
      name: t('salesOrg.unavailableVendor'),
      displayCode: /^[0-9]{1,10}$/.test(currentVendor) ? currentVendor.padStart(10, '0') : currentVendor,
    }]
    : vendors;
  const history = selected && params.history === '1'
    ? await withTenant(client, (tx) => changeHistory(tx, client, 'sales_org', selected.salesOrg))
    : [];
  const search = params.q?.trim().toLocaleLowerCase() ?? '';
  const visibleOrganisations = organisations.filter((item) => !search || `${item.salesOrg} ${item.displayName}`.toLocaleLowerCase().includes(search));

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:p-6">
      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm">
        <header className="flex min-h-16 items-center gap-2 border-b border-[#9eb6c8] bg-[#c9dce9] px-3 py-2 text-[#28445b] sm:gap-3 sm:px-4">
          <Link href="/config" aria-label={t('nav.workbench')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#b5cddd] text-xl hover:bg-[#a9c3d5] sm:h-9 sm:w-9">‹</Link>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#2d708b] font-bold tracking-tight text-white shadow-sm sm:h-8 sm:w-8" aria-label={t('app.name')}>C</span>
          <h1 className="min-w-0 flex-1 text-center text-sm font-semibold leading-tight sm:text-base">{t('salesOrg.screenTitle')}</h1>
          <Link href="/config" className="hidden shrink-0 text-xs text-[#28445b] underline sm:inline">{t('nav.workbench')}</Link>
        </header>
        <div className="flex flex-wrap items-center gap-2 border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:py-2">
          {canMaintain && <Link href="/config/sales-orgs?new=1" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('salesOrg.newEntries')}</Link>}
          {canAssignCompany && <Link href="/config/sales-orgs/assign-company" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('salesOrg.assignCompanyCode')}</Link>}
          {canAssignDistributionChannel && <Link href="/config/sales-orgs/assign-distribution-channel" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('salesOrgChannel.navLink')}</Link>}
          {canAssignDivision && <Link href="/config/sales-orgs/assign-division" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('salesOrgDivision.navLink')}</Link>}
          {canDefineSalesArea && <Link href="/config/sales-areas" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('salesArea.navLink')}</Link>}
          <form action="/config/sales-orgs" className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
            <input className="field-input h-11 min-w-0 flex-1 sm:h-8 sm:w-52 sm:flex-none" name="q" defaultValue={params.q ?? ''} placeholder={t('salesOrg.findPlaceholder')} aria-label={t('salesOrg.findPlaceholder')} />
            <button type="submit" className="btn btn-default h-11 shrink-0 sm:h-8">{t('salesOrg.find')}</button>
          </form>
        </div>
        <div className="border-b border-[#cbd5de] px-4 py-3 text-sm font-semibold text-[#334f65]">{t('salesOrg.tableHeading')}</div>
        {!canMaintain && <p role="status" className="border-b border-[#cbd5de] px-4 py-2 text-sm text-ink-soft">{t('auth.readOnly', { authority: SALES_ORG_DEFINE })}</p>}
        <div className="divide-y divide-[#d6dce1] sm:hidden" role="list" aria-label={t('salesOrg.tableHeading')}>
          {visibleOrganisations.map((item) => (
            <article key={item.salesOrg} role="listitem" className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link className="font-mono font-semibold text-accent underline" href={detailHref(item.salesOrg.trim())}>{item.salesOrg.trim()}</Link>
                    <span className={`chip ${item.isActive ? 'chip-ok' : 'chip-neutral'}`}>{t(item.isActive ? 'salesOrg.active' : 'salesOrg.inactive')}</span>
                  </div>
                  <p className="mt-1 break-words text-sm font-medium text-[#263b4d]">{item.displayName}</p>
                </div>
                <div className="flex shrink-0 flex-col gap-2">
                  <Link className="inline-flex min-h-11 items-center justify-center rounded border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd]" href={detailHref(item.salesOrg.trim())}>{t('salesOrg.open')}</Link>
                  {canMaintain && item.isActive && <Link className="inline-flex min-h-11 items-center justify-center rounded border border-[#8faabd] bg-white px-3 text-sm text-[#264e6b] hover:bg-[#f8fbfd]" href={copyHref(item.salesOrg.trim())}>{t('salesOrg.copy')}</Link>}
                </div>
              </div>
            </article>
          ))}
          {visibleOrganisations.length === 0 && <p role="status" className="px-4 py-8 text-center text-sm text-ink-soft">{search ? t('salesOrg.noSearchResults') : t('salesOrg.empty')}</p>}
        </div>
        <div className="hidden overflow-x-auto sm:block">
          <table className="min-w-full border-collapse text-sm" aria-label={t('salesOrg.tableHeading')}>
            <thead className="bg-[#eef1f4] text-[#33414c]"><tr className="border-y border-[#c4ccd2]">
              <th className="w-36 border-r border-[#cbd1d6] px-2 py-2 text-left">{t('salesOrg.codeShort')}</th>
              <th className="px-3 py-2 text-left">{t('salesOrg.name')}</th>
              <th className="w-32 px-3 py-2 text-end">{t('common.actions')}</th>
            </tr></thead>
            <tbody>
              {visibleOrganisations.map((item) => (
                <tr key={item.salesOrg} className="border-b border-[#d6dce1] hover:bg-[#f8fbfd]">
                  <td className="border-r border-[#e1e5e8] px-2 py-2 font-mono"><Link className="text-accent underline" href={detailHref(item.salesOrg.trim())}>{item.salesOrg.trim()}</Link>{!item.isActive && <span className="ms-2 text-xs text-ink-faint">{t('salesOrg.inactive')}</span>}</td>
                  <td className="px-3 py-2">{item.displayName}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-end"><Link className="text-accent underline" href={detailHref(item.salesOrg.trim())}>{t('salesOrg.open')}</Link>{canMaintain && item.isActive && <Link className="ms-3 text-accent underline" href={copyHref(item.salesOrg.trim())}>{t('salesOrg.copy')}</Link>}</td>
                </tr>
              ))}
              {visibleOrganisations.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-sm text-ink-soft">{search ? t('salesOrg.noSearchResults') : t('salesOrg.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex flex-col gap-1 border-t border-[#cbd5de] bg-[#f7f9fb] px-3 py-3 text-xs text-ink-soft sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <span>{t('salesOrg.retentionNote')}</span><span className="tabular">{visibleOrganisations.length}</span>
        </div>
      </section>

      {changeLock?.mode === 'CHANGE' && selected && (
        <ChangeLock lockObject="SALES_ORG" argument={selected.salesOrg} />
      )}
      <LockNotice message={changeLock?.mode === 'DISPLAY' ? displayOnlyMessage(changeLock) : null} />
      {creating && <SalesOrgDefinitionForm key="CREATE:new" mode="CREATE" initial={initial} version={0} languageKey={languageKey} currencies={currencies} countries={countries} purchasingOrganizations={purchasingOrganizationChoices} referenceSalesOrganizations={referenceSalesOrganizationChoices} factoryCalendars={factoryCalendarChoices} customers={customerChoices} vendors={vendorChoices} />}
      {editing && selected && <SalesOrgDefinitionForm key={`CHANGE:${selected.salesOrg}`} mode="CHANGE" initial={initial} version={version} languageKey={languageKey} currencies={currencies} countries={countries} purchasingOrganizations={purchasingOrganizationChoices} referenceSalesOrganizations={referenceSalesOrganizationChoices} factoryCalendars={factoryCalendarChoices} customers={customerChoices} vendors={vendorChoices} />}

      {selectionRequested && !selected && (
        <section className="panel p-4"><p role="status" className="text-sm text-signal-error">{t('salesOrg.notFound')}</p><Link className="mt-2 inline-block text-sm text-accent underline" href="/config/sales-orgs">{t('salesOrg.backToOverview')}</Link></section>
      )}

      {selected && !editing && (
        <section className="panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="panel-title">{t('salesOrg.detail')} · <span className="code">{selected.salesOrg.trim()}</span></h2><p className="mt-1 text-sm text-ink-soft">{selected.displayName}</p></div>
            <div className="flex flex-wrap gap-3 text-sm">
              <Link className="text-accent underline" href="/config/sales-orgs">{t('salesOrg.backToOverview')}</Link>
              {canMaintain && selected.isActive && <Link className="text-accent underline" href={editHref(selected.salesOrg.trim())}>{t('common.change')}</Link>}
              <Link className="text-accent underline" href={historyHref(selected.salesOrg.trim())}>{t('salesOrg.history')}</Link>
            </div>
          </div>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="field-label">{t('salesOrg.name')}</dt><dd>{selected.displayName}</dd></div>
            <div><dt className="field-label">{t('salesOrg.status')}</dt><dd><span className={`chip ${selected.isActive ? 'chip-ok' : 'chip-neutral'}`}>{t(selected.isActive ? 'salesOrg.active' : 'salesOrg.inactive')}</span></dd></div>
            <div><dt className="field-label">{t('salesOrg.assignedCompanyCode')}</dt><dd className="code">{display(selected.companyCode)}</dd></div>
            <div><dt className="field-label">{t('salesOrg.currency')}</dt><dd className="code">{display(selected.currency)}</dd></div>
            <div><dt className="field-label">{t('salesOrg.formText')}</dt><dd className="code">{display(selected.localizedText?.formText)}</dd></div>
            <div><dt className="field-label">{t('salesOrg.factoryCalendar')}</dt><dd className="code">{display(selected.factoryCalendar)}</dd></div>
            <div><dt className="field-label">{t('salesOrg.addressNumber')}</dt><dd className="code">{display(selected.addressNumber)}</dd></div>
            <div><dt className="field-label">{t('salesOrg.purchasingOrganization')}</dt><dd className="code">{display(selected.purchasingOrganization)}</dd></div>
            <div><dt className="field-label">{t('salesOrg.referenceSalesOrg')}</dt><dd className="code">{display(selected.referenceSalesOrg)}</dd></div>
            <div><dt className="field-label">{t('salesOrg.vendor')}</dt><dd className="code">{displayVendorId(selected.intercompanyBillingVendor)}</dd></div>
            <div><dt className="field-label">{t('salesOrg.rebateProcessingActive')}</dt><dd>{t(selected.rebateProcessingActive ? 'common.yes' : 'common.no')}</dd></div>
            <div><dt className="field-label">{t('salesOrg.alePurchaseOrders')}</dt><dd>{t(selected.alePurchaseOrders ? 'common.yes' : 'common.no')}</dd></div>
            <div><dt className="field-label">{t('salesOrg.intercompanyBillingCustomer')}</dt><dd className="code">{display(selected.intercompanyBillingCustomer)}</dd></div>
            {canMaintain && <div><dt className="field-label">{t('salesOrg.version')}</dt><dd className="tabular">{version}</dd></div>}
          </dl>
          <section className="mt-4 border-t border-line pt-3">
            <h3 className="text-sm font-semibold">{t('salesOrg.addressHeading')}</h3>
            <dl className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[
                [t('salesOrg.country'), selected.addressRecord?.country],
                [t('salesOrg.searchTerm1'), selected.addressRecord?.searchTerm1], [t('salesOrg.searchTerm2'), selected.addressRecord?.searchTerm2],
                [t('salesOrg.street'), selected.addressRecord?.street], [t('salesOrg.houseNumber'), selected.addressRecord?.houseNumber],
                [t('salesOrg.postalCode'), selected.addressRecord?.postalCode], [t('salesOrg.city'), selected.addressRecord?.city],
                [t('salesOrg.region'), selected.addressRecord?.region], [t('salesOrg.poBox'), selected.addressRecord?.poBox],
                [t('salesOrg.poBoxPostalCode'), selected.addressRecord?.poBoxPostalCode], [t('salesOrg.companyPostalCode'), selected.addressRecord?.companyPostalCode],
                [t('salesOrg.telephone'), selected.addressRecord?.telephone], [t('salesOrg.telephoneExtension'), selected.addressRecord?.telephoneExtension],
                [t('salesOrg.mobilePhone'), selected.addressRecord?.mobilePhone], [t('salesOrg.faxNumber'), selected.addressRecord?.faxNumber],
                [t('salesOrg.faxExtension'), selected.addressRecord?.faxExtension], [t('salesOrg.emailAddress'), selected.addressRecord?.emailAddress],
              ].map(([label, value]) => <div key={label}><dt className="field-label">{label}</dt><dd>{display(value as string | null)}</dd></div>)}
            </dl>
          </section>
          {!selected.isActive && <p className="mt-3 text-xs text-ink-soft">{t('salesOrg.inactiveRetained')}</p>}
        </section>
      )}

      {selected && !editing && canMaintain && changeLock?.mode === 'CHANGE' && <DeactivateSalesOrgForm salesOrg={selected.salesOrg.trim()} name={selected.displayName} version={version} isActive={selected.isActive} />}
      {selected && params.history === '1' && (
        <section className="panel overflow-x-auto">
          <div className="panel-header"><h2 className="panel-title">{t('salesOrg.history')} · <span className="code">{selected.salesOrg.trim()}</span></h2></div>
          {history.map((entry) => <article key={entry.id} className="break-words border-b border-line p-3 text-sm">
            <p className="break-all font-medium text-xs sm:break-words sm:text-sm">{entry.changedAt.toISOString()} · {entry.changedBy} · {entry.changeType}</p>
            {entry.reason && <p className="text-ink-soft">{entry.reason}</p>}
            <ul className="mt-1 text-2xs text-ink-soft">{entry.items.map((item) => <li key={item.id}>{item.fieldLabel}: {item.oldValue ?? '—'} → {item.newValue ?? '—'}</li>)}</ul>
          </article>)}
          {!history.length && <p className="p-3 text-sm text-ink-soft">{t('salesOrg.noHistory')}</p>}
        </section>
      )}
    </div>
  );
}
