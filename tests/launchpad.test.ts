import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { launchpadFor } from '@/ui/shell/launchpad';
import { SCREENS } from '@/ui/shell/screen-catalog';

describe('launchpad', () => {
  it('offers a reader holding nothing no work and no setup', () => {
    expect(launchpadFor([])).toEqual({ work: [], setup: [] });
  });

  it('offers only screens whose own code the reader holds, and no reading screens', () => {
    const view = launchpadFor(['PROC.PO.CREATE']);
    const ids = view.work.flatMap((w) => w.items.map((i) => i.id));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const screen = SCREENS.find((s) => s.id === id)!;
      expect(screen.code, id).toBe('PROC.PO.CREATE');
    }
  });

  it('follows a role pattern the same as an exact grant', () => {
    const exact = launchpadFor(['PROC.PO.CREATE']).work.flatMap((w) => w.items.map((i) => i.id));
    const pattern = launchpadFor(['PROC.PO.*']).work.flatMap((w) => w.items.map((i) => i.id));
    for (const id of exact) expect(pattern).toContain(id);
  });

  it('shows no more than five per module, in the module order', () => {
    const view = launchpadFor(['INV.*', 'PROC.*', 'FIN.*', 'SALES.*', 'PROD.*']);
    for (const w of view.work) expect(w.items.length).toBeLessThanOrEqual(5);
    const order = ['mm', 'pp', 'qm', 'fico', 'sd', 'hr'];
    const seen = view.work.map((w) => order.indexOf(w.module));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('keeps configuration and administration out of the work list', () => {
    const ids = launchpadFor(['CFG.*', 'PLT.*']).work.flatMap((w) => w.items.map((i) => i.id));
    for (const id of ids) {
      const nav = SCREENS.find((s) => s.id === id)!.nav!;
      expect(nav.module).not.toBe('admin');
      expect(nav.category).not.toBe('Configuration');
    }
  });

  it('offers setup tiles only to a reader holding the authority behind them', () => {
    expect(launchpadFor(['PROC.PO.CREATE']).setup).toEqual([]);
    expect(launchpadFor(['CFG.PLT.CLIENT.DEFINE']).setup).toEqual(['tenants', 'workbench']);
    expect(launchpadFor(['CFG.PLT.NUMBERRANGE.DEFINE']).setup).toEqual(['workbench', 'numberRanges']);
    expect(launchpadFor(['*'])).toEqual({ work: [], setup: ['tenants', 'workbench', 'numberRanges'] });
  });

  it('keeps the system-status panel and setup tiles behind that same check', () => {
    const page = readFileSync('src/app/page.tsx', 'utf8');
    expect(page).toContain('launchpadFor(session.user.capabilities)');
    expect(page).toContain("view.setup.includes('tenants')");
  });
});

describe('command bar links', () => {
  const bar = readFileSync('src/ui/shell/CommandBar.tsx', 'utf8');
  const links = readFileSync('src/ui/shell/CommandBarLinks.tsx', 'utf8');

  it('no longer hard-codes the setup links for every reader', () => {
    expect(bar).not.toContain('href="/clients"');
    expect(bar).not.toContain('href="/config"');
    expect(bar).toContain('<CommandBarLinks />');
  });

  it('decides them from the same setup authority as the launchpad', () => {
    expect(links).toContain('launchpadFor(session.user.capabilities).setup');
    expect(links).toContain("setup.includes('tenants')");
    expect(links).toContain("setup.includes('workbench')");
  });
});
