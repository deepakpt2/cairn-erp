import { afterAll, describe, expect, it } from 'vitest';

import { SCREENS } from '@/ui/shell/screen-catalog';
import { screenHref } from '@/ui/shell/screen-links';
import { termRegistry } from '@/platform/tables/registry';
import { closeDb, db } from './helpers';

afterAll(async () => {
  await closeDb();
});

describe('registry and screen catalogue', () => {
  it('registers every built screen, by its code or its route (the launchpad has no code and is the home)', async () => {
    const rows = await db().select({ code: termRegistry.ourCode, route: termRegistry.routePath }).from(termRegistry);
    const codes = new Set(rows.map((r) => r.code).filter(Boolean));
    const routes = new Set(rows.map((r) => r.route).filter(Boolean));
    const missing = SCREENS.filter((s) => s.path !== '/')
      .filter((s) => !codes.has(s.code) && !routes.has(screenHref(s)) && !routes.has(s.id))
      .map((s) => `${s.code} ${s.id}`);
    expect(missing).toEqual([]);
  });
});
