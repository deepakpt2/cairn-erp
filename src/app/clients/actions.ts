'use server';

/**
 * Tenant onboarding action — CAIRN.md §7.2, D-006
 *
 * The product owner creates their own tenant through this screen, one page at a
 * time, during testing. That makes this a first-class feature rather than a seed
 * script — and it is the live demonstration of requirement R-06.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createTenant, TenancyError } from '@/platform/tenancy';
import { getSession } from '@/platform/auth/current';
import { assertProvisioningToken, authorizeProvisioning, ProvisioningError } from '@/platform/tenancy/provisioning';
import { t } from '@/platform/i18n';

export interface OnboardState {
  ok: boolean;
  message?: string;
  remedy?: string;
  field?: string;
}

export async function createTenantAction(
  _previous: OnboardState,
  formData: FormData,
): Promise<OnboardState> {
  const read = (name: string) => String(formData.get(name) ?? '').trim();
  const inputUsername = read('username');

  // Creation type decides what the tenant starts with (R-75). Copying is offered on the
  // screen and refused here as well, because a button disabled in the browser is not a
  // refusal: a forged POST would otherwise create a tenant nobody asked for. Nothing is
  // written and no source tenant is read, which is why the form renders no picker.
  const creationType = read('creationType') || 'empty';
  if (creationType === 'copy') {
    return {
      ok: false,
      field: 'creationType',
      message: t('onboard.creationType.copy.refused'),
      remedy: t('onboard.creationType.copy.remedy'),
    };
  }

  try {
    const environment = process.env.CAIRN_ENV;
    const configuredToken = process.env.CAIRN_PROVISIONING_TOKEN;
    const suppliedToken = read('provisioningToken');
    // Reject arbitrary POSTs before password hashing or any tenant write.
    assertProvisioningToken(environment, configuredToken, suppliedToken);
    const session = environment === 'development' ? null : await getSession();
    const result = await createTenant({
      clientKey: read('clientKey'),
      name: read('name'),
      legalName: read('legalName') || undefined,
      country: read('country') || 'KW',
      currency: read('currency') || 'USD',
      timezone: read('timezone') || 'UTC',
      isDevelopment: formData.get('isDevelopment') === 'on',
      activateStandardPackage: creationType === 'standard',
      // The form no longer asks for a company code, a company name, a chart of accounts
      // or a fiscal year variant: SCR-032 took the enterprise structure and the financial
      // basis off this screen. The two defaults below stay only until step B2 removes the
      // fields from CreateTenantInput and the service owns them; without them the tenant
      // settings would record no variant while the package creates K4.
      fiscalYearVariant: 'K4',
      chartOfAccounts: 'CA01',
      administrator: {
        username: read('username'),
        fullName: read('fullName'),
        email: read('email') || undefined,
        password: String(formData.get('password') ?? ''),
      },
      createdBy: session?.user.username ?? (environment === 'development' ? 'ONBOARDING' : 'OWNER_BOOTSTRAP'),
    }, (tx) => authorizeProvisioning(tx, { environment, configuredToken, suppliedToken, session }));

    revalidatePath('/clients');

    // Straight to the logon screen, with the fields filled in. The person who
    // just created the tenant has no session yet — the screen they created is the
    // one that issued the first user account — so sending them anywhere else would
    // only bounce them back through a redirect they did not ask for.
    const next = new URLSearchParams({
      client: result.client,
      created: '1',
      username: inputUsername,
      next: '/config',
    });
    redirect(`/signin?${next.toString()}`);
  } catch (error) {
    if (error instanceof TenancyError || error instanceof ProvisioningError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    // Re-throw redirects and anything we do not recognise.
    throw error;
  }
}
