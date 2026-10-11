/** Real write actions, with only request/session and framework cache mocked. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SessionContext } from '@/platform/auth/session';
import { createTenant, destroyTenant, withTenant, closeDb, type TestTenant } from './helpers';
import { maintainNumberRange, listNumberRanges } from '@/modules/foundation/number-ranges';

const request = vi.hoisted(() => ({ session: null as SessionContext | null }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/platform/auth/current', async (original) => {
  const actual = await original<typeof import('@/platform/auth/current')>();
  return { ...actual, requireSession: vi.fn(async () => {
    if (!request.session) throw new Error('AUTH_REDIRECT');
    return request.session;
  }) };
});
import { savePeriodRule } from '@/app/config/posting-periods/actions';
import { saveNumberRange } from '@/app/config/number-ranges/actions';
import { postJournalAction } from '@/app/finance/journal/new/actions';
import { saveMaterialAction } from '@/app/inventory/materials/actions';
import { getMaterialDetail } from '@/modules/inventory/materials';
import { savePaymentTermAction } from '@/app/config/payment-terms/actions';
import { getPaymentTerms } from '@/modules/foundation/payment-terms';
import { savePartnerAction } from '@/app/foundation/partners/actions';
import { getBusinessPartner } from '@/modules/foundation/business-partners';
import { saveSupplierCompanyAction } from '@/app/foundation/partners/company-actions';
import { getSupplierCompany } from '@/modules/foundation/supplier-companies';
import { saveSupplierPurchasingAction } from '@/app/foundation/partners/purchasing-actions';
import { getSupplierPurchasing } from '@/modules/foundation/supplier-purchasing';
import { saveCustomerCompanyAction } from '@/app/foundation/partners/customer-company-actions';
import { getCustomerCompany } from '@/modules/foundation/customer-companies';
import { saveCustomerSalesAreaAction } from '@/app/foundation/partners/customer-sales-area-actions';
import { getCustomerSalesArea } from '@/modules/foundation/customer-sales-areas';

let alpha: TestTenant; let beta: TestTenant;
const year = new Date().getUTCFullYear();
beforeAll(async () => {
  alpha = await createTenant('action-alpha'); beta = await createTenant('action-beta');
  await maintainNumberRange({ client: alpha.client, objectCode: 'JOURNAL_ENTRY', companyCode: '1000', subObject: 'GENERAL', fiscalYear: 0, prefix: 'JE', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE', mode: 'CREATE', changedBy: 'TEST', reason: 'Action test setup' });
});
afterAll(async () => { await destroyTenant(alpha.client); await destroyTenant(beta.client); await closeDb(); });
function signedIn(capabilities = ['*']) {
  request.session = { user: { client: alpha.client, userId: 'action-user', username: 'real.operator', fullName: 'Real Operator', email: null, mustChangePassword: false, capabilities }, expiresAt: new Date(Date.now() + 100000), renewed: false };
}
function form(values: Record<string, string>) {
  const data = new FormData(); for (const [k, v] of Object.entries(values)) data.set(k, v); return data;
}
function periodForm() { return form({ client: beta.client, changedBy: 'FORGED', variant: 'C001', accountType: 'S', periodFrom: '1', periodTo: '11', allowSpecialPeriods: 'on' }); }
function rangeForm() { return form({ client: beta.client, changedBy: 'FORGED', objectCode: 'JOURNAL_ENTRY', companyCode: '1000', subObject: 'GENERAL', fiscalYear: '0', prefix: 'JE', fromNumber: '1', toNumber: '1000000', numberLength: '6', displayStyle: 'READABLE', status: 'ACTIVE', mode: 'CHANGE', reason: 'Security verification' }); }
function journalForm() { return form({ client: beta.client, postedBy: 'FORGED', postingDate: `${year}-04-15`, companyCode: '1000', documentType: 'SA', currency: 'USD', reference: 'SECURITY-TEST', line_0_account: '100000', line_0_side: 'S', line_0_amount: '50.0000', line_1_account: '200000', line_1_side: 'H', line_1_amount: '50.0000' }); }

describe('server action security', () => {
  it('derives customer accounting tenant/actor and ignores a forged chart',async()=>{
    signedIn();const general=form({partnerNumber:'SEC-CUSTOMER',category:'ORGANIZATION',name:'Security customer',country:'KW',city:'Kuwait City',roles:'CUSTOMER',expectedVersion:'0',reason:'Customer action setup'});
    expect((await savePartnerAction({ok:true},general)).ok).toBe(true);
    const data=form({client:beta.client,changedBy:'FORGED',chartOfAccounts:'WRONG',partnerNumber:'SEC-CUSTOMER',companyCode:'1000',reconciliationAccount:'110000',paymentTermsCode:'NET30',expectedVersion:'0',reason:'Customer company security test'});
    expect((await saveCustomerCompanyAction({ok:true},data)).ok).toBe(true);
    expect((await getCustomerCompany(alpha.client,'SEC-CUSTOMER','1000'))?.createdBy).toBe('real.operator');
    expect((await getCustomerCompany(alpha.client,'SEC-CUSTOMER','1000'))?.chartOfAccounts).toBe('CAIRN');
    expect(await getCustomerCompany(beta.client,'SEC-CUSTOMER','1000')).toBeNull();
  });
  it('refuses customer accounting changes with only supplier-specific authority',async()=>{
    signedIn(['FIN.SUPPLIER.COMPANY.MAINTAIN']);const data=form({partnerNumber:'SEC-CUSTOMER',companyCode:'1000',expectedVersion:'1',reason:'Denied AR security test'});
    expect((await saveCustomerCompanyAction({ok:true},data)).message).toContain('FIN.CUSTOMER.COMPANY.MAINTAIN');
  });
  it('derives customer sales-area tenant/actor and normalises posted codes',async()=>{
    signedIn();const data=form({client:beta.client,changedBy:'FORGED',partnerNumber:'SEC-CUSTOMER',salesOrg:'1000',distributionChannel:'01',division:'01',deliveringPlant:'1000',pricingProcedure:'rvaa01',salesDistrict:'kw01',completeDelivery:'on',expectedVersion:'0',reason:'Customer sales-area security test'});
    expect((await saveCustomerSalesAreaAction({ok:true},data)).ok).toBe(true);
    const row=await getCustomerSalesArea(alpha.client,'SEC-CUSTOMER','1000','01','01');
    expect(row?.createdBy).toBe('real.operator');expect(row?.pricingProcedure).toBe('RVAA01');expect(row?.salesDistrict).toBe('KW01');expect(row?.completeDelivery).toBe(true);
    expect(await getCustomerSalesArea(beta.client,'SEC-CUSTOMER','1000','01','01')).toBeNull();
  });
  it('refuses customer sales-area changes with only accounting authority',async()=>{
    signedIn(['FIN.CUSTOMER.COMPANY.MAINTAIN']);const data=form({partnerNumber:'SEC-CUSTOMER',salesOrg:'1000',distributionChannel:'01',division:'01',expectedVersion:'1',reason:'Denied sales-area security test'});
    expect((await saveCustomerSalesAreaAction({ok:true},data)).message).toContain('SALES.CUSTOMER.SALESAREA.MAINTAIN');
  });
  it('refuses anonymous customer sales-area action requests',async()=>{
    request.session=null;await expect(saveCustomerSalesAreaAction({ok:true},new FormData())).rejects.toThrow('AUTH_REDIRECT');
  });
  it('refuses anonymous customer company action requests',async()=>{
    request.session=null;await expect(saveCustomerCompanyAction({ok:true},new FormData())).rejects.toThrow('AUTH_REDIRECT');
  });

  it('derives general-partner tenant and audit actor from the session',async()=>{
    signedIn();const data=form({client:beta.client,changedBy:'FORGED',partnerNumber:'SEC-PARTNER',category:'ORGANIZATION',name:'Security supplier',name2:'',searchTerm:'SEC',country:'KW',region:'',street:'Test street',city:'Kuwait City',postalCode:'',taxNumber:'DEMO-TAX',email:'test@example.com',phone:'',roles:'SUPPLIER',expectedVersion:'0',reason:'Partner security test'});
    expect((await savePartnerAction({ok:true},data)).ok).toBe(true);
    expect((await getBusinessPartner(alpha.client,'SEC-PARTNER'))?.general.createdBy).toBe('real.operator');
    expect(await getBusinessPartner(beta.client,'SEC-PARTNER')).toBeNull();
  });
  it('refuses general-partner writes without its master-data authority',async()=>{
    signedIn(['INV.*']);const data=form({partnerNumber:'DENIED-PARTNER',category:'ORGANIZATION',name:'Denied supplier',country:'KW',city:'Kuwait City',expectedVersion:'0',reason:'Denied partner test'});
    expect((await savePartnerAction({ok:true},data)).message).toContain('FND.PARTNER.MAINTAIN');
    expect(await getBusinessPartner(alpha.client,'DENIED-PARTNER')).toBeNull();
  });
  it('refuses anonymous general-partner action requests',async()=>{
    request.session=null;await expect(savePartnerAction({ok:true},new FormData())).rejects.toThrow('AUTH_REDIRECT');
  });
  it('derives supplier company tenant/actor and ignores submitted chart',async()=>{
    signedIn();
    const data=form({client:beta.client,changedBy:'FORGED',chartOfAccounts:'WRONG',partnerNumber:'SEC-PARTNER',companyCode:'1000',reconciliationAccount:'200000',paymentTermsCode:'NET30',expectedVersion:'0',reason:'Company security test'});
    // General partner is created by the earlier real general action security test.
    expect((await saveSupplierCompanyAction({ok:true},data)).ok).toBe(true);
    expect((await getSupplierCompany(alpha.client,'SEC-PARTNER','1000'))?.createdBy).toBe('real.operator');
    expect((await getSupplierCompany(alpha.client,'SEC-PARTNER','1000'))?.chartOfAccounts).toBe('CAIRN');
    expect(await getSupplierCompany(beta.client,'SEC-PARTNER','1000')).toBeNull();
  });
  it('refuses supplier accounting writes with only general master authority',async()=>{
    signedIn(['FND.*']);const data=form({partnerNumber:'SEC-PARTNER',companyCode:'1000',expectedVersion:'1',reconciliationAccount:'200000',paymentTermsCode:'NET15',reason:'Denied finance test'});
    expect((await saveSupplierCompanyAction({ok:true},data)).message).toContain('FIN.SUPPLIER.COMPANY.MAINTAIN');
  });
  it('refuses anonymous supplier company action requests',async()=>{
    request.session=null;await expect(saveSupplierCompanyAction({ok:true},new FormData())).rejects.toThrow('AUTH_REDIRECT');
  });
  it('derives supplier purchasing tenant/actor from session, ignoring forged fields',async()=>{
    signedIn();const data=form({client:beta.client,changedBy:'FORGED',partnerNumber:'SEC-PARTNER',purchasingOrg:'1000',orderCurrency:'USD',purchasingGroup:'001',incotermsCode:'FCA',incotermsLocation:'Kuwait City',paymentTermsCode:'NET30',expectedVersion:'0',reason:'Purchasing action security test'});
    expect((await saveSupplierPurchasingAction({ok:true},data)).ok).toBe(true);
    expect((await getSupplierPurchasing(alpha.client,'SEC-PARTNER','1000'))?.createdBy).toBe('real.operator');
    expect(await getSupplierPurchasing(beta.client,'SEC-PARTNER','1000')).toBeNull();
  });
  it('refuses supplier buying changes with only financial authority',async()=>{
    signedIn(['FIN.*']);const data=form({partnerNumber:'SEC-PARTNER',purchasingOrg:'1000',expectedVersion:'1',reason:'Denied purchasing test'});
    expect((await saveSupplierPurchasingAction({ok:true},data)).message).toContain('PROC.SUPPLIER.PURCHASING.MAINTAIN');
  });
  it('refuses anonymous supplier purchasing action requests',async()=>{
    request.session=null;await expect(saveSupplierPurchasingAction({ok:true},new FormData())).rejects.toThrow('AUTH_REDIRECT');
  });



  it('derives payment-term tenant/actor from session, not forged form fields', async () => {
    signedIn();
    const data=form({client:beta.client,changedBy:'FORGED',termsCode:'SECACT',description:'Security test',baselineSource:'DOCUMENT_DATE',netDays:'30',discount1Days:'',discount1Percent:'0.00',discount2Days:'',discount2Percent:'0.00',isActive:'on',expectedVersion:'0',reason:'Action security test'});
    expect((await savePaymentTermAction({ok:true},data)).ok).toBe(true);
    expect((await getPaymentTerms(alpha.client,'SECACT'))?.createdBy).toBe('real.operator');
    expect(await getPaymentTerms(beta.client,'SECACT')).toBeNull();
  });
  it('refuses payment-term changes without the configuration authority', async () => {
    signedIn(['FIN.*']);
    const data=form({termsCode:'DENIED',description:'Denied',baselineSource:'DOCUMENT_DATE',netDays:'30',discount1Days:'',discount1Percent:'0.00',discount2Days:'',discount2Percent:'0.00',isActive:'on',expectedVersion:'0',reason:'Denied authority test'});
    expect((await savePaymentTermAction({ok:true},data)).message).toContain('CFG.FIN.PAYTERMS.DEFINE');
    expect(await getPaymentTerms(alpha.client,'DENIED')).toBeNull();
  });
  it('refuses anonymous payment-term server-action calls', async () => {
    request.session=null;
    await expect(savePaymentTermAction({ok:true},new FormData())).rejects.toThrow('AUTH_REDIRECT');
  });

  it('ignores a forged tenant/actor when changing posting controls', async () => {
    signedIn();
    expect((await savePeriodRule(periodForm())).ok).toBe(true);
    const own = await withTenant(alpha.client, (tx) => tx.execute(sql`select period_to, changed_by from posting_period_rule where account_type = 'S'`));
    const other = await withTenant(beta.client, (tx) => tx.execute(sql`select period_to from posting_period_rule where account_type = 'S'`));
    expect((own as unknown as Array<Record<string, unknown>>)[0]).toEqual({ period_to: 11, changed_by: 'real.operator' });
    expect((other as unknown as Array<{ period_to: number }>)[0].period_to).toBe(12);
  });

  it('refuses a period mutation without authority and leaves the database unchanged', async () => {
    signedIn(['AUDIT.*']);
    const data = periodForm(); data.set('periodTo', '10');
    const result = await savePeriodRule(data);
    expect(result.ok).toBe(false); expect(result.message).toContain('FIN.CLOSE.PERIOD');
    const own = await withTenant(alpha.client, (tx) => tx.execute(sql`select period_to from posting_period_rule where account_type = 'S'`));
    expect((own as unknown as Array<{ period_to: number }>)[0].period_to).toBe(11);
  });

  it('takes the number-range tenant and actor from the authenticated request', async () => {
    signedIn(); const data = rangeForm(); data.set('toNumber', '999998');
    expect((await saveNumberRange({ ok: true }, data)).ok).toBe(true);
    expect((await listNumberRanges(alpha.client)).ranges[0].changedBy).toBe('real.operator');
    expect((await listNumberRanges(beta.client)).ranges).toHaveLength(0);
  });

  it('refuses unauthorised number-range maintenance', async () => {
    signedIn(['FIN.JOURNAL.POST']);
    const result = await saveNumberRange({ ok: true }, rangeForm());
    expect(result.ok).toBe(false); expect(result.message).toContain('CFG.PLT.NUMBERRANGE.DEFINE');
  });

  it('posts in the session tenant under the actual user, not the form tenant', async () => {
    signedIn(); const result = await postJournalAction({ ok: true }, journalForm());
    expect(result.ok).toBe(true);
    const own = await withTenant(alpha.client, (tx) => tx.execute(sql`select created_by from journal_entry where document_number = ${result.documentNumber}`));
    const other = await withTenant(beta.client, (tx) => tx.execute(sql`select count(*)::int as n from journal_entry`));
    expect((own as unknown as Array<{ created_by: string }>)[0].created_by).toBe('real.operator');
    expect((other as unknown as Array<{ n: number }>)[0].n).toBe(0);
  });

  it('refuses a posting without its named authority', async () => {
    signedIn(['CFG.*']);
    const result = await postJournalAction({ ok: true }, journalForm());
    expect(result.ok).toBe(false); expect(result.message).toContain('FIN.JOURNAL.POST');
  });

  it('ignores a forged tenant and audit actor when creating a material', async () => {
    signedIn(['INV.MATERIAL.MAINTAIN']);
    const data = form({ client: beta.client, changedBy: 'FORGED', view: 'BASIC', materialNumber: 'ACTION-MATERIAL', expectedVersion: '0', description: 'Action master', materialType: 'RAW', materialGroup: 'RAW', baseUnit: 'KG', grossWeight: '0', netWeight: '0' });
    const result = await saveMaterialAction({ ok: true }, data);
    expect(result.ok).toBe(true);
    expect((await getMaterialDetail(alpha.client, 'ACTION-MATERIAL'))?.base.createdBy).toBe('real.operator');
    expect(await getMaterialDetail(beta.client, 'ACTION-MATERIAL')).toBeNull();
  });

  it('requires the separate valuation authority even for a basic-data maintainer', async () => {
    signedIn(['INV.*']);
    const result = await saveMaterialAction({ ok: true }, form({ view: 'ACCOUNTING', materialNumber: 'ACTION-MATERIAL', plant: '1000' }));
    expect(result.ok).toBe(false); expect(result.message).toContain('FIN.MATERIAL.VALUATION.MAINTAIN');
  });

  it('does not turn an authentication redirect into a posting-error response', async () => {
    request.session = null;
    await expect(postJournalAction({ ok: true }, journalForm())).rejects.toThrow('AUTH_REDIRECT');
    await expect(savePeriodRule(periodForm())).rejects.toThrow('AUTH_REDIRECT');
    await expect(saveNumberRange({ ok: true }, rangeForm())).rejects.toThrow('AUTH_REDIRECT');
    await expect(saveMaterialAction({ ok: true }, form({ view: 'BASIC' }))).rejects.toThrow('AUTH_REDIRECT');
  });
});
