/**
 * Favourites and recent screens (navigation Stage 5), kept in the reader's own browser.
 *
 * Only screen ids are stored, never titles or addresses, and every id is resolved against the menu the server
 * built for this reader. An id that is no longer offered — the reader lost a grant, the screen was renamed or
 * removed — is dropped on read, so stored data can neither show a screen the menu hides nor grant anything.
 * Nothing here touches the server; a later stage may move it to the account without changing the shape.
 */
export const MAX_FAVOURITES = 20;
export const MAX_RECENTS = 8;

export interface PersonalNav {
  favourites: string[];
  recents: string[];
}

export const EMPTY_PERSONAL: PersonalNav = { favourites: [], recents: [] };

export function storageKey(client: string, userId: string): string {
  return `cairn.nav.v1:${client}:${userId}`;
}

function ids(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const v of value) if (typeof v === 'string' && v.length > 0 && v.length <= 120) seen.add(v);
  return [...seen].slice(0, max);
}

/** Tolerant of anything in storage: bad JSON, wrong shape and foreign data all read as empty. */
export function parsePersonal(raw: string | null): PersonalNav {
  if (!raw) return EMPTY_PERSONAL;
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return EMPTY_PERSONAL;
    const o = data as Record<string, unknown>;
    return { favourites: ids(o.favourites, MAX_FAVOURITES), recents: ids(o.recents, MAX_RECENTS) };
  } catch {
    return EMPTY_PERSONAL;
  }
}

export function serializePersonal(p: PersonalNav): string {
  return JSON.stringify({ favourites: p.favourites.slice(0, MAX_FAVOURITES), recents: p.recents.slice(0, MAX_RECENTS) });
}

/** Most recent first, no duplicates, bounded. A screen already first changes nothing (returns the same object). */
export function recordRecent(p: PersonalNav, id: string): PersonalNav {
  if (p.recents[0] === id) return p;
  return { ...p, recents: [id, ...p.recents.filter((r) => r !== id)].slice(0, MAX_RECENTS) };
}

/** Adds to the end of the favourites, or removes. Refused (unchanged) past the limit. */
export function toggleFavourite(p: PersonalNav, id: string): PersonalNav {
  if (p.favourites.includes(id)) return { ...p, favourites: p.favourites.filter((f) => f !== id) };
  if (p.favourites.length >= MAX_FAVOURITES) return p;
  return { ...p, favourites: [...p.favourites, id] };
}

export interface ResolvedEntry {
  id: string;
  title: string;
  href: string;
}

/** Drops every id the menu does not offer this reader; order kept. */
export function resolveEntries(list: readonly string[], offered: ReadonlyMap<string, ResolvedEntry>): ResolvedEntry[] {
  const out: ResolvedEntry[] = [];
  for (const id of list) {
    const entry = offered.get(id);
    if (entry) out.push(entry);
  }
  return out;
}
