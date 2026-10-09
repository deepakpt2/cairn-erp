/**
 * Sign in — CAIRN.md §23.
 *
 * A route handler rather than a server action, for one reason that matters: a
 * plain HTML form posting to a URL works with no client-side JavaScript, and it
 * can be exercised end to end by a script. The logon screen is the one screen that
 * must never depend on a framework detail.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { relativeRedirect } from '@/app/api/auth/redirect';
import { withTenant } from '@/platform/db/client';
import { AuthError, SESSION_COOKIE, SESSION_TTL_MINUTES, createSession, signIn } from '@/platform/auth/session';

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const tenant = String(form.get('client') ?? '').trim().toUpperCase();
  const username = String(form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const nextPath = safeNext(String(form.get('next') ?? ''));

  // Validate before the tenant key reaches a SET statement. Same discipline as
  // everywhere else: four alphanumerics, or nothing happens at all.
  if (!/^[A-Za-z0-9]{4}$/.test(tenant)) {
    return failure('CAIRN_AUTH_INVALID', tenant, username, nextPath);
  }

  if (!username || !password) {
    return failure('CAIRN_AUTH_INVALID', tenant, username, nextPath);
  }

  try {
    const user = await signIn({
      client: tenant,
      username,
      password,
      ipAddress: clientIp(request),
    });

    const { token } = await withTenant(tenant, (tx) =>
      createSession(tx, {
        client: tenant,
        userId: user.userId,
        ipAddress: clientIp(request),
        userAgent: request.headers.get('user-agent'),
      }),
    );

    const response = relativeRedirect(nextPath);

    response.cookies.set(SESSION_COOKIE, `${tenant}.${token}`, {
      httpOnly: true,
      sameSite: 'lax',
      // Secure only where the connection is secure, so local development over
      // plain HTTP still works without a flag that lies about the transport.
      secure: (process.env.APP_BASE_URL ?? '').startsWith('https://'),
      path: '/',
      maxAge: SESSION_TTL_MINUTES * 60,
    });

    return response;
  } catch (error) {
    const code = error instanceof AuthError ? error.code : 'CAIRN_AUTH';
    return failure(code, tenant, username, nextPath);
  }
}

/**
 * Send the user back to the logon screen with the reason.
 *
 * The code travels in the query string, not the message: the screen owns the
 * wording, so it stays consistent and translatable (R-19).
 */
function failure(code: string, tenant: string, username: string, nextPath: string) {
  const params = new URLSearchParams({ error: code });
  if (tenant) params.set('client', tenant);
  if (username) params.set('username', username);
  if (nextPath && nextPath !== '/') params.set('next', nextPath);
  return relativeRedirect(`/signin?${params.toString()}`);
}

/** Only a same-site path survives, so `next` cannot become an open redirect. */
function safeNext(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function clientIp(request: NextRequest): string | null {
  // Trusted only because the proxy sets it and nothing else can reach the app
  // (§22.7). Recorded for the access log, never used for a decision.
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    null
  );
}
