/**
 * User administration — CAIRN.md §23, SCR-003 (SU01).
 *
 * Create users, view the user list, maintain details, and initiate password
 * resets. Application users stand apart from employee master records: a user
 * may exist without an employee link, and password recovery works for such
 * users through the forgot-password screen.
 *
 * Capability-gated: creating needs CFG.PLT.USER.CREATE, maintaining needs
 * CFG.PLT.USER.MAINTAIN, initiating a reset needs CFG.PLT.USER.PASSWORD_RESET.
 */
import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { CREATE, MAINTAIN, PASSWORD_RESET } from './constants';
import { listUsersAction } from './actions';
import Users from './Users';

const CREATE_ROUTE = '/platform/users/new';
const RESET_ROUTE = '/platform/users/reset';
const FORGOT_ROUTE = '/forgot-password';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const session = await requireSession('/platform/users');
  const client = session.user.client;

  const { ok, users } = await listUsersAction(client);
  const rows = ok ? (users ?? []) : [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{CREATE} · {MAINTAIN} · {PASSWORD_RESET}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Users</h1>
          <div className="flex gap-2">
            {can(session, CREATE) && (
              <Link
                href={CREATE_ROUTE}
                className="btn btn-default"
              >
                New user
              </Link>
            )}
            {can(session, PASSWORD_RESET) && (
              <Link
                href={RESET_ROUTE}
                className="btn btn-default"
              >
                Reset password
              </Link>
            )}
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
              Launchpad
            </Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          An application user is independent of an employee master record — a
          user may exist without one, and an employee may have no user account.
          Password reset touches only the user account, never HR data.
        </p>
      </header>

      {!can(session, MAINTAIN) && (
        <div className="p-3 border border-line rounded bg-warn-soft text-warn text-sm">
          This session does not hold {MAINTAIN}. User details can be read but
          not changed here.
        </div>
      )}

      <Users users={rows} canMaintain={can(session, MAINTAIN)} canReset={can(session, PASSWORD_RESET)} />

      <p className="mt-4 text-sm text-ink-faint">
        To reset a user's password, use <Link href={RESET_ROUTE}>Reset password</Link>.
        A user who has forgotten their own password uses <Link href={FORGOT_ROUTE}>Forgot password</Link> from the logon screen.
      </p>
    </div>
  );
}