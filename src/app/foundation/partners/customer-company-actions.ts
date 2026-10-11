'use server';
import { revalidatePath } from 'next/cache';
import { requireSession,requireCapability,AuthzError } from '@/platform/auth/current';
import { saveCustomerCompany,CustomerCompanyError } from '@/modules/foundation/customer-companies';
import { t } from '@/platform/i18n';
export interface CompanyState{ok:boolean;message?:string;remedy?:string;version?:number;status?:string}
export async function saveCustomerCompanyAction(_previous:CompanyState,form:FormData):Promise<CompanyState>{
  const session=await requireSession('/foundation/partners');const read=(key:string)=>String(form.get(key)??'').trim();
  try{
    await requireCapability('FIN.CUSTOMER.COMPANY.MAINTAIN',session);
    const result=await saveCustomerCompany({client:session.user.client,changedBy:session.user.username,partnerNumber:read('partnerNumber'),companyCode:read('companyCode'),expectedVersion:Number(read('expectedVersion')),reconciliationAccount:read('reconciliationAccount'),paymentTermsCode:read('paymentTermsCode'),
      paymentMethods:read('paymentMethods').toUpperCase(),dunningProcedure:read('dunningProcedure').toUpperCase(),isBlocked:form.get('isBlocked')==='on',reason:read('reason')});
    revalidatePath('/foundation/partners');
    return {ok:true,message:t(result.changed?'custco.saved':'custco.unchanged',{status:t(`bp.status.${result.status}`)}),version:result.version,status:result.status};
  }catch(error){if(error instanceof CustomerCompanyError||error instanceof AuthzError)return {ok:false,message:error.message,remedy:error.remedy};throw error;}
}
