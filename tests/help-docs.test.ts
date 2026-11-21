import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { helpHref, loadHelpPage, renderMarkdown, resolveHelpFile } from '@/modules/platform/help-docs';

describe('in-app user guide', () => {
  it('serves only the manual, never other files under docs/', () => {
    expect(resolveHelpFile([])).toBe('README.md');
    expect(resolveHelpFile(['codemap', 'README'])).toBeNull();
    expect(resolveHelpFile(['04-sd-sales-distribution', '..%2f..%2fREADME'])).toBeNull();
    expect(resolveHelpFile(['01-getting-started', '..'])).toBeNull();
    expect(resolveHelpFile(['01-getting-started', 'a', 'b'])).toBeNull();
    expect(loadHelpPage(['01-getting-started', 'nope'])).toBeNull();
  });

  it('maps manual links to /help and drops links that leave the manual', () => {
    expect(helpHref('../05-fico-finance-controlling/master-data.md#x', '04-sd-sales-distribution/overview.md')).toBe('/help/05-fico-finance-controlling/master-data#x');
    expect(helpHref('../README.md', '01-getting-started/login-and-roles.md')).toBe('/help');
    expect(helpHref('../../src/app/page.tsx', '01-getting-started/a.md')).toBeNull();
    expect(helpHref('../codemap/README.md', '01-getting-started/a.md')).toBeNull();
  });

  it('escapes raw HTML', () => {
    expect(renderMarkdown('<script>alert(1)</script> `<b>`', 'README.md')).not.toContain('<script>');
  });

  it('renders every manual page and keeps every internal link resolvable', () => {
    const docs = path.join(process.cwd(), 'docs');
    const files = ['README.md', ...fs.readdirSync(docs).filter((d) => /^\d\d-/.test(d)).flatMap((d) => fs.readdirSync(path.join(docs, d)).map((f) => `${d}/${f}`))];
    for (const f of files) {
      const slug = f === 'README.md' ? [] : f.replace(/\.md$/, '').split('/');
      const page = loadHelpPage(slug);
      expect(page, f).not.toBeNull();
      expect(page!.html, f).not.toMatch(/\]\(/);
    }
  });
});
