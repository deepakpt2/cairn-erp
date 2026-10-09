/**
 * Term registry service — CAIRN.md §4.4
 *
 * Powers the command bar, alias search and the coverage view. Reference
 * identifiers are accepted as input and reported as a lookup courtesy, never as
 * our own naming (§19.5 AI-05).
 */
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { termAlias, termRegistry } from '../tables/registry';

export interface RegistryHit {
  id: string;
  ourCode: string | null;
  ourTable: string | null;
  title: string;
  termType: string;
  module: string;
  description: string | null;
  coverageTier: string;
  routePath: string | null;
  conformanceTier: string | null;
  matchedOn: 'OUR_CODE' | 'ALIAS' | 'TITLE' | 'TABLE';
  matchedTerm?: string;
  aliases?: string[];
}

/**
 * Resolve whatever the user typed in the command bar.
 *
 * Order matters: our own codes win, then aliases, then a title search. If someone
 * types our code we never second-guess them.
 */
export async function resolveTerm(term: string): Promise<RegistryHit | null> {
  const input = term.trim();
  if (input === '') return null;

  // 1 · Our own transaction code, exact.
  const byCode = await db()
    .select()
    .from(termRegistry)
    .where(eq(termRegistry.ourCode, input))
    .limit(1);
  if (byCode.length > 0) {
    return toHit(byCode[0], 'OUR_CODE');
  }

  // 2 · Our own table name, exact.
  const byTable = await db()
    .select()
    .from(termRegistry)
    .where(eq(termRegistry.ourTable, input))
    .limit(1);
  if (byTable.length > 0) {
    return toHit(byTable[0], 'TABLE');
  }

  // 3 · An external alias, exact and case-insensitive.
  const aliasRows = await db()
    .select({ term: termRegistry, alias: termAlias.alias })
    .from(termAlias)
    .innerJoin(termRegistry, eq(termRegistry.id, termAlias.termId))
    .where(ilike(termAlias.alias, input))
    .limit(1);
  if (aliasRows.length > 0) {
    const hit = toHit(aliasRows[0].term, 'ALIAS');
    hit.matchedTerm = aliasRows[0].alias;
    return hit;
  }

  // 4 · A partial title match, so an approximate search still lands somewhere.
  const byTitle = await db()
    .select()
    .from(termRegistry)
    .where(
      and(
        eq(termRegistry.isSearchable, true),
        or(
          ilike(termRegistry.title, `%${input}%`),
          ilike(termRegistry.description, `%${input}%`),
          sql`${termRegistry.ourCode} ilike ${'%' + input + '%'}`,
        ),
      ),
    )
    .limit(1);
  if (byTitle.length > 0) {
    return toHit(byTitle[0], 'TITLE');
  }

  return null;
}

/** Full-text-ish search for the registry screen. */
export async function searchRegistry(query: string, limit = 50): Promise<RegistryHit[]> {
  const input = query.trim();

  const rows =
    input === ''
      ? await db().select().from(termRegistry).orderBy(termRegistry.module, termRegistry.title).limit(limit)
      : await db()
          .select()
          .from(termRegistry)
          .where(
            or(
              ilike(termRegistry.title, `%${input}%`),
              ilike(termRegistry.ourCode, `%${input}%`),
              ilike(termRegistry.description, `%${input}%`),
            ),
          )
          .limit(limit);

  // If a text search matched nothing, try treating the term as an alias.
  if (rows.length === 0 && input !== '') {
    const aliasRows = await db()
      .select({ term: termRegistry, alias: termAlias.alias })
      .from(termAlias)
      .innerJoin(termRegistry, eq(termRegistry.id, termAlias.termId))
      .where(ilike(termAlias.alias, `%${input}%`))
      .limit(limit);
    if (aliasRows.length > 0) {
      return Promise.all(
        aliasRows.map(async (row) => {
          const hit = toHit(row.term, 'ALIAS');
          hit.matchedTerm = row.alias;
          return hit;
        }),
      );
    }
  }

  return rows.map((row) => toHit(row, 'TITLE'));
}

/** Aliases for a set of registry entries, for the "also known as" display. */
export async function aliasesFor(termIds: string[]): Promise<Record<string, string[]>> {
  if (termIds.length === 0) return {};
  const rows = await db()
    .select()
    .from(termAlias)
    .where(sql`${termAlias.termId} = any(${sql.raw(`array[${termIds.map((id) => `'${id}'`).join(',')}]::varchar[]`)})`);

  const result: Record<string, string[]> = {};
  for (const row of rows) {
    result[row.termId] ??= [];
    result[row.termId].push(row.alias);
  }
  return result;
}

function toHit(
  row: typeof termRegistry.$inferSelect,
  matchedOn: RegistryHit['matchedOn'],
): RegistryHit {
  return {
    id: row.id,
    ourCode: row.ourCode,
    ourTable: row.ourTable,
    title: row.title,
    termType: row.termType,
    module: row.module,
    description: row.description,
    coverageTier: row.coverageTier,
    routePath: row.routePath,
    conformanceTier: row.conformanceTier,
    matchedOn,
  };
}

/** Human label for a coverage tier (§4.4). */
export function coverageLabel(tier: string): string {
  switch (tier) {
    case 'TIER_1_BUILT':
      return 'Tier 1 · built';
    case 'TIER_2_CONFIGURED':
      return 'Tier 2 · configuration';
    case 'TIER_3_MAPPED':
      return 'Tier 3 · mapped, not built';
    case 'REFERENCE':
      return 'Data model';
    default:
      return tier;
  }
}
