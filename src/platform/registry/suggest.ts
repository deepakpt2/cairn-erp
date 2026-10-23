/**
 * Term registry suggestions.
 *
 * The catalogue is about 170 terms, so this ranks in the application. It does
 * not use a trigram index, and it does not invent a code or a screen: every
 * hit is a row that was passed in.
 *
 * Exact words come first, in this field order: tcode alias, our code or table,
 * name, then explanation. A phrase in that order ranks above the same words
 * rearranged. Words shorter than two letters do not count. If nothing matches
 * exactly, the nearest hit uses the same field order. A changed spelling has
 * to cover every typed word. One extra word counts only when the rest still
 * match as a phrase, or the remaining word is the whole field.
 *
 * An exact custom code or table name is pinned first, so typing our own
 * identifier is never second-guessed by an alias that happens to look the same.
 */

export type SuggestionField = 'ALIAS' | 'CODE' | 'TITLE' | 'DESCRIPTION';
export type SuggestionKind = 'EXACT' | 'NEAREST';

export interface SuggestionSource {
  ourCode: string | null;
  ourTable: string | null;
  title: string;
  description: string | null;
  aliases: string[];
  isSearchable?: boolean;
}

export interface RankedSuggestion<T> {
  item: T;
  field: SuggestionField;
  kind: SuggestionKind;
  matchedText: string;
  distance: number;
  quality: number;
}

/** What the search box shows. A row from the catalogue, not a new screen. */
export interface RegistrySuggestion {
  id: string;
  ourCode: string | null;
  ourTable: string | null;
  title: string;
  routePath: string | null;
  field: SuggestionField;
  kind: SuggestionKind;
  matchedText: string;
}

export interface ExactOwnIdentifier<T> {
  item: T;
  matchedOn: 'OUR_CODE' | 'TABLE';
}

const FIELD_RANK: Record<SuggestionField, number> = {
  ALIAS: 0,
  CODE: 1,
  TITLE: 2,
  DESCRIPTION: 3,
};

/** Letters and digits only, so `F-28` and `F28` compare as the same code. */
export function compactCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Words of two or more letters. A run of single letters separated only by
 * punctuation, such as `G/L`, is one word. `F-28` is one word as well.
 */
export function suggestionWords(value: string): string[] {
  const tokens: Array<{ text: string; start: number; end: number }> = [];
  const pattern = /[A-Za-z0-9]+/g;
  let found: RegExpExecArray | null;
  while ((found = pattern.exec(value)) !== null) {
    tokens.push({ text: found[0].toUpperCase(), start: found.index, end: found.index + found[0].length });
  }

  const words: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    let text = tokens[index].text;
    let end = tokens[index].end;
    while (
      text.length === 1 &&
      index + 1 < tokens.length &&
      tokens[index + 1].text.length === 1 &&
      !/\s/.test(value.slice(end, tokens[index + 1].start))
    ) {
      text += tokens[index + 1].text;
      end = tokens[index + 1].end;
      index++;
    }
    if (
      text.length === 1 &&
      index + 1 < tokens.length &&
      /^[0-9]+$/.test(tokens[index + 1].text) &&
      !/\s/.test(value.slice(end, tokens[index + 1].start))
    ) {
      text += tokens[index + 1].text;
      index++;
    }
    if (text.length >= 2) words.push(text);
  }
  return words;
}

function clip(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
}

function stems(word: string): string[] {
  const out = [word];
  if (word.length >= 5 && word.endsWith('IES')) out.push(`${word.slice(0, -3)}Y`);
  if (word.length >= 5 && word.endsWith('ES')) out.push(word.slice(0, -2));
  if (word.length >= 5 && word.endsWith('S') && !word.endsWith('SS')) out.push(word.slice(0, -1));
  return out;
}

function sameWord(left: string, right: string): boolean {
  if (left === right) return true;
  const rightStems = new Set(stems(right));
  return stems(left).some((stem) => rightStems.has(stem));
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  const gap = Math.abs(left.length - right.length);
  if (gap > 2) return gap;
  const width = right.length + 1;
  let previous = Array.from({ length: width }, (_, index) => index);
  const current = new Array<number>(width);
  for (let i = 1; i <= left.length; i++) {
    current[0] = i;
    let rowMin = i;
    for (let j = 1; j < width; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > 2) return rowMin;
    previous = current.slice();
  }
  return previous[width - 1];
}

function spellingLimit(word: string): number {
  if (word.length <= 2) return 0;
  if (word.length <= 4) return 1;
  return 2;
}

function wordDistance(query: string, field: string): number {
  if (sameWord(query, field)) return 0;
  let best = editDistance(query, field);
  for (const stem of stems(field)) {
    if (stem !== field) best = Math.min(best, editDistance(query, stem));
  }
  for (const stem of stems(query)) {
    if (stem !== query) best = Math.min(best, editDistance(stem, field));
  }
  return best;
}

function phrase(fieldWords: string[], queryWords: string[]): boolean {
  if (queryWords.length === 0 || fieldWords.length < queryWords.length) return false;
  for (let start = 0; start <= fieldWords.length - queryWords.length; start++) {
    if (queryWords.every((word, offset) => sameWord(fieldWords[start + offset], word))) return true;
  }
  return false;
}

function allPresent(fieldWords: string[], queryWords: string[]): boolean {
  const used = new Set<number>();
  return queryWords.every((word) => {
    const at = fieldWords.findIndex((item, index) => !used.has(index) && sameWord(item, word));
    if (at < 0) return false;
    used.add(at);
    return true;
  });
}

function alignDistance(fieldWords: string[], queryWords: string[], inOrder: boolean): number | null {
  const used = new Set<number>();
  let total = 0;
  let inexact = false;
  let cursor = 0;
  for (const word of queryWords) {
    const limit = spellingLimit(word);
    let found = -1;
    let best = 99;
    const start = inOrder ? cursor : 0;
    for (let index = start; index < fieldWords.length; index++) {
      if (used.has(index)) continue;
      const distance = wordDistance(word, fieldWords[index]);
      if (distance <= limit && distance < best) {
        best = distance;
        found = index;
        if (distance === 0) break;
      }
    }
    if (found < 0) return null;
    if (best > 0) inexact = true;
    total += best;
    used.add(found);
    if (inOrder) cursor = found + 1;
  }
  if (!inexact) return null;
  return total;
}

interface WordScore {
  quality: number;
  distance: number;
  matched: number;
}

function scoreWords(fieldWords: string[], queryWords: string[]): WordScore | null {
  if (queryWords.length === 0) return null;
  if (phrase(fieldWords, queryWords)) return { quality: 1, distance: 0, matched: queryWords.length };
  if (allPresent(fieldWords, queryWords)) return { quality: 2, distance: 0, matched: queryWords.length };
  const ordered = alignDistance(fieldWords, queryWords, true);
  if (ordered !== null) return { quality: 3, distance: ordered, matched: queryWords.length };
  const unordered = alignDistance(fieldWords, queryWords, false);
  if (unordered !== null) return { quality: 4, distance: unordered, matched: queryWords.length };
  return null;
}

interface FieldScore {
  field: SuggestionField;
  kind: SuggestionKind;
  quality: number;
  distance: number;
  extra: number;
  matchedText: string;
}

function scoreField(text: string, field: SuggestionField, queryWords: string[], compactQuery: string): FieldScore | null {
  const compactField = compactCode(text);
  if (compactQuery.length >= 2 && compactField === compactQuery) {
    return { field, kind: 'EXACT', quality: 0, distance: 0, extra: 0, matchedText: clip(text) };
  }
  if (queryWords.length === 0) return null;
  const fieldWords = suggestionWords(text);
  const full = scoreWords(fieldWords, queryWords);
  if (full && full.quality <= 2) {
    return {
      field,
      kind: 'EXACT',
      quality: full.quality,
      distance: 0,
      extra: Math.max(0, fieldWords.length - full.matched),
      matchedText: clip(text),
    };
  }
  if (full) {
    return {
      field,
      kind: 'NEAREST',
      quality: full.quality,
      distance: full.distance,
      extra: Math.max(0, fieldWords.length - full.matched),
      matchedText: clip(text),
    };
  }
  if (queryWords.length < 2) return null;

  // One extra typed word. A single leftover word matches only when it is the
  // whole field, so "class" does not nearest-match every code that contains it.
  let best: FieldScore | null = null;
  for (let skip = 0; skip < queryWords.length; skip++) {
    const remainder = queryWords.filter((_, index) => index !== skip);
    const wholeField = fieldWords.length === remainder.length && phrase(fieldWords, remainder);
    const phraseHit = remainder.length >= 2 && phrase(fieldWords, remainder);
    if (wholeField || phraseHit) {
      const candidate: FieldScore = {
        field,
        kind: 'NEAREST',
        quality: 5,
        distance: 1,
        extra: Math.max(0, fieldWords.length - remainder.length),
        matchedText: clip(text),
      };
      if (!best || betterScore(candidate, best)) best = candidate;
      continue;
    }
    if (remainder.length < 2) continue;
    const spelling = alignDistance(fieldWords, remainder, true) ?? alignDistance(fieldWords, remainder, false);
    if (spelling === null) continue;
    const candidate: FieldScore = {
      field,
      kind: 'NEAREST',
      quality: 7,
      distance: spelling + 1,
      extra: Math.max(0, fieldWords.length - remainder.length),
      matchedText: clip(text),
    };
    if (!best || betterScore(candidate, best)) best = candidate;
  }
  return best;
}

function betterScore(left: FieldScore, right: FieldScore): boolean {
  if (left.kind !== right.kind) return left.kind === 'EXACT';
  const field = FIELD_RANK[left.field] - FIELD_RANK[right.field];
  if (field !== 0) return field < 0;
  if (left.quality !== right.quality) return left.quality < right.quality;
  if (left.distance !== right.distance) return left.distance < right.distance;
  return left.extra < right.extra;
}

function fieldTexts(item: SuggestionSource): Array<{ field: SuggestionField; text: string }> {
  const texts: Array<{ field: SuggestionField; text: string }> = [];
  for (const alias of item.aliases) {
    if (alias.trim()) texts.push({ field: 'ALIAS', text: alias });
  }
  if (item.ourCode) texts.push({ field: 'CODE', text: item.ourCode });
  if (item.ourTable) texts.push({ field: 'CODE', text: item.ourTable });
  if (item.title) texts.push({ field: 'TITLE', text: item.title });
  if (item.description) texts.push({ field: 'DESCRIPTION', text: item.description });
  return texts;
}

interface Scored<T> extends RankedSuggestion<T> {
  extra: number;
}

function sharedPrefix(query: string, matched: string): number {
  const left = compactCode(query);
  const right = compactCode(matched);
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

function compareScored<T extends SuggestionSource>(left: Scored<T>, right: Scored<T>, query: string): number {
  const field = FIELD_RANK[left.field] - FIELD_RANK[right.field];
  if (field !== 0) return field;
  if (left.quality !== right.quality) return left.quality - right.quality;
  if (left.distance !== right.distance) return left.distance - right.distance;
  if (left.extra !== right.extra) return left.extra - right.extra;
  if (left.field === 'ALIAS' || left.field === 'CODE') {
    const prefix = sharedPrefix(query, right.matchedText) - sharedPrefix(query, left.matchedText);
    if (prefix !== 0) return prefix;
  }
  const title = left.item.title.localeCompare(right.item.title);
  if (title !== 0) return title;
  return (left.item.ourCode ?? left.item.ourTable ?? '').localeCompare(right.item.ourCode ?? right.item.ourTable ?? '');
}

/**
 * Two nearest hits the command bar must not choose between. An exact hit is
 * never tied in this sense: Enter opens the first exact screen.
 */
export function equallyNear<T extends SuggestionSource>(
  left: RankedSuggestion<T>,
  right: RankedSuggestion<T>,
  query: string,
): boolean {
  if (left.kind !== 'NEAREST' || right.kind !== 'NEAREST') return false;
  if (left.field !== right.field || left.quality !== right.quality || left.distance !== right.distance) return false;
  if (left.field === 'ALIAS' || left.field === 'CODE') {
    return sharedPrefix(query, left.matchedText) === sharedPrefix(query, right.matchedText);
  }
  return true;
}

/**
 * Exact custom code or table name. Case and separators do not matter.
 * An alias is not considered here.
 */
export function exactOwnIdentifier<T extends SuggestionSource>(items: T[], query: string): ExactOwnIdentifier<T> | null {
  const trimmed = query.trim();
  const compact = compactCode(trimmed);
  if (compact.length < 2) return null;
  const upper = trimmed.toUpperCase();
  const codeExact = items.find((item) => item.ourCode?.toUpperCase() === upper);
  if (codeExact) return { item: codeExact, matchedOn: 'OUR_CODE' };
  const tableExact = items.find((item) => item.ourTable?.toUpperCase() === upper);
  if (tableExact) return { item: tableExact, matchedOn: 'TABLE' };
  const code = items.find((item) => item.ourCode && compactCode(item.ourCode) === compact);
  if (code) return { item: code, matchedOn: 'OUR_CODE' };
  const table = items.find((item) => item.ourTable && compactCode(item.ourTable) === compact);
  if (table) return { item: table, matchedOn: 'TABLE' };
  return null;
}

/** Rank catalogue rows for a typed query. Exact hits suppress nearest hits. */
export function rankSuggestions<T extends SuggestionSource>(items: T[], query: string, limit = 8): RankedSuggestion<T>[] {
  const trimmed = query.trim().slice(0, 120);
  const queryWords = suggestionWords(trimmed).slice(0, 8);
  const compactQuery = compactCode(trimmed);
  if (compactQuery.length < 2 && queryWords.length === 0) return [];

  const best = new Map<T, Scored<T>>();
  for (const item of items) {
    for (const candidate of fieldTexts(item)) {
      const score = scoreField(candidate.text, candidate.field, queryWords, compactQuery);
      if (!score) continue;
      const current = best.get(item);
      if (current && !betterScore(score, current)) continue;
      best.set(item, { item, ...score });
    }
  }

  const scored = [...best.values()];
  const exact = scored.filter((row) => row.kind === 'EXACT');
  const chosen = exact.length > 0 ? exact : scored.filter((row) => row.kind === 'NEAREST');
  chosen.sort((left, right) => compareScored(left, right, trimmed));
  return chosen.slice(0, Math.max(0, limit)).map((row) => ({
    item: row.item,
    field: row.field,
    kind: row.kind,
    matchedText: row.matchedText,
    distance: row.distance,
    quality: row.quality,
  }));
}

/**
 * The order the registry and the command bar share.
 * An exact custom code or table name stays first. Everything else follows
 * the suggestion ranking.
 */
export function rankRegistry<T extends SuggestionSource>(items: T[], query: string, limit = 8): RankedSuggestion<T>[] {
  const own = exactOwnIdentifier(items, query);
  const ranked = rankSuggestions(
    items.filter((item) => item.isSearchable !== false),
    query,
    limit,
  );
  if (!own) return ranked;
  const head: RankedSuggestion<T> = {
    item: own.item,
    field: 'CODE',
    kind: 'EXACT',
    matchedText: clip(own.matchedOn === 'TABLE' ? own.item.ourTable ?? '' : own.item.ourCode ?? ''),
    distance: 0,
    quality: 0,
  };
  return [head, ...ranked.filter((row) => row.item !== own.item)].slice(0, Math.max(0, limit));
}
