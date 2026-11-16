import { describe, expect, it } from 'vitest';
import {
  EMPTY_PERSONAL, MAX_FAVOURITES, MAX_RECENTS, parsePersonal, recordRecent, resolveEntries, serializePersonal,
  storageKey, toggleFavourite,
} from '@/ui/shell/nav-personal';

describe('favourites and recents', () => {
  it('reads anything in storage safely', () => {
    for (const raw of [null, '', 'not json', '42', 'null', '[]', '{"favourites":"x","recents":{}}']) {
      expect(parsePersonal(raw)).toEqual(EMPTY_PERSONAL);
    }
    expect(parsePersonal('{"favourites":["a",1,"a",""],"recents":["b"]}')).toEqual({ favourites: ['a'], recents: ['b'] });
  });

  it('round-trips and bounds what it reads', () => {
    const big = { favourites: Array.from({ length: 50 }, (_, i) => `f${i}`), recents: Array.from({ length: 50 }, (_, i) => `r${i}`) };
    const back = parsePersonal(serializePersonal(big));
    expect(back.favourites).toHaveLength(MAX_FAVOURITES);
    expect(back.recents).toHaveLength(MAX_RECENTS);
  });

  it('records recents most recent first, without duplicates, bounded', () => {
    let p = EMPTY_PERSONAL;
    for (const id of ['a', 'b', 'c', 'a']) p = recordRecent(p, id);
    expect(p.recents).toEqual(['a', 'c', 'b']);
    expect(recordRecent(p, 'a')).toBe(p);
    for (let i = 0; i < 20; i++) p = recordRecent(p, `x${i}`);
    expect(p.recents).toHaveLength(MAX_RECENTS);
    expect(p.recents[0]).toBe('x19');
  });

  it('toggles a favourite on and off, and stops at the limit', () => {
    let p = toggleFavourite(EMPTY_PERSONAL, 'a');
    expect(p.favourites).toEqual(['a']);
    expect(toggleFavourite(p, 'a').favourites).toEqual([]);
    for (let i = 0; i < 30; i++) p = toggleFavourite(p, `f${i}`);
    expect(p.favourites).toHaveLength(MAX_FAVOURITES);
    expect(toggleFavourite(p, 'one-more')).toBe(p);
  });

  it('shows only what the menu offers this reader, in stored order', () => {
    const offered = new Map([['a', { id: 'a', title: 'A', href: '/a' }], ['c', { id: 'c', title: 'C', href: '/c' }]]);
    expect(resolveEntries(['c', 'gone', 'a'], offered).map((e) => e.id)).toEqual(['c', 'a']);
    expect(resolveEntries(['x'], new Map())).toEqual([]);
  });

  it('keys storage by tenant and user so readers on one browser do not share', () => {
    expect(storageKey('DMO1', 'u1')).not.toBe(storageKey('DMO1', 'u2'));
    expect(storageKey('DMO1', 'u1')).not.toBe(storageKey('DMO2', 'u1'));
  });
});
