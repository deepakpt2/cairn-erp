'use server';
import { revalidatePath } from 'next/cache';
import { requireSession, requireCapability, AuthzError } from '@/platform/auth/current';
import { savePaymentTerms, PaymentTermsError } from '@/modules/foundation/payment-terms';
import type { BaselineSource } from '@/modules/foundation/payment-term-dates';
import { t } from '@/platform/i18n';
export interface TermsState { ok:boolean; message?:string; remedy?:string; code?:string; version?:number }
export async function savePaymentTermAction(_previous:TermsState,form:FormData):Promise<TermsState>{
  const session=await requireSession('/config/payment-terms');
  const read=(key:string)=>String(form.get(key)??'').trim();
  const days=(key:string)=>read(key)===''?null:Number(read(key));
  try{
    await requireCapability('CFG.FIN.PAYTERMS.DEFINE',session);
    const result=await savePaymentTerms({client:session.user.client,changedBy:session.user.username,reason:read('reason'),expectedVersion:Number(read('expectedVersion')),
      values:{termsCode:read('termsCode'),description:read('description'),baselineSource:read('baselineSource') as BaselineSource,netDays:Number(read('netDays')),
        discount1Days:days('discount1Days'),discount1Percent:read('discount1Percent'),discount2Days:days('discount2Days'),discount2Percent:read('discount2Percent'),isActive:form.get('isActive')==='on'}});
    revalidatePath('/config/payment-terms');revalidatePath('/config');
    return {ok:true,message:t(result.changed?'pt.saved':'pt.unchanged'),code:read('termsCode'),version:result.version};
  }catch(error){
    if(error instanceof PaymentTermsError||error instanceof AuthzError)return {ok:false,message:error.message,remedy:error.remedy};
    throw error;
  }
}
