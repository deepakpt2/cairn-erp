/**
 * Sign every demo account in, and leave nothing behind.
 *
 * The phase reports are read by a person who will then try to log in, so the
 * accounts are exercised through the product's own sign-in — not by comparing
 * hashes — and every session this opens is revoked before it exits.
 */
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';

import { signIn } from '../src/platform/auth/session';
import { withTenant } from '../src/platform/db/client';

const [, , clientArg, credentialsPath] = process.argv;
const client = clientArg || process.env.CAIRN_DEMO_CLIENT || '';

async function main() {
  const report = readFileSync(credentialsPath, 'utf8');
  // The report is written for a person, so the password sits on a labelled line of its
  // own. It is twenty characters of the unambiguous alphabet the generator uses.
  const shared = /(?:^|\s)([A-Za-z2-9]{20})(?:\s|$)/m.exec(report);
  if (!shared) throw new Error('The credentials report carries no generated password.');
  const password = shared[1];

  // Refuse to touch anything but the disposable demo database this report is written
  // from: signing eleven accounts in — and revoking every live session afterwards — is
  // only ever safe against an installation the demo provisioner completed, in the
  // database that is currently connected.
  const guard = await withTenant(client, async (tx) => tx.execute(sql`
    select database_name, status from demo_installation
     where database_name = current_database() and status = 'COMPLETED' limit 1
  `)) as unknown as Array<{ database_name: string; status: string }>;
  if (!guard.length) {
    throw new Error(`No completed demo installation in ${client} for the current database; refusing to sign anyone in.`);
  }

  const users = await withTenant(client, async (tx) => tx.execute(sql`
    select username from app_user where client = ${client} and is_active = true order by username
  `)) as unknown as Array<{ username: string }>;

  const results: string[] = [];
  let failed = 0;
  for (const row of users) {
    try {
      const user = await signIn({ client, username: row.username, password });
      results.push(`OK   ${row.username} (${user.userId.slice(0, 8)}…)`);
    } catch (error) {
      failed += 1;
      results.push(`FAIL ${row.username}: ${(error as Error).message}`);
    }
  }

  // Nothing is left signed in: the phase's own guarantee is zero live sessions.
  const revoked = await withTenant(client, async (tx) => tx.execute(sql`
    update user_session set revoked_at = now() where client = ${client} and revoked_at is null
  `)) as unknown as { count?: number };
  const live = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::text as n from user_session where client = ${client} and revoked_at is null
  `)) as unknown as Array<{ n: string }>;

  console.log(`accounts=${users.length} failed=${failed}`);
  for (const line of results) console.log(line);
  console.log(`live_sessions_after_revocation=${live[0]?.n ?? '?'}`);
  process.exit(failed === 0 && live[0]?.n === '0' ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
