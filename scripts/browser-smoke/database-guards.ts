import type { BrowserTargetId } from './targets';

export type BrowserAcceptanceDatabaseGuard = {
  database: string;
  port: string;
  batch: string;
};

/** Each local acceptance target is bound to an explicitly reviewed loopback database and port. */
export const ACCEPTANCE_DATABASE_GUARDS: Partial<Record<BrowserTargetId, BrowserAcceptanceDatabaseGuard>> = {
  'company-code-definition': { database: 'cairn_b110', port: '55496', batch: 'B-110' },
  'company-code-coa-assignment': { database: 'cairn_b115', port: '55498', batch: 'B-115' },
  'plant-definition': { database: 'cairn_b125', port: '55521', batch: 'B-125' },
  'plant-company-code-assignment': { database: 'cairn_b129', port: '55523', batch: 'B-129' },
  'storage-locations': { database: 'cairn_b139', port: '55525', batch: 'B-139' },
  'purchasing-orgs': { database: 'cairn_b150', port: '55527', batch: 'B-150' },
  'purchasing-org-company-code': { database: 'cairn_b151', port: '55528', batch: 'B-151' },
  'purchasing-groups': { database: 'cairn_b152', port: '55529', batch: 'B-152' },
  'sales-orgs': { database: 'cairn_b153', port: '55530', batch: 'B-153' },
  'sales-org-division': { database: 'cairn', port: '5432', batch: 'OVXA local loopback' },
  'controlling-area': { database: 'cairn', port: '5432', batch: 'SCR-024 local loopback' },
  'controlling-area-company-assignment': { database: 'cairn_b210', port: '5432', batch: 'B-211 local loopback' },
  'chart-of-accounts': { database: 'cairn_b210', port: '5432', batch: 'SCR-026 local loopback' },
  'gl-accounts': { database: 'cairn_b210', port: '5432', batch: 'SCR-028 local loopback' },
  'fiscal-year-variants': { database: 'cairn_b210', port: '5432', batch: 'SCR-029 local loopback' },
  // Every target is bound, including the ones that predate this guard. The runner verifies a
  // guard that exists and simply runs a target that has none, so an unregistered target would
  // reach whatever DATABASE_URL says with no review behind it. Binding all of them to the local
  // loopback database is what makes that impossible: a target may run here, or not at all.
  'foundation': { database: 'cairn_b210', port: '5432', batch: 'foundation local loopback' },
  'material-basic': { database: 'cairn_b210', port: '5432', batch: 'material-basic local loopback' },
  'material-purchasing': { database: 'cairn_b210', port: '5432', batch: 'material-purchasing local loopback' },
  'material-mrp': { database: 'cairn_b210', port: '5432', batch: 'material-mrp local loopback' },
  'material-valuation': { database: 'cairn_b210', port: '5432', batch: 'material-valuation local loopback' },
  'payment-terms': { database: 'cairn_b210', port: '5432', batch: 'payment-terms local loopback' },
  'payment-methods': { database: 'cairn_b210', port: '5432', batch: 'payment-methods local loopback' },
  'business-partners': { database: 'cairn_b210', port: '5432', batch: 'business-partners local loopback' },
  'supplier-company': { database: 'cairn_b210', port: '5432', batch: 'supplier-company local loopback' },
  'supplier-purchasing': { database: 'cairn_b210', port: '5432', batch: 'supplier-purchasing local loopback' },
  'customer-company': { database: 'cairn_b210', port: '5432', batch: 'customer-company local loopback' },
  'customer-sales-area': { database: 'cairn_b210', port: '5432', batch: 'customer-sales-area local loopback' },
  'sales-org-company-code': { database: 'cairn_b210', port: '5432', batch: 'SCR-021 local loopback' },
  'distribution-channels': { database: 'cairn_b210', port: '5432', batch: 'SCR-022 local loopback' },
  'divisions': { database: 'cairn_b210', port: '5432', batch: 'SCR-022 local loopback' },
  'posting-period-variants': { database: 'cairn_b210', port: '5432', batch: 'SCR-031 local loopback' },
};
