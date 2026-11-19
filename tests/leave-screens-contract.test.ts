/** Source-level contract for the leave screens: one new screen, live-session actions, protected export routes. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const walk = (dir: string): string[] => readdirSync(join(process.cwd(), dir)).flatMap((n) => {
  const rel = `${dir}/${n}`;
  return statSync(join(process.cwd(), rel)).isDirectory() ? walk(rel) : [rel];
});

describe('leave screens', () => {
  it('adds exactly one screen, /config/time-types, and keeps /people/time-leave as the tabbed screen', () => {
    const catalog = read('src/ui/shell/screen-catalog.ts');
    expect(catalog.match(/id: "\/config\/time-types"/g)).toHaveLength(1);
    expect(catalog.match(/id: "\/people\/time-leave"/g)).toHaveLength(1);
    const pages = walk('src/app').filter((f) => f.endsWith('/page.tsx') && /time-types|time-leave|leave/.test(f)).sort();
    expect(pages).toEqual(['src/app/config/time-types/page.tsx', 'src/app/people/time-leave/page.tsx']);
    const page = read('src/app/people/time-leave/page.tsx');
    for (const tab of ["'absences'", "'time'", "'balances'"]) expect(page).toContain(tab);
  });

  it('server actions use the live session and never a capability array or a composite absence identity', () => {
    for (const f of ['src/app/people/time-leave/actions.ts', 'src/app/config/time-types/actions.ts', 'src/app/people/leave-live.ts']) {
      const text = read(f);
      expect(text, f).not.toMatch(/user\.capabilities/);
      expect(text, f).not.toMatch(/\bcan\(/);
    }
    const actions = read('src/app/people/time-leave/actions.ts');
    expect(actions).toContain('absenceId');
    expect(actions).toContain('confirmUnpaid');
    expect(actions).toContain('liveLeave(');
    expect(read('src/app/people/leave-live.ts')).toContain('authorization: { userId');
  });

  it('export routes need a session and are never cached', () => {
    for (const f of ['src/app/api/leave/balances/export/route.ts', 'src/app/api/leave/balances/export/[exportId]/route.ts']) {
      const text = read(f);
      expect(text, f).toContain('getSession');
      expect(text, f).toContain('401');
      expect(text, f).toContain("'Cache-Control': 'private, no-store'");
      expect(text, f).toContain("attachment");
    }
  });

  it('the absence list is keyed by id, and the request form previews before it asks for confirmation', () => {
    const tab = read('src/app/people/time-leave/AbsencesTab.tsx');
    expect(tab).toContain('key={a.id}');
    expect(tab).toContain('name="absenceId"');
    expect(tab).toContain('previewAbsenceAction');
    expect(tab).toContain('requiresConfirmation');
  });
});
