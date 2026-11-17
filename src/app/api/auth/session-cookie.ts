import type { NextResponse } from 'next/server';

import { SESSION_COOKIE, SESSION_TTL_MINUTES } from '@/platform/auth/session';

/** The one place the session cookie is written, shared by the password and second-factor handlers. */
export function setSessionCookie(response: NextResponse, tenant: string, token: string): void {
  response.cookies.set(SESSION_COOKIE, `${tenant}.${token}`, {
    httpOnly: true,
    sameSite: 'lax',
    // Secure only where the connection is secure, so local development over
    // plain HTTP still works without a flag that lies about the transport.
    secure: (process.env.APP_BASE_URL ?? '').startsWith('https://'),
    path: '/',
    maxAge: SESSION_TTL_MINUTES * 60,
  });
}
