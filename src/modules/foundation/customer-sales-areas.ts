/** Validated customer sales-area defaults (pricing/delivery only). Order, delivery and billing services must snapshot these values. */
import { z } from 'zod';
import { and,eq,asc,sql } from 'drizzle-orm';
import { withTenant,type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { companyCode,salesOrg,salesArea,plant } from './schema';
import { businessPartner,bpRole } from './business-partner-schema';
import { customerSalesArea } from './customer-sales-area-schema';
import { requireGeneralPartner } from './business-partners';
export class CustomerSalesAreaError extends Error{
  constructor(message:string,readonly remedy='Review the customer sales-area defaults and try again.'){super(message);}
}
const inputSchema=z.object({client:z.string().regex(/^[A-Za-z0-9]{2,4}$/),partnerNumber:z.string().regex(/^[A-Z0-9][A-Z0-9_.-]{0,39}$/),
  salesOrg:z.string().regex(/^[A-Z0-9]{2,10}$/),distributionChannel:z.string().regex(/^[A-Z0-9]{2,4}$/),division:z.string().regex(/^[A-Z0-9]{2,4}$/),
  expectedVersion:z.number().int().nonnegative(),changedBy:z.string().min(1).max(60),reason:z.string().trim().min(3).max(500),
  salesDistrict:z.string().trim().regex(/^([A-Z0-9]{1,6})?$/,'Sales district uses up to six capital letters or digits.'),
  deliveringPlant:z.string().trim().regex(/^([A-Z0-9]{1,10})?$/,'Delivering plant uses up to ten capital letters or digits.'),
  pricingProcedure:z.string().trim().regex(/^([A-Z0-9]{1,6})?$/,'Pricing procedure uses up to six capital letters or digits.'),
  completeDelivery:z.boolean(),orderCombination:z.boolean(),isBlocked:z.boolean()});
export type CustomerSalesAreaInput=z.input<typeof inputSchema>;
const key=(client:string,partner:string,org:string,channel:string,division:string)=>and(eq(customerSalesArea.client,client),eq(customerSalesArea.partnerNumber,partner),eq(customerSalesArea.salesOrg,org),eq(customerSalesArea.distributionChannel,channel),eq(customerSalesArea.division,division));
/** Sales area, its organisation and company must be active; a delivering plant must belong to that company code. */
async function validateSalesArea(tx:Tx,client:string,org:string,channel:string,division:string,plantCode:string|null){
  const [area]=await tx.select().from(salesArea).where(and(eq(salesArea.client,client),eq(salesArea.salesOrg,org),eq(salesArea.distributionChannel,channel),eq(salesArea.division,division)));
  if(!area?.isActive)throw new CustomerSalesAreaError('Sales area is missing or inactive.');
  const [organisation]=await tx.select().from(salesOrg).where(and(eq(salesOrg.client,client),eq(salesOrg.salesOrg,org)));
  if(!organisation?.isActive)throw new CustomerSalesAreaError('Sales organisation is missing or inactive.');
  const [company]=await tx.select().from(companyCode).where(and(eq(companyCode.client,client),eq(companyCode.companyCode,organisation.companyCode)));
  if(!company?.isActive)throw new CustomerSalesAreaError('Sales organisation must belong to an active company.');
  if(plantCode){
    const [site]=await tx.select().from(plant).where(and(eq(plant.client,client),eq(plant.plant,plantCode)));
    if(!site?.isActive)throw new CustomerSalesAreaError('Delivering plant is missing or inactive.');
    if(site.companyCode!==organisation.companyCode)throw new CustomerSalesAreaError('Delivering plant must belong to the sales organisation company code.');
  }
  return {area,organisation,company};
}
/** Writes one customer sales-area view. Staged saves are allowed; the operational gate is requireCustomerSalesArea. */
export async function saveCustomerSalesArea(raw:CustomerSalesAreaInput){
  const parsed=inputSchema.safeParse(raw);if(!parsed.success)throw new CustomerSalesAreaError(parsed.error.issues[0].message);
  const {client,partnerNumber,salesOrg:org,distributionChannel:channel,division,expectedVersion,changedBy,reason,...input}=parsed.data;
  return withTenant(client,async tx=>{
    // Same general identity lock as other partner segments: role deactivation/blocking cannot race this maintenance.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/business_partner/${partnerNumber}`},0))`);
    const [partner]=await tx.select().from(businessPartner).where(and(eq(businessPartner.client,client),eq(businessPartner.partnerNumber,partnerNumber)));
    const [role]=await tx.select().from(bpRole).where(and(eq(bpRole.client,client),eq(bpRole.partnerNumber,partnerNumber),eq(bpRole.roleCode,'CUSTOMER')));
    if(!partner||!role?.isActive)throw new CustomerSalesAreaError('An existing active customer role is required.','Create/activate the general Customer role first.');
    const values={salesDistrict:input.salesDistrict||null,deliveringPlant:input.deliveringPlant||null,pricingProcedure:input.pricingProcedure||null,
      completeDelivery:input.completeDelivery,orderCombination:input.orderCombination,isBlocked:input.isBlocked};
    await validateSalesArea(tx,client,org,channel,division,values.deliveringPlant);
    const [before]=await tx.select().from(customerSalesArea).where(key(client,partnerNumber,org,channel,division)).for('update');
    if((before?.version??0)!==expectedVersion)throw new CustomerSalesAreaError('Customer sales-area view changed after it was opened.','Reload the current sales-area view before saving.');
    if(before&&Object.entries(values).every(([k,v])=>(before as Record<string,unknown>)[k]===v))return {changed:false,version:before.version,status:before.salesStatus};
    // Delivery and pricing defaults are both needed for a complete sales-area view; flags are optional defaults.
    const complete=!!(values.deliveringPlant&&values.pricingProcedure);
    const salesStatus=!complete?'INCOMPLETE':!before||before.salesStatus==='INCOMPLETE'?'CREATED':'MAINTAINED';const version=(before?.version??0)+1;
    if(before)await tx.update(customerSalesArea).set({...values,salesStatus,version,changedBy,changedAt:new Date()}).where(key(client,partnerNumber,org,channel,division));
    else await tx.insert(customerSalesArea).values({...values,client,partnerNumber,salesOrg:org,distributionChannel:channel,division,roleCode:'CUSTOMER',salesStatus,version,createdBy:changedBy});
    const snapshot=(row:Record<string,unknown>)=>Object.fromEntries(Object.keys(values).map(k=>[k,row[k]]));
    await recordChange(tx,{client,objectClass:'customer_sales_area',objectKey:`${partnerNumber}/${org}/${channel}/${division}`,changeType:!before?'CREATE':before.isBlocked!==input.isBlocked?input.isBlocked?'BLOCK':'UNBLOCK':'CHANGE',changedBy,reason,
      transactionCode:'SALES.CUSTOMER.SALESAREA.MAINTAIN',before:before?{...snapshot(before),salesStatus:before.salesStatus}:undefined,after:{...values,salesStatus},
      securityRelevantFields:['deliveringPlant','pricingProcedure','completeDelivery','orderCombination','isBlocked']});
    return {changed:true,version,status:salesStatus};
  });
}
export async function getCustomerSalesArea(client:string,partner:string,org:string,channel:string,division:string){
  return withTenant(client,async tx=>(await tx.select().from(customerSalesArea).where(key(client,partner,org,channel,division)))[0]??null);
}
export async function listCustomerSalesAreas(client:string,partner:string){
  return withTenant(client,tx=>tx.select().from(customerSalesArea).where(and(eq(customerSalesArea.client,client),eq(customerSalesArea.partnerNumber,partner)))
    .orderBy(asc(customerSalesArea.salesOrg),asc(customerSalesArea.distributionChannel),asc(customerSalesArea.division)));
}
/** Operational gate for future order/delivery services: general Customer usable, segment complete/unblocked, references still active. */
export async function requireCustomerSalesArea(tx:Tx,client:string,partner:string,org:string,channel:string,division:string){
  await requireGeneralPartner(tx,client,partner,'CUSTOMER');
  const [segment]=await tx.select().from(customerSalesArea).where(key(client,partner,org,channel,division));
  if(!segment||segment.salesStatus==='INCOMPLETE'||segment.isBlocked)throw new CustomerSalesAreaError('Customer sales-area data is missing, incomplete or blocked.');
  await validateSalesArea(tx,client,org,channel,division,segment.deliveringPlant);
  return segment;
}
