// In-app user guide: serves the Markdown manual in docs/ (README + numbered module folders).
// Only the manual is reachable — never docs/codemap or the engineering notes beside it.
import fs from 'node:fs';
import path from 'node:path';

export const HELP_ROUTE = '/help';
const DOCS_DIR = () => path.join(process.cwd(), 'docs');
// README.md and the numbered folders (01-getting-started … 07-end-to-end-workflows).
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SECTION = /^\d\d-/;

export type HelpPage = { title: string; html: string; file: string };

/** Slug path (`['04-sd-sales-distribution','overview']`, or `[]` for the index) → file, or null. */
export function resolveHelpFile(slug: string[]): string | null {
  if (slug.length === 0) return 'README.md';
  if (slug.length !== 2 || !slug.every((s) => SAFE_SEGMENT.test(s)) || !SECTION.test(slug[0])) return null;
  return `${slug[0]}/${slug[1]}.md`;
}

export function loadHelpPage(slug: string[]): HelpPage | null {
  const file = resolveHelpFile(slug);
  if (!file) return null;
  let text: string;
  try { text = fs.readFileSync(path.join(DOCS_DIR(), file), 'utf8'); } catch { return null; }
  const title = /^#\s+(.+)$/m.exec(text)?.[1].replace(/[`*_]/g, '') ?? 'User guide';
  return { title, file, html: renderMarkdown(text, file) };
}

// ── Markdown → HTML (the subset the manual uses). Everything is escaped before markup is added. ──
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const slugify = (h: string) =>
  h.toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');

/** A manual link target → in-app URL, or null when it leaves the manual. */
export function helpHref(href: string, fromFile: string): string | null {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('#')) return href;
  const [target, hash] = href.split('#');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), target));
  if (!resolved.endsWith('.md') || resolved.startsWith('..')) return null;
  const parts = resolved.slice(0, -3).split('/');
  const slug = resolved === 'README.md' ? [] : parts;
  if (!resolveHelpFile(slug)) return null;
  return `${HELP_ROUTE}${slug.length ? '/' + slug.join('/') : ''}${hash ? '#' + hash : ''}`;
}

function inline(src: string, file: string): string {
  const codes: string[] = [];
  let s = src.replace(/`([^`]+)`/g, (_m, c: string) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
    const to = helpHref(href.replace(/&amp;/g, '&'), file);
    if (!to) return text;
    const ext = /^https?:/i.test(to);
    return `<a href="${esc(to)}"${ext ? ' rel="noopener noreferrer" target="_blank"' : ''}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
       .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

const indentOf = (l: string) => /^ */.exec(l)![0].length;
const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const CALLOUT = { NOTE: 'Note', IMPORTANT: 'Important', TIP: 'Tip', WARNING: 'Warning' } as const;

function blocks(lines: string[], file: string, ids: Map<string, number>): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const body: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`); continue;
    }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      const base = slugify(h[2]); const n = ids.get(base) ?? 0; ids.set(base, n + 1);
      out.push(`<h${h[1].length} id="${esc(n ? `${base}-${n}` : base)}">${inline(h[2], file)}</h${h[1].length}>`); i++; continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
      const kind = /^\[!(NOTE|IMPORTANT|TIP|WARNING)\]\s*$/.exec(body[0] ?? '');
      if (kind) out.push(`<aside class="callout callout-${kind[1].toLowerCase()}"><p class="callout-label">${CALLOUT[kind[1] as keyof typeof CALLOUT]}</p>${blocks(body.slice(1), file, ids)}</aside>`);
      else out.push(`<blockquote>${blocks(body, file, ids)}</blockquote>`);
      continue;
    }
    if (/^\|/.test(line) && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = cells(line); i += 2; const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c, file)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, file)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      const base = indentOf(line); const ordered = /\d/.test(li[2]);
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i]; const m = LIST.exec(l);
        if (m && indentOf(l) === base) { items.push([m[3]]); i++; }
        else if (items.length && l.trim() && indentOf(l) > base) { items[items.length - 1].push(l.slice(Math.min(indentOf(l), base + 2))); i++; }
        else if (items.length && !l.trim() && /^\s/.test(lines[i + 1] ?? '') && indentOf(lines[i + 1]) > base) { items[items.length - 1].push(''); i++; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(([first, ...rest]) => {
        const nested = rest.findIndex((r) => LIST.test(r));
        const cont = (nested < 0 ? rest : rest.slice(0, nested)).filter(Boolean).join(' ');
        const sub = nested < 0 ? '' : blocks(rest.slice(nested), file, ids);
        return `<li>${inline([first, cont].filter(Boolean).join(' '), file)}${sub}</li>`;
      }).join('')}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>|\|)/.test(lines[i]) && !LIST.test(lines[i])) para.push(lines[i++].trim());
    if (!para.length) { para.push(lines[i++]); }
    out.push(`<p>${inline(para.join(' '), file)}</p>`);
  }
  return out.join('\n');
}

export function renderMarkdown(text: string, file: string): string {
  return blocks(text.replace(/\r\n/g, '\n').split('\n'), file, new Map());
}
