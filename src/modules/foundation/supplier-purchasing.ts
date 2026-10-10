/** Audited purchasing-organisation defaults. Future PO services must snapshot these values. */
import { z } from 'zod';
import { and,eq,asc,sql } from 'drizzle-orm';
import { withTenant,type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { currency } from '../../platform/tables/reference';
import { companyCode,purchasingOrg,purchasingGroup,purchasingOrgPlant,plant as plantTable } from './schema';
import { businessPartner,bpRole } from './business-partner-schema';
import { paymentTerms } from './payment-terms-schema';
import { supplierPurchasing } from './supplier-purchasing-schema';
import { requireGeneralPartner } from './business-partners';
export const DELIVERY_TERMS=['EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP'] as const;
export class SupplierPurchasingError extends Error {constructor(message:string,readonly remedy='Review the supplier purchasing defaults and try again.'){super(message);}}
const inputSchema=z.object({client:z.string().regex(/^[A-Za-z0-9]{2,4}$/),partnerNumber:z.string().regex(/^[A-Z0-9][A-Z0-9_.-]{0,39}$/),purchasingOrg:z.string().regex(/^[A-Z0-9]{2,10}$/),
  expectedVersion:z.number().int().nonnegative(),changedBy:z.string().min(1).max(60),reason:z.string().trim().min(3).max(500),orderCurrency:z.string().regex(/^([A-Z]{3})?$/),purchasingGroup:z.string().trim().max(6),
  incotermsCode:z.union([z.literal(''),z.enum(DELIVERY_TERMS)]),incotermsLocation:z.string().trim().max(160),paymentTermsCode:z.string().trim().max(12),isBlocked:z.boolean()});
export type SupplierPurchasingInput=z.input<typeof inputSchema>;
const key=(client:string,partner:string,org:string)=>and(eq(supplierPurchasing.client,client),eq(supplierPurchasing.partnerNumber,partner),eq(supplierPurchasing.purchasingOrg,org));
async function validateAssignments(tx:Tx,client:string,org:string,cur:string|null,group:string|null,terms:string|null){
  const [scope]=await tx.select().from(purchasingOrg).where(and(eq(purchasingOrg.client,client),eq(purchasingOrg.purchasingOrg,org)));
  if(!scope?.isActive)throw new SupplierPurchasingError('Purchasing organisation is missing or inactive.');
  const [company]=await tx.select().from(companyCode).where(and(eq(companyCode.client,client),eq(companyCode.companyCode,scope.companyCode)));
  if(!company?.isActive)throw new SupplierPurchasingError('Purchasing organisation must belong to an active company.');
  if(cur){const [ref]=await tx.select().from(currency).where(eq(currency.code,cur));if(!ref?.isActive)throw new SupplierPurchasingError('Order currency is missing or inactive.');}
  if(group){const [buyer]=await tx.select().from(purchasingGroup).where(and(eq(purchasingGroup.client,client),eq(purchasingGroup.purchasingGroup,group)));
    if(!buyer?.isActive||(buyer.purchasingOrg&&buyer.purchasingOrg!==org))throw new SupplierPurchasingError('Choose an active purchasing group valid for this organisation.');}
  if(terms){const [term]=await tx.select().from(paymentTerms).where(and(eq(paymentTerms.client,client),eq(paymentTerms.termsCode,terms)));if(!term?.isActive)throw new SupplierPurchasingError('Purchasing payment terms are missing or inactive.');}
  return scope;
}
export async function saveSupplierPurchasing(raw:SupplierPurchasingInput){
  const parsed=inputSchema.safeParse(raw);if(!parsed.success)throw new SupplierPurchasingError(parsed.error.issues[0].message);
  const {client,partnerNumber,purchasingOrg:org,expectedVersion,changedBy,reason,...input}=parsed.data;
  return withTenant(client,async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/business_partner/${partnerNumber}`},0))`);
    const [general]=await tx.select().from(businessPartner).where(and(eq(businessPartner.client,client),eq(businessPartner.partnerNumber,partnerNumber)));
    const [role]=await tx.select().from(bpRole).where(and(eq(bpRole.client,client),eq(bpRole.partnerNumber,partnerNumber),eq(bpRole.roleCode,'SUPPLIER')));
    if(!general||!role?.isActive)throw new SupplierPurchasingError('An existing active general Supplier role is required.');
    const values={orderCurrency:input.orderCurrency||null,purchasingGroup:input.purchasingGroup||null,incotermsCode:input.incotermsCode||null,incotermsLocation:input.incotermsLocation||null,paymentTermsCode:input.paymentTermsCode||null,isBlocked:input.isBlocked};
    if(!values.incotermsCode&&values.incotermsLocation)throw new SupplierPurchasingError('A delivery-term location requires a delivery-term code.');
    await validateAssignments(tx,client,org,values.orderCurrency,values.purchasingGroup,values.paymentTermsCode);
    const [before]=await tx.select().from(supplierPurchasing).where(key(client,partnerNumber,org)).for('update');
    if((before?.version??0)!==expectedVersion)throw new SupplierPurchasingError('Supplier purchasing view changed after it was opened.','Reload this organisation view before saving.');
    if(before&&Object.entries(values).every(([k,v])=>(before as Record<string,unknown>)[k]===v))return {changed:false,version:before.version,status:before.purchasingStatus};
    const complete=!!(values.orderCurrency&&values.purchasingGroup&&(!values.incotermsCode||values.incotermsLocation));
    const purchasingStatus=!complete?'INCOMPLETE':!before||before.purchasingStatus==='INCOMPLETE'?'CREATED':'MAINTAINED';const version=(before?.version??0)+1;
    if(before)await tx.update(supplierPurchasing).set({...values,purchasingStatus,version,changedBy,changedAt:new Date()}).where(key(client,partnerNumber,org));
    else await tx.insert(supplierPurchasing).values({...values,client,partnerNumber,purchasingOrg:org,roleCode:'SUPPLIER',purchasingStatus,version,createdBy:changedBy});
    const snapshot=(row:Record<string,unknown>)=>Object.fromEntries(Object.keys(values).map(k=>[k,row[k]]));
    await recordChange(tx,{client,objectClass:'supplier_purchasing_org',objectKey:`${partnerNumber}/${org}`,changeType:!before?'CREATE':before.isBlocked!==input.isBlocked?input.isBlocked?'BLOCK':'UNBLOCK':'CHANGE',changedBy,reason,
      transactionCode:'PROC.SUPPLIER.PURCHASING.MAINTAIN',before:before?{...snapshot(before),purchasingStatus:before.purchasingStatus}:undefined,after:{...values,purchasingStatus},securityRelevantFields:['orderCurrency','incotermsCode','paymentTermsCode','isBlocked']});
    return {changed:true,version,status:purchasingStatus};
  });
}
export async function getSupplierPurchasing(client:string,partner:string,org:string){return withTenant(client,async tx=>(await tx.select().from(supplierPurchasing).where(key(client,partner,org)))[0]??null);}
export async function listSupplierPurchasing(client:string,partner:string){return withTenant(client,tx=>tx.select().from(supplierPurchasing).where(and(eq(supplierPurchasing.client,client),eq(supplierPurchasing.partnerNumber,partner))).orderBy(asc(supplierPurchasing.purchasingOrg)));}
export async function requireSupplierPurchasing(tx:Tx,client:string,partner:string,org:string,plant?:string){
  await requireGeneralPartner(tx,client,partner,'SUPPLIER');
  const [segment]=await tx.select().from(supplierPurchasing).where(key(client,partner,org));
  if(!segment||segment.purchasingStatus==='INCOMPLETE'||segment.isBlocked)throw new SupplierPurchasingError('Supplier purchasing defaults are missing, incomplete or blocked.');
  await validateAssignments(tx,client,org,segment.orderCurrency,segment.purchasingGroup,segment.paymentTermsCode);
  if(plant){const [site]=await tx.select().from(plantTable).where(and(eq(plantTable.client,client),eq(plantTable.plant,plant),eq(plantTable.isActive,true)));if(!site)throw new SupplierPurchasingError('Plant is missing or inactive.');const [assignment]=await tx.select().from(purchasingOrgPlant).where(and(eq(purchasingOrgPlant.client,client),eq(purchasingOrgPlant.purchasingOrg,org),eq(purchasingOrgPlant.plant,plant)));if(!assignment)throw new SupplierPurchasingError('The purchasing organisation is not assigned to this plant.');}
  return segment;
}

export async function supplierPurchasingChoices(client:string,org:string){return withTenant(client,async tx=>{
  const organisations=await tx.select({code:purchasingOrg.purchasingOrg,name:purchasingOrg.name,companyCode:purchasingOrg.companyCode,currency:companyCode.currency}).from(purchasingOrg).innerJoin(companyCode,and(eq(companyCode.client,purchasingOrg.client),eq(companyCode.companyCode,purchasingOrg.companyCode))).where(and(eq(purchasingOrg.isActive,true),eq(companyCode.isActive,true))).orderBy(asc(purchasingOrg.purchasingOrg));
  const selected=organisations.find(row=>row.code===org);
  const groups=await tx.select({code:purchasingGroup.purchasingGroup,name:purchasingGroup.name,org:purchasingGroup.purchasingOrg}).from(purchasingGroup).where(eq(purchasingGroup.isActive,true)).orderBy(asc(purchasingGroup.purchasingGroup));
  const currencies=await tx.select({code:currency.code,name:currency.name}).from(currency).where(eq(currency.isActive,true)).orderBy(asc(currency.code));
  const terms=await tx.select({code:paymentTerms.termsCode,description:paymentTerms.description}).from(paymentTerms).where(eq(paymentTerms.isActive,true)).orderBy(asc(paymentTerms.termsCode));
  return {organisations,selected,groups:groups.filter(row=>!row.org||row.org===org),currencies,terms};
});}
