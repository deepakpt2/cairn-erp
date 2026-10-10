import { beforeAll,afterAll,describe,expect,it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTenant,destroyTenant,withTenant,closeDb,type TestTenant } from './helpers';
import { db } from '../src/platform/db/client';
import { saveBusinessPartner } from '../src/modules/foundation/business-partners';
import { saveSupplierPurchasing,getSupplierPurchasing,listSupplierPurchasing,requireSupplierPurchasing,type SupplierPurchasingInput } from '../src/modules/foundation/supplier-purchasing';
let alpha:TestTenant;let beta:TestTenant;
async function partner(tenant:TestTenant,number:string,roles:['SUPPLIER']|['CUSTOMER']=['SUPPLIER']){
  await saveBusinessPartner({client:tenant.client,partnerNumber:number,expectedVersion:0,changedBy:'TEST',reason:'Purchasing fixture setup',category:'ORGANIZATION',name:'Example supplier',name2:'',searchTerm:'',country:'KW',region:'',street:'Test street',city:'Kuwait City',postalCode:'',taxNumber:'',email:'',phone:'',roles,isBlocked:false});
}
beforeAll(async()=>{alpha=await createTenant('supplier-purchasing-alpha');beta=await createTenant('supplier-purchasing-beta');for(const n of ['STAGED','READY','NOOP','RACE','BLOCK','INVALID','MULTI','INACTIVE'])await partner(alpha,n);await partner(alpha,'CUSTOMERONLY',['CUSTOMER']);});
afterAll(async()=>{await destroyTenant(alpha.client);await destroyTenant(beta.client);await closeDb();});
const input=(number:string,patch:Partial<SupplierPurchasingInput>={}):SupplierPurchasingInput=>({client:alpha.client,partnerNumber:number,purchasingOrg:'1000',expectedVersion:0,changedBy:'TEST',reason:'Purchasing master test',orderCurrency:'USD',purchasingGroup:'001',incotermsCode:'FCA',incotermsLocation:'Kuwait City',paymentTermsCode:'NET30',isBlocked:false,...patch});
describe('supplier purchasing-organisation defaults',()=>{
  it('stages missing required defaults and delivery-term location',async()=>{
    expect((await saveSupplierPurchasing(input('STAGED',{orderCurrency:'',purchasingGroup:'',incotermsLocation:''}))).status).toBe('INCOMPLETE');
    await expect(withTenant(alpha.client,tx=>requireSupplierPurchasing(tx,alpha.client,'STAGED','1000'))).rejects.toThrow('incomplete');
    expect((await saveSupplierPurchasing(input('STAGED',{expectedVersion:1}))).status).toBe('CREATED');
  });
  it('validates current buying defaults and assigned plant without an accounting-company segment',async()=>{
    await saveSupplierPurchasing(input('READY'));
    await expect(withTenant(alpha.client,tx=>requireSupplierPurchasing(tx,alpha.client,'READY','1000','1000'))).resolves.toMatchObject({orderCurrency:'USD',incotermsCode:'FCA'});
    const companies=await withTenant(alpha.client,tx=>tx.execute(sql`select * from supplier_company_code where partner_number='READY'`));expect(companies).toHaveLength(0);
  });
  it('allows complete defaults without optional delivery terms or term override',async()=>{
    await partner(alpha,'OPTIONAL');expect((await saveSupplierPurchasing(input('OPTIONAL',{incotermsCode:'',incotermsLocation:'',paymentTermsCode:''}))).status).toBe('CREATED');
  });
  it('requires an active supplier role, never a customer-only identity',async()=>{
    await expect(saveSupplierPurchasing(input('CUSTOMERONLY'))).rejects.toThrow('active general Supplier');
    await expect(saveSupplierPurchasing(input('MISSING'))).rejects.toThrow('active general Supplier');
  });
  it.each([{purchasingOrg:'9999'},{orderCurrency:'ZZZ'},{purchasingGroup:'ZZZ'},{paymentTermsCode:'MISSING'},{incotermsCode:'BAD' as SupplierPurchasingInput['incotermsCode']},{incotermsCode:'' as const,incotermsLocation:'Location without code'},{reason:''}])('rejects invalid references/rules without writing %j',async(patch)=>{
    await expect(saveSupplierPurchasing(input('INVALID',patch))).rejects.toThrow();expect(await getSupplierPurchasing(alpha.client,'INVALID','1000')).toBeNull();
  });
  it('preserves no-op version/audit and rejects stale edits',async()=>{
    await saveSupplierPurchasing(input('NOOP'));expect(await saveSupplierPurchasing(input('NOOP',{expectedVersion:1}))).toEqual({changed:false,version:1,status:'CREATED'});
    await saveSupplierPurchasing(input('NOOP',{expectedVersion:1,paymentTermsCode:'NET15'}));
    await expect(saveSupplierPurchasing(input('NOOP',{expectedVersion:1,paymentTermsCode:'IMMEDIATE'}))).rejects.toThrow('changed after');
    const log=await withTenant(alpha.client,tx=>tx.execute(sql`select count(*)::int as n from change_document where object_class='supplier_purchasing_org' and object_key='NOOP/1000'`));expect((log as unknown as Array<{n:number}>)[0].n).toBe(2);
  });
  it('serializes concurrent changes',async()=>{
    await saveSupplierPurchasing(input('RACE'));const results=await Promise.allSettled([saveSupplierPurchasing(input('RACE',{expectedVersion:1,incotermsLocation:'Site A'})),saveSupplierPurchasing(input('RACE',{expectedVersion:1,incotermsLocation:'Site B'}))]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  });
  it('keeps blocks purchasing-specific and validates current operational references',async()=>{
    await saveSupplierPurchasing(input('BLOCK',{isBlocked:true}));await expect(withTenant(alpha.client,tx=>requireSupplierPurchasing(tx,alpha.client,'BLOCK','1000'))).rejects.toThrow('blocked');
    await saveSupplierPurchasing(input('BLOCK',{expectedVersion:1,isBlocked:false}));
    await withTenant(alpha.client,tx=>tx.execute(sql`update purchasing_group set is_active=false where purchasing_group='001'`));
    await expect(withTenant(alpha.client,tx=>requireSupplierPurchasing(tx,alpha.client,'BLOCK','1000'))).rejects.toThrow('active purchasing group');
    await withTenant(alpha.client,tx=>tx.execute(sql`update purchasing_group set is_active=true where purchasing_group='001'`));
  });
  it('keeps two organisation records independent and rejects cross-org group assignment',async()=>{
    await withTenant(alpha.client,async tx=>{
      await tx.execute(sql`insert into purchasing_org(client,purchasing_org,name,company_code,created_by) values(${alpha.client},'2000','Second buyer','1000','TEST')`);
      await tx.execute(sql`insert into purchasing_group(client,purchasing_group,name,purchasing_org,created_by) values(${alpha.client},'201','Second group','2000','TEST')`);
    });
    await saveSupplierPurchasing(input('MULTI'));
    await expect(saveSupplierPurchasing(input('MULTI',{purchasingOrg:'2000'}))).rejects.toThrow('valid for this organisation');
    await saveSupplierPurchasing(input('MULTI',{purchasingOrg:'2000',purchasingGroup:'201',orderCurrency:'KWD',isBlocked:true}));
    expect(await listSupplierPurchasing(alpha.client,'MULTI')).toHaveLength(2);expect((await getSupplierPurchasing(alpha.client,'MULTI','1000'))?.isBlocked).toBe(false);
  });
  it('requires a real active plant assignment when a plant is supplied',async()=>{
    await expect(withTenant(alpha.client,tx=>requireSupplierPurchasing(tx,alpha.client,'READY','1000','9999'))).rejects.toThrow('Plant');
    await withTenant(alpha.client,tx=>tx.execute(sql`delete from purchasing_org_plant where purchasing_org='1000' and plant='1000'`));
    await expect(withTenant(alpha.client,tx=>requireSupplierPurchasing(tx,alpha.client,'READY','1000','1000'))).rejects.toThrow('not assigned');
  });
  it('isolates same keys and default-denies unscoped reads',async()=>{
    expect(await getSupplierPurchasing(beta.client,'READY','1000')).toBeNull();expect(await db().execute(sql`select * from supplier_purchasing_org`)).toHaveLength(0);
  });
  it('rejects inactive purchasing term overrides',async()=>{
    await withTenant(alpha.client,tx=>tx.execute(sql`update payment_terms set is_active=false where terms_code='NET60'`));
    await expect(saveSupplierPurchasing(input('INACTIVE',{paymentTermsCode:'NET60'}))).rejects.toThrow('inactive');
  });
  it('cascades organisation defaults with tenant removal',async()=>{
    const temp=await createTenant('supplier-purchasing-cascade');await partner(temp,'TEMP');await saveSupplierPurchasing({...input('TEMP'),client:temp.client});await destroyTenant(temp.client);expect(await withTenant(temp.client,tx=>tx.execute(sql`select * from supplier_purchasing_org`))).toHaveLength(0);
  });
});
