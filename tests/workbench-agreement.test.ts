import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The workbench and the command bar must open the same page for one code,
 * and a workbench step must not name a route that has no page.
 */

function pages(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string, route: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('(') || name === 'api') continue;
      const path = join(dir, name);
      if (name === 'page.tsx') found.add(route || '/');
      else if (statSync(path).isDirectory()) walk(path, `${route}/${name}`);
    }
  };
  walk('src/app', '');
  return found;
}

function activities(): Array<{ code: string; route?: string }> {
  const source = readFileSync('scripts/seed.ts', 'utf8').split('const CAPABILITIES')[0];
  return [...source.matchAll(/\{ code: '([^']+)'[\s\S]*?\n  \}/g)].map((match) => ({
    code: match[1],
    route: match[0].match(/route: '([^']+)'/)?.[1],
  }));
}

function terms(): Map<string, string> {
  const source = readFileSync('scripts/seed.ts', 'utf8');
  const out = new Map<string, string>();
  for (const part of source.split("{ ourCode:").slice(1)) {
    const code = part.match(/^ '([^']+)'/)?.[1];
    const route = part.match(/route: '([^']*)'/)?.[1];
    if (code && route) out.set(code, route);
  }
  return out;
}

describe('workbench agreement', () => {
  const built = readFileSync('src/app/config/page.tsx', 'utf8');
  const builtRoutes = built.slice(built.indexOf('const BUILT_ROUTES'), built.indexOf(']);', built.indexOf('const BUILT_ROUTES')));
  const existing = pages();

  it('opens the same route from the workbench and the command bar', () => {
    const registry = terms();
    const disagreements = activities()
      .filter((activity) => activity.route && registry.has(activity.code) && registry.get(activity.code) !== activity.route)
      .map((activity) => `${activity.code} workbench ${activity.route} command ${registry.get(activity.code)}`);
    expect(disagreements).toEqual([]);
  });

  it('does not store a route that has no page', () => {
    const missing = activities()
      .filter((activity) => activity.route && !existing.has(activity.route))
      .map((activity) => `${activity.code} ${activity.route}`);
    expect(missing).toEqual([]);
  });

  it('links every built activity from the workbench', () => {
    const pending = activities()
      .filter((activity) => activity.route && existing.has(activity.route) && !builtRoutes.includes(`'${activity.route}'`))
      .map((activity) => activity.route);
    expect([...new Set(pending)]).toEqual([]);
  });

  it('lets the command bar open every built workbench activity', () => {
    const registry = terms();
    const silent = activities()
      .filter((activity) => activity.route && existing.has(activity.route) && !registry.has(activity.code))
      .map((activity) => activity.code);
    expect(silent).toEqual([]);
  });
});
