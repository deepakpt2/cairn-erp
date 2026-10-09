/**
 * A redirect that does not depend on knowing the host.
 *
 * `NextResponse.redirect` demands an absolute URL, and building it from
 * `request.url` produced `http://0.0.0.0:3000/...` — the address the server
 * happens to be bound to, not the address the browser used. Behind the reverse
 * proxy that would send the user to a host that does not resolve for them.
 *
 * A relative `Location` is what the browser resolves against the URL it already
 * has, so it is correct over plain HTTP, over the proxy, and through the preview
 * host, without any of them needing to be configured here.
 */
import { NextResponse } from 'next/server';

export function relativeRedirect(path: string, status: 303 | 302 = 303): NextResponse {
  return new NextResponse(null, { status, headers: { location: path } });
}
