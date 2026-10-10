/** General-only, audited partner service. No supplier/customer company or organisation data is fabricated. */
import { z } from 'zod';
import { and, eq, asc, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { country as countryReference } from '../../platform/tables/reference';
import { businessPartner, bpRole } from './business-partner-schema';
export const PARTNER_ROLES=['SUPPLIER','CUSTOMER'] as const;
export class PartnerError extends Error {
  constructor(message:string,readonly remedy='Review the partner data and try again.'){super(message);}
}
const optional=(max:number)=>z.string().trim().max(max).transform(v=>v||null);
const inputSchema=z.object({
  client:z.string().regex(/^[A-Za-z0-9]{2,4}$/),partnerNumber:z.string().regex(/^[A-Z0-9][A-Z0-9_.-]{0,39}$/),
  expectedVersion:z.number().int().nonnegative(),changedBy:z.string().min(1).max(60),reason:z.string().trim().min(3).max(500),
  category:z.enum(['ORGANIZATION','PERSON']),name:z.string().trim().max(160),name2:optional(160),searchTerm:optional(40),country:z.string().trim().regex(/^([A-Z]{2})?$/).transform(v=>v||null),
  region:optional(80),street:optional(180),city:optional(100),postalCode:optional(20),taxNumber:optional(40),
  email:z.string().trim().max(254).refine(v=>v===''||z.string().email().safeParse(v).success,'Enter a valid email address.').transform(v=>v||null),
  phone:optional(40),roles:z.array(z.enum(PARTNER_ROLES)).max(2).refine(v=>new Set(v).size===v.length,'Roles must not be duplicated.'),isBlocked:z.boolean(),
});
export type PartnerInput=z.input<typeof inputSchema>;
const key=(client:string,number:string)=>and(eq(businessPartner.client,client),eq(businessPartner.partnerNumber,number));
const roleKey=(client:string,number:string)=>and(eq(bpRole.client,client),eq(bpRole.partnerNumber,number));
export async function saveBusinessPartner(raw:PartnerInput){
  const parsed=inputSchema.safeParse(raw);if(!parsed.success)throw new PartnerError(parsed.error.issues[0].message);
  const {client,partnerNumber,expectedVersion,changedBy,reason,roles,...fields}=parsed.data;
  return withTenant(client,async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/business_partner/${partnerNumber}`},0))`);
    const [before]=await tx.select().from(businessPartner).where(key(client,partnerNumber)).for('update');
    if((before?.version??0)!==expectedVersion)throw new PartnerError('Partner changed after it was opened.','Reload the current version before saving.');
    if(before&&before.category!==fields.category)throw new PartnerError('Partner category is immutable after creation.','Create a different partner for a different category.');
    if(fields.country){const [ref]=await tx.select().from(countryReference).where(eq(countryReference.code,fields.country));if(!ref)throw new PartnerError('Country code is not configured.');}
    const previousRoles=await tx.select().from(bpRole).where(roleKey(client,partnerNumber));
    const oldActive=previousRoles.filter(r=>r.isActive).map(r=>r.roleCode).sort();const nextActive=[...roles].sort();
    if(before&&Object.entries(fields).every(([k,v])=>(before as Record<string,unknown>)[k]===v)&&JSON.stringify(oldActive)===JSON.stringify(nextActive))return {changed:false,version:before.version,status:before.generalStatus};
    const complete=!!(fields.name&&fields.country&&fields.city);
    const generalStatus=!complete?'INCOMPLETE':!before||before.generalStatus==='INCOMPLETE'?'CREATED':'MAINTAINED';
    const version=(before?.version??0)+1;
    if(before)await tx.update(businessPartner).set({...fields,generalStatus,version,changedBy,changedAt:new Date()}).where(key(client,partnerNumber));
    else await tx.insert(businessPartner).values({...fields,client,partnerNumber,generalStatus,version,createdBy:changedBy});
    // Never delete role identities: future segment/history references remain stable.
    for(const code of PARTNER_ROLES){
      const old=previousRoles.find(r=>r.roleCode===code);const active=roles.includes(code);
      if(old&&old.isActive!==active)await tx.update(bpRole).set({isActive:active,changedBy,changedAt:new Date()}).where(and(eq(bpRole.client,client),eq(bpRole.partnerNumber,partnerNumber),eq(bpRole.roleCode,code)));
      if(!old&&active)await tx.insert(bpRole).values({client,partnerNumber,roleCode:code,isActive:true,createdBy:changedBy});
    }
    const snapshot=(row:Record<string,unknown>)=>Object.fromEntries(Object.keys(fields).map(k=>[k,row[k]]));
    await recordChange(tx,{client,objectClass:'business_partner',objectKey:partnerNumber,changeType:!before?'CREATE':before.isBlocked!==fields.isBlocked?fields.isBlocked?'BLOCK':'UNBLOCK':'CHANGE',changedBy,reason,
      transactionCode:'FND.PARTNER.MAINTAIN',before:before?{...snapshot(before),roles:oldActive,generalStatus:before.generalStatus}:undefined,after:{...fields,roles:nextActive,generalStatus},
      securityRelevantFields:['taxNumber','roles','isBlocked','category']});
    return {changed:true,version,status:generalStatus};
  });
}
export async function getBusinessPartner(client:string,number:string){return withTenant(client,async tx=>{
  const [general]=await tx.select().from(businessPartner).where(key(client,number));if(!general)return null;
  const roles=await tx.select().from(bpRole).where(roleKey(client,number)).orderBy(asc(bpRole.roleCode));return {general,roles};
});}
export async function listBusinessPartners(client:string,query=''){return withTenant(client,async tx=>{
  const rows=await tx.select().from(businessPartner).orderBy(asc(businessPartner.partnerNumber));
  const term=query.trim().toLowerCase();return rows.filter(r=>!term||`${r.partnerNumber} ${r.name} ${r.searchTerm??''}`.toLowerCase().includes(term)).slice(0,200);
});}
export async function requireGeneralPartner(tx:Tx,client:string,number:string,role:typeof PARTNER_ROLES[number]){
  const [general]=await tx.select().from(businessPartner).where(key(client,number));
  if(!general||general.isBlocked||general.generalStatus==='INCOMPLETE')throw new PartnerError('General partner data is missing, incomplete or blocked.');
  const [assigned]=await tx.select().from(bpRole).where(and(roleKey(client,number),eq(bpRole.roleCode,role),eq(bpRole.isActive,true)));
  if(!assigned)throw new PartnerError('The requested partner role is not active.');
  return general;
}
