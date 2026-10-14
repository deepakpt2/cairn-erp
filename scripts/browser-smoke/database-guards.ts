import type { BrowserTargetId } from './targets';

export type BrowserAcceptanceDatabaseGuard = {
  database: string;
  port: string;
  batch: string;
};

/** Each acceptance target is bound to its own verified disposable loopback database. */
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
};
