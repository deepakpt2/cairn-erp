/**
 * Stock reconciliation — SCR-144 / INV.STOCK.RECONCILE.
 *
 * `stock_quantity` is a projection of `material_document_line`. A projection nobody can rebuild
 * is a projection nobody can trust: when it drifts, the only honest question is "what does the
 * ledger say", and until this module existed there was no way to ask it.
 *
 * The ledger is the material documents themselves — `line_direction` gives the sign, and every
 * line names its document, so the sum per dimension is the balance the documents justify.
 */
import { sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { assertInventoryCountOpen, PhysicalInventoryError } from './physical-inventory';

export class StockReconcileError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'StockReconcileError';
    this.remedy = remedy;
  }
}

export const RECONCILE_CAPABILITY = 'INV.STOCK.RECONCILE';
export const RECONCILE_ALIASES = ['MB5L'] as const;

export interface StockDriftRow {
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  stockType: string;
  /** What the material documents say. */
  ledgerQuantity: string;
  /** What the projection says. */
  projectedQuantity: string;
  difference: string;
}

export interface ReconcileResult {
  balanced: boolean;
  scope: { plant: string | null };
  dimensionsChecked: number;
  drift: StockDriftRow[];
}

/**
 * Compare the ledger with the projection. The drift query is written so that a dimension which
 * exists in only one of the two sides is a drift of its full quantity — a projection row with
 * no documents behind it is exactly the kind of ghost this check is for.
 */
async function driftIn(tx: Tx, client: string, plant: string | null): Promise<StockDriftRow[]> {
  const rows = await tx.execute(sql`
    with ledger as (
      select l.client, l.material_number, l.plant, l.storage_location, l.stock_type,
             sum(case when l.line_direction = 'RECEIPT' then l.base_quantity else -l.base_quantity end) as qty
        from material_document_line l
        join material_document d
          on d.client = l.client and d.material_document_number = l.material_document_number
       where l.client = ${client}
         and d.status in ('POSTED', 'REVERSED')
         and (${plant}::text is null or l.plant = ${plant}::text)
       group by 1, 2, 3, 4, 5
    ),
    projected as (
      select s.client, s.material_number, s.plant, s.storage_location, s.stock_type, s.quantity as qty
        from stock_quantity s
       where s.client = ${client}
         and (${plant}::text is null or s.plant = ${plant}::text)
    ),
    both_sides as (
      select coalesce(l.material_number, p.material_number) as material_number,
             coalesce(l.plant, p.plant) as plant,
             coalesce(l.storage_location, p.storage_location) as storage_location,
             coalesce(l.stock_type, p.stock_type) as stock_type,
             coalesce(l.qty, 0) as ledger_qty,
             coalesce(p.qty, 0) as projected_qty
        from ledger l
        full outer join projected p
          on p.client = l.client
         and p.material_number = l.material_number
         and p.plant = l.plant
         and p.storage_location is not distinct from l.storage_location
         and p.stock_type = l.stock_type
    )
    select material_number, plant, storage_location, stock_type,
           ledger_qty::text as ledger_quantity,
           projected_qty::text as projected_quantity,
           (projected_qty - ledger_qty)::text as difference
      from both_sides
     where abs(projected_qty - ledger_qty) > 0.0005
     order by material_number, plant, storage_location nulls first, stock_type
     limit 500
  `) as unknown as Array<Record<string, string | null>>;

  return rows.map((r) => ({
    materialNumber: String(r.material_number),
    plant: String(r.plant),
    storageLocation: r.storage_location === null ? null : String(r.storage_location),
    stockType: String(r.stock_type),
    ledgerQuantity: Number(r.ledger_quantity).toFixed(3),
    projectedQuantity: Number(r.projected_quantity).toFixed(3),
    difference: Number(r.difference).toFixed(3),
  }));
}

/** Read-only: what the ledger says, against what the projection says. */
export async function reconcileStock(
  client: string, scope: { plant?: string | null } = {},
): Promise<ReconcileResult> {
  const plant = scope.plant?.trim() || null;
  return withTenant(client, async (tx) => {
    const drift = await driftIn(tx, client, plant);
    const counted = await tx.execute(sql`
      select count(*)::int as n from stock_quantity
       where client = ${client} and (${plant}::text is null or plant = ${plant}::text)
    `) as unknown as Array<{ n: number }>;
    return {
      balanced: drift.length === 0,
      scope: { plant },
      dimensionsChecked: counted[0]?.n ?? 0,
      drift,
    };
  });
}

/**
 * Rebuild a single dimension from the ledger. The projection is recomputed, never adjusted
 * by a delta: a delta applied to a wrong number stays wrong.
 *
 * Zero-quantity dimensions are kept only when the ledger still justifies them; a dimension
 * the ledger no longer knows is deleted, which is the ghost case.
 */
export async function rebuildStockDimension(input: {
  client: string;
  changedBy: string;
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  stockType: string;
}): Promise<{ ledgerQuantity: string }> {
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${`${input.client}/stock-scope/${input.materialNumber}`}, 0))
    `);

    // SCR-143/144: an open count freezes this dimension's book quantity. A rebuild would rewrite
    // the very number the count intends to compare with, so it refuses while the count stands.
    try {
      await assertInventoryCountOpen(tx, input.client, {
        materialNumber: input.materialNumber, plant: input.plant, storageLocation: input.storageLocation,
      });
    } catch (caught) {
      if (caught instanceof PhysicalInventoryError) {
        throw new StockReconcileError(caught.message, caught.remedy);
      }
      throw caught;
    }

    const rows = await tx.execute(sql`
      select coalesce(sum(case when l.line_direction = 'RECEIPT' then l.base_quantity else -l.base_quantity end), 0)::text as qty
        from material_document_line l
        join material_document d
          on d.client = l.client and d.material_document_number = l.material_document_number
       where l.client = ${input.client}
         and d.status in ('POSTED', 'REVERSED')
         and l.material_number = ${input.materialNumber}
         and l.plant = ${input.plant}
         and l.storage_location is not distinct from ${input.storageLocation}
         and l.stock_type = ${input.stockType}
    `) as unknown as Array<{ qty: string }>;
    const quantity = Number(rows[0]?.qty ?? 0);

    if (Math.abs(quantity) <= 0.0005) {
      await tx.execute(sql`
        delete from stock_quantity
         where client = ${input.client} and material_number = ${input.materialNumber}
           and plant = ${input.plant}
           and storage_location is not distinct from ${input.storageLocation}
           and stock_type = ${input.stockType}
      `);
    } else {
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${input.client}, ${input.materialNumber}, ${input.plant}, ${input.storageLocation},
                ${input.stockType}, ${quantity.toFixed(3)}, ${input.changedBy})
        on conflict (client, material_number, plant, storage_location, stock_type)
        do update set quantity = ${quantity.toFixed(3)}, changed_by = ${input.changedBy}, changed_at = now()
      `);
    }

    return { ledgerQuantity: quantity.toFixed(3) };
  });
}
