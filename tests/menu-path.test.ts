import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NAV_CHILD_ROUTES, SCREENS } from '@/ui/shell/screen-catalog';
import { resolveMenuPath } from '@/ui/shell/menu-path';

const q = (s = '') => new URLSearchParams(s);

/** Every `page.tsx` under src/app, as a route with each [param] folded to `x`. */
function pageRoutes(dir = 'src/app', prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...pageRoutes(`${dir}/${entry.name}`, `${prefix}/${entry.name}`));
    else if (entry.name === 'page.tsx') out.push(prefix === '' ? '/' : prefix);
  }
  return out;
}

describe('menu path', () => {
  it('reads module, category, activity and screen for a catalogued page', () => {
    expect(resolveMenuPath('/purchasing/orders', q())!.segments).toEqual([
      'MM – Materials Management', 'Procurement', 'Purchase orders', 'Create purchase order',
    ]);
    expect(resolveMenuPath('/controlling/internal-orders', q())!.segments[0]).toBe('Finance & Controlling');
  });

  it('shows the launchpad as the Dashboard alone', () => {
    expect(resolveMenuPath('/', q())!.segments).toEqual(['Dashboard']);
  });

  it('collapses a repeated label instead of printing it twice', () => {
    for (const s of SCREENS) {
      const segs = resolveMenuPath(s.path, new URLSearchParams(s.query as Record<string, string>))!.segments;
      for (let i = 1; i < segs.length; i++) expect(segs[i].toLowerCase(), `${s.id}`).not.toBe(segs[i - 1].toLowerCase());
    }
  });

  it('finds a path for every catalogue entry, including the query variants of one page', () => {
    for (const s of SCREENS) {
      const path = resolveMenuPath(s.path, new URLSearchParams(s.query as Record<string, string>));
      expect(path, s.id).not.toBeNull();
      expect(path!.screen!.id, s.id).toBe(s.id);
    }
  });

  it('puts a detail page under its list', () => {
    expect(resolveMenuPath('/platform/users/jane', q())!.screen!.path).toBe('/platform/users');
    expect(resolveMenuPath('/platform/notifications/42', q())!.screen!.path).toBe('/platform/notifications');
    // A catalogued static page under the same prefix keeps its own path.
    expect(resolveMenuPath('/platform/users/access', q())!.screen!.path).toBe('/platform/users/access');
  });

  it('names a parent for every dynamic page in the app, and every parent is a catalogued screen', () => {
    const dynamic = pageRoutes().filter((r) => r.includes('[')).map((r) => r.replace(/\[[^\]]+\]/g, 'x'));
    expect(dynamic.length).toBeGreaterThan(0);
    for (const route of dynamic) {
      expect(NAV_CHILD_ROUTES.some((r) => r.pattern.test(route)), `${route} has no parent`).toBe(true);
    }
    for (const r of NAV_CHILD_ROUTES) expect(SCREENS.some((s) => s.path === r.parent), r.parent).toBe(true);
  });

  it('shows nothing for sign-in and other uncatalogued addresses', () => {
    for (const p of ['/signin', '/forgot-password', '/reset-password', '/nowhere']) expect(resolveMenuPath(p, q())).toBeNull();
  });

  it('prints no screen code or reference alias in a path', () => {
    const tcode = /\b[A-Z]{2}\d{2}[A-Z0-9]?\b/;
    for (const s of SCREENS) {
      for (const label of resolveMenuPath(s.path, new URLSearchParams(s.query as Record<string, string>))!.segments) {
        expect(label, s.id).not.toMatch(tcode);
        if (s.code) expect(label, s.id).not.toBe(s.code);
      }
    }
  });

  it('sits in the status bar with its levels linked', () => {
    const bar = readFileSync('src/ui/shell/StatusBar.tsx', 'utf8');
    const comp = readFileSync('src/ui/shell/MenuPath.tsx', 'utf8');
    expect(bar).toContain('<MenuPath linkLevels />');
    // Links exist only behind the prop, and the screen itself is never a link.
    expect(comp).toContain('linkLevels && href && !current');
    expect(comp).toContain('linkLevels = false');
    expect(comp).toContain('aria-current');
    expect(comp).toContain("t('status.menuPath')");
  });
});
