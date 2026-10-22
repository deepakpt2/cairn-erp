'use server';
import { revalidatePath } from 'next/cache';
import { requireSession,requireCapability,AuthzError } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import { saveSupplierCompany,SupplierCompanyError } from '@/modules/foundation/supplier-companies';
import { t } from '@/platform/i18n';
export interface CompanyState{ok:boolean;message?:string;remedy?:string;version?:number;status?:string}
export async function saveSupplierCompanyAction(_previous:CompanyState,form:FormData):Promise<CompanyState>{
  const session=await requireSession('/foundation/partners');const read=(key:string)=>String(form.get(key)??'').trim();
  try{
    await requireCapability('FIN.SUPPLIER.COMPANY.MAINTAIN',session);
    await assertChangeForSession(session,{lockObject:'SUPPLIER_COMPANY',argument:`${read('partnerNumber')}/${read('companyCode')}`});
    const result=await saveSupplierCompany({client:session.user.client,changedBy:session.user.username,partnerNumber:read('partnerNumber'),companyCode:read('companyCode'),expectedVersion:Number(read('expectedVersion')),reconciliationAccount:read('reconciliationAccount'),paymentTermsCode:read('paymentTermsCode'),paymentMethods:form.has('paymentMethods')?read('paymentMethods'):undefined,isBlocked:form.get('isBlocked')==='on',reason:read('reason')});
    revalidatePath('/foundation/partners');
    return {ok:true,message:t(result.changed?'sc.saved':'sc.unchanged',{status:t(`bp.status.${result.status}`)}),version:result.version,status:result.status};
  }catch(error){if(error instanceof SupplierCompanyError||error instanceof AuthzError||error instanceof EnqueueError)return {ok:false,message:error.message,remedy:error.remedy};throw error;}
}
