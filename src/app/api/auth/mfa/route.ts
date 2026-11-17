/**
 * Second factor — AUTH-01 §7. A route handler for the same reason sign-in is one: a plain HTML form
 * posting to a URL works with no client-side JavaScript. The session is created here, from the
 * challenge's user id, after `verifyChallenge` accepts the code — never from a form field.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { relativeRedirect } from '@/app/api/auth/redirect';
import { setSessionCookie } from '@/app/api/auth/session-cookie';
import { withTenant } from '@/platform/db/client';
import { MfaError, verifyChallenge } from '@/platform/auth/mfa';
import { createSession } from '@/platform/auth/session';

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const tenant = String(form.get('client') ?? '').trim().toUpperCase();
  const challengeId = String(form.get('challenge') ?? '');
  const code = String(form.get('code') ?? '');
  const enrol = form.get('enrol') === '1';
  const nextRaw = String(form.get('next') ?? '');
  const nextPath = nextRaw.startsWith('/') && !nextRaw.startsWith('//') && !nextRaw.includes('\\') ? nextRaw : '/';

  if (!/^[A-Za-z0-9]{4}$/.test(tenant) || !/^[0-9a-f-]{36}$/i.test(challengeId)) {
    return relativeRedirect('/signin?error=CAIRN_AUTH');
  }
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? null;

  try {
    const verified = await verifyChallenge({ client: tenant, challengeId, code, ipAddress: ip });
    const { token } = await withTenant(tenant, (tx) =>
      createSession(tx, { client: tenant, userId: verified.userId, ipAddress: ip, userAgent: request.headers.get('user-agent') }),
    );

    // Enrolment finished at sign-in: the recovery codes are shown once, on this response, then never again.
    const response = verified.recoveryCodes
      ? new NextResponse(recoveryCodesPage(verified.recoveryCodes, nextPath), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
      : relativeRedirect(nextPath);
    setSessionCookie(response, tenant, token);
    return response;
  } catch (error) {
    if (error instanceof MfaError) {
      if (error.code === 'CHALLENGE_DEAD' || error.code === 'CHALLENGE_INVALID') return relativeRedirect('/signin?error=CAIRN_AUTH_MFA_ENDED');
      const q = new URLSearchParams({ challenge: challengeId, client: tenant, error: error.code, left: String(error.attemptsLeft ?? '') });
      if (enrol) q.set('enrol', '1');
      if (nextPath !== '/') q.set('next', nextPath);
      return relativeRedirect(`/signin/mfa?${q.toString()}`);
    }
    return relativeRedirect('/signin?error=CAIRN_AUTH');
  }
}

function recoveryCodesPage(codes: string[], next: string): string {
  const list = codes.map((c) => `<li><code>${esc(c)}</code></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recovery codes</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}li{margin:.25rem 0}code{font-size:1.1rem}</style></head><body>
<h1>Save your recovery codes</h1>
<p>Two-factor authentication is on. Each code works once if you lose your authenticator. <strong>They are shown only now.</strong></p>
<ol>${list}</ol>
<p><a download="recovery-codes.txt" href="data:text/plain;charset=utf-8,${encodeURIComponent(codes.join('\n') + '\n')}">Download as a file</a></p>
<form method="get" action="${esc(next)}"><label><input type="checkbox" required> I have stored these codes somewhere safe.</label><p><button type="submit">Continue</button></p></form>
</body></html>`;
}
