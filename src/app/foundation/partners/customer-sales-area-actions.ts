'use server';
import { revalidatePath } from 'next/cache';
import { requireSession,requireCapability,AuthzError } from '@/platform/auth/current';
import { saveCustomerSalesArea,CustomerSalesAreaError } from '@/modules/foundation/customer-sales-areas';
import { t } from '@/platform/i18n';
export interface SalesAreaState{ok:boolean;message?:string;remedy?:string;version?:number;status?:string}
export async function saveCustomerSalesAreaAction(_previous:SalesAreaState,form:FormData):Promise<SalesAreaState>{
  const session=await requireSession('/foundation/partners');const read=(key:string)=>String(form.get(key)??'').trim();
  try{
    await requireCapability('SALES.CUSTOMER.SALESAREA.MAINTAIN',session);
    const result=await saveCustomerSalesArea({client:session.user.client,changedBy:session.user.username,partnerNumber:read('partnerNumber'),
      salesOrg:read('salesOrg'),distributionChannel:read('distributionChannel'),division:read('division'),expectedVersion:Number(read('expectedVersion')),
      deliveringPlant:read('deliveringPlant').toUpperCase(),pricingProcedure:read('pricingProcedure').toUpperCase(),salesDistrict:read('salesDistrict').toUpperCase(),
      completeDelivery:form.get('completeDelivery')==='on',orderCombination:form.get('orderCombination')==='on',isBlocked:form.get('isBlocked')==='on',reason:read('reason')});
    revalidatePath('/foundation/partners');
    return {ok:true,message:t(result.changed?'csa.saved':'csa.unchanged',{status:t(`bp.status.${result.status}`)}),version:result.version,status:result.status};
  }catch(error){if(error instanceof CustomerSalesAreaError||error instanceof AuthzError)return {ok:false,message:error.message,remedy:error.remedy};throw error;}
}
