import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCREENS } from '@/ui/shell/screen-catalog';
import { ALSO, relatedLinks, screenHref } from '@/ui/shell/screen-links';

function href(path: string, query: string): string {
  const links = relatedLinks(path, new URLSearchParams(query));
  return links.links.concat(links.more).map((link) => `${link.screen.path} ${link.href}`).join('\n');
}

function one(path: string, query: string, target: string): string {
  const links = relatedLinks(path, new URLSearchParams(query));
  const hit = links.links.concat(links.more).find((link) => link.screen.path === target);
  return hit?.href ?? '';
}

describe('screen links', () => {
  it('lists every built page except sign-in, and no missing page', () => {
    const pages = new Set<string>();
    const walk = (directory: string, route: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path, `${route}/${name}`);
        else if (name === 'page.tsx') pages.add(route || '/');
      }
    };
    walk(join(process.cwd(), 'src/app'), '');
    pages.delete('/signin');
    const paths = new Set(SCREENS.map((screen) => screen.path));
    expect([...pages].filter((path) => !paths.has(path))).toEqual([]);
    expect([...paths].filter((path) => !pages.has(path))).toEqual([]);
    expect(new Set(SCREENS.map((screen) => screen.id)).size).toBe(SCREENS.length);
    for (const targets of Object.values(ALSO)) {
      for (const target of targets) expect(paths.has(target), target).toBe(true);
    }
  });

  it('opens a related screen without posting or starting a run', () => {
    const list = one('/production/production-order-display', 'order=10001&plant=1000', '/production/order-information');
    expect(list).toContain('selection=PRODUCTION_ORDER%3AHEADERS');
    expect(list).toContain('order=10001');
    expect(list).not.toContain('run=');

    const planned = one('/production/planned-order-display', 'order=20002&plant=1000', '/production/order-information');
    const plannedParams = new URLSearchParams(planned.split('?')[1] ?? '');
    expect(plannedParams.get('selection')).toBe('PLANNED_ORDER:HEADERS');
    expect(plannedParams.get('plannedOrder')).toBe('20002');
    expect(plannedParams.get('plant')).toBe('1000');
    expect(plannedParams.get('order')).toBeNull();
    expect(plannedParams.get('run')).toBeNull();

    const back = one('/production/order-information', 'selection=PLANNED_ORDER:HEADERS&plannedOrder=20002', '/production/planned-order-display');
    expect(back).toContain('order=20002');

    const production = one('/production/planned-order-display', 'order=20002', '/production/production-order-display');
    expect(production).toBe('/production/production-order-display');

    const receipt = one('/purchasing/purchase-order-display', 'order=4500001', '/inventory/goods-receipt');
    expect(receipt).toBe('/inventory/goods-receipt?order=4500001');

    const clearing = one('/purchasing/purchase-order-display', 'order=4500001', '/purchasing/grir-clearing');
    expect(clearing).toContain('orderFrom=4500001');
    expect(clearing).toContain('orderTo=4500001');
  });

  it('does not copy a refusal field onto single-level planning', () => {
    const planning = SCREENS.find((screen) => screen.path === '/production/single-level-planning');
    expect(planning?.accepts).not.toContain('companyCode');
    const opened = one('/finance/customer-balances', 'companyCode=1000&material=RM1&plant=1000', '/production/single-level-planning');
    expect(opened === '' || !opened.includes('companyCode=')).toBe(true);
  });

  it('does not put an operation number on production-order display', () => {
    const display = one('/production/time-ticket', 'order=10001&operation=0010', '/production/production-order-display');
    expect(display).toContain('order=10001');
    expect(display).not.toContain('operation=');
  });

  it('never carries a run, post, or save flag', () => {
    const search = new URLSearchParams('run=1&post=1&save=1&action=post&order=1&plant=1000');
    for (const screen of SCREENS) {
      const links = relatedLinks(screen.path, search);
      for (const link of links.links.concat(links.more)) {
        const params = new URLSearchParams(link.href.split('?')[1] ?? '');
        expect(params.get('run'), link.href).toBeNull();
        expect(params.get('post'), link.href).toBeNull();
        expect(params.get('save'), link.href).toBeNull();
        expect(params.get('action'), link.href).toBeNull();
      }
    }
  });

  it('keeps a screen query that defines the screen', () => {
    const sales = SCREENS.find((screen) => screen.id === '/foundation/partners?view=CUSTOMER_SALES');
    expect(sales).toBeTruthy();
    expect(screenHref(sales!)).toBe('/foundation/partners?view=CUSTOMER_SALES');
  });
});
