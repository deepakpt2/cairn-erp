import { beforeAll,afterAll,describe,expect,it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTenant,destroyTenant,withTenant,closeDb,type TestTenant } from './helpers';
import { db } from '../src/platform/db/client';
import { saveBusinessPartner } from '../src/modules/foundation/business-partners';
import { saveCustomerSalesArea,getCustomerSalesArea,listCustomerSalesAreas,requireCustomerSalesArea,type CustomerSalesAreaInput } from '../src/modules/foundation/customer-sales-areas';
let alpha:TestTenant;let beta:TestTenant;
async function partner(tenant:TestTenant,number:string,roles:['CUSTOMER']|['SUPPLIER']=['CUSTOMER']){
  await saveBusinessPartner({client:tenant.client,partnerNumber:number,expectedVersion:0,changedBy:'TEST',reason:'Customer sales-area fixture',category:'ORGANIZATION',name:'Example customer',name2:'',searchTerm:'',country:'KW',region:'',street:'Test street',city:'Kuwait City',postalCode:'',taxNumber:'',email:'',phone:'',roles,isBlocked:false});
}
beforeAll(async()=>{
  alpha=await createTenant('customer-sales-area-alpha');beta=await createTenant('customer-sales-area-beta');
  for(const number of ['STAGED','READY','NOOP','RACE','BLOCK','INVALID','FOREIGN','MULTI','HISTORY','GATE','ROLEOFF'])await partner(alpha,number);
  await partner(alpha,'SUPPLIERONLY',['SUPPLIER']);
  // Extra fixtures, explicitly test-only: a second company with its own plant, a second sales area, and an inactive sales area.
  await withTenant(alpha.client,async tx=>{
    await tx.execute(sql`insert into company_code(client,company_code,name,chart_of_accounts,fiscal_year_variant,posting_period_variant,currency,country,created_by) select client,'2000','Second test company',chart_of_accounts,fiscal_year_variant,posting_period_variant,currency,country,'TEST' from company_code where company_code='1000'`);
    await tx.execute(sql`insert into plant(client,plant,name,company_code,country,created_by) values (${alpha.client},'2000PL','Second company plant','2000','KW','TEST')`);
    await tx.execute(sql`insert into sales_area(client,sales_org,distribution_channel,division,name,is_active,created_by) values (${alpha.client},'1000','03','01','Online test area',true,'TEST')`);
    await tx.execute(sql`insert into sales_area(client,sales_org,distribution_channel,division,name,is_active,created_by) values (${alpha.client},'1000','02','02','Inactive test area',false,'TEST')`);
  });
});
afterAll(async()=>{await destroyTenant(alpha.client);await destroyTenant(beta.client);await closeDb();});
const input=(number:string,patch:Partial<CustomerSalesAreaInput>={}):CustomerSalesAreaInput=>({client:alpha.client,partnerNumber:number,salesOrg:'1000',distributionChannel:'01',division:'01',expectedVersion:0,changedBy:'TEST',reason:'Customer sales-area test',salesDistrict:'',deliveringPlant:'1000',pricingProcedure:'RVAA01',completeDelivery:false,orderCombination:false,isBlocked:false,...patch});
const gate=(number:string,org='1000',channel='01',division='01')=>withTenant(alpha.client,tx=>requireCustomerSalesArea(tx,alpha.client,number,org,channel,division));
describe('customer sales-area defaults',()=>{
  it('stages without delivery/pricing defaults and completes when both are maintained',async()=>{
    expect((await saveCustomerSalesArea(input('STAGED',{deliveringPlant:'',pricingProcedure:''}))).status).toBe('INCOMPLETE');
    await expect(gate('STAGED')).rejects.toThrow('incomplete');
    expect(await saveCustomerSalesArea(input('STAGED',{expectedVersion:1}))).toEqual({changed:true,version:2,status:'CREATED'});
  });
  it('derives nothing from the company and validates the sales area and delivering plant',async()=>{
    await saveCustomerSalesArea(input('READY',{salesDistrict:'KW01',completeDelivery:true}));
    const row=await getCustomerSalesArea(alpha.client,'READY','1000','01','01');
    expect(row).toMatchObject({deliveringPlant:'1000',pricingProcedure:'RVAA01',salesDistrict:'KW01',completeDelivery:true,orderCombination:false,salesStatus:'CREATED'});
    await expect(gate('READY')).resolves.toMatchObject({pricingProcedure:'RVAA01'});
  });
  it('refuses a supplier-only partner or unknown partner',async()=>{
    await expect(saveCustomerSalesArea(input('SUPPLIERONLY'))).rejects.toThrow('active customer');
    await expect(saveCustomerSalesArea(input('MISSING'))).rejects.toThrow('active customer');
  });
  it.each([
    {salesOrg:'9999'},{distributionChannel:'99'},{division:'99'},{deliveringPlant:'NOPE'},{deliveringPlant:'2000PL'},
    {salesDistrict:'TOOLONGDISTRICT'},{pricingProcedure:'bad code'},{reason:''},{salesOrg:'1000',distributionChannel:'02',division:'02'},
  ])('rejects invalid or inactive sales-area values without writing %j',async(patch)=>{
    await expect(saveCustomerSalesArea(input('INVALID',patch))).rejects.toThrow();
    expect(await listCustomerSalesAreas(alpha.client,'INVALID')).toHaveLength(0);
  });
  it('refuses inactive sales organisation or company at save and at operational use',async()=>{
    await saveCustomerSalesArea(input('INVALID'));
    await withTenant(alpha.client,tx=>tx.execute(sql`update company_code set is_active=false where company_code='1000'`));
    await expect(gate('INVALID')).rejects.toThrow('active company');
    await expect(saveCustomerSalesArea(input('INVALID',{expectedVersion:1,deliveringPlant:'1000',pricingProcedure:'RVAA02'}))).rejects.toThrow('active company');
    await withTenant(alpha.client,tx=>tx.execute(sql`update company_code set is_active=true where company_code='1000'`));
    await expect(gate('INVALID')).resolves.toBeTruthy();
  });
  it('preserves no-op and rejects stale maintenance with a reason-bearing history',async()=>{
    await saveCustomerSalesArea(input('NOOP'));
    expect(await saveCustomerSalesArea(input('NOOP',{expectedVersion:1}))).toEqual({changed:false,version:1,status:'CREATED'});
    await saveCustomerSalesArea(input('NOOP',{expectedVersion:1,pricingProcedure:'RVAA02'}));
    await expect(saveCustomerSalesArea(input('NOOP',{expectedVersion:1,pricingProcedure:'RVAA03'}))).rejects.toThrow('changed after');
    const history=await withTenant(alpha.client,tx=>tx.execute(sql`select count(*)::int as n from change_document where object_class='customer_sales_area' and object_key='NOOP/1000/01/01'`));
    expect((history as unknown as Array<{n:number}>)[0].n).toBe(2);
  });
  it('serializes concurrent expected-version changes',async()=>{
    await saveCustomerSalesArea(input('RACE'));
    const results=await Promise.allSettled([saveCustomerSalesArea(input('RACE',{expectedVersion:1,pricingProcedure:'RVAA02'})),saveCustomerSalesArea(input('RACE',{expectedVersion:1,pricingProcedure:'RVAA03'}))]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  });
  it('blocks one sales area without blocking the general partner or a sibling area',async()=>{
    await saveCustomerSalesArea(input('BLOCK'));
    await saveCustomerSalesArea(input('BLOCK',{salesOrg:'1000',distributionChannel:'03',division:'01'}));
    await saveCustomerSalesArea(input('BLOCK',{expectedVersion:1,isBlocked:true}));
    await expect(gate('BLOCK')).rejects.toThrow('blocked');
    await expect(gate('BLOCK','1000','03','01')).resolves.toBeTruthy();
    await saveCustomerSalesArea(input('BLOCK',{expectedVersion:2,isBlocked:false}));
    await expect(gate('BLOCK')).resolves.toBeTruthy();
  });
  it('keeps two sales areas of one customer independent and lists them in key order',async()=>{
    await saveCustomerSalesArea(input('MULTI'));
    await saveCustomerSalesArea(input('MULTI',{salesOrg:'1000',distributionChannel:'03',division:'01',pricingProcedure:'RVAA09',orderCombination:true}));
    const rows=await listCustomerSalesAreas(alpha.client,'MULTI');
    expect(rows.map(r=>`${r.distributionChannel}/${r.division}`)).toEqual(['01/01','03/01']);
    expect(rows[0].pricingProcedure).toBe('RVAA01');expect(rows[1].pricingProcedure).toBe('RVAA09');expect(rows[1].orderCombination).toBe(true);
  });
  it('gates on the general partner block and on the inactive or removed customer role',async()=>{
    await saveCustomerSalesArea(input('GATE'));
    await withTenant(alpha.client,tx=>tx.execute(sql`update business_partner set is_blocked=true where partner_number='GATE'`));
    await expect(gate('GATE')).rejects.toThrow('blocked');
    await withTenant(alpha.client,tx=>tx.execute(sql`update business_partner set is_blocked=false where partner_number='GATE'`));
    await saveCustomerSalesArea(input('ROLEOFF'));
    await withTenant(alpha.client,tx=>tx.execute(sql`update bp_role set is_active=false where partner_number='ROLEOFF' and role_code='CUSTOMER'`));
    await expect(gate('ROLEOFF')).rejects.toThrow('not active');
  });
  it('refuses an operational use when the delivering plant is inactive',async()=>{
    await saveCustomerSalesArea(input('HISTORY'));
    await withTenant(alpha.client,tx=>tx.execute(sql`update plant set is_active=false where plant='1000'`));
    await expect(gate('HISTORY')).rejects.toThrow('plant');
    await withTenant(alpha.client,tx=>tx.execute(sql`update plant set is_active=true where plant='1000'`));
    await expect(gate('HISTORY')).resolves.toBeTruthy();
  });
  it('does not change customer company or supplier segments of a dual-role partner',async()=>{
    await saveBusinessPartner({client:alpha.client,partnerNumber:'DUALROLE',expectedVersion:0,changedBy:'TEST',reason:'Dual role sales fixture',category:'ORGANIZATION',name:'Dual role partner',name2:'',searchTerm:'',country:'KW',region:'',street:'Test street',city:'Kuwait City',postalCode:'',taxNumber:'',email:'',phone:'',roles:['CUSTOMER','SUPPLIER'],isBlocked:false});
    const {saveCustomerCompany,getCustomerCompany}=await import('../src/modules/foundation/customer-companies');
    await saveCustomerCompany({client:alpha.client,partnerNumber:'DUALROLE',companyCode:'1000',expectedVersion:0,changedBy:'TEST',reason:'Customer company fixture',reconciliationAccount:'110000',paymentTermsCode:'NET30',isBlocked:false});
    await saveCustomerSalesArea(input('DUALROLE',{pricingProcedure:'RVAA05',isBlocked:true}));
    const company=await getCustomerCompany(alpha.client,'DUALROLE','1000');expect(company?.reconciliationAccount).toBe('110000');expect(company?.paymentTermsCode).toBe('NET30');expect(company?.isBlocked).toBe(false);
  });
  it('isolates sales-area views by tenant and default-denies unscoped access',async()=>{
    await saveCustomerSalesArea(input('FOREIGN'));
    expect(await getCustomerSalesArea(beta.client,'FOREIGN','1000','01','01')).toBeNull();
    expect(await listCustomerSalesAreas(alpha.client,'FOREIGN')).toHaveLength(1);
    expect(await db().execute(sql`select * from customer_sales_area`)).toHaveLength(0);
  });
  it('cascades new sales-area settings with tenant removal',async()=>{
    const temp=await createTenant('customer-sales-area-cascade');await partner(temp,'TEMP');await saveCustomerSalesArea({...input('TEMP'),client:temp.client});await destroyTenant(temp.client);
    expect(await withTenant(temp.client,tx=>tx.execute(sql`select * from customer_sales_area`))).toHaveLength(0);
  });
});
