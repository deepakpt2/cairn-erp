import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCREENS } from '@/ui/shell/screen-catalog';
import { visibleScreenIds } from '../src/ui/shell/screen-access';
import { EXPLICIT_GRANT_ONLY_CAPABILITIES } from '@/platform/auth/capability-policy';

const client = readFileSync('src/ui/shell/RelatedScreens.tsx', 'utf8');
const server = readFileSync('src/ui/shell/RelatedScreensAccess.tsx', 'utf8');
const access = readFileSync('src/ui/shell/screen-access.ts', 'utf8');

const maintenance = SCREENS.find((screen) => screen.code === 'CFG.FIN.COA.DEFINE')!;
const reading = SCREENS.find((screen) => /\.DISPLAY$|\.LIST$|\.REPORT$/.test(screen.code))!;
const uncoded = SCREENS.find((screen) => screen.code === '')!;

/**
 * The strip offers what a reader can use and withholds what they cannot — and
 * the authority list itself never reaches the browser.
 */
describe('related screens by authority', () => {
  it('withholds a maintenance screen from a reader who holds nothing', () => {
    const visible = visibleScreenIds([]);
    expect(visible.has(maintenance.id)).toBe(false);
  });

  it('offers a maintenance screen to a reader who holds exactly that authority', () => {
    expect(visibleScreenIds(['CFG.FIN.COA.DEFINE']).has(maintenance.id)).toBe(true);
  });

  it('honours wildcard authorities, on whole segments only', () => {
    expect(visibleScreenIds(['CFG.*']).has(maintenance.id)).toBe(true);
    // A held pattern must account for the whole required path and no more.
    expect(visibleScreenIds(['CFG']).has(maintenance.id)).toBe(false);
    expect(visibleScreenIds(['FIN.*']).has(maintenance.id)).toBe(false);
  });

  it('offers the reading screens to everybody, because opening a screen asks only for a session', () => {
    const visible = visibleScreenIds([]);
    expect(visible.has(reading.id)).toBe(true);
    expect(reading.code).not.toBe('');
  });

  it('offers a screen that claims no authority at all', () => {
    expect(visibleScreenIds([]).has(uncoded.id)).toBe(true);
  });

  it('offers everything to a reader who holds everything, bar what insists on an exact grant', () => {
    const visible = visibleScreenIds(['*']);
    const withheld = SCREENS.filter((screen) => !visible.has(screen.id));
    // Credit control and goods-movement reprocessing are deliberately exempt
    // from broad role patterns; a wildcard must not open them.
    expect(withheld.length).toBeGreaterThan(0);
    for (const screen of withheld) {
      expect(EXPLICIT_GRANT_ONLY_CAPABILITIES.has(screen.code)).toBe(true);
    }
  });

  it('opens those again for a reader granted the authority by name', () => {
    for (const code of EXPLICIT_GRANT_ONLY_CAPABILITIES) {
      const screen = SCREENS.find((entry) => entry.code === code);
      if (!screen) continue;
      expect(visibleScreenIds([code]).has(screen.id)).toBe(true);
    }
  });

  it('grows strictly: holding more never hides what was already offered', () => {
    const none = visibleScreenIds([]);
    const some = visibleScreenIds(['CFG.FIN.COA.DEFINE']);
    for (const id of none) expect(some.has(id)).toBe(true);
    expect(some.size).toBeGreaterThan(none.size);
  });
});

describe('related screens wiring', () => {
  it('decides on the server and sends the browser only screen ids', () => {
    expect(server).toContain('getSession()');
    expect(server).toContain('visibleScreenIds(');
    expect(server).toContain('session?.user.capabilities');
    // The authority list itself is never passed down.
    expect(server).not.toContain('capabilities={');
    expect(client).not.toContain('hasCapability');
  });

  it('filters every list it renders, and vanishes rather than standing empty', () => {
    expect(client).toContain('visibleScreenIds');
    expect(client).toContain('links.filter(');
    expect(client).toContain('more.filter(');
    expect(client).toContain('if (offered.length === 0 && alsoOffered.length === 0) return null;');
  });

  it('reads the catalogue rather than restating it', () => {
    expect(access).toContain("from './screen-catalog'");
    expect(access).toContain("from '@/platform/auth/session'");
    expect(access).not.toContain("code: 'CFG.");
  });
});
