/** Validated customer/company master writes; invoice services must snapshot these assignments. */
import { z } from 'zod';
import { and,eq,asc,sql } from 'drizzle-orm';
import { withTenant,type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { companyCode } from './schema';
import { glAccount,journalEntryLine } from '../finance/schema';
import { businessPartner,bpRole } from './business-partner-schema';
import { paymentTerms } from './payment-terms-schema';
import { customerCompany } from './customer-company-schema';
import { requireGeneralPartner } from './business-partners';
export class CustomerCompanyError extends Error{
  constructor(message:string,readonly remedy='Review customer company settings and try again.'){super(message);}
}
const inputSchema=z.object({client:z.string().regex(/^[A-Za-z0-9]{2,4}$/),partnerNumber:z.string().regex(/^[A-Z0-9][A-Z0-9_.-]{0,39}$/),companyCode:z.string().regex(/^[A-Z0-9]{2,10}$/),
  expectedVersion:z.number().int().nonnegative(),changedBy:z.string().min(1).max(60),reason:z.string().trim().min(3).max(500),reconciliationAccount:z.string().trim().max(20),paymentTermsCode:z.string().trim().max(12),isBlocked:z.boolean()});
export type CustomerCompanyInput=z.input<typeof inputSchema>;
const key=(client:string,partner:string,company:string)=>and(eq(customerCompany.client,client),eq(customerCompany.partnerNumber,partner),eq(customerCompany.companyCode,company));
async function validateAssignments(tx:Tx,client:string,company:string,account:string|null,terms:string|null){
  const [site]=await tx.select().from(companyCode).where(and(eq(companyCode.client,client),eq(companyCode.companyCode,company)));
  if(!site?.isActive)throw new CustomerCompanyError('Company code is missing or inactive.');
  if(account){const [gl]=await tx.select().from(glAccount).where(and(eq(glAccount.client,client),eq(glAccount.chartOfAccounts,site.chartOfAccounts),eq(glAccount.accountNumber,account)));
    if(!gl||gl.isBlocked||gl.reconciliationType!=='CUSTOMER')throw new CustomerCompanyError('Use an unblocked customer reconciliation account in the company chart.');}
  if(terms){const [term]=await tx.select().from(paymentTerms).where(and(eq(paymentTerms.client,client),eq(paymentTerms.termsCode,terms)));if(!term?.isActive)throw new CustomerCompanyError('Payment terms are missing or inactive.');}
  return site;
}
export async function saveCustomerCompany(raw:CustomerCompanyInput){
  const parsed=inputSchema.safeParse(raw);if(!parsed.success)throw new CustomerCompanyError(parsed.error.issues[0].message);
  const {client,partnerNumber,companyCode:company,expectedVersion,changedBy,reason,...input}=parsed.data;
  return withTenant(client,async tx=>{
    // Same general identity lock: role deactivation/blocking cannot race this maintenance.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/business_partner/${partnerNumber}`},0))`);
    const [partner]=await tx.select().from(businessPartner).where(and(eq(businessPartner.client,client),eq(businessPartner.partnerNumber,partnerNumber)));
    const [role]=await tx.select().from(bpRole).where(and(eq(bpRole.client,client),eq(bpRole.partnerNumber,partnerNumber),eq(bpRole.roleCode,'CUSTOMER')));
    if(!partner||!role?.isActive)throw new CustomerCompanyError('An existing active customer role is required.','Create/activate the general Customer role first.');
    const account=input.reconciliationAccount||null,terms=input.paymentTermsCode||null;
    const site=await validateAssignments(tx,client,company,account,terms);
    const [before]=await tx.select().from(customerCompany).where(key(client,partnerNumber,company)).for('update');
    if((before?.version??0)!==expectedVersion)throw new CustomerCompanyError('Customer company view changed after it was opened.','Reload the current company view before saving.');
    const values={chartOfAccounts:site.chartOfAccounts,reconciliationAccount:account,paymentTermsCode:terms,isBlocked:input.isBlocked};
    if(before&&Object.entries(values).every(([k,v])=>(before as Record<string,unknown>)[k]===v))return {changed:false,version:before.version,status:before.companyStatus};
    if(before&&(before.reconciliationAccount!==account||before.chartOfAccounts!==site.chartOfAccounts)){
      const history=await tx.select({line:journalEntryLine.lineNumber}).from(journalEntryLine).where(and(eq(journalEntryLine.client,client),eq(journalEntryLine.businessPartner,partnerNumber),eq(journalEntryLine.companyCode,company))).limit(1);
      if(history.length)throw new CustomerCompanyError('Reconciliation assignment cannot change here after linked accounting exists.','Use a reviewed reconciliation migration; posted accounting facts remain unchanged.');
    }
    const complete=!!(account&&terms);const companyStatus=!complete?'INCOMPLETE':!before||before.companyStatus==='INCOMPLETE'?'CREATED':'MAINTAINED';const version=(before?.version??0)+1;
    if(before)await tx.update(customerCompany).set({...values,companyStatus,version,changedBy,changedAt:new Date()}).where(key(client,partnerNumber,company));
    else await tx.insert(customerCompany).values({...values,client,partnerNumber,companyCode:company,roleCode:'CUSTOMER',companyStatus,version,createdBy:changedBy});
    const snapshot=(row:Record<string,unknown>)=>Object.fromEntries(Object.keys(values).map(k=>[k,row[k]]));
    await recordChange(tx,{client,objectClass:'customer_company_code',objectKey:`${partnerNumber}/${company}`,changeType:!before?'CREATE':before.isBlocked!==input.isBlocked?input.isBlocked?'BLOCK':'UNBLOCK':'CHANGE',changedBy,reason,
      transactionCode:'FIN.CUSTOMER.COMPANY.MAINTAIN',before:before?{...snapshot(before),companyStatus:before.companyStatus}:undefined,after:{...values,companyStatus},securityRelevantFields:['chartOfAccounts','reconciliationAccount','paymentTermsCode','isBlocked']});
    return {changed:true,version,status:companyStatus};
  });
}
export async function getCustomerCompany(client:string,partner:string,company:string){return withTenant(client,async tx=>(await tx.select().from(customerCompany).where(key(client,partner,company)))[0]??null);}
export async function listCustomerCompanies(client:string,partner:string){return withTenant(client,tx=>tx.select().from(customerCompany).where(and(eq(customerCompany.client,client),eq(customerCompany.partnerNumber,partner))).orderBy(asc(customerCompany.companyCode)));}
export async function requireCustomerCompany(tx:Tx,client:string,partner:string,company:string){
  await requireGeneralPartner(tx,client,partner,'CUSTOMER');
  const [segment]=await tx.select().from(customerCompany).where(key(client,partner,company));
  if(!segment||segment.companyStatus==='INCOMPLETE'||segment.isBlocked)throw new CustomerCompanyError('Customer company data is missing, incomplete or blocked.');
  const site=await validateAssignments(tx,client,company,segment.reconciliationAccount,segment.paymentTermsCode);
  if(site.chartOfAccounts!==segment.chartOfAccounts)throw new CustomerCompanyError('Company chart assignment changed; review customer reconciliation settings.');
  return segment;
}

export async function customerCompanyChoices(client:string,company:string){return withTenant(client,async tx=>{
  const companies=await tx.select({code:companyCode.companyCode,name:companyCode.name,chartOfAccounts:companyCode.chartOfAccounts,currency:companyCode.currency}).from(companyCode).where(eq(companyCode.isActive,true)).orderBy(asc(companyCode.companyCode));
  const selected=companies.find(row=>row.code===company);
  const accounts=selected?await tx.select({number:glAccount.accountNumber,name:glAccount.name}).from(glAccount).where(and(eq(glAccount.chartOfAccounts,selected.chartOfAccounts),eq(glAccount.reconciliationType,'CUSTOMER'),eq(glAccount.isBlocked,false))).orderBy(asc(glAccount.accountNumber)):[];
  const terms=await tx.select({code:paymentTerms.termsCode,description:paymentTerms.description}).from(paymentTerms).where(eq(paymentTerms.isActive,true)).orderBy(asc(paymentTerms.termsCode));
  return {companies,selected,accounts,terms};
});}
