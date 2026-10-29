/**
 * Reset password — CAIRN.md §23.
 *
 * Public token-completion page. Reads the reset token and tenant from the URL
 * search params and passes them to the client form component. The token is
 * never logged, stored in browser storage, or included in any URL other than
 * the one it arrived in.
 *
 * Server component wrapper: reads searchParams and passes them to the client
 * form, avoiding `useSearchParams()` (which requires Suspense during static
 * prerendering).
 */
import ResetPasswordForm from './ResetPasswordForm';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; token?: string }>;
}) {
  const params = await searchParams;
  const client = params.client ?? '';
  const token = params.token ?? '';

  if (!token || !client) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <div className="text-lg font-semibold tracking-tight text-ink">
              Reset password
            </div>
            <div className="text-xs text-ink-soft">
              A valid reset link is required. Please use the forgot-password
              link to request a reset.
            </div>
          </div>
          <p className="mt-4 text-center text-2xs text-ink-faint">
            <a href="/signin" className="link">Sign in</a>.
          </p>
        </div>
      </div>
    );
  }

  return <ResetPasswordForm client={client} token={token} />;
}
