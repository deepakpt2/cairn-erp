/**
 * The India UAT dataset's test credentials, in the application.
 *
 * The same rows the installer writes to its mode-0600 credential file, shown here so a tester
 * who is already signed in does not have to open a file on the host. It is deliberately narrow:
 *
 *   - **Not in production.** Outside a development build the route answers 404 as though it did
 *     not exist, which is the same treatment any other absent route gets.
 *   - **Not a password store.** The passwords are read from the credential file the installer
 *     wrote, at the moment the page is rendered. The database holds a hash and cannot reproduce
 *     them; when the file is gone the page says so rather than showing a blank.
 *   - **Not the user directory.** It is a separate route precisely because the ordinary
 *     `/platform/users` screen must never carry a password column.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { notFound } from 'next/navigation';
import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { DEFAULT_CREDENTIALS_DIR, DEMO_CREDENTIALS_FILENAME } from '@/platform/tenancy/demo-credentials';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

interface CredentialRow {
  username: string;
  password: string;
  role: string;
  department: string;
  employee: string;
}

/**
 * Parse the credential file back into rows.
 *
 * The file is human-formatted, so this reads the ACCOUNTS table rather than trying to be
 * clever: a line after the header rule, with columns separated by two or more spaces.
 */
function readCredentialRows(directory: string): { rows: CredentialRow[]; missing: boolean } {
  let text: string;
  try {
    text = readFileSync(join(directory, DEMO_CREDENTIALS_FILENAME), 'utf8');
  } catch {
    return { rows: [], missing: true };
  }

  const lines = text.split('\n');
  const headerIndex = lines.findIndex((line) => line.includes('USERNAME') && line.includes('PASSWORD'));
  if (headerIndex < 0) return { rows: [], missing: false };

  const rows: CredentialRow[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim() || line.startsWith('-') || line.startsWith('=')) break;
    // username  password  role  department  employee (personnelNumber)
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 5) continue;
    const [username, password, role, department, ...rest] = parts;
    rows.push({
      username: username!,
      password: password!,
      role: role!,
      department: department!,
      employee: rest.join(' '),
    });
  }
  return { rows, missing: false };
}

export default async function TestCredentialsPage() {
  // A production build has no such page. The check comes before the session, so the route does
  // not even reveal that it exists to somebody who is signed in.
  if ((process.env.CAIRN_ENV ?? 'development') !== 'development') notFound();

  const session = await requireSession('/platform/users/test-credentials');
  const directory = process.env.CAIRN_DEMO_CREDENTIALS_DIR?.trim() || DEFAULT_CREDENTIALS_DIR;
  const { rows, missing } = readCredentialRows(directory);

  return (
    <Page
      title="UAT test credentials"
      description="Test-only sign-ins for the India UAT dataset. Disabled outside a development build."
      width="6xl"
      back={null}
    >
      <section className="panel p-4 text-sm" role="note">
        <p className="font-medium">These are test credentials for a fictional company.</p>
        <p className="mt-1 text-ink-soft">
          Every account has its own generated password so segregation of duties can be tested by
          signing in as each role. The passwords are read from the installer&apos;s credential
          file; the database holds only a hash and cannot reproduce them.
        </p>
      </section>

      {missing ? (
        <section className="panel panel-warning mt-4 p-4 text-sm" role="alert">
          <p className="font-medium">The credential file could not be read.</p>
          <p className="mt-1 text-ink-soft">
            Looked for <code>{join(directory, DEMO_CREDENTIALS_FILENAME)}</code>. If it was lost,
            the passwords cannot be recovered from the database; reinstall the dataset to issue new
            ones.
          </p>
        </section>
      ) : rows.length === 0 ? (
        <section className="panel mt-4 p-4 text-sm">
          <p>The credential file holds no account rows yet. Run the installer.</p>
        </section>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th scope="col">Username</th>
                <th scope="col">Password (test)</th>
                <th scope="col">Role</th>
                <th scope="col">Department</th>
                <th scope="col">Employee</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.username}>
                  <td className="font-mono">{row.username}</td>
                  <td className="font-mono">{row.password}</td>
                  <td>{row.role}</td>
                  <td>{row.department}</td>
                  <td>{row.employee}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-ink-soft">
        Signed in as {session.user.username}. The ordinary user directory is at{' '}
        <Link href="/platform/users" className="underline">/platform/users</Link>, which never
        shows a password.
      </p>
      <div className="mt-3">
        <LinkButton href="/platform/users" variant="default">Back to users</LinkButton>
      </div>
    </Page>
  );
}
