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

  // Creation type decides what the tenant starts with (R-75). Only the two values that
  // can proceed are forwarded as themselves; anything else, including a forged 'copy',
  // reaches the service, which refuses it before writing anything.
  const posted = read('creationType');
  const creationType = posted === 'standard' || posted === 'copy' ? posted : 'empty';

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
      creationType,
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
