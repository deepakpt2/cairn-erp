/**
 * Term registry service — CAIRN.md §4.4
 *
 * Powers the command bar, alias search and the coverage view. Reference
 * identifiers are accepted as input and reported as a lookup courtesy, never as
 * our own naming (§19.5 AI-05).
 *
 * Search ranking lives in `suggest.ts`. An exact custom code or table name is
 * never second-guessed. Every other query uses that ranking, and the command
 * bar opens the top hit that has a route.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { termAlias, termRegistry } from '../tables/registry';
import {
  equallyNear,
  rankRegistry,
  type RankedSuggestion,
  type RegistrySuggestion,
  type SuggestionField,
  type SuggestionKind,
} from './suggest';

export type { RegistrySuggestion, SuggestionField, SuggestionKind };

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
  matchedOn: 'OUR_CODE' | 'ALIAS' | 'TITLE' | 'TABLE' | 'DESCRIPTION';
  matchedTerm?: string;
  aliases?: string[];
  matchField?: SuggestionField;
  matchKind?: SuggestionKind;
  matchedText?: string;
  /** False when several nearest hits are equally close. Enter must not pick one. */
  matchUnique?: boolean;
}

interface CatalogueTerm extends RegistryHit {
  isSearchable: boolean;
  aliases: string[];
}

/**
 * Resolve whatever the user typed in the command bar.
 *
 * An exact custom code or table name wins. Otherwise the top ranked suggestion
 * wins, including a nearest spelling when nothing matches exactly. The caller
 * opens the route only when this hit has one.
 */
export async function resolveTerm(term: string): Promise<RegistryHit | null> {
  const input = term.trim();
  if (input === '') return null;
  const ranked = rankRegistry(await loadCatalogue(), input, 2);
  if (ranked.length === 0) return null;
  const hit = toRankedHit(ranked[0]);
  hit.matchUnique = ranked.length === 1 || ranked[0].kind === 'EXACT' || !equallyNear(ranked[0], ranked[1], input);
  return hit;
}

/** Ranked search for the registry screen. An empty query lists the catalogue. */
export async function searchRegistry(query: string, limit = 50): Promise<RegistryHit[]> {
  const catalogue = await loadCatalogue();
  const input = query.trim();
  if (input === '') {
    return catalogue
      .slice()
      .sort((left, right) => left.module.localeCompare(right.module) || left.title.localeCompare(right.title))
      .slice(0, limit)
      .map((row) => toHit(row, 'OUR_CODE', row.aliases));
  }
  return rankRegistry(catalogue, input, limit).map(toRankedHit);
}

/** Short list for the registry search box. Same order as `searchRegistry`. */
export async function suggestRegistry(query: string, limit = 8): Promise<RegistrySuggestion[]> {
  const input = query.trim();
  if (input === '') return [];
  return rankRegistry(await loadCatalogue(), input, limit).map((ranked) => ({
    id: ranked.item.id,
    ourCode: ranked.item.ourCode,
    ourTable: ranked.item.ourTable,
    title: ranked.item.title,
    routePath: ranked.item.routePath,
    field: ranked.field,
    kind: ranked.kind,
    matchedText: ranked.matchedText,
  }));
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

let catalogueCache: { at: number; rows: CatalogueTerm[] } | null = null;

async function loadCatalogue(): Promise<CatalogueTerm[]> {
  const now = Date.now();
  if (catalogueCache && now - catalogueCache.at < 15_000) return catalogueCache.rows;
  const rows = await readCatalogue();
  catalogueCache = { at: now, rows };
  return rows;
}

async function readCatalogue(): Promise<CatalogueTerm[]> {
  const rows = await db().select().from(termRegistry);
  const aliases = await db().select({ termId: termAlias.termId, alias: termAlias.alias }).from(termAlias);
  const byTerm = new Map<string, string[]>();
  for (const alias of aliases) {
    const list = byTerm.get(alias.termId);
    if (list) list.push(alias.alias);
    else byTerm.set(alias.termId, [alias.alias]);
  }
  for (const list of byTerm.values()) {
    list.sort((left, right) => left.length - right.length || left.localeCompare(right));
  }
  return rows.map((row) => ({
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
    matchedOn: 'OUR_CODE' as const,
    isSearchable: row.isSearchable,
    aliases: byTerm.get(row.id) ?? [],
  }));
}

function toHit(
  row: {
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
  },
  matchedOn: RegistryHit['matchedOn'],
  aliases?: string[],
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
    aliases,
  };
}

function toRankedHit(ranked: RankedSuggestion<CatalogueTerm>): RegistryHit {
  const matchedOn =
    ranked.field === 'ALIAS'
      ? 'ALIAS'
      : ranked.field === 'TITLE'
        ? 'TITLE'
        : ranked.field === 'DESCRIPTION'
          ? 'DESCRIPTION'
          : ranked.matchedText === ranked.item.ourTable
            ? 'TABLE'
            : ranked.item.ourCode
              ? 'OUR_CODE'
              : 'TABLE';
  const hit = toHit(ranked.item, matchedOn, ranked.item.aliases);
  hit.matchField = ranked.field;
  hit.matchKind = ranked.kind;
  hit.matchedText = ranked.matchedText;
  if (ranked.field === 'ALIAS') hit.matchedTerm = ranked.matchedText;
  return hit;
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
