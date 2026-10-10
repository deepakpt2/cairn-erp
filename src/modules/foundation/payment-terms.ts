/** Audited, versioned tenant payment terms. Called by trusted services/actions, never raw client RPC. */
import { z } from 'zod';
import { and, eq, asc, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { paymentTerms } from './payment-terms-schema';
import { BASELINE_SOURCES, calculatePaymentSchedule, type BaselineSource } from './payment-term-dates';

export class PaymentTermsError extends Error {
  constructor(message: string, readonly remedy = 'Review the payment-term values and try again.') { super(message); }
}
const percentage=z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,2})?$/, 'Use a percentage with up to 2 decimals.')
  .refine((v)=>toScaled(v,2)<=10000n,'Percentage must not exceed 100.').transform((v)=>fromScaled(toScaled(v,2),2));
const valuesSchema=z.object({
  termsCode:z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,11}$/), description:z.string().trim().min(1).max(160),
  baselineSource:z.enum(BASELINE_SOURCES), netDays:z.number().int().min(0).max(3650),
  discount1Days:z.number().int().min(0).max(3650).nullable(), discount1Percent:percentage,
  discount2Days:z.number().int().min(0).max(3650).nullable(), discount2Percent:percentage,
  isActive:z.boolean(),
}).superRefine((v,ctx)=>{
  const p1=toScaled(v.discount1Percent,2),p2=toScaled(v.discount2Percent,2);
  if ((v.discount1Days===null)!==(p1===0n)) ctx.addIssue({code:'custom',message:'First discount days and percentage must be enabled together.'});
  if ((v.discount2Days===null)!==(p2===0n)) ctx.addIssue({code:'custom',message:'Second discount days and percentage must be enabled together.'});
  if (v.discount1Days!==null && v.discount1Days>v.netDays) ctx.addIssue({code:'custom',message:'First discount deadline must not exceed net days.'});
  if (v.discount2Days!==null && (v.discount1Days===null || v.discount2Days<v.discount1Days || v.discount2Days>v.netDays || p2>p1)) ctx.addIssue({code:'custom',message:'Second discount must follow the first, precede net due date and not exceed its percentage.'});
});
export type PaymentTermValues=z.input<typeof valuesSchema>;
const inputSchema=z.object({ client:z.string().regex(/^[A-Za-z0-9]{2,4}$/), expectedVersion:z.number().int().nonnegative(),
  changedBy:z.string().min(1).max(60), reason:z.string().trim().min(3).max(500), values:valuesSchema });
export type PaymentTermInput=z.input<typeof inputSchema>;
const key=(client:string,code:string)=>and(eq(paymentTerms.client,client),eq(paymentTerms.termsCode,code));

export async function savePaymentTerms(raw:PaymentTermInput) {
  const parsed=inputSchema.safeParse(raw);
  if (!parsed.success) throw new PaymentTermsError(parsed.error.issues[0].message);
  const {client,expectedVersion,changedBy,reason,values}=parsed.data;
  return withTenant(client,async(tx)=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/payment_terms/${values.termsCode}`},0))`);
    const [before]=await tx.select().from(paymentTerms).where(key(client,values.termsCode)).for('update');
    if ((before?.version??0)!==expectedVersion) throw new PaymentTermsError('Payment terms changed after they were opened.','Reload the current version before saving.');
    const {termsCode,...fields}=values;
    if (before && Object.entries(fields).every(([k,v])=>(before as Record<string,unknown>)[k]===v)) { await markActivityComplete(tx,client,'CFG.FIN.PAYTERMS.DEFINE',changedBy); return {changed:false,version:before.version}; }
    const version=(before?.version??0)+1;
    if(before) await tx.update(paymentTerms).set({...fields,version,changedBy,changedAt:new Date()}).where(key(client,termsCode));
    else await tx.insert(paymentTerms).values({...values,client,version,createdBy:changedBy});
    const snapshot=(row:Record<string,unknown>)=>Object.fromEntries(Object.keys(fields).map((k)=>[k,row[k]]));
    await recordChange(tx,{client,objectClass:'payment_terms',objectKey:termsCode,changeType:before?'CHANGE':'CREATE',changedBy,reason,
      transactionCode:'CFG.FIN.PAYTERMS.DEFINE',before:before?snapshot(before):undefined,after:fields,
      securityRelevantFields:['baselineSource','netDays','discount1Days','discount1Percent','discount2Days','discount2Percent','isActive']});
    await markActivityComplete(tx,client,'CFG.FIN.PAYTERMS.DEFINE',changedBy);
    return {changed:true,version};
  });
}
export async function listPaymentTerms(client:string) { return withTenant(client,(tx)=>tx.select().from(paymentTerms).orderBy(asc(paymentTerms.termsCode))); }
export async function getPaymentTerms(client:string,code:string) { return withTenant(client,async(tx)=>(await tx.select().from(paymentTerms).where(key(client,code)))[0]??null); }
export async function paymentSchedule(client:string,code:string,dates:Partial<Record<BaselineSource,string>>) {
  const rule=await getPaymentTerms(client,code);
  if(!rule?.isActive) throw new PaymentTermsError('Payment terms do not exist or are inactive.','Choose an active payment term.');
  return calculatePaymentSchedule({...rule,baselineSource:rule.baselineSource as BaselineSource},dates);
}
export const STANDARD_PAYMENT_TERMS:PaymentTermValues[]=[
  ...[0,15,30,60].map((days)=>({termsCode:days===0?'IMMEDIATE':`NET${days}`,description:days===0?'Immediate payment':`Net ${days} days`,baselineSource:'DOCUMENT_DATE' as const,netDays:days,discount1Days:null,discount1Percent:'0.00',discount2Days:null,discount2Percent:'0.00',isActive:true})),
  {termsCode:'D2_10_NET30',description:'2 percent within 10 days, net 30',baselineSource:'DOCUMENT_DATE',netDays:30,discount1Days:10,discount1Percent:'2.00',discount2Days:null,discount2Percent:'0.00',isActive:true},
];
export async function applyPaymentTermDefaults(tx:Tx,client:string,actor:string) {
  for(const values of STANDARD_PAYMENT_TERMS){
    const inserted=await tx.insert(paymentTerms).values({...values,client,createdBy:actor}).onConflictDoNothing().returning();
    if(inserted.length) await recordChange(tx,{client,objectClass:'payment_terms',objectKey:values.termsCode,changeType:'CREATE',changedBy:actor,
      reason:'Standard payment-term configuration',transactionCode:'CFG.FIN.PAYTERMS.DEFINE',after:values});
  }
}
