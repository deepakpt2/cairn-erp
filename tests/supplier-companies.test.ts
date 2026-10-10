import { beforeAll,afterAll,describe,expect,it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTenant,destroyTenant,withTenant,closeDb,defineTestRanges,type TestTenant } from './helpers';
import { db } from '../src/platform/db/client';
import { postJournalEntry } from '../src/platform/posting';
import { saveBusinessPartner } from '../src/modules/foundation/business-partners';
import { saveSupplierCompany,getSupplierCompany,listSupplierCompanies,requireSupplierCompany,type SupplierCompanyInput } from '../src/modules/foundation/supplier-companies';
let alpha:TestTenant;let beta:TestTenant;
async function partner(tenant:TestTenant,number:string,roles:['SUPPLIER']|['CUSTOMER']=['SUPPLIER']){
  await saveBusinessPartner({client:tenant.client,partnerNumber:number,expectedVersion:0,changedBy:'TEST',reason:'Supplier company fixture',category:'ORGANIZATION',name:'Example supplier',name2:'',searchTerm:'',country:'KW',region:'',street:'Test street',city:'Kuwait City',postalCode:'',taxNumber:'',email:'',phone:'',roles,isBlocked:false});
}
beforeAll(async()=>{
  alpha=await createTenant('supplier-company-alpha');beta=await createTenant('supplier-company-beta');
  for(const number of ['STAGED','READY','NOOP','RACE','BLOCK','INVALID','FOREIGN','MULTICO','HISTORY'])await partner(alpha,number);
  await partner(alpha,'CUSTOMERONLY',['CUSTOMER']);
});
afterAll(async()=>{await destroyTenant(alpha.client);await destroyTenant(beta.client);await closeDb();});
const input=(number:string,patch:Partial<SupplierCompanyInput>={}):SupplierCompanyInput=>({client:alpha.client,partnerNumber:number,companyCode:'1000',expectedVersion:0,changedBy:'TEST',reason:'Supplier company test',reconciliationAccount:'200000',paymentTermsCode:'NET30',isBlocked:false,...patch});
describe('supplier company-code settings',()=>{
  it('stages and completes accounting settings independently',async()=>{
    expect((await saveSupplierCompany(input('STAGED',{reconciliationAccount:'',paymentTermsCode:''}))).status).toBe('INCOMPLETE');
    await expect(withTenant(alpha.client,tx=>requireSupplierCompany(tx,alpha.client,'STAGED','1000'))).rejects.toThrow('incomplete');
    expect(await saveSupplierCompany(input('STAGED',{expectedVersion:1}))).toEqual({changed:true,version:2,status:'CREATED'});
  });
  it('derives the assigned company chart and validates supplier reconciliation',async()=>{
    await saveSupplierCompany(input('READY'));
    const row=await getSupplierCompany(alpha.client,'READY','1000');expect(row?.chartOfAccounts).toBe('CAIRN');expect(row?.reconciliationAccount).toBe('200000');
    await expect(withTenant(alpha.client,tx=>requireSupplierCompany(tx,alpha.client,'READY','1000'))).resolves.toMatchObject({paymentTermsCode:'NET30'});
  });
  it('refuses a customer-only partner or unknown partner',async()=>{
    await expect(saveSupplierCompany(input('CUSTOMERONLY'))).rejects.toThrow('active supplier');
    await expect(saveSupplierCompany(input('MISSING'))).rejects.toThrow('active supplier');
  });
  it.each([{companyCode:'9999'},{reconciliationAccount:'100000'},{reconciliationAccount:'110000'},{paymentTermsCode:'MISSING'},{reason:''}])('rejects wrong company/account/terms without writing %j',async(patch)=>{
    await expect(saveSupplierCompany(input('INVALID',patch))).rejects.toThrow();expect(await getSupplierCompany(alpha.client,'INVALID','1000')).toBeNull();
  });
  it('rejects inactive payment terms',async()=>{
    await withTenant(alpha.client,tx=>tx.execute(sql`update payment_terms set is_active=false where terms_code='NET60'`));
    await expect(saveSupplierCompany(input('INVALID',{paymentTermsCode:'NET60'}))).rejects.toThrow('inactive');
  });
  it('rejects blocked reconciliation account',async()=>{
    await withTenant(alpha.client,tx=>tx.execute(sql`update gl_account set is_blocked=true where account_number='200100'`));
    await expect(saveSupplierCompany(input('INVALID',{reconciliationAccount:'200100'}))).rejects.toThrow('unblocked');
  });
  it('preserves no-op and rejects stale maintenance',async()=>{
    await saveSupplierCompany(input('NOOP'));
    expect(await saveSupplierCompany(input('NOOP',{expectedVersion:1}))).toEqual({changed:false,version:1,status:'CREATED'});
    await saveSupplierCompany(input('NOOP',{expectedVersion:1,paymentTermsCode:'NET15'}));
    await expect(saveSupplierCompany(input('NOOP',{expectedVersion:1,paymentTermsCode:'IMMEDIATE'}))).rejects.toThrow('changed after');
    const history=await withTenant(alpha.client,tx=>tx.execute(sql`select count(*)::int as n from change_document where object_class='supplier_company_code' and object_key='NOOP/1000'`));
    expect((history as unknown as Array<{n:number}>)[0].n).toBe(2);
  });
  it('serializes concurrent expected-version changes',async()=>{
    await saveSupplierCompany(input('RACE'));
    const results=await Promise.allSettled([saveSupplierCompany(input('RACE',{expectedVersion:1,paymentTermsCode:'NET15'})),saveSupplierCompany(input('RACE',{expectedVersion:1,paymentTermsCode:'IMMEDIATE'}))]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  });
  it('blocks company-specific operational use without blocking the global identity',async()=>{
    await saveSupplierCompany(input('BLOCK',{isBlocked:true}));
    await expect(withTenant(alpha.client,tx=>requireSupplierCompany(tx,alpha.client,'BLOCK','1000'))).rejects.toThrow('blocked');
    await saveSupplierCompany(input('BLOCK',{expectedVersion:1,isBlocked:false}));
    await expect(withTenant(alpha.client,tx=>requireSupplierCompany(tx,alpha.client,'BLOCK','1000'))).resolves.toBeTruthy();
  });
  it('uses the general partner block gate as well as company settings',async()=>{
    await withTenant(alpha.client,tx=>tx.execute(sql`update business_partner set is_blocked=true where partner_number='READY'`));
    await expect(withTenant(alpha.client,tx=>requireSupplierCompany(tx,alpha.client,'READY','1000'))).rejects.toThrow('blocked');
  });
  it('isolates company views and default-denies unscoped access',async()=>{
    await saveSupplierCompany(input('FOREIGN'));
    expect(await getSupplierCompany(beta.client,'FOREIGN','1000')).toBeNull();
    expect(await listSupplierCompanies(alpha.client,'FOREIGN')).toHaveLength(1);
    expect(await db().execute(sql`select * from supplier_company_code`)).toHaveLength(0);
  });
  it('keeps two company-code views independent for one supplier',async()=>{
    await withTenant(alpha.client,tx=>tx.execute(sql`insert into company_code(client,company_code,name,chart_of_accounts,fiscal_year_variant,posting_period_variant,currency,country,created_by) select client,'2000','Second test company',chart_of_accounts,fiscal_year_variant,posting_period_variant,currency,country,'TEST' from company_code where company_code='1000'`));
    await saveSupplierCompany(input('MULTICO'));
    await saveSupplierCompany(input('MULTICO',{companyCode:'2000',paymentTermsCode:'NET15',isBlocked:true}));
    expect(await listSupplierCompanies(alpha.client,'MULTICO')).toHaveLength(2);
    expect((await getSupplierCompany(alpha.client,'MULTICO','1000'))?.isBlocked).toBe(false);
    await expect(withTenant(alpha.client,tx=>requireSupplierCompany(tx,alpha.client,'MULTICO','2000'))).rejects.toThrow('blocked');
  });
  it('protects reconciliation assignment when partner-linked accounting exists',async()=>{
    await saveSupplierCompany(input('HISTORY'));
    await defineTestRanges(alpha);
    await withTenant(alpha.client,tx=>postJournalEntry(tx,{client:alpha.client,companyCode:'1000',documentType:'SA',documentDate:'2026-10-10',postingDate:'2026-10-10',fiscalYear:2026,postingPeriod:10,currency:'USD',localCurrency:'USD',postedBy:'TEST',lines:[{glAccount:'100000',debitCredit:'S',amount:'10.0000'},{glAccount:'200000',debitCredit:'H',amount:'10.0000',businessPartner:'HISTORY'}]}));
    await withTenant(alpha.client,tx=>tx.execute(sql`update gl_account set is_blocked=false where account_number='200100'`));
    await expect(saveSupplierCompany(input('HISTORY',{expectedVersion:1,reconciliationAccount:'200100'}))).rejects.toThrow('linked accounting');
    expect((await getSupplierCompany(alpha.client,'HISTORY','1000'))?.reconciliationAccount).toBe('200000');
  });
  it('cascades new company settings with tenant removal',async()=>{
    const temp=await createTenant('supplier-company-cascade');await partner(temp,'TEMP');await saveSupplierCompany({...input('TEMP'),client:temp.client});await destroyTenant(temp.client);
    expect(await withTenant(temp.client,tx=>tx.execute(sql`select * from supplier_company_code`))).toHaveLength(0);
  });
});
