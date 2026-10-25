/**
 * Links between built screens.
 *
 * A link opens the other screen. It does not post, confirm, release, or start
 * a planning run. Selection values are copied only when the target already
 * reads that field. An order number is not copied onto a different kind of
 * order.
 */
import { SCREENS, type ScreenArea, type ScreenLink } from './screen-catalog';

const BANNED = new Set(['run', 'post', 'action', 'confirm', 'confirmed', 'save', 'requestKey', 'payload', 'mode', 'reason']);

/** Copied between screens in the same family. */
const SAME_FAMILY = new Set([
  'order', 'orderNumber', 'plannedOrder', 'plant', 'material', 'materialNumber',
  'document', 'documentNumber', 'company', 'companyCode', 'year', 'fiscalYear',
  'vendor', 'customer', 'partner', 'supplier', 'batch', 'workCenter', 'usage',
  'alternative', 'validOn', 'type', 'group', 'counter', 'view', 'agreement',
  'contract', 'requisition', 'storageLocation', 'productionVersion',
  'controllingArea', 'costCenter', 'profitCenter', 'asset', 'sub', 'glAccount',
  'chartOfAccounts', 'purchasingOrg', 'purchasingGroup', 'chart', 'account',
  'selection', 'invoice', 'parked', 'component', 'dateFrom', 'dateTo', 'dateBasis',
  'mrpController', 'orderFrom', 'orderTo', 'companyFrom', 'companyTo',
  'documentDateFrom', 'documentDateTo', 'keyDate', 'salesOrg', 'distributionChannel',
  'division', 'operation', 'movementType', 'req', 'agreementNumber', 'contractNumber',
]);

/** Safe to copy across families. An order number is not in this set. */
const CROSS_FAMILY = new Set([
  'plant', 'material', 'materialNumber', 'company', 'companyCode', 'vendor',
  'customer', 'supplier', 'batch', 'workCenter', 'chart', 'account', 'chartOfAccounts',
]);

/**
 * Screens that belong to the work of another family. These are paths, not
 * reference codes. The family strip already lists its own members.
 */
export const ALSO: Record<string, readonly string[]> = {
  platform: ['/clients', '/config', '/finance/journal', '/inventory/materials', '/purchasing/orders', '/production/orders'],
  tenants: ['/config', '/'],
  workbench: ['/config/company-codes', '/config/plants', '/config/chart-of-accounts'],
  partners: ['/finance/customer-invoice', '/finance/vendor-invoice', '/purchasing/orders'],
  'planned-orders': [
    '/production/order-information',
    '/production/production-order-display',
    '/production/stock-requirements',
    '/production/single-item-planning',
    '/production/boms',
  ],
  'production-orders': [
    '/production/planned-order-display',
    '/production/stock-requirements',
    '/production/single-item-planning',
    '/inventory/material-documents',
    '/production/boms',
    '/config/scheduling-profiles',
  ],
  planning: [
    '/production/planned-order-display',
    '/production/boms',
    '/inventory/materials',
    '/inventory/stock-overview',
    '/production/order-information',
  ],
  'production-master': ['/inventory/materials', '/production/orders', '/production/stock-requirements'],
  'purchase-orders': [
    '/purchasing/requisitions',
    '/inventory/goods-receipt',
    '/purchasing/invoice-verification',
    '/purchasing/grir-clearing',
    '/purchasing/invoice-overview',
    '/inventory/material-documents',
    '/config/release-strategies',
  ],
  requisitions: ['/purchasing/rfq', '/purchasing/orders', '/purchasing/purchase-order-display'],
  quotations: ['/purchasing/orders', '/purchasing/purchase-order-display'],
  contracts: ['/purchasing/orders', '/purchasing/purchase-order-display', '/purchasing/info-record'],
  'scheduling-agreements': ['/inventory/goods-receipt', '/purchasing/purchase-order-list'],
  'invoice-verification': [
    '/purchasing/purchase-order-display',
    '/inventory/goods-receipt',
    '/finance/journal/document',
    '/purchasing/grir-clearing',
  ],
  'goods-movement': [
    '/inventory/material-documents',
    '/inventory/stock-overview',
    '/purchasing/purchase-order-display',
    '/inventory/materials',
  ],
  materials: ['/inventory/stock-overview', '/production/boms', '/production/single-item-planning', '/production/production-versions'],
  stock: ['/inventory/materials', '/inventory/material-documents', '/inventory/migo', '/production/stock-requirements'],
  'material-documents': ['/inventory/migo', '/inventory/stock-overview', '/finance/journal/document', '/purchasing/purchase-order-display'],
  journal: ['/finance/customer-invoice', '/finance/vendor-invoice', '/finance/gl-clearing'],
  'customer-accounting': ['/finance/journal/document', '/foundation/partners'],
  'vendor-accounting': ['/finance/journal/document', '/foundation/partners', '/purchasing/invoice-verification'],
  assets: ['/finance/journal/document', '/config/account-determination'],
  'internal-orders': ['/controlling/original-budget', '/controlling/settlement-rules', '/controlling/order-settlement'],
  'order-settlement': ['/controlling/internal-order-display', '/controlling/settlement-rules', '/finance/journal/document'],
  'order-budget': ['/controlling/internal-order-display', '/controlling/order-settlement'],
  'controlling-reports': ['/controlling/plan-revaluation', '/controlling/internal-orders', '/config/cost-centers'],
  batches: ['/inventory/materials', '/inventory/migo', '/config/batch-management'],
  'physical-inventory': ['/inventory/stock-overview', '/inventory/materials'],
  'batch-config': ['/config/batch-search-procedures', '/inventory/batches/display'],
  'batch-search-config': ['/config/batch-management', '/inventory/batch-search-strategies'],
  'gl-config': ['/finance/journal'],
  credit: ['/finance/customer-invoice', '/foundation/partners'],
  close: ['/finance/trial-balance', '/finance/journal', '/config/exchange-rates', '/config/tax-codes'],
  statements: ['/finance/journal', '/finance/close-cockpit'],
  consolidation: ['/config/consolidation', '/finance/consolidation-monitor', '/finance/consolidated-statements'],
  'number-ranges': ['/config/number-range-objects', '/config/number-ranges'],
  'sales-config': ['/config/sales-areas'],
  'purchasing-config': ['/purchasing/orders', '/config/plants'],
  'plant-config': ['/config/company-codes'],
  'company-config': ['/config/plants', '/config/chart-of-accounts'],
  'currency-config': ['/finance/fx/valuation', '/config/company-codes'],
  'release-config': ['/purchasing/orders', '/purchasing/purchase-order-display'],
  'production-config': ['/production/orders', '/production/work-centers'],
  'tax-config': ['/finance/tax/report', '/finance/customer-invoice'],
  'controlling-plan': ['/controlling/cost-center-report', '/controlling/internal-orders'],
  'general-ledger': ['/finance/journal', '/finance/trial-balance'],
};

export interface RelatedLink {
  screen: ScreenLink;
  href: string;
  kind: 'family' | 'also';
}

export function screenHref(screen: ScreenLink, extra?: URLSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(screen.query)) params.set(key, value);
  if (extra) {
    for (const [key, value] of extra) {
      if (BANNED.has(key) || params.has(key) || value.trim() === '') continue;
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `${screen.path}?${query}` : screen.path;
}

export function matchScreen(pathname: string, search: URLSearchParams): ScreenLink | null {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : '/';
  const candidates = SCREENS.filter((screen) => screen.path === path);
  if (candidates.length === 0) return null;
  const specific = candidates
    .filter((screen) => Object.entries(screen.query).every(([key, value]) => search.get(key) === value))
    .sort((left, right) => Object.keys(right.query).length - Object.keys(left.query).length);
  return specific[0] ?? null;
}

export function screensInArea(area: ScreenArea): ScreenLink[] {
  return SCREENS
    .filter((screen) => screen.area === area)
    .slice()
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

function screenByPath(path: string): ScreenLink | undefined {
  return SCREENS.find((screen) => screen.path === path && Object.keys(screen.query).length === 0)
    ?? SCREENS.find((screen) => screen.path === path);
}

function carried(source: ScreenLink, target: ScreenLink, search: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  const allowed = source.family === target.family ? SAME_FAMILY : CROSS_FAMILY;
  for (const key of allowed) {
    if (!target.accepts.includes(key)) continue;
    const value = search.get(key)?.trim();
    if (value) out.set(key, value);
  }

  const order = search.get('order')?.trim() ?? '';
  const planned = search.get('plannedOrder')?.trim() ?? '';

  if (target.path === '/production/order-information') {
    out.delete('run');
    if (source.family === 'planned-orders' && order) {
      out.set('selection', 'PLANNED_ORDER:HEADERS');
      out.set('plannedOrder', order);
      out.delete('order');
    } else if (source.family === 'production-orders') {
      out.set('selection', 'PRODUCTION_ORDER:HEADERS');
      if (order) out.set('order', order);
    }
  }

  if (source.path === '/production/order-information' && target.path.startsWith('/production/planned-order') && planned && target.accepts.includes('order')) {
    out.set('order', planned);
  }

  if (source.family === 'purchase-orders' && order) {
    if (target.accepts.includes('order')) out.set('order', order);
    if (target.accepts.includes('orderFrom')) out.set('orderFrom', order);
    if (target.accepts.includes('orderTo')) out.set('orderTo', order);
  }

  for (const key of BANNED) out.delete(key);
  return out;
}

export function relatedLinks(pathname: string, search: URLSearchParams): {
  current: ScreenLink | null;
  links: RelatedLink[];
  more: RelatedLink[];
  indexHref: string;
} {
  const current = matchScreen(pathname, search);
  const indexHref = `/#screens-${current?.area ?? 'platform'}`;
  if (!current) return { current, links: [], more: [], indexHref };

  const siblings = SCREENS
    .filter((screen) => screen.family === current.family && screen.id !== current.id)
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  const seen = new Set<string>([current.id]);
  const familyLinks = siblings.map((screen) => {
    seen.add(screen.id);
    return { screen, href: screenHref(screen, carried(current, screen, search)), kind: 'family' as const };
  });
  const alsoLinks: RelatedLink[] = [];
  for (const path of ALSO[current.family] ?? []) {
    const screen = screenByPath(path);
    if (!screen || seen.has(screen.id)) continue;
    seen.add(screen.id);
    alsoLinks.push({ screen, href: screenHref(screen, carried(current, screen, search)), kind: 'also' });
  }

  const links: RelatedLink[] = [];
  const more: RelatedLink[] = [];
  for (const link of familyLinks) (links.length < 8 ? links : more).push(link);
  for (const link of alsoLinks) (links.length < 12 ? links : more).push(link);
  return { current, links, more, indexHref };
}
