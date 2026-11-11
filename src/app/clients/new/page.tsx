import TenantForm from './TenantForm';

export const dynamic = 'force-dynamic';

/**
 * Tenant creation has one gate: the owner token, checked when the form is submitted.
 *
 * The form itself is not a secret — what it can create is. It used to be hidden from
 * signed-in users once a tenant existed, on the theory that tenant creation had two
 * gates; now that the token is the only gate, hiding the form would only hide which
 * secret is needed, and first setup already showed the form to anyone who asked.
 */
export default async function CreateTenantPage() {
  if (process.env.CAIRN_ENV === 'development') return <TenantForm />;
  return <TenantForm requiresOwnerToken />;
}
