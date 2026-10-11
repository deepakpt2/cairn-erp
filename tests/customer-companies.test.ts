import { beforeAll,afterAll,describe,expect,it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTenant,destroyTenant,withTenant,closeDb,defineTestRanges,type TestTenant } from './helpers';
import { db } from '../src/platform/db/client';
import { postJournalEntry } from '../src/platform/posting';
import { saveBusinessPartner } from '../src/modules/foundation/business-partners';
import { saveCustomerCompany,getCustomerCompany,listCustomerCompanies,requireCustomerCompany,type CustomerCompanyInput } from '../src/modules/foundation/customer-companies';
let alpha:TestTenant;let beta:TestTenant;
async function partner(tenant:TestTenant,number:string,roles:['CUSTOMER']|['SUPPLIER']=['CUSTOMER']){
  await saveBusinessPartner({client:tenant.client,partnerNumber:number,expectedVersion:0,changedBy:'TEST',reason:'Customer company fixture',category:'ORGANIZATION',name:'Example customer',name2:'',searchTerm:'',country:'KW',region:'',street:'Test street',city:'Kuwait City',postalCode:'',taxNumber:'',email:'',phone:'',roles,isBlocked:false});
}
beforeAll(async()=>{
  alpha=await createTenant('customer-company-alpha');beta=await createTenant('customer-company-beta');
  for(const number of ['STAGED','READY','NOOP','RACE','BLOCK','INVALID','FOREIGN','MULTICO','HISTORY','PAYDUN','PAYBAD'])await partner(alpha,number);
  await partner(alpha,'SUPPLIERONLY',['SUPPLIER']);
});
afterAll(async()=>{await destroyTenant(alpha.client);await destroyTenant(beta.client);await closeDb();});
const input=(number:string,patch:Partial<CustomerCompanyInput>={}):CustomerCompanyInput=>({client:alpha.client,partnerNumber:number,companyCode:'1000',expectedVersion:0,changedBy:'TEST',reason:'Customer company test',reconciliationAccount:'110000',paymentTermsCode:'NET30',paymentMethods:'',dunningProcedure:'',isBlocked:false,...patch});
describe('customer company-code settings',()=>{
  it('stages and completes accounting settings independently',async()=>{
    expect((await saveCustomerCompany(input('STAGED',{reconciliationAccount:'',paymentTermsCode:''}))).status).toBe('INCOMPLETE');
    await expect(withTenant(alpha.client,tx=>requireCustomerCompany(tx,alpha.client,'STAGED','1000'))).rejects.toThrow('incomplete');
    expect(await saveCustomerCompany(input('STAGED',{expectedVersion:1}))).toEqual({changed:true,version:2,status:'CREATED'});
  });
  it('derives the assigned company chart and validates customer reconciliation',async()=>{
    await saveCustomerCompany(input('READY'));
    const row=await getCustomerCompany(alpha.client,'READY','1000');expect(row?.chartOfAccounts).toBe('CAIRN');expect(row?.reconciliationAccount).toBe('110000');
    await expect(withTenant(alpha.client,tx=>requireCustomerCompany(tx,alpha.client,'READY','1000'))).resolves.toMatchObject({paymentTermsCode:'NET30'});
  });
  it('refuses a supplier-only partner or unknown partner',async()=>{
    await expect(saveCustomerCompany(input('SUPPLIERONLY'))).rejects.toThrow('active customer');
    await expect(saveCustomerCompany(input('MISSING'))).rejects.toThrow('active customer');
  });
  it.each([{companyCode:'9999'},{reconciliationAccount:'100000'},{reconciliationAccount:'200000'},{paymentTermsCode:'MISSING'},{reason:''}])('rejects wrong company/account/terms without writing %j',async(patch)=>{
    await expect(saveCustomerCompany(input('INVALID',patch))).rejects.toThrow();expect(await getCustomerCompany(alpha.client,'INVALID','1000')).toBeNull();
  });
  it('rejects inactive payment terms',async()=>{
    await withTenant(alpha.client,tx=>tx.execute(sql`update payment_terms set is_active=false where terms_code='NET60'`));
    await expect(saveCustomerCompany(input('INVALID',{paymentTermsCode:'NET60'}))).rejects.toThrow('inactive');
  });
  it('rejects blocked reconciliation account',async()=>{
    await withTenant(alpha.client,tx=>tx.execute(sql`update gl_account set is_blocked=true where account_number='110100'`));
    await expect(saveCustomerCompany(input('INVALID',{reconciliationAccount:'110100'}))).rejects.toThrow('unblocked');
  });
  it('preserves no-op and rejects stale maintenance',async()=>{
    await saveCustomerCompany(input('NOOP'));
    expect(await saveCustomerCompany(input('NOOP',{expectedVersion:1}))).toEqual({changed:false,version:1,status:'CREATED'});
    await saveCustomerCompany(input('NOOP',{expectedVersion:1,paymentTermsCode:'NET15'}));
    await expect(saveCustomerCompany(input('NOOP',{expectedVersion:1,paymentTermsCode:'IMMEDIATE'}))).rejects.toThrow('changed after');
    const history=await withTenant(alpha.client,tx=>tx.execute(sql`select count(*)::int as n from change_document where object_class='customer_company_code' and object_key='NOOP/1000'`));
    expect((history as unknown as Array<{n:number}>)[0].n).toBe(2);
  });
  it('serializes concurrent expected-version changes',async()=>{
    await saveCustomerCompany(input('RACE'));
    const results=await Promise.allSettled([saveCustomerCompany(input('RACE',{expectedVersion:1,paymentTermsCode:'NET15'})),saveCustomerCompany(input('RACE',{expectedVersion:1,paymentTermsCode:'IMMEDIATE'}))]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  });
  it('blocks company-specific operational use without blocking the global identity',async()=>{
    await saveCustomerCompany(input('BLOCK',{isBlocked:true}));
    await expect(withTenant(alpha.client,tx=>requireCustomerCompany(tx,alpha.client,'BLOCK','1000'))).rejects.toThrow('blocked');
    await saveCustomerCompany(input('BLOCK',{expectedVersion:1,isBlocked:false}));
    await expect(withTenant(alpha.client,tx=>requireCustomerCompany(tx,alpha.client,'BLOCK','1000'))).resolves.toBeTruthy();
  });
  it('uses the general partner block gate as well as company settings',async()=>{
    await withTenant(alpha.client,tx=>tx.execute(sql`update business_partner set is_blocked=true where partner_number='READY'`));
    await expect(withTenant(alpha.client,tx=>requireCustomerCompany(tx,alpha.client,'READY','1000'))).rejects.toThrow('blocked');
  });
  it('isolates company views and default-denies unscoped access',async()=>{
    await saveCustomerCompany(input('FOREIGN'));
    expect(await getCustomerCompany(beta.client,'FOREIGN','1000')).toBeNull();
    expect(await listCustomerCompanies(alpha.client,'FOREIGN')).toHaveLength(1);
    expect(await db().execute(sql`select * from customer_company_code`)).toHaveLength(0);
  });
  it('keeps two company-code views independent for one customer',async()=>{
    await withTenant(alpha.client,tx=>tx.execute(sql`insert into company_code(client,company_code,name,chart_of_accounts,fiscal_year_variant,posting_period_variant,currency,country,created_by) select client,'2000','Second test company',chart_of_accounts,fiscal_year_variant,posting_period_variant,currency,country,'TEST' from company_code where company_code='1000'`));
    await saveCustomerCompany(input('MULTICO'));
    await saveCustomerCompany(input('MULTICO',{companyCode:'2000',paymentTermsCode:'NET15',isBlocked:true}));
    expect(await listCustomerCompanies(alpha.client,'MULTICO')).toHaveLength(2);
    expect((await getCustomerCompany(alpha.client,'MULTICO','1000'))?.isBlocked).toBe(false);
    await expect(withTenant(alpha.client,tx=>requireCustomerCompany(tx,alpha.client,'MULTICO','2000'))).rejects.toThrow('blocked');
  });
  it('protects reconciliation assignment when partner-linked accounting exists',async()=>{
    await saveCustomerCompany(input('HISTORY'));
    await defineTestRanges(alpha);
    await withTenant(alpha.client,tx=>postJournalEntry(tx,{client:alpha.client,companyCode:'1000',documentType:'SA',documentDate:'2026-10-10',postingDate:'2026-10-10',fiscalYear:2026,postingPeriod:10,currency:'USD',localCurrency:'USD',postedBy:'TEST',lines:[{glAccount:'100000',debitCredit:'S',amount:'10.0000'},{glAccount:'110000',debitCredit:'H',amount:'10.0000',businessPartner:'HISTORY'}]}));
    await withTenant(alpha.client,tx=>tx.execute(sql`update gl_account set is_blocked=false where account_number='110100'`));
    await expect(saveCustomerCompany(input('HISTORY',{expectedVersion:1,reconciliationAccount:'110100'}))).rejects.toThrow('linked accounting');
    expect((await getCustomerCompany(alpha.client,'HISTORY','1000'))?.reconciliationAccount).toBe('110000');
  });
  it('does not mutate the supplier company segment of a dual-role partner',async()=>{
    await saveBusinessPartner({client:alpha.client,partnerNumber:'DUALROLE',expectedVersion:0,changedBy:'TEST',reason:'Dual role accounting fixture',category:'ORGANIZATION',name:'Dual role partner',name2:'',searchTerm:'',country:'KW',region:'',street:'Test street',city:'Kuwait City',postalCode:'',taxNumber:'',email:'',phone:'',roles:['CUSTOMER','SUPPLIER'],isBlocked:false});
    const {saveSupplierCompany,getSupplierCompany}=await import('../src/modules/foundation/supplier-companies');
    await saveSupplierCompany({client:alpha.client,partnerNumber:'DUALROLE',companyCode:'1000',expectedVersion:0,changedBy:'TEST',reason:'Supplier side fixture',reconciliationAccount:'200000',paymentTermsCode:'NET30',isBlocked:false});
    await saveCustomerCompany(input('DUALROLE',{paymentTermsCode:'NET15',isBlocked:true}));
    const supplier=await getSupplierCompany(alpha.client,'DUALROLE','1000');expect(supplier?.reconciliationAccount).toBe('200000');expect(supplier?.paymentTermsCode).toBe('NET30');expect(supplier?.isBlocked).toBe(false);
  });
  it('rechecks active company and role at operational use',async()=>{
    await saveCustomerCompany(input('INVALID'));
    await withTenant(alpha.client,tx=>tx.execute(sql`update company_code set is_active=false where company_code='1000'`));
    await expect(withTenant(alpha.client,tx=>requireCustomerCompany(tx,alpha.client,'INVALID','1000'))).rejects.toThrow('inactive');
    await withTenant(alpha.client,tx=>tx.execute(sql`update company_code set is_active=true where company_code='1000'`));
    await withTenant(alpha.client,tx=>tx.execute(sql`update bp_role set is_active=false where partner_number='INVALID' and role_code='CUSTOMER'`));
    await expect(withTenant(alpha.client,tx=>requireCustomerCompany(tx,alpha.client,'INVALID','1000'))).rejects.toThrow('not active');
  });
  it('cascades new company settings with tenant removal',async()=>{
    const temp=await createTenant('customer-company-cascade');await partner(temp,'TEMP');await saveCustomerCompany({...input('TEMP'),client:temp.client});await destroyTenant(temp.client);
    expect(await withTenant(temp.client,tx=>tx.execute(sql`select * from customer_company_code`))).toHaveLength(0);
  });
});
describe('customer company payment methods and dunning procedure (B-018)',()=>{
  it('normalizes payment methods and the dunning procedure on save',async()=>{
    await saveCustomerCompany(input('PAYDUN',{paymentMethods:' t , c,C ',dunningProcedure:'ma04'}));
    const row=await getCustomerCompany(alpha.client,'PAYDUN','1000');
    expect(row?.paymentMethods).toBe('C,T');expect(row?.dunningProcedure).toBe('MA04');
    expect(row?.version).toBe(1);expect(row?.companyStatus).toBe('CREATED');
  });
  it('treats a reordered or duplicated payment-method set as unchanged',async()=>{
    expect(await saveCustomerCompany(input('PAYDUN',{expectedVersion:1,paymentMethods:'T,C',dunningProcedure:'MA04'}))).toEqual({changed:false,version:1,status:'CREATED'});
  });
  it('records a dunning-only change with version bump and security-relevant history item',async()=>{
    expect(await saveCustomerCompany(input('PAYDUN',{expectedVersion:1,paymentMethods:'C,T',dunningProcedure:'MA02'}))).toEqual({changed:true,version:2,status:'MAINTAINED'});
    const items=await withTenant(alpha.client,tx=>tx.execute(sql`select i.field_name,i.old_value,i.new_value,i.is_security_relevant from change_document_item i join change_document d on d.id=i.change_document_id where d.object_class='customer_company_code' and d.object_key='PAYDUN/1000' and d.change_type='CHANGE' and i.is_security_relevant='true'`));
    expect(items).toEqual([{field_name:'dunningProcedure',old_value:'MA04',new_value:'MA02',is_security_relevant:'true'}]);
  });
  it('clears the dunning procedure again on blank input without losing the payment methods',async()=>{
    await saveCustomerCompany(input('PAYDUN',{expectedVersion:2,paymentMethods:'C,T',dunningProcedure:''}));
    const row=await getCustomerCompany(alpha.client,'PAYDUN','1000');
    expect(row?.dunningProcedure).toBeNull();expect(row?.paymentMethods).toBe('C,T');expect(row?.version).toBe(3);
  });
  it.each([{paymentMethods:'WIRE TRANSFER'},{paymentMethods:'TOOLONGCODE'},{paymentMethods:'A,B,C,D,E,F,G,H,I,J,K'},{dunningProcedure:'MAHNV'}])('rejects invalid payment/dunning codes without writing %j',async(patch)=>{
    await expect(saveCustomerCompany(input('PAYBAD',patch))).rejects.toThrow();
    expect(await getCustomerCompany(alpha.client,'PAYBAD','1000')).toBeNull();
  });
  it('keeps payment/dunning fields out of the completeness gate',async()=>{
    await saveCustomerCompany(input('PAYDUN',{expectedVersion:3,reconciliationAccount:'',paymentTermsCode:'',paymentMethods:'T',dunningProcedure:'MA01'}));
    const row=await getCustomerCompany(alpha.client,'PAYDUN','1000');
    expect(row?.companyStatus).toBe('INCOMPLETE');expect(row?.paymentMethods).toBe('T');expect(row?.dunningProcedure).toBe('MA01');
    await expect(withTenant(alpha.client,tx=>requireCustomerCompany(tx,alpha.client,'PAYDUN','1000'))).rejects.toThrow('incomplete');
  });
});
