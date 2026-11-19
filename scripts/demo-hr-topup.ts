/**
 * Bring an already-provisioned demo tenant up to the current people phase: position tiers, the HR positions,
 * the four HR accounts and the user-to-employee links. Additive and idempotent (the people phase adopts what
 * stands). It reuses the password in the existing credential file and rewrites that file with the new accounts.
 *
 * Run: set -a; . ./.env; set +a; CAIRN_ENV=production npx tsx scripts/demo-hr-topup.ts
 */
import { readFileSync } from 'node:fs';

import { closeDb } from '../src/platform/db/client';
import { validateTarget } from '../src/platform/db/target-guard';
import {
  DEFAULT_CREDENTIALS_DIR, DEMO_CREDENTIALS_FILENAME, renderDemoCredentialReport, writeDemoCredentials,
} from '../src/platform/tenancy/demo-credentials';
import { buildDemoPeople, listDemoAccounts } from '../src/platform/tenancy/demo-people';
import { buildDemoTimeline } from '../src/platform/tenancy/demo-provisioning';
import { DEMO_IDENTITY } from '../src/platform/tenancy/demo-organisation';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  await validateTarget(new URL(url).pathname.slice(1), undefined, url);
  const directory = process.env.CAIRN_DEMO_CREDENTIALS_DIR?.trim() || DEFAULT_CREDENTIALS_DIR;
  const file = `${directory}/${DEMO_CREDENTIALS_FILENAME}`;
  const password = /^\s*Password\s+(\S+)\s*$/m.exec(readFileSync(file, 'utf8'))?.[1];
  if (!password) throw new Error(`No password line in ${file}; run the full provisioner instead.`);

  const result = await buildDemoPeople({ client: DEMO_IDENTITY.clientKey, password, timeline: buildDemoTimeline() });
  const accounts = await listDemoAccounts(DEMO_IDENTITY.clientKey);
  writeDemoCredentials(renderDemoCredentialReport({
    loginUrl: process.env.CAIRN_DEMO_LOGIN_URL?.trim() || 'http://localhost:3000',
    tenant: process.env.CAIRN_DEMO_TENANT_NAME?.trim() || 'Cairn Demo',
    password, passwordGeneratedAt: null, accounts, filePath: file, hostPath: file, generatedAt: new Date().toISOString(),
  }), { directory });
  console.log(`Demo people up to date: ${result.positions} positions, ${result.employees} employees, ${accounts.length} accounts (credential file rewritten).`);
}

main().then(() => closeDb()).catch(async (error) => { console.error(error instanceof Error ? error.message : error); await closeDb(); process.exit(1); });
