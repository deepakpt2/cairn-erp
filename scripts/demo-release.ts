/**
 * Adds the demo release strategies, documents and release capabilities to an already provisioned
 * demo tenant (fresh provisioning does the same in phase D19_RELEASE). Idempotent.
 * Usage: set -a; . ./.env; set +a; npx tsx scripts/demo-release.ts
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../src/platform/db/client';
import { DEMO_ACTOR, DEMO_IDENTITY } from '../src/platform/tenancy/demo-organisation';
import { ensureDemoRelease } from '../src/platform/tenancy/demo-release';

async function main() {
  const client = DEMO_IDENTITY.clientKey;
  // Roles of a tenant provisioned before the finance release capabilities existed.
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into role_capability (client, role_code, capability_code, created_by)
      select ${client}, r.role_code, c.code, ${DEMO_ACTOR}
        from (values ('DEMO_ACCOUNTANT'), ('DEMO_CONTROLLER')) as r(role_code)
        cross join (values ('FIN.JOURNAL.RELEASE'), ('FIN.AP.PAYMENTRUN.RELEASE')) as c(code)
      on conflict do nothing
    `);
  });
  const today = new Date().toISOString().slice(0, 10);
  const result = await ensureDemoRelease(client, DEMO_ACTOR, { today, postingDate: today });
  console.log(JSON.stringify(result));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
