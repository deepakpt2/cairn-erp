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
};
