'use server';
import { revalidatePath } from 'next/cache';
import { requireSession,requireCapability,AuthzError } from '@/platform/auth/current';
import { saveSupplierPurchasing,SupplierPurchasingError,type SupplierPurchasingInput } from '@/modules/foundation/supplier-purchasing';
import { t } from '@/platform/i18n';
export interface PurchasingState{ok:boolean;message?:string;remedy?:string;version?:number;status?:string}
export async function saveSupplierPurchasingAction(_previous:PurchasingState,form:FormData):Promise<PurchasingState>{
  const session=await requireSession('/foundation/partners');const read=(key:string)=>String(form.get(key)??'').trim();
  try{
    await requireCapability('PROC.SUPPLIER.PURCHASING.MAINTAIN',session);
    const result=await saveSupplierPurchasing({client:session.user.client,changedBy:session.user.username,partnerNumber:read('partnerNumber'),purchasingOrg:read('purchasingOrg'),expectedVersion:Number(read('expectedVersion')),orderCurrency:read('orderCurrency'),purchasingGroup:read('purchasingGroup'),incotermsCode:read('incotermsCode') as SupplierPurchasingInput['incotermsCode'],incotermsLocation:read('incotermsLocation'),paymentTermsCode:read('paymentTermsCode'),isBlocked:form.get('isBlocked')==='on',reason:read('reason')});
    revalidatePath('/foundation/partners');
    return {ok:true,message:t(result.changed?'sp.saved':'sp.unchanged',{status:t(`bp.status.${result.status}`)}),version:result.version,status:result.status};
  }catch(error){if(error instanceof SupplierPurchasingError||error instanceof AuthzError)return {ok:false,message:error.message,remedy:error.remedy};throw error;}
}
