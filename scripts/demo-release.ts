/**
 * Adds the demo purchase-order release strategies to an already provisioned
 * demo tenant (fresh provisioning does the same through the procurement phase).
 * Idempotent. Usage: set -a; . ./.env; set +a; npx tsx scripts/demo-release.ts
 */
import { DEMO_ACTOR, DEMO_IDENTITY } from '../src/platform/tenancy/demo-organisation';
import { ensureDemoReleaseStrategies } from '../src/platform/tenancy/demo-release';

ensureDemoReleaseStrategies(DEMO_IDENTITY.clientKey, DEMO_ACTOR)
  .then((result) => { console.log(JSON.stringify(result)); process.exit(0); })
  .catch((error) => { console.error(error); process.exit(1); });
