import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * UI contract: status colour comes from the `signal-*` tokens, not from raw Tailwind red/amber/green,
 * so every screen reads success, warning and error the same way. Dark-surface variants (shade 200
 * and 900+ on dark panels) are outside this rule.
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

describe('status palette', () => {
  it('uses signal tokens for light status text, backgrounds and borders', () => {
    const raw = /\b(text-(red|amber|green|emerald)-(700|800)|bg-(red|amber|green|emerald)-50|border-(red|amber|green|emerald)-(200|300))\b/;
    const offenders = files('src').filter((f) => raw.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
