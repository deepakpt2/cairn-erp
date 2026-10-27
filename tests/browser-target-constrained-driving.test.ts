import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A browser target has to drive a field the way the screen it opened renders it.
 *
 * `ConstrainedField` picks the control from the kind: anything in `CLOSED_KINDS` becomes a
 * `<select>`, everything else becomes a combobox `<input>` with a suggestion list. A target that
 * types into a select, or picks an option out of a combobox, does not fail with a useful message —
 * it waits thirty seconds for a control that will never exist, and the run reads as a broken screen
 * rather than as a stale target. Seven targets sat in that state on `main` at once while the vitest
 * suite stayed green, because nothing in the suite opens a browser.
 *
 * So the pairing is checked here against the same list the component reads: a name the page renders
 * as a closed field must not be addressed as `input[name="…"]`, and a name it renders as an open
 * field must not be addressed as `select[name="…"]`. The rule is on the selector rather than on the
 * call, because a target reaches the same control through `page.fill`, a scoped `locator`, or an
 * option lookup, and every one of those is wrong when the control is the other element.
 *
 * Which control a name is depends on the page, not on the name: `companyCode` is a closed select
 * inside a form and a plain text filter above a list. So it is resolved per page, from the route the
 * target navigated to or the route the runner opened for it. Where neither is readable, the file is
 * left alone rather than guessed at.
 */
const ROOT = process.cwd();
const APP = join(ROOT, 'src', 'app');
const TARGETS = join(ROOT, 'scripts', 'browser-smoke');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function closedKinds(): Set<string> {
  const source = readFileSync(join(ROOT, 'src/modules/foundation/constrained-kinds.ts'), 'utf8');
  const block = source.split('CLOSED_KINDS = new Set<ConstrainedKind>(')[1] ?? '';
  const kinds = new Set<string>();
  for (const match of block.matchAll(/'([a-z-]+)'/g)) kinds.add(match[1]);
  return kinds;
}

/** The name an element declares: a string literal, or the prefix of a template literal. */
function declaredName(fragment: string): string | undefined {
  const literal = fragment.match(/\bname="([^"]+)"/);
  if (literal) return literal[1];
  const template = fragment.match(/\bname=\{`([^-`$]*)/);
  return template?.[1] ? `${template[1]}*` : undefined;
}

type PageFields = { closed: Set<string>; open: Set<string>; plain: Set<string> };

/** What one page renders each name as, read from every component that lives beside it. */
function pageFields(directory: string, kinds: Set<string>): PageFields {
  const fields: PageFields = { closed: new Set(), open: new Set(), plain: new Set() };
  for (const file of walk(directory).filter((candidate) => candidate.endsWith('.tsx'))) {
    const source = readFileSync(file, 'utf8');
    for (const part of source.split('<ConstrainedField').slice(1)) {
      const fragment = part.slice(0, 700);
      const kind = fragment.match(/\bkind="([^"]+)"/)?.[1];
      const name = declaredName(fragment);
      if (!kind || !name) continue;
      (kinds.has(kind) ? fields.closed : fields.open).add(name);
    }
    for (const match of source.matchAll(/<input\b[^>]*?\bname=(?:"([^"]+)"|\{`([^-`$]*))/g)) {
      const name = match[1] ?? (match[2] ? `${match[2]}*` : '');
      if (name) fields.plain.add(name);
    }
  }
  return fields;
}

/** Route path → the directory that serves it, with route-group folders removed from both sides. */
function routeDirectories(): Map<string, string> {
  const routes = new Map<string, string>();
  for (const file of walk(APP)) {
    if (!file.endsWith(`${sep}page.tsx`)) continue;
    const directory = file.slice(0, -`${sep}page.tsx`.length);
    const route = relative(APP, directory).split(sep).filter((segment) => !segment.startsWith('(')).join('/');
    routes.set(`/${route}`.replace(/\/+$/, ''), directory);
  }
  return routes;
}

/** The routes a target opens, in file order, so a fill can be read against the page above it. */
function visitedRoutes(source: string): Array<{ line: number; route: string | undefined }> {
  // A target's route is usually a file-level constant named after the screen rather than after a
  // route, so any constant holding a path is fair game.
  const constants = new Map<string, string>();
  for (const match of source.matchAll(/const (\w+) = '(\/[^']*)'/g)) constants.set(match[1], match[2]);
  const stops: Array<{ line: number; route: string | undefined }> = [];
  source.split('\n').forEach((line, index) => {
    if (!line.includes('page.goto(')) return;
    const inline = line.match(/page\.goto\(\s*`\$\{base\}(\/[^?`"]*)/)?.[1];
    if (inline) return stops.push({ line: index + 1, route: inline });
    const named = line.match(/page\.goto\(\s*`\$\{base\}\$\{(\w+)\}/)?.[1];
    if (named) return stops.push({ line: index + 1, route: constants.get(named) });
    stops.push({ line: index + 1, route: undefined });
  });
  return stops;
}

/**
 * The route the runner opens before it hands the page to a target, read from its own mapping. A
 * target that does not navigate itself is therefore still judged against the screen it starts on.
 */
function entryRoutes(): Map<string, string> {
  const source = readFileSync(join(ROOT, 'scripts/browser-smoke.ts'), 'utf8');
  const body = source.split('function protectedRouteFor')[1]?.split('\n}')[0] ?? '';
  const routes = new Map<string, string>();
  for (const line of body.split('\n')) {
    const route = line.match(/return '(\/[^']*)'/)?.[1];
    if (!route) continue;
    for (const id of line.matchAll(/target\.id === '([a-z0-9-]+)'/g)) routes.set(id[1], route);
  }
  return routes;
}

/** Every `input[name="…"]` / `select[name="…"]` a line addresses, however it got there. */
function addressedSelectors(line: string): Array<{ control: 'input' | 'select'; name: string }> {
  const found: Array<{ control: 'input' | 'select'; name: string }> = [];
  for (const match of line.matchAll(/'(input|select)\[name="([^"]+)"\]/g)) {
    found.push({ control: match[1] as 'input' | 'select', name: match[2] });
  }
  return found;
}

function routeOf(route: string, routes: Map<string, string>): string | undefined {
  const path = route.split('?')[0].replace(/\/+$/, '') || '/';
  if (routes.has(path)) return path;
  // A target may append a segment the page resolves itself (a dialog, a tab): take the longest
  // known route that the visited path starts with.
  let best: string | undefined;
  for (const known of routes.keys()) {
    if (known !== '/' && (path === known || path.startsWith(`${known}/`)) && (!best || known.length > best.length)) best = known;
  }
  return best;
}

function findings(): { problems: string[]; checkedFiles: number; pagesMapped: number; drivesRead: number } {
  const kinds = closedKinds();
  const routes = routeDirectories();
  const entry = entryRoutes();
  const cache = new Map<string, PageFields>();
  const problems: string[] = [];
  let drivesRead = 0;
  let checkedFiles = 0;
  for (const file of walk(TARGETS).filter((candidate) => candidate.endsWith('.ts'))) {
    const source = readFileSync(file, 'utf8');
    const ownStops = visitedRoutes(source);
    const targetId = file.slice(0, -3).split('/').pop() as string;
    const entryRoute = entry.get(targetId);
    if (!ownStops.length && !entryRoute) continue;
    checkedFiles += 1;
    // The runner opens the entry screen first, so a fill before the target's own goto belongs there.
    const stops = [...(entryRoute ? [{ line: 0, route: entryRoute }] : []), ...ownStops];
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      const addressed = addressedSelectors(line);
      if (!addressed.length) return;
      const upTo = stops.filter((stop) => stop.line <= index + 1);
      const route = upTo[upTo.length - 1]?.route ? routeOf(upTo[upTo.length - 1].route as string, routes) : undefined;
      if (!route) return;
      let fields = cache.get(route);
      if (!fields) {
        fields = pageFields(routes.get(route) as string, kinds);
        cache.set(route, fields);
      }
      const where = `${relative(ROOT, file)}:${index + 1}`;
      for (const selector of addressed) {
        drivesRead += 1;
        // A row field is named with a suffix on the page and in the target (`plant-1`), so a name
        // recovered from a template literal is matched on its prefix.
        const matches = (name: string) => (name.endsWith('*')
          ? selector.name.startsWith(name.slice(0, -1)) : selector.name === name);
        // Where the same page also writes the name into a plain input, both elements exist and the
        // target may honestly mean either one.
        const asText = [...fields.plain].some(matches);
        if (selector.control === 'input' && !asText && [...fields.closed].some(matches)) {
          problems.push(`${where} addresses input[name="${selector.name}"] on ${route}, where the screen renders that field as a <select>. Drive it with chooseClosed() from scripts/browser-smoke/closed-fields.ts.`);
        }
        if (selector.control === 'select' && !asText && [...fields.open].some(matches)) {
          problems.push(`${where} addresses select[name="${selector.name}"] on ${route}, where the screen renders a combobox input. Fill the field and choose from its suggestion list.`);
        }
      }
    });
  }
  return { problems, checkedFiles, pagesMapped: routes.size, drivesRead };
}

describe('browser targets drive a constrained field as the page renders it', () => {
  it('finds the pages and fields it claims to read', () => {
    // The guard is only worth having while it is looking at real screens, so a moved directory or a
    // renamed prop that would leave it scanning nothing has to fail here rather than pass quietly.
    const { checkedFiles, pagesMapped, drivesRead } = findings();
    expect(pagesMapped).toBeGreaterThanOrEqual(200);
    expect(checkedFiles).toBeGreaterThanOrEqual(100);
    // Most targets drive their fields by label or role, so only the handful of lines that name a
    // control by attribute are in scope. The floor says the scanner still sees those, not that it
    // sees everything.
    expect(drivesRead).toBeGreaterThanOrEqual(20);
  });

  it('types only into what is open and selects only in what is closed', () => {
    expect(findings().problems).toEqual([]);
  });
});
