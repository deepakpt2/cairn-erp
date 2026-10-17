import { asc, count, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { journalEntry } from '../finance/schema';
import { companyCode, postingPeriodVariant } from './schema';

/**
 * OBBP Assign Company Code to Posting Period Variant — the read side (SCR-033 stage 1).
 *
 * This module exists before the writes for the same reason the OBBO reader does: the
 * screen has to render what the tenant holds before it is worth writing to, and the
 * three questions it answers — which variant each Company Code holds, what the variants
 * are called, and whether a Company Code has posted — must have one answer that the
 * write side then enforces rather than restates. The posted count is read here because
 * the contract's clearing rule turns on it: a variant may be cleared only while the
 * Company Code has no journal entries, so the dialog has to say that before the click.
 */
export const ACTIVITY = 'CFG.FIN.PPV.ASSIGN';

export interface PostingPeriodVariantAssignmentRow {
  companyCode: string;
  name: string;
  isActive: boolean;
  /** The variant the Company Code posts against, or null while unassigned. */
  postingPeriodVariant: string | null;
  /** The assigned variant's description, or null while unassigned (or unresolvable). */
  variantName: string | null;
  /** Journal entries posted under this Company Code; the clearing rule turns on it. */
  postedDocuments: number;
}

export async function listPostingPeriodVariantAssignments(
  client: string,
): Promise<PostingPeriodVariantAssignmentRow[]> {
  return withTenant(client, async (tx) => {
    const [companies, variants, postings] = await Promise.all([
      tx
        .select({
          companyCode: companyCode.companyCode,
          name: companyCode.name,
          isActive: companyCode.isActive,
          postingPeriodVariant: companyCode.postingPeriodVariant,
        })
        .from(companyCode)
        .where(eq(companyCode.client, client))
        .orderBy(asc(companyCode.companyCode)),
      tx
        .select({ variant: postingPeriodVariant.variant, name: postingPeriodVariant.name })
        .from(postingPeriodVariant)
        .where(eq(postingPeriodVariant.client, client))
        .orderBy(asc(postingPeriodVariant.variant)),
      tx
        .select({ companyCode: journalEntry.companyCode, documents: count() })
        .from(journalEntry)
        .where(eq(journalEntry.client, client))
        .groupBy(journalEntry.companyCode),
    ]);

    const variantNames = new Map(variants.map((row) => [row.variant, row.name]));
    const posted = new Map(postings.map((row) => [row.companyCode, Number(row.documents)]));

    return companies.map((row) => ({
      companyCode: row.companyCode,
      name: row.name,
      isActive: row.isActive,
      postingPeriodVariant: row.postingPeriodVariant,
      variantName: row.postingPeriodVariant
        ? (variantNames.get(row.postingPeriodVariant) ?? null)
        : null,
      postedDocuments: posted.get(row.companyCode) ?? 0,
    }));
  });
}
