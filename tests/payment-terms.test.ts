import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTenant, destroyTenant, withTenant, closeDb, type TestTenant } from './helpers';
import { applyPaymentTermDefaults, getPaymentTerms, listPaymentTerms, paymentSchedule, savePaymentTerms, type PaymentTermValues } from '../src/modules/foundation/payment-terms';
import { calendarDate, calculatePaymentSchedule } from '../src/modules/foundation/payment-term-dates';
import { db } from '../src/platform/db/client';
let alpha:TestTenant;let beta:TestTenant;
beforeAll(async()=>{alpha=await createTenant('payment-alpha');beta=await createTenant('payment-beta');});
afterAll(async()=>{await destroyTenant(alpha.client);await destroyTenant(beta.client);await closeDb();});
const rule=(code='CUSTOM'):PaymentTermValues=>({termsCode:code,description:'Custom payment terms',baselineSource:'DOCUMENT_DATE',netDays:30,discount1Days:10,discount1Percent:'2.00',discount2Days:20,discount2Percent:'1.00',isActive:true});
const save=(values:PaymentTermValues,expectedVersion=0)=>savePaymentTerms({client:alpha.client,values,expectedVersion,changedBy:'TEST',reason:'Payment terms test'});

describe('payment-term master',()=>{
  it('activates five standard terms for a fresh tenant',async()=>{
    const rows=await listPaymentTerms(alpha.client);expect(rows).toHaveLength(5);expect(rows.map(x=>x.termsCode)).toContain('NET30');
  });
  it('creates exact discount percentages and audited configuration',async()=>{
    expect(await save(rule())).toEqual({changed:true,version:1});
    const row=await getPaymentTerms(alpha.client,'CUSTOM');expect(row?.discount1Percent).toBe('2.00');expect(row?.discount2Percent).toBe('1.00');
    const log=await withTenant(alpha.client,(tx)=>tx.execute(sql`select count(*)::int as n from change_document where object_class='payment_terms' and object_key='CUSTOM'`));
    expect((log as unknown as Array<{n:number}>)[0].n).toBe(1);
  });
  it('preserves version and audit on no-op and rejects stale edits',async()=>{
    await save(rule('NOOP'));
    expect(await save(rule('NOOP'),1)).toEqual({changed:false,version:1});
    await save({...rule('NOOP'),netDays:45},1);
    await expect(save({...rule('NOOP'),netDays:60},1)).rejects.toThrow('changed after');
    expect((await getPaymentTerms(alpha.client,'NOOP'))?.netDays).toBe(45);
  });
  it('serializes competing edits using one expected version',async()=>{
    await save(rule('RACE'));
    const results=await Promise.allSettled([save({...rule('RACE'),netDays:40},1),save({...rule('RACE'),netDays:50},1)]);
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(results.filter(x=>x.status==='rejected')).toHaveLength(1);
  });
  it('standard activation is additive and never overwrites existing definitions',async()=>{
    const net=await getPaymentTerms(alpha.client,'NET30');
    await save({...rule('NET30'),netDays:45},net!.version);
    await withTenant(alpha.client,(tx)=>applyPaymentTermDefaults(tx,alpha.client,'TEST'));
    expect((await getPaymentTerms(alpha.client,'NET30'))?.netDays).toBe(45);
  });
  it.each([
    {discount1Percent:'2.001'}, {discount1Days:31}, {discount2Days:5}, {discount2Percent:'3.00'},
    {discount1Days:null,discount1Percent:'2.00'}, {netDays:-1},
  ])('rejects invalid rule without inserting %j',async(patch)=>{
    await expect(save({...rule('INVALID'),...patch})).rejects.toThrow();expect(await getPaymentTerms(alpha.client,'INVALID')).toBeNull();
  });
  it('rejects runtime use of an inactive term',async()=>{
    await save({...rule('INACTIVE'),isActive:false});
    await expect(paymentSchedule(alpha.client,'INACTIVE',{DOCUMENT_DATE:'2026-01-01'})).rejects.toThrow('inactive');
  });
  it('isolates identically coded terms and default-denies unscoped reads',async()=>{
    await save(rule('ISOLATED'));
    expect(await getPaymentTerms(beta.client,'ISOLATED')).toBeNull();
    const result=await db().execute(sql`select * from payment_terms`);expect(result).toHaveLength(0);
  });
  it('enforces null/percent coherence in the database as well as service validation',async()=>{
    await expect(withTenant(alpha.client,(tx)=>tx.execute(sql`insert into payment_terms(client,terms_code,description,net_days,discount1_percent) values(${alpha.client},'BADSQL','Bad SQL',30,2)`))).rejects.toThrow();
  });
  it('tenant deletion cascades the new payment-term rows',async()=>{
    const temporary=await createTenant('payment-cascade');await destroyTenant(temporary.client);
    const rows=await withTenant(temporary.client,(tx)=>tx.execute(sql`select * from payment_terms`));expect(rows).toHaveLength(0);
  });
});

describe('payment due-date snapshot calculation',()=>{
  const snapshot={...rule(),version:7};
  it('handles month-end and leap-year dates in UTC calendar days',()=>{
    expect(calculatePaymentSchedule(snapshot,{DOCUMENT_DATE:'2024-01-31'}).netDueDate).toBe('2024-03-01');
    expect(calculatePaymentSchedule(snapshot,{DOCUMENT_DATE:'2026-01-31'}).netDueDate).toBe('2026-03-02');
  });
  it('returns immutable-consumer dates/percentages plus master version',()=>{
    const result=calculatePaymentSchedule(snapshot,{DOCUMENT_DATE:'2026-10-10'});
    expect(result.termsVersion).toBe(7);expect(result.netDueDate).toBe('2026-11-09');
    expect(result.discounts).toEqual([{untilDate:'2026-10-20',percent:'2.00'},{untilDate:'2026-10-30',percent:'1.00'}]);
  });
  it('selects posting/entry baseline explicitly and never silently falls back',()=>{
    const rule2={...snapshot,baselineSource:'POSTING_DATE' as const};
    expect(calculatePaymentSchedule(rule2,{DOCUMENT_DATE:'2026-01-01',POSTING_DATE:'2026-02-01'}).netDueDate).toBe('2026-03-03');
    expect(()=>calculatePaymentSchedule(rule2,{DOCUMENT_DATE:'2026-01-01'})).toThrow('POSTING_DATE');
  });
  it('rejects nonexistent calendar dates',()=>{
    expect(()=>calendarDate('2026-02-29')).toThrow();expect(()=>calendarDate('2026-13-01')).toThrow();
  });
});
