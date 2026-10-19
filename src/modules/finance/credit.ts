/**
 * Customer credit management (SCR-103 / FIN.CREDIT.MAINTAIN, FD32).
 *
 * One credit record per customer and credit control area on the
 * canonical partner and area masters, with an append-only field
 * audit. Exposure derives at read time from open FI-AR items
 * across the companies of the area — never double-counted, never
 * silently bypassed: the credit-check evaluation blocks on a
 * missing record, a manual hold, an expired or zero limit, or an
 * exceeded limit, and warns at the area's configured threshold.
 */

export const CREDIT_CAPABILITY = 'FIN.CREDIT.MAINTAIN';

export const CREDIT_DECISIONS = ['OK', 'WARN', 'BLOCK'] as const;
export type CreditDecision = (typeof CREDIT_DECISIONS)[number];

export const CREDIT_BLOCK_REASONS = [
  'NO_CREDIT_RECORD', 'MANUAL_HOLD', 'LIMIT_EXPIRED', 'ZERO_LIMIT', 'LIMIT_EXCEEDED',
] as const;

export interface CustomerCreditView {
  customer: string;
  customerName: string;
  creditControlArea: string;
  creditLimit: number;
  creditCurrency: string;
  riskCategory: string;
  representativeGroup: string | null;
  validTo: string | null;
  limitExpired: boolean;
  customerCreditGroup: string | null;
  isBlocked: boolean;
  blockReason: string | null;
  exposure: number;
  openReceivables: number;
  availableCredit: number;
  utilizationPercent: number | null;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface CreditCheckResult {
  decision: CreditDecision;
  reason: string;
  exposure: number;
  creditLimit: number | null;
  availableCredit: number | null;
  utilizationPercent: number | null;
}

export interface CreditAuditView {
  auditId: string;
  field: string;
  previousValue: string | null;
  newValue: string | null;
  changedBy: string;
  changeReason: string;
  changedAt: string;
}

export class CreditError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CreditError';
    this.remedy = remedy;
  }
}
