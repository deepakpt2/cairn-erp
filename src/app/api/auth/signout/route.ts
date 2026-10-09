/**
 * Sign out — CAIRN.md §23.
 *
 * Revokes the session server-side before clearing the cookie. Clearing the cookie
 * alone would leave a live session that could be replayed by anyone who had
 * captured it; revocation is the event, the cookie is only its echo.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { relativeRedirect } from '@/app/api/auth/redirect';
import { withTenant } from '@/platform/db/client';
import { SESSION_COOKIE, parseSessionCookie, revokeSession } from '@/platform/auth/session';

export async function POST(request: NextRequest) {
  const parsed = parseSessionCookie(request.cookies.get(SESSION_COOKIE)?.value);

  if (parsed) {
    await withTenant(parsed.client, (tx) =>
      revokeSession(tx, { client: parsed.client, token: parsed.token }),
    );
  }

  const response = relativeRedirect('/signin');
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
