#!/usr/bin/env node
/**
 * Regenerates the index tables in docs/codemap/ from the source.
 *
 *   node scripts/codemap-index.mjs           # rewrite the generated sections
 *   node scripts/codemap-index.mjs --check   # exit 1 if any file would change
 *
 * Hand-written parts are kept: everything in a module file (and shared.md) above `## Files`
 * (title, purpose line, Gotchas), shared.md above `## Used by`, and database.md above
 * `## Tables by owning module`. Everything below those headings is generated.
 *
 * File ownership is read from the existing tables, so a file stays where it is listed.
 * A new file under src/modules/<m> goes to <m>; a new src/app file goes with the module
 * named for its folder or its siblings, else the module whose services it imports most;
 * anything else is shared. Move a row by hand to reassign it; the next run keeps it.
 *
 * Reads docs/codemap/import-graph.json for dependencies; refresh that first with
 *   npx madge --json --ts-config tsconfig.json --extensions ts,tsx src > docs/codemap/import-graph.json
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const MAP = join(ROOT, 'docs/codemap');
const CHECK = process.argv.includes('--check');
const MODULES = ['audit', 'finance', 'foundation', 'inventory', 'people', 'platform', 'production', 'purchasing', 'quality', 'sales'];
const docPath = (mod) => join(MAP, mod === 'shared' ? 'shared.md' : `modules/${mod}.md`);

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
});
const files = walk(join(ROOT, 'src')).map((path) => relative(join(ROOT, 'src'), path).split('\\').join('/')).sort();
const text = Object.fromEntries(files.map((f) => [f, readFileSync(join(ROOT, 'src', f), 'utf8')]));
const isSchema = (f) => /(^|\/)[\w-]*schema\.ts$|^platform\/tables\//.test(f);

// --- tables: Drizzle identifier -> SQL name, SQL name -> defining file
const ident2sql = {};
const sqlOwner = {};
for (const f of files) {
  for (const m of text[f].matchAll(/export const (\w+)\s*=\s*pgTable\(\s*['"](\w+)['"]/g)) {
    ident2sql[m[1]] = m[2];
    sqlOwner[m[2]] = f;
  }
}
const sqlNames = Object.keys(sqlOwner).sort((a, b) => b.length - a.length);
const sqlRe = new RegExp(`\\b(?:from|join|into|update|table|exists)\\s+(?:public\\.)?"?(${sqlNames.join('|')})\\b`, 'gi');

function exportsOf(src) {
  const out = new Set();
  for (const m of src.matchAll(/^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|enum|abstract class)\s+(\w+)/gm)) out.add(m[1]);
  if (/^export default/m.test(src) && !/^export default (?:async )?(?:function|class) \w+/m.test(src)) out.add('default');
  for (const m of src.matchAll(/^export\s+\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '');
      if (name && !part.trim().startsWith('type ')) out.add(name);
    }
  }
  for (const m of src.matchAll(/^export \* from ['"]([^'"]+)['"]/gm)) out.add(`*${m[1]}`);
  for (const boilerplate of ['dynamic', 'generateMetadata', 'metadata', 'revalidate', 'runtime']) out.delete(boilerplate);
  return [...out];
}

function tablesOf(f) {
  if (f.startsWith('app/') || f.startsWith('ui/')) return [];
  const src = text[f];
  const set = new Set();
  if (isSchema(f)) {
    for (const m of src.matchAll(/pgTable\(\s*['"](\w+)['"]/g)) set.add(m[1]);
  } else {
    for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"][^'"]*(?:schema|tables)[^'"]*['"]/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '');
        if (ident2sql[name]) set.add(ident2sql[name]);
      }
    }
    for (const m of src.matchAll(sqlRe)) set.add(m[1]);
  }
  return [...set].sort();
}

// --- ownership: the existing tables first
const listed = {};
for (const mod of [...MODULES, 'shared']) {
  if (!existsSync(docPath(mod))) continue;
  const doc = readFileSync(docPath(mod), 'utf8');
  const section = doc.split(/^## /m).find((sec) => sec.startsWith('Files')) ?? '';
  let dir = '';
  for (const line of section.split('\n')) {
    const header = line.match(/^\| \*\*([^*]+)\*\* \|/);
    if (header) { dir = header[1]; continue; }
    const row = line.match(/^\| ([^|*\s][^|]*?) \|/);
    if (row && row[1] !== 'file' && !row[1].startsWith('---')) listed[dir + row[1]] = mod;
  }
}
const importBest = (f, among) => {
  const counts = {};
  for (const m of text[f].matchAll(/modules\/(\w+)\//g)) if (!among || among.includes(m[1])) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
};
const AREA = { controlling: 'foundation', 'constrained-values': 'foundation' };
const owner = {};
const added = [];
for (const f of files) {
  const parts = f.split('/');
  if (parts[0] === 'modules') { owner[f] = parts[1]; continue; }
  if (listed[f]) { owner[f] = listed[f]; continue; }
  if (parts[0] !== 'app') { owner[f] = 'shared'; continue; }
  const dir = f.slice(0, f.lastIndexOf('/') + 1);
  const siblings = new Set(Object.keys(listed).filter((k) => k.startsWith(dir) && !k.slice(dir.length).includes('/')).map((k) => listed[k]));
  owner[f] = siblings.size === 1 ? [...siblings][0]
    : MODULES.includes(parts[1]) ? parts[1]
    : AREA[parts[1]] ?? (parts.length <= 3 ? 'shared' : importBest(f) ?? 'shared');
  added.push(`${f} -> ${owner[f]}`);
}

// --- dependencies from the import graph
const graph = JSON.parse(readFileSync(join(MAP, 'import-graph.json'), 'utf8'));
const unit = (f) => (owner[f] === 'shared' ? f.split('/').slice(0, 2).join('/') : owner[f]);
const deps = {};
const usedBy = {};
const unitUsers = {};
for (const [f, targets] of Object.entries(graph)) {
  if (!owner[f]) continue;
  for (const t of targets) {
    if (!owner[t]) continue;
    const from = owner[f] === 'shared' ? unit(f) : owner[f];
    const to = owner[t] === 'shared' ? unit(t) : owner[t];
    if (from === to || from === 'platform/schema.ts') continue;
    if (owner[f] !== 'shared') (deps[owner[f]] ??= new Set()).add(to);
    if (owner[t] !== 'shared') (usedBy[owner[t]] ??= new Set()).add(from);
    else (unitUsers[to] ??= new Set()).add(from);
  }
}

// --- tests: listed under every module whose code they import
const testsBy = {};
for (const t of readdirSync(join(ROOT, 'tests')).filter((n) => /\.test\.tsx?$/.test(n)).sort()) {
  const src = readFileSync(join(ROOT, 'tests', t), 'utf8');
  const hit = new Set();
  for (const m of src.matchAll(/['"](?:\.\.\/)+src\/([^'"]+)['"]/g)) {
    const base = m[1].replace(/\.(ts|tsx)$/, '');
    const f = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((x) => text[x] !== undefined);
    if (f && owner[f] !== 'shared') hit.add(owner[f]);
  }
  for (const mod of hit) (testsBy[mod] ??= []).push(t.replace(/\.test\.tsx?$/, ''));
}

// --- rendering
const cell = (s) => s.replace(/\|/g, '\\|');
const dirOf = (f) => f.slice(0, f.lastIndexOf('/') + 1);
function filesTable(list) {
  const rows = ['| file | exports | tables |', '|---|---|---|'];
  let dir = null;
  for (const f of list) {
    if (dirOf(f) !== dir) { dir = dirOf(f); rows.push(`| **${dir}** | | |`); }
    rows.push(`| ${f.slice(dir.length)} | ${cell(exportsOf(text[f]).join(', '))} | ${tablesOf(f).join(', ')} |`);
  }
  return rows.join('\n');
}
const routeOf = (f) => '/' + f.replace(/^app\//, '').replace(/\/?(page\.tsx|route\.ts)$/, '').replace(/\([^)]*\)\//g, '');
const keepAbove = (path, heading, fallback) => {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : fallback;
  const at = current.indexOf(`\n${heading}`);
  return (at >= 0 ? current.slice(0, at) : current).trimEnd();
};

const outputs = {};
for (const mod of [...MODULES, 'shared']) {
  const list = files.filter((f) => owner[f] === mod).sort((a, b) => dirOf(a).localeCompare(dirOf(b)) || a.localeCompare(b));
  const routes = list.filter((f) => /(^|\/)(page\.tsx|route\.ts)$/.test(f)).map(routeOf);
  const owned = Object.entries(sqlOwner).filter(([, f]) => owner[f] === mod).map(([s]) => s).sort();
  const head = mod === 'shared'
    ? keepAbove(docPath(mod), '## Used by', '# Shared\n\n## Gotchas\n')
    : keepAbove(docPath(mod), '## Files', `# ${mod}\n\n## Gotchas\n`);
  const sections = [head, ''];
  if (mod === 'shared') {
    sections.push('## Used by', '| shared unit | used by |', '|---|---|',
      ...Object.keys(unitUsers).sort().map((u) => `| ${u} | ${[...unitUsers[u]].sort().join(', ')} |`), '');
  }
  sections.push(`## Files (${list.length})`, filesTable(list), '',
    `## Routes (${routes.length})`, routes.map((r) => `\`${r}\``).join(' · ') || '—', '',
    `## Tables owned (${owned.length})`, owned.join(', ') || '—', '');
  if (mod !== 'shared') {
    sections.push('## Depends on', [...(deps[mod] ?? [])].sort().join(', ') || '—', '',
      '## Used by', [...(usedBy[mod] ?? [])].sort().join(', ') || '—', '',
      `## Tests (${(testsBy[mod] ?? []).length})`, (testsBy[mod] ?? []).join(', ') || '—', '');
  }
  outputs[docPath(mod)] = sections.join('\n');
}

const refs = {};
for (const f of files) if (!isSchema(f)) for (const s of tablesOf(f)) (refs[s] ??= new Set()).add(unit(f));
const db = [keepAbove(join(MAP, 'database.md'), '## Tables by owning module', '# Database\n'), '', '## Tables by owning module (schema file: tables)'];
const byMod = {};
for (const [s, f] of Object.entries(sqlOwner)) (byMod[owner[f] === 'shared' ? 'platform (shared)' : owner[f]] ??= []).push(s);
for (const [mod, list] of Object.entries(byMod).sort()) {
  const bySchema = {};
  for (const t of list.sort()) (bySchema[sqlOwner[t]] ??= []).push(t);
  db.push(`### ${mod} (${list.length})`, ...Object.entries(bySchema).sort().map(([f, ts]) => `- \`${f}\`: ${ts.join(', ')}`), '');
}
db.push('## Cross-module access', '| table | owner | also used by |', '|---|---|---|');
for (const t of Object.keys(sqlOwner).sort()) {
  const own = unit(sqlOwner[t]);
  const others = [...(refs[t] ?? [])].filter((m) => m !== own).sort();
  if (others.length) db.push(`| ${t} | ${own} | ${others.join(', ')} |`);
}
outputs[join(MAP, 'database.md')] = db.join('\n') + '\n';

let changed = 0;
for (const [path, content] of Object.entries(outputs)) {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (before === content) continue;
  changed++;
  if (CHECK) console.log(`stale: ${relative(ROOT, path)}`);
  else writeFileSync(path, content);
}
for (const line of added) console.log(`new file placed: ${line}`);
console.log(`${files.length} files, ${Object.keys(sqlOwner).length} tables; ${changed} codemap file(s) ${CHECK ? 'stale' : 'written'}`);
if (CHECK && changed) process.exit(1);
