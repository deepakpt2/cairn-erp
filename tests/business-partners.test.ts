import { beforeAll,afterAll,describe,expect,it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTenant,destroyTenant,withTenant,closeDb,type TestTenant } from './helpers';
import { db } from '../src/platform/db/client';
import { saveBusinessPartner,getBusinessPartner,listBusinessPartners,requireGeneralPartner,type PartnerInput } from '../src/modules/foundation/business-partners';
let alpha:TestTenant;let beta:TestTenant;
beforeAll(async()=>{alpha=await createTenant('partner-alpha');beta=await createTenant('partner-beta');});
afterAll(async()=>{await destroyTenant(alpha.client);await destroyTenant(beta.client);await closeDb();});
function input(code:string,patch:Partial<PartnerInput>={}):PartnerInput{return {client:alpha.client,partnerNumber:code,expectedVersion:0,changedBy:'TEST',reason:'Partner backend test',category:'ORGANIZATION',name:'Example Industrial Supply',name2:'',searchTerm:'EXAMPLE',country:'KW',region:'Farwaniya',street:'Test Street 10',city:'Kuwait City',postalCode:'80000',taxNumber:'DEMO-TAX-001',email:'orders@example.com',phone:'+965 5550 0100',roles:['SUPPLIER'],isBlocked:false,...patch};}
describe('general business partner master',()=>{
  it('creates a complete supplier identity without company/purchasing segments',async()=>{
    expect(await saveBusinessPartner(input('SUPP-001'))).toEqual({changed:true,version:1,status:'CREATED'});
    const row=await getBusinessPartner(alpha.client,'SUPP-001');expect(row?.general.name).toBe('Example Industrial Supply');expect(row?.roles.map(x=>x.roleCode)).toEqual(['SUPPLIER']);
  });
  it('stages incomplete general data and completes it later',async()=>{
    expect((await saveBusinessPartner(input('STAGED',{name:'',country:'',city:''}))).status).toBe('INCOMPLETE');
    await expect(withTenant(alpha.client,tx=>requireGeneralPartner(tx,alpha.client,'STAGED','SUPPLIER'))).rejects.toThrow('incomplete');
    expect((await saveBusinessPartner(input('STAGED',{expectedVersion:1}))).status).toBe('CREATED');
  });
  it('supports supplier and customer roles on one stable identity',async()=>{
    await saveBusinessPartner(input('DUAL',{roles:['SUPPLIER','CUSTOMER']}));
    const row=await getBusinessPartner(alpha.client,'DUAL');expect(row?.roles).toHaveLength(2);
    await expect(withTenant(alpha.client,tx=>requireGeneralPartner(tx,alpha.client,'DUAL','CUSTOMER'))).resolves.toMatchObject({partnerNumber:'DUAL'});
  });
  it('role deactivation/reactivation preserves original role rows',async()=>{
    await saveBusinessPartner(input('ROLES',{roles:['SUPPLIER','CUSTOMER']}));const before=await getBusinessPartner(alpha.client,'ROLES');
    await saveBusinessPartner(input('ROLES',{roles:['CUSTOMER'],expectedVersion:1}));
    const inactive=await getBusinessPartner(alpha.client,'ROLES');expect(inactive?.roles.find(r=>r.roleCode==='SUPPLIER')?.isActive).toBe(false);
    await expect(withTenant(alpha.client,tx=>requireGeneralPartner(tx,alpha.client,'ROLES','SUPPLIER'))).rejects.toThrow('not active');
    await saveBusinessPartner(input('ROLES',{roles:['SUPPLIER','CUSTOMER'],expectedVersion:2}));
    const after=await getBusinessPartner(alpha.client,'ROLES');expect(after?.roles[0].createdAt).toEqual(before?.roles[0].createdAt);
  });
  it('preserves no-op version/audit and refuses stale updates',async()=>{
    await saveBusinessPartner(input('NOOP'));
    expect(await saveBusinessPartner(input('NOOP',{expectedVersion:1}))).toEqual({changed:false,version:1,status:'CREATED'});
    await saveBusinessPartner(input('NOOP',{expectedVersion:1,name:'Revised example company'}));
    await expect(saveBusinessPartner(input('NOOP',{expectedVersion:1,name:'Stale company'}))).rejects.toThrow('changed after');
    const rows=await withTenant(alpha.client,tx=>tx.execute(sql`select count(*)::int as n from change_document where object_class='business_partner' and object_key='NOOP'`));expect((rows as unknown as Array<{n:number}>)[0].n).toBe(2);
  });
  it('serializes competing edits of the same version',async()=>{
    await saveBusinessPartner(input('RACE'));
    const results=await Promise.allSettled([saveBusinessPartner(input('RACE',{expectedVersion:1,name:'First company'})),saveBusinessPartner(input('RACE',{expectedVersion:1,name:'Second company'}))]);
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(results.filter(x=>x.status==='rejected')).toHaveLength(1);
  });
  it('blocks operational use and audits the supplied reason',async()=>{
    await saveBusinessPartner(input('BLOCK'));
    await saveBusinessPartner(input('BLOCK',{expectedVersion:1,isBlocked:true,reason:'Compliance review hold'}));
    await expect(withTenant(alpha.client,tx=>requireGeneralPartner(tx,alpha.client,'BLOCK','SUPPLIER'))).rejects.toThrow('blocked');
    await saveBusinessPartner(input('BLOCK',{expectedVersion:2,isBlocked:false,reason:'Compliance review cleared'}));
    await expect(withTenant(alpha.client,tx=>requireGeneralPartner(tx,alpha.client,'BLOCK','SUPPLIER'))).resolves.toBeTruthy();
  });
  it.each([
    {country:'ZZ'},{email:'invalid-email'},{partnerNumber:'lowercase'},{roles:['SUPPLIER','SUPPLIER'] as PartnerInput['roles']},{reason:''},
  ])('rejects invalid input before storing %j',async(patch)=>{
    await expect(saveBusinessPartner(input('INVALID',patch))).rejects.toThrow();expect(await getBusinessPartner(alpha.client,'INVALID')).toBeNull();
  });
  it('refuses category conversion after creation',async()=>{
    await saveBusinessPartner(input('CATEGORY'));
    await expect(saveBusinessPartner(input('CATEGORY',{expectedVersion:1,category:'PERSON'}))).rejects.toThrow('immutable');
  });
  it('isolates identical partner numbers and default-denies unscoped reads',async()=>{
    await saveBusinessPartner(input('ISOLATED'));
    expect(await getBusinessPartner(beta.client,'ISOLATED')).toBeNull();
    expect(await db().execute(sql`select * from business_partner`)).toHaveLength(0);
    expect(await db().execute(sql`select * from bp_role`)).toHaveLength(0);
  });
  it('finds partners by number/name/search term',async()=>{
    expect((await listBusinessPartners(alpha.client,'SUPP-001')).map(r=>r.partnerNumber)).toContain('SUPP-001');
    expect((await listBusinessPartners(alpha.client,'EXAMPLE')).length).toBeGreaterThan(0);
  });
  it('cascades both tables on tenant removal',async()=>{
    const temp=await createTenant('partner-cascade');await saveBusinessPartner({...input('TEMP'),client:temp.client});await destroyTenant(temp.client);
    expect(await withTenant(temp.client,tx=>tx.execute(sql`select * from business_partner`))).toHaveLength(0);
    expect(await withTenant(temp.client,tx=>tx.execute(sql`select * from bp_role`))).toHaveLength(0);
  });
});
