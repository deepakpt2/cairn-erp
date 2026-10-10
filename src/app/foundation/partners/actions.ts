'use server';
import { revalidatePath } from 'next/cache';
import { requireSession, requireCapability, AuthzError } from '@/platform/auth/current';
import { saveBusinessPartner, PartnerError } from '@/modules/foundation/business-partners';
import type { PartnerInput } from '@/modules/foundation/business-partners';
import { t } from '@/platform/i18n';
export interface PartnerState {ok:boolean;message?:string;remedy?:string;number?:string;version?:number;status?:string}
export async function savePartnerAction(_previous:PartnerState,form:FormData):Promise<PartnerState>{
  const session=await requireSession('/foundation/partners');const read=(key:string)=>String(form.get(key)??'').trim();
  try{
    await requireCapability('FND.PARTNER.MAINTAIN',session);
    const result=await saveBusinessPartner({client:session.user.client,changedBy:session.user.username,expectedVersion:Number(read('expectedVersion')),reason:read('reason'),
      partnerNumber:read('partnerNumber'),category:read('category') as PartnerInput['category'],name:read('name'),name2:read('name2'),searchTerm:read('searchTerm'),country:read('country'),region:read('region'),street:read('street'),city:read('city'),postalCode:read('postalCode'),taxNumber:read('taxNumber'),email:read('email'),phone:read('phone'),roles:form.getAll('roles').map(String) as PartnerInput['roles'],isBlocked:form.get('isBlocked')==='on'});
    revalidatePath('/foundation/partners');
    return {ok:true,message:t(result.changed?'bp.saved':'bp.unchanged',{status:t(`bp.status.${result.status}`)}),number:read('partnerNumber'),version:result.version,status:result.status};
  }catch(error){if(error instanceof PartnerError||error instanceof AuthzError)return {ok:false,message:error.message,remedy:error.remedy};throw error;}
}
