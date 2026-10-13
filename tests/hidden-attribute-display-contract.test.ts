import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B-157 regression guard — the `hidden` attribute versus display utilities.
 *
 * A JSX element must never combine the HTML `hidden` attribute with a display
 * utility class (`flex`, `block`, `grid`, `inline-flex`, …). The browser's
 * `[hidden] { display: none }` rule lives in the user-agent stylesheet, so any
 * author `display` declaration silently wins and the "hidden" element stays
 * laid out — invisible in code review, and it keeps intercepting pointer
 * events. That is exactly how SCR-020's closed Central Address dialog covered
 * the form and made the page unclickable; the service tests could not see it
 * and only the real browser acceptance run found it.
 *
 * The fix pattern is conditional mounting (`{open && (…)}`) or a conditional
 * display class — never the `hidden` attribute next to a display utility.
 */

const DISPLAY_UTILITIES = /(?:^|[\s"'`])(flex|block|grid|inline|inline-flex|inline-block|table)(?:[\s"'`]|$)/;

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.name.endsWith('.tsx')) found.push(full);
  }
  return found;
}

describe('hidden attribute versus display utilities (B-157 guard)', () => {
  it('never combines hidden={…} with a display utility class in the same element', () => {
    const offenders: string[] = [];
    for (const file of walk('src')) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!line.includes('hidden={')) return;
        const classAttribute = line.match(/className="([^"]*)"/)?.[1] ?? '';
        if (DISPLAY_UTILITIES.test(classAttribute)) {
          offenders.push(`${file}:${index + 1} → ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
