/**
 * Production-order lifecycle. The stored words match CREATED and RELEASED.
 * SAP shows this state as TECO. The internal status code I0045 is not stored.
 * Closed, delivered, and partially delivered are not statuses of this order.
 */
export const PRODUCTION_ORDER_STATUSES = ['CREATED', 'RELEASED', 'TECHNICALLY_COMPLETED'] as const;
export type ProductionOrderStatus = (typeof PRODUCTION_ORDER_STATUSES)[number];

/** Statuses that remain open supply for MD01 and MD04. Technical completion is excluded. */
export const PRODUCTION_ORDER_SUPPLY_STATUSES = ['CREATED', 'RELEASED'] as const;

export function parseProductionOrderStatus(value: unknown): ProductionOrderStatus | null {
  const status = String(value ?? '').trim();
  return (PRODUCTION_ORDER_STATUSES as readonly string[]).includes(status)
    ? status as ProductionOrderStatus
    : null;
}

/**
 * A released order may be charged. Technical completion ends logistics planning,
 * not goods receipt, component issue, or confirmation. Created may not be charged.
 * Closed is not stored, so its posting ban is not applied here.
 */
export function productionOrderMayBeCharged(status: ProductionOrderStatus): boolean {
  return status === 'RELEASED' || status === 'TECHNICALLY_COMPLETED';
}

export function confirmationBlockReason(status: ProductionOrderStatus): string | null {
  return productionOrderMayBeCharged(status)
    ? null
    : 'The order is not released. Confirmation does not release it.';
}

/**
 * Release writes released_by and released_at in the same update, and nothing
 * clears one of them. A failed release at creation rolls back both. Both must
 * stand for a released order, and both must be empty for an order that was
 * never released. One without the other is not a prior status.
 */
export function priorStatusFromRelease(
  releasedBy: unknown,
  releasedAt: unknown,
): { ok: true; status: 'RELEASED' | 'CREATED' } | { ok: false } {
  const by = releasedBy == null ? '' : String(releasedBy).trim();
  const at = releasedAt == null || releasedAt === '' ? null : releasedAt;
  if (by && at) return { ok: true, status: 'RELEASED' };
  if (!by && !at) return { ok: true, status: 'CREATED' };
  return { ok: false };
}
