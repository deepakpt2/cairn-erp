/** Validated supplier/company master writes; invoice services must snapshot these assignments. */
import { z } from 'zod';
import { and,eq,asc,sql } from 'drizzle-orm';
import { withTenant,type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { companyCode } from './schema';
import { glAccount,journalEntryLine } from '../finance/schema';
import { businessPartner,bpRole } from './business-partner-schema';
import { paymentTerms } from './payment-terms-schema';
import { supplierCompany } from './supplier-company-schema';
import { requireGeneralPartner } from './business-partners';
export class SupplierCompanyError extends Error{
  constructor(message:string,readonly remedy='Review supplier company settings and try again.'){super(message);}
}
const inputSchema=z.object({client:z.string().regex(/^[A-Za-z0-9]{2,4}$/),partnerNumber:z.string().regex(/^[A-Z0-9][A-Z0-9_.-]{0,39}$/),companyCode:z.string().regex(/^[A-Z0-9]{2,10}$/),
  expectedVersion:z.number().int().nonnegative(),changedBy:z.string().min(1).max(60),reason:z.string().trim().min(3).max(500),reconciliationAccount:z.string().trim().max(20),paymentTermsCode:z.string().trim().max(12),isBlocked:z.boolean()});
export type SupplierCompanyInput=z.input<typeof inputSchema>;
const key=(client:string,partner:string,company:string)=>and(eq(supplierCompany.client,client),eq(supplierCompany.partnerNumber,partner),eq(supplierCompany.companyCode,company));
async function validateAssignments(tx:Tx,client:string,company:string,account:string|null,terms:string|null){
  const [site]=await tx.select().from(companyCode).where(and(eq(companyCode.client,client),eq(companyCode.companyCode,company)));
  if(!site?.isActive)throw new SupplierCompanyError('Company code is missing or inactive.');
  if(account){const [gl]=await tx.select().from(glAccount).where(and(eq(glAccount.client,client),eq(glAccount.chartOfAccounts,site.chartOfAccounts),eq(glAccount.accountNumber,account)));
    if(!gl||gl.isBlocked||gl.reconciliationType!=='VENDOR')throw new SupplierCompanyError('Use an unblocked supplier reconciliation account in the company chart.');}
  if(terms){const [term]=await tx.select().from(paymentTerms).where(and(eq(paymentTerms.client,client),eq(paymentTerms.termsCode,terms)));if(!term?.isActive)throw new SupplierCompanyError('Payment terms are missing or inactive.');}
  return site;
}
export async function saveSupplierCompany(raw:SupplierCompanyInput){
  const parsed=inputSchema.safeParse(raw);if(!parsed.success)throw new SupplierCompanyError(parsed.error.issues[0].message);
  const {client,partnerNumber,companyCode:company,expectedVersion,changedBy,reason,...input}=parsed.data;
  return withTenant(client,async tx=>{
    // Same general identity lock: role deactivation/blocking cannot race this maintenance.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/business_partner/${partnerNumber}`},0))`);
    const [partner]=await tx.select().from(businessPartner).where(and(eq(businessPartner.client,client),eq(businessPartner.partnerNumber,partnerNumber)));
    const [role]=await tx.select().from(bpRole).where(and(eq(bpRole.client,client),eq(bpRole.partnerNumber,partnerNumber),eq(bpRole.roleCode,'SUPPLIER')));
    if(!partner||!role?.isActive)throw new SupplierCompanyError('An existing active supplier role is required.','Create/activate the general Supplier role first.');
    const account=input.reconciliationAccount||null,terms=input.paymentTermsCode||null;
    const site=await validateAssignments(tx,client,company,account,terms);
    const [before]=await tx.select().from(supplierCompany).where(key(client,partnerNumber,company)).for('update');
    if((before?.version??0)!==expectedVersion)throw new SupplierCompanyError('Supplier company view changed after it was opened.','Reload the current company view before saving.');
    const values={chartOfAccounts:site.chartOfAccounts,reconciliationAccount:account,paymentTermsCode:terms,isBlocked:input.isBlocked};
    if(before&&Object.entries(values).every(([k,v])=>(before as Record<string,unknown>)[k]===v))return {changed:false,version:before.version,status:before.companyStatus};
    if(before&&before.reconciliationAccount!==account){
      const history=await tx.select({line:journalEntryLine.lineNumber}).from(journalEntryLine).where(and(eq(journalEntryLine.client,client),eq(journalEntryLine.businessPartner,partnerNumber),eq(journalEntryLine.companyCode,company))).limit(1);
      if(history.length)throw new SupplierCompanyError('Reconciliation assignment cannot change here after linked accounting exists.','Use a reviewed reconciliation migration; posted accounting facts remain unchanged.');
    }
    const complete=!!(account&&terms);const companyStatus=!complete?'INCOMPLETE':!before||before.companyStatus==='INCOMPLETE'?'CREATED':'MAINTAINED';const version=(before?.version??0)+1;
    if(before)await tx.update(supplierCompany).set({...values,companyStatus,version,changedBy,changedAt:new Date()}).where(key(client,partnerNumber,company));
    else await tx.insert(supplierCompany).values({...values,client,partnerNumber,companyCode:company,roleCode:'SUPPLIER',companyStatus,version,createdBy:changedBy});
    const snapshot=(row:Record<string,unknown>)=>Object.fromEntries(Object.keys(values).map(k=>[k,row[k]]));
    await recordChange(tx,{client,objectClass:'supplier_company_code',objectKey:`${partnerNumber}/${company}`,changeType:!before?'CREATE':before.isBlocked!==input.isBlocked?input.isBlocked?'BLOCK':'UNBLOCK':'CHANGE',changedBy,reason,
      transactionCode:'FIN.SUPPLIER.COMPANY.MAINTAIN',before:before?{...snapshot(before),companyStatus:before.companyStatus}:undefined,after:{...values,companyStatus},securityRelevantFields:['chartOfAccounts','reconciliationAccount','paymentTermsCode','isBlocked']});
    return {changed:true,version,status:companyStatus};
  });
}
export async function getSupplierCompany(client:string,partner:string,company:string){return withTenant(client,async tx=>(await tx.select().from(supplierCompany).where(key(client,partner,company)))[0]??null);}
export async function listSupplierCompanies(client:string,partner:string){return withTenant(client,tx=>tx.select().from(supplierCompany).where(and(eq(supplierCompany.client,client),eq(supplierCompany.partnerNumber,partner))).orderBy(asc(supplierCompany.companyCode)));}
export async function requireSupplierCompany(tx:Tx,client:string,partner:string,company:string){
  await requireGeneralPartner(tx,client,partner,'SUPPLIER');
  const [segment]=await tx.select().from(supplierCompany).where(key(client,partner,company));
  if(!segment||segment.companyStatus==='INCOMPLETE'||segment.isBlocked)throw new SupplierCompanyError('Supplier company data is missing, incomplete or blocked.');
  const site=await validateAssignments(tx,client,company,segment.reconciliationAccount,segment.paymentTermsCode);
  if(site.chartOfAccounts!==segment.chartOfAccounts)throw new SupplierCompanyError('Company chart assignment changed; review supplier reconciliation settings.');
  return segment;
}
