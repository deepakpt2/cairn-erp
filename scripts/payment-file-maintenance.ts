/**
 * Operator maintenance for retained salary payment artifacts. Two read-mostly commands, neither of which
 * recalculates payroll or mutates old evidence:
 *
 *   sweep     — remove encrypted orphans (published `.enc` with no committed metadata row, older than the grace
 *               period) and stale staging temp files. Never deletes a referenced artifact.
 *   backfill  — retain EXACT legacy bytes for one owner when their integrity against the stored evidence can be
 *               checked (original stored plaintext body, or an immutable snapshot whose CSV the operator has
 *               verified). Writes nothing when byte equivalence cannot be established.
 *
 * Configuration (all via environment, never printed):
 *   DATABASE_URL                    the authorized runtime database
 *   CAIRN_PAYMENT_FILE_DIR          the private artifact directory (same as the app)
 *   CAIRN_BANK_DATA_KEYRING_JSON    the keyring (needed for backfill)
 *   CAIRN_ARTIFACT_TENANT           tenant key
 *   CAIRN_ARTIFACT_COMMAND          sweep | backfill
 *   CAIRN_ARTIFACT_OWNER_KIND       FILE | REISSUE   (backfill)
 *   CAIRN_ARTIFACT_OWNER_ID         preparation id / reissue id (backfill)
 *   CAIRN_ARTIFACT_OPERATOR         operator identifier for the audit column
 */
import { and, eq } from 'drizzle-orm';

import { closeDb, withTenant } from '../src/platform/db/client';
import { validateTarget } from '../src/platform/db/target-guard';
import { parseBankDataKeyring } from '../src/platform/security/bank-data-keyring';
import { backfillLegacyArtifact, sweepOrphans } from '../src/modules/people/payment-file-artifacts';
import { payrollPaymentFile, payrollPaymentReissue } from '../src/modules/people/schema';

const TENANT = process.env.CAIRN_ARTIFACT_TENANT ?? '';
const COMMAND = process.env.CAIRN_ARTIFACT_COMMAND ?? '';
const OPERATOR = (process.env.CAIRN_ARTIFACT_OPERATOR ?? 'ARTIFACT-MAINTENANCE').slice(0, 60);

function fail(message: string): never { throw new Error(message); }

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) fail('DATABASE_URL must name the authorized runtime database explicitly.');
  if (!process.env.CAIRN_PAYMENT_FILE_DIR) fail('CAIRN_PAYMENT_FILE_DIR must name the private artifact directory.');
  if (!/^[A-Za-z0-9]{2,4}$/.test(TENANT)) fail('CAIRN_ARTIFACT_TENANT must be a valid tenant key.');
  const databaseName = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, '');
  await validateTarget(databaseName, undefined, process.env.DATABASE_URL);

  if (COMMAND === 'sweep') {
    const result = await withTenant(TENANT, (tx) => sweepOrphans(tx, TENANT));
    process.stdout.write(`${JSON.stringify({ tenant: TENANT, ...result })}\n`);
    return;
  }

  if (COMMAND !== 'backfill') fail('CAIRN_ARTIFACT_COMMAND must be "sweep" or "backfill".');
  const kind = process.env.CAIRN_ARTIFACT_OWNER_KIND;
  const ownerId = process.env.CAIRN_ARTIFACT_OWNER_ID ?? '';
  if (kind !== 'FILE' && kind !== 'REISSUE') fail('CAIRN_ARTIFACT_OWNER_KIND must be FILE or REISSUE.');
  if (!/^[0-9a-f-]{36}$/.test(ownerId)) fail('CAIRN_ARTIFACT_OWNER_ID must be a preparation id or reissue id.');
  const keyringJson = process.env.CAIRN_BANK_DATA_KEYRING_JSON ?? '';
  if (!keyringJson) fail('CAIRN_BANK_DATA_KEYRING_JSON is required for backfill.');

  await withTenant(TENANT, async (tx) => {
    if (kind === 'FILE') {
      const [file] = await tx.select().from(payrollPaymentFile)
        .where(and(eq(payrollPaymentFile.client, TENANT), eq(payrollPaymentFile.preparationId, ownerId))).limit(1);
      if (!file) { process.stdout.write(`${JSON.stringify({ result: 'not-found' })}\n`); return; }
      // Only a stored plaintext body can be backfilled with provable byte identity. A snapshot-only legacy row
      // must be verified by an operator out of band; we do not silently reconstruct it here.
      if (!file.body) {
        process.stdout.write(`${JSON.stringify({ result: 'unverifiable', reason: 'no stored body; snapshot reconstruction must be verified out of band' })}\n`);
        return;
      }
      const outcome = await backfillLegacyArtifact(tx, {
        client: TENANT, ownerKind: 'FILE', ownerId, fileReference: file.fileReference,
        bytes: Buffer.from(file.body), expectedSha256: file.checksum, keyring: parseBankDataKeyring(keyringJson),
        changedBy: OPERATOR, source: 'body',
      });
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
      return;
    }
    const [reissue] = await tx.select().from(payrollPaymentReissue)
      .where(and(eq(payrollPaymentReissue.client, TENANT), eq(payrollPaymentReissue.reissueId, ownerId))).limit(1);
    if (!reissue) { process.stdout.write(`${JSON.stringify({ result: 'not-found' })}\n`); return; }
    process.stdout.write(`${JSON.stringify({ result: 'unverifiable', reason: 'replacement has no stored plaintext body; verify the deterministic snapshot out of band before retaining' })}\n`);
  });
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Artifact maintenance failed.'}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
