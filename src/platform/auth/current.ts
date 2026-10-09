/**
 * Reading the session on the server — CAIRN.md §23.
 *
 * Every protected screen starts by calling `requireSession()`. There is no
 * middleware doing a cheap cookie-presence check, and that is deliberate: a
 * request that merely *has* a cookie is not authenticated, and a guard that cannot
 * tell the difference teaches the reader to trust something that is not true. The
 * session is verified against the database, inside the tenant scope the cookie
 * names, at the point the screen asks for it.
 *
 * The tenant a screen operates on comes from here and nowhere else. An earlier
 * version of these pages accepted `?client=` in the query string, which was fine
 * as a development convenience and is not fine now that there is a session: it
 * would let a signed-in user of one tenant read another's ledgers, which is
 * exactly what the isolation tests exist to prevent.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { withTenant } from '../db/client';
import {
  SESSION_COOKIE,
  hasCapability,
  parseSessionCookie,
  resolveSession,
  type AuthenticatedUser,
  type SessionContext,
} from './session';

/** The session for this request, or null. Never throws for an absent session. */
export async function getSession(): Promise<SessionContext | null> {
  const store = await cookies();
  const parsed = parseSessionCookie(store.get(SESSION_COOKIE)?.value);
  if (!parsed) return null;

  return withTenant(parsed.client, (tx) =>
    resolveSession(tx, { client: parsed.client, token: parsed.token }),
  );
}

/**
 * The session, or a redirect to the logon screen.
 *
 * `next` carries the page the user was trying to reach, so signing in returns
 * them there rather than dumping them on the launchpad. Only the path is kept —
 * never a full URL, which would turn the logon screen into an open redirect.
 */
export async function requireSession(nextPath?: string): Promise<SessionContext> {
  const session = await getSession();
  if (session) return session;

  const next = nextPath ? `?next=${encodeURIComponent(nextPath)}` : '';
  redirect(`/signin${next}`);
}

/**
 * The session, and a named authority within it.
 *
 * Refuses with a message that names the missing authority rather than a bare
 * "access denied": a user should be told which authority they lack so they can ask
 * for the right one, and an administrator should be able to read the same sentence
 * back to them.
 */
export async function requireCapability(
  capability: string,
  session?: SessionContext,
): Promise<SessionContext & { user: AuthenticatedUser }> {
  const resolved = session ?? (await requireSession());

  if (!hasCapability(resolved.user.capabilities, capability)) {
    throw new AuthzError(capability, resolved.user.username);
  }

  return resolved;
}

export class AuthzError extends Error {
  readonly capability: string;
  readonly username: string;

  constructor(capability: string, username: string) {
    super(
      `User ${username} does not hold the authority ${capability}.`,
    );
    this.name = 'AuthzError';
    this.capability = capability;
    this.username = username;
  }

  get remedy(): string {
    return (
      `Ask an administrator to add the authority ${this.capability} to one of your ` +
      `roles. Authorities are maintained per role and are visible in the user's role list.`
    );
  }
}

/** Does the signed-in user hold this authority? For conditional rendering. */
export function can(session: SessionContext, capability: string): boolean {
  return hasCapability(session.user.capabilities, capability);
}
