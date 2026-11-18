import Link from 'next/link';
import { t } from '@/platform/i18n';
import { listTenants } from '@/platform/tenancy';
import { requireSession } from '@/platform/auth/current';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/** Tenant administration — CAIRN.md §6.3. The entry point to every other screen. */
export default async function TenantsPage() {
  const session = process.env.CAIRN_ENV === 'development' ? null : await requireSession('/clients');
  const allTenants = await listTenants();
  const tenants = session ? allTenants.filter((tenant) => tenant.client === session.user.client) : allTenants;

  return (
    <Page
      title={t('tenants.title')} code="CFG.PLT.CLIENT.DEFINE" width="5xl" back={null}
      description={t('tenants.subtitle')}
      actions={
        <>
          <LinkButton href="/clients/new" variant="primary">{t('tenants.create')}</LinkButton>
        </>
      }
    >

      {tenants.length === 0 ? (
        <div className="panel p-8 text-center">
          <p className="text-sm font-medium">{t('tenants.empty')}</p>
          <p className="mt-1 text-sm text-ink-soft">{t('tenants.emptyHint')}</p>
          <Link href="/clients/new" className="btn btn-primary mt-4">
            {t('tenants.create')}
          </Link>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-24">{t('tenants.column.key')}</th>
                <th>{t('tenants.column.name')}</th>
                <th className="w-24">{t('tenants.column.country')}</th>
                <th className="w-24">{t('tenants.column.currency')}</th>
                <th className="w-32">{t('tenants.column.status')}</th>
                <th className="w-32">{t('tenants.column.origin')}</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.client}>
                  <td className="code font-semibold">{tenant.client}</td>
                  <td>
                    <span className="font-medium">{tenant.name}</span>
                  </td>
                  <td className="code">{tenant.country}</td>
                  <td className="code">{tenant.currency}</td>
                  <td>
                    <span
                      className={`chip ${
                        tenant.status === 'ACTIVE' ? 'chip-ok' : 'chip-neutral'
                      }`}
                    >
                      {tenant.status}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`chip ${
                        tenant.is_development ? 'chip-info' : 'chip-neutral'
                      }`}
                    >
                      {tenant.is_development
                        ? t('tenants.origin.development')
                        : t('tenants.origin.owner')}
                    </span>
                  </td>
                  <td className="text-end">
                    <Link
                      href={`/config?client=${tenant.client}`}
                      className="text-accent hover:underline"
                    >
                      {t('nav.workbench')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
