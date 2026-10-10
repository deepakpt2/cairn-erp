import { requireSession, can } from '@/platform/auth/current';
import { listTenants } from '@/platform/tenancy';
import { PROVISION_CAPABILITY } from '@/platform/tenancy/provisioning';
import { t } from '@/platform/i18n';
import TenantForm from './TenantForm';

export const dynamic = 'force-dynamic';
export default async function CreateTenantPage() {
  if (process.env.CAIRN_ENV === 'development') return <TenantForm />;
  const initialized = (await listTenants()).length > 0;
  if (initialized) {
    const session = await requireSession('/clients/new');
    if (!can(session, PROVISION_CAPABILITY)) return <div className="panel m-6 p-6">{t('auth.missingAuthority', { authority: PROVISION_CAPABILITY })}</div>;
  }
  return <TenantForm requiresOwnerToken />;
}
