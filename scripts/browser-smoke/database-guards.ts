import type { BrowserTargetId } from './targets';

export type BrowserAcceptanceDatabaseGuard = {
  database: string;
  port: string;
  batch: string;
};

/** Each local acceptance target is bound to an explicitly reviewed loopback database and port. */
export const ACCEPTANCE_DATABASE_GUARDS: Partial<Record<BrowserTargetId, BrowserAcceptanceDatabaseGuard>> = {
  // R-77 (owner ruling, 2026-10-17): these nine were each bound to a disposable cluster of
  // their own — cairn_b110 to cairn_b153 on ports 55496 to 55530 — which this environment does
  // not provide, so all nine stopped at their guard and could not run at all. They are rebound to
  // the reviewed loopback database, following SCR-024, SCR-025, SCR-026 and SCR-028, and each
  // keeps the batch it came from in its label. Isolation between targets now rests on the reserved
  // fixture key each one owns and on the runner's refusal to touch a tenant that is not exactly
  // that fixture, rather than on a cluster per target.
  'company-code-definition': { database: 'cairn_b210', port: '5432', batch: 'B-110 local loopback' },
  'company-code-coa-assignment': { database: 'cairn_b210', port: '5432', batch: 'B-115 local loopback' },
  'plant-definition': { database: 'cairn_b210', port: '5432', batch: 'B-125 local loopback' },
  'plant-company-code-assignment': { database: 'cairn_b210', port: '5432', batch: 'B-129 local loopback' },
  'storage-locations': { database: 'cairn_b210', port: '5432', batch: 'B-139 local loopback' },
  'purchasing-orgs': { database: 'cairn_b210', port: '5432', batch: 'B-150 local loopback' },
  'purchasing-org-company-code': { database: 'cairn_b210', port: '5432', batch: 'B-151 local loopback' },
  'purchasing-groups': { database: 'cairn_b210', port: '5432', batch: 'B-152 local loopback' },
  'sales-orgs': { database: 'cairn_b210', port: '5432', batch: 'B-153 local loopback' },
  'sales-org-division': { database: 'cairn_b210', port: '5432', batch: 'OVXA local loopback' },
  'controlling-area': { database: 'cairn_b210', port: '5432', batch: 'SCR-024 local loopback' },
  'controlling-area-company-assignment': { database: 'cairn_b210', port: '5432', batch: 'B-211 local loopback' },
  'chart-of-accounts': { database: 'cairn_b210', port: '5432', batch: 'SCR-026 local loopback' },
  'gl-accounts': { database: 'cairn_b210', port: '5432', batch: 'SCR-028 local loopback' },
  'chart-of-accounts-copy': { database: 'cairn_b210', port: '5432', batch: 'SCR-027 local loopback' },
  'fiscal-year-variant-assignment': { database: 'cairn_b210', port: '5432', batch: 'SCR-030 local loopback' },
  'posting-period-variant-assignment': { database: 'cairn_b210', port: '5432', batch: 'SCR-033 local loopback' },
  'exchange-rates': { database: 'cairn_b210', port: '5432', batch: 'SCR-034 local loopback' },
  'tax-codes': { database: 'cairn_b210', port: '5432', batch: 'SCR-035 local loopback' },
  'banks': { database: 'cairn_b210', port: '5432', batch: 'SCR-036 local loopback' },
  'house-banks': { database: 'cairn_b210', port: '5432', batch: 'SCR-037 local loopback' },
  'document-types': { database: 'cairn_b210', port: '5432', batch: 'SCR-038 local loopback' },
  'tolerance-groups': { database: 'cairn_b210', port: '5432', batch: 'SCR-039 local loopback' },
  'account-determination': { database: 'cairn_b210', port: '5432', batch: 'SCR-040 local loopback' },
  'cost-centers': { database: 'cairn_b210', port: '5432', batch: 'SCR-041 local loopback' },
  'cost-center-hierarchy': { database: 'cairn_b210', port: '5432', batch: 'SCR-042 local loopback' },
  'activity-types': { database: 'cairn_b210', port: '5432', batch: 'SCR-043 local loopback' },
  'activity-rates': { database: 'cairn_b210', port: '5432', batch: 'SCR-044 local loopback' },
  'profit-centers': { database: 'cairn_b210', port: '5432', batch: 'SCR-045 local loopback' },
  'profit-center-hierarchy': { database: 'cairn_b210', port: '5432', batch: 'SCR-047a local loopback' },
  'material-types': { database: 'cairn_b210', port: '5432', batch: 'SCR-048 local loopback' },
  'material-groups': { database: 'cairn_b210', port: '5432', batch: 'SCR-049 local loopback' },
  'number-range-objects': { database: 'cairn_b210', port: '5432', batch: 'SCR-050 local loopback' },
  'material-number-ranges': { database: 'cairn_b210', port: '5432', batch: 'SCR-051 local loopback' },
  'industry-sectors': { database: 'cairn_b210', port: '5432', batch: 'SCR-052 local loopback' },
  'industries': { database: 'cairn_b210', port: '5432', batch: 'SCR-077 local loopback' },
  'material-deletion-flag': { database: 'cairn_b210', port: '5432', batch: 'SCR-053 local loopback' },
  'material-period-control': { database: 'cairn_b210', port: '5432', batch: 'SCR-054 local loopback' },
  'purchase-requisitions': { database: 'cairn_b210', port: '5432', batch: 'SCR-055 local loopback' },
  'purchase-orders': { database: 'cairn_b210', port: '5432', batch: 'SCR-056 local loopback' },
  'characteristics': { database: 'cairn_b210', port: '5432', batch: 'SCR-057 local loopback' },
  'classes': { database: 'cairn_b210', port: '5432', batch: 'SCR-058 local loopback' },
  'release-strategies': { database: 'cairn_b210', port: '5432', batch: 'SCR-059 local loopback' },
  'release-acts': { database: 'cairn_b210', port: '5432', batch: 'SCR-060 local loopback' },
  'goods-receipt': { database: 'cairn_b210', port: '5432', batch: 'SCR-061 local loopback' },
  'invoice-verification': { database: 'cairn_b210', port: '5432', batch: 'SCR-062 local loopback' },
  'payment-run': { database: 'cairn_b210', port: '5432', batch: 'SCR-063 local loopback' },
  'vendor-clearing': { database: 'cairn_b210', port: '5432', batch: 'SCR-064 local loopback' },
  'vendor-balances': { database: 'cairn_b210', port: '5432', batch: 'SCR-065 local loopback' },
  'vendor-ageing': { database: 'cairn_b210', port: '5432', batch: 'SCR-066 local loopback' },
  'customer-invoice': { database: 'cairn_b210', port: '5432', batch: 'SCR-067 local loopback' },
  'incoming-payment': { database: 'cairn_b210', port: '5432', batch: 'SCR-068 local loopback' },
  'incoming-payment-completion': { database: 'cairn_b210', port: '5432', batch: 'SCR-079 local loopback' },
  'outgoing-payment': { database: 'cairn_b210', port: '5432', batch: 'SCR-078 local loopback' },
  'outgoing-payment-completion': { database: 'cairn_b210', port: '5432', batch: 'SCR-080 local loopback' },
  'vendor-down-payment': { database: 'cairn_b210', port: '5432', batch: 'SCR-081 local loopback' },
  'vendor-down-payment-clearing': { database: 'cairn_b210', port: '5432', batch: 'SCR-082 local loopback' },
  'customer-down-payment-clearing': { database: 'cairn_b210', port: '5432', batch: 'SCR-084 local loopback' },
  'customer-down-payment-request': { database: 'cairn_b210', port: '5432', batch: 'SCR-085 local loopback' },
  'vendor-down-payment-request': { database: 'cairn_b210', port: '5432', batch: 'SCR-086 local loopback' },
  'parked-journal': { database: 'cairn_b210', port: '5432', batch: 'SCR-087 local loopback' },
  'journal-items': { database: 'cairn_b210', port: '5432', batch: 'SCR-088 local loopback' },
  'gl-balances': { database: 'cairn_b210', port: '5432', batch: 'SCR-089 local loopback' },
  'document-display': { database: 'cairn_b210', port: '5432', batch: 'SCR-090 local loopback' },
  'asset-master': { database: 'cairn_b210', port: '5432', batch: 'SCR-091 local loopback' },
  'asset-acquisition': { database: 'cairn_b210', port: '5432', batch: 'SCR-092 local loopback' },
  'asset-retirement': { database: 'cairn_b210', port: '5432', batch: 'SCR-093 local loopback' },
  'asset-depreciation': { database: 'cairn_b210', port: '5432', batch: 'SCR-094 local loopback' },
  'asset-history': { database: 'cairn_b210', port: '5432', batch: 'SCR-095 local loopback' },
  'gl-document': { database: 'cairn_b210', port: '5432', batch: 'SCR-096 local loopback' },
  'tax-report': { database: 'cairn_b210', port: '5432', batch: 'SCR-097 local loopback' },
  'fx-valuation': { database: 'cairn_b210', port: '5432', batch: 'SCR-098 local loopback' },
  'grir-reclass': { database: 'cairn_b210', port: '5432', batch: 'SCR-099 local loopback' },
  'customer-down-payment': { database: 'cairn_b210', port: '5432', batch: 'SCR-083 local loopback' },
  'customer-balances': { database: 'cairn_b210', port: '5432', batch: 'SCR-069 local loopback' },
  'customer-ageing': { database: 'cairn_b210', port: '5432', batch: 'SCR-070 local loopback' },
  'clearing-reset': { database: 'cairn_b210', port: '5432', batch: 'SCR-071 local loopback' },
  'document-reversal': { database: 'cairn_b210', port: '5432', batch: 'SCR-072 local loopback' },
  'customer-clearing': { database: 'cairn_b210', port: '5432', batch: 'SCR-073 local loopback' },
  'dunning': { database: 'cairn_b210', port: '5432', batch: 'SCR-074 local loopback' },
  'vendor-invoice': { database: 'cairn_b210', port: '5432', batch: 'SCR-075 local loopback' },
  'vendor-credit-memo': { database: 'cairn_b210', port: '5432', batch: 'SCR-076 local loopback' },
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
  // SCR-032 · B3 acceptance runs on the reviewed loopback database, like every other
  // local target; the probes it creates are destroyed by the check itself.
  'tenant-creation': { database: 'cairn_b210', port: '5432', batch: 'SCR-032 local loopback' },
};
