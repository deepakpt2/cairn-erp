/**
 * Maintain vendor evaluation — SCR-165.
 *
 * A manual score is stored. An automatic score is calculated from posted
 * purchasing history and is not stored. A missing score is not zero. The
 * overall score is derived and is not a column. A check writes nothing.
 * A closed financial period is not read.
 */
import { sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';

export const VENDOR_EVALUATION_CAPABILITY = 'PROC.VENDOR.EVALUATE';
export const VENDOR_EVALUATION_ROUTE = '/purchasing/vendor-evaluation';
const OBJECT_CLASS = 'vendor_evaluation_assessment';
const UNAVAILABLE = 'Supplier or evaluation is not available in the selected purchasing scope.';

const REFUSED: Record<string, string> = {
  companyCode: 'Vendor evaluation is not company-code-specific.',
  material: 'A material scope is not this evaluation.',
  purchaseOrder: 'A purchasing document is not the key. The supplier and the purchasing organisation are.',
  purchasingDocument: 'A purchasing document is not the key. The supplier and the purchasing organisation are.',
  subCriterion: 'A sub-criterion is not configured. A main criterion is not scored twice.',
  evaluationRun: 'An automatic score is calculated from posted history. A run is not stored.',
  recalculate: 'Recalculate is not a write. The automatic score is the posted history up to the period end.',
  approval: 'This screen does not approve an evaluation.',
  export: 'An export is not this evaluation.',
  weight: 'A weight is configuration. This screen does not change it.',
  overallScore: 'The overall score is derived. It is not entered.',
  status: 'There is no stored evaluation status. Completeness is derived from the scores.',
  revision: 'There is no revision stack. The change document is the history.',
  asOf: 'The as-of date is the period end. It is not a separate cutoff.',
  uuid: 'A uuid key is not a field on this evaluation.',
  outbox: 'An outbox is not this evaluation.',
  attachment: 'Attachments are not stored.',
};

const KNOWN = new Set(['supplier', 'purchasingOrg', 'periodFrom', 'periodTo']);

export class VendorEvaluationError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'VendorEvaluationError';
  }
}

export interface EvaluationCriterion {
  criterionCode: string;
  description: string;
  method: 'MANUAL' | 'AUTOMATIC';
  evidence: string;
  scoreMin: string;
  scoreMax: string;
  weight: string;
  score: string | null;
  evidenceNote: string;
  reason: string | null;
  version: number | null;
  evaluatedBy: string | null;
  evaluatedAt: string | null;
}

export interface VendorEvaluation {
  supplierNumber: string;
  supplierName: string;
  purchasingOrg: string;
  periodFrom: string;
  periodTo: string;
  asOfDate: string;
  blocked: boolean;
  criteria: EvaluationCriterion[];
  scored: number;
  applicable: number;
  /** Derived. Null when a required score is missing. Not stored. */
  overallScore: string | null;
  weightTotal: string;
  message: string;
}

export interface ManualScoreResult {
  wrote: boolean;
  criterionCode: string;
  score: string;
  version: number;
}

function fail(message: string, remedy?: string): never {
  throw new VendorEvaluationError(message, remedy);
}

function key(value: string | undefined): string {
  return value?.trim().toUpperCase() ?? '';
}

function text(value: unknown): string {
  return value == null ? '' : String(value);
}

function money(value: string): string {
  return fromScaled(toScaled(value || '0', 2), 2);
}

function date(value: string | undefined, label: string): string {
  const parsed = value?.trim() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) fail(`${label} is not a date.`, 'Use a calendar date.');
  return parsed;
}

function when(value: Date | string | null | undefined): string {
  if (value == null || value === '') return '';
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function refuseNamed(params: Record<string, string>): void {
  for (const [name, value] of Object.entries(params)) {
    if (!value.trim() || KNOWN.has(name)) continue;
    fail(REFUSED[name] ?? `${name} is not a field on this evaluation.`, 'Choose the supplier, the purchasing organisation, and the period.');
  }
}

function selection(params: Record<string, string>) {
  refuseNamed(params);
  const supplier = key(params.supplier);
  const purchasingOrg = key(params.purchasingOrg);
  const periodFrom = date(params.periodFrom, 'The period from');
  const periodTo = date(params.periodTo, 'The period to');
  if (!supplier || !purchasingOrg) fail(UNAVAILABLE);
  if (supplier.length > 40) fail('The supplier is too long.');
  if (purchasingOrg.length > 10) fail('The purchasing organisation is too long.');
  if (periodFrom > periodTo) fail('The period from is after the period to.');
  const span = (Date.parse(`${periodTo}T00:00:00Z`) - Date.parse(`${periodFrom}T00:00:00Z`)) / 86_400_000;
  if (span > 366) fail('The evaluation period is longer than a year.', 'Choose a shorter period.');
  return { supplier, purchasingOrg, periodFrom, periodTo };
}

function scoreText(value: string, min: string, max: string): string {
  const parsed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(parsed)) fail('The score is not a score on the configured scale.', `Use a number from ${min} to ${max}.`);
  const scaled = toScaled(parsed, 2);
  if (scaled < toScaled(min, 2) || scaled > toScaled(max, 2)) {
    fail(`The score is outside ${min} to ${max}.`, 'Use the scale shown for the criterion.');
  }
  return fromScaled(scaled, 2);
}

function halfUp(numerator: bigint, denominator: bigint, scale: number): string {
  if (denominator === 0n) return '';
  const factor = 10n ** BigInt(scale);
  const product = numerator * factor;
  const negative = product < 0n;
  const absolute = negative ? -product : product;
  const divisor = denominator < 0n ? -denominator : denominator;
  const quotient = absolute / divisor;
  const remainder = absolute % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return fromScaled(negative ? -rounded : rounded, scale);
}

function priceScore(expected: string, net: string): string | null {
  const expectedScaled = toScaled(expected || '0', 4);
  const netScaled = toScaled(net || '0', 4);
  if (expectedScaled <= 0n) return null;
  const excess = netScaled > expectedScaled ? netScaled - expectedScaled : 0n;
  const remaining = expectedScaled - excess;
  if (remaining <= 0n) return '0.00';
  return halfUp(remaining * 100n, expectedScaled, 2);
}

function deliveryScore(onTime: string, scored: string): string | null {
  const total = toScaled(scored || '0', 3);
  if (total <= 0n) return null;
  return halfUp(toScaled(onTime || '0', 3) * 100n, total, 2);
}

function overall(criteria: EvaluationCriterion[]): { score: string | null; weightTotal: string } {
  const weightTotal = criteria.reduce((sum, row) => sum + toScaled(row.weight, 2), 0n);
  const complete = criteria.length > 0 && criteria.every((row) => row.score != null);
  if (!complete || weightTotal <= 0n) return { score: null, weightTotal: fromScaled(weightTotal, 2) };
  const weighted = criteria.reduce((sum, row) => sum + toScaled(row.score ?? '0', 2) * toScaled(row.weight, 2), 0n);
  return { score: halfUp(weighted, weightTotal * 100n, 2), weightTotal: fromScaled(weightTotal, 2) };
}

async function load(client: string, chosen: ReturnType<typeof selection>): Promise<VendorEvaluation> {
  return withTenant(client, async (tx) => {
    const [org] = await tx.execute(sql`
      select 1 as hit from purchasing_org where client = ${client} and purchasing_org = ${chosen.purchasingOrg}
    `) as unknown as Array<{ hit: number }>;
    if (!org) fail(`Purchasing organisation ${chosen.purchasingOrg} does not stand.`);
    const [segment] = await tx.execute(sql`
      select sp.purchasing_status, sp.is_blocked, coalesce(bp.name, '') as name
        from supplier_purchasing_org sp
        join business_partner bp
          on bp.client = sp.client and bp.partner_number = sp.partner_number
       where sp.client = ${client}
         and sp.partner_number = ${chosen.supplier}
         and sp.purchasing_org = ${chosen.purchasingOrg}
    `) as unknown as Array<{ purchasing_status: string; is_blocked: boolean; name: string }>;
    if (!segment || segment.purchasing_status === 'INCOMPLETE') fail(UNAVAILABLE);
    const criteria = await tx.execute(sql`
      select criterion_code, description, method, evidence, score_min::text as score_min,
             score_max::text as score_max, weight::text as weight
        from vendor_evaluation_criterion
       where client = ${client}
       order by criterion_code
    `) as unknown as Array<Record<string, unknown>>;
    if (criteria.length === 0) fail('No evaluation criterion is configured.', 'Configure the criteria before scoring a supplier.');
    const assessments = await tx.execute(sql`
      select criterion_code, score::text as score, reason, version, created_by, changed_by, created_at, changed_at
        from vendor_evaluation_assessment
       where client = ${client}
         and supplier_number = ${chosen.supplier}
         and purchasing_org = ${chosen.purchasingOrg}
         and period_from = ${chosen.periodFrom}
         and period_to = ${chosen.periodTo}
    `) as unknown as Array<Record<string, unknown>>;
    const byCode = new Map(assessments.map((row) => [text(row.criterion_code), row]));
    const [price] = await tx.execute(sql`
      select coalesce(sum(si.expected_amount), 0)::text as expected,
             coalesce(sum(si.net_amount), 0)::text as net,
             count(*)::int as n
        from supplier_invoice_item si
        join supplier_invoice s
          on s.client = si.client and s.invoice_number = si.invoice_number
        join purchase_order po
          on po.client = s.client and po.order_number = s.purchase_order_number
       where si.client = ${client}
         and po.supplier_number = ${chosen.supplier}
         and po.purchasing_org = ${chosen.purchasingOrg}
         and s.supplier_number = ${chosen.supplier}
         and s.status = 'POSTED'
         and s.category = 'INVOICE'
         and s.posting_date >= ${chosen.periodFrom}
         and s.posting_date <= ${chosen.periodTo}
    `) as unknown as Array<{ expected: string; net: string; n: number }>;
    const receipts = await tx.execute(sql`
      select l.base_quantity::text as quantity,
             d.posting_date::text as posting_date,
             sc.delivery_date,
             rev.posting_date as reversal_date
        from material_document_line l
        join material_document d
          on d.client = l.client and d.material_document_number = l.material_document_number
        join movement_type mv on mv.client = l.client and mv.movement_type = l.movement_type
        join purchase_order po
          on po.client = l.client and po.order_number = l.purchase_order_number
        left join lateral (
          select min(rev.posting_date)::text as posting_date
            from material_document rev
            left join material_document_line rl
              on rl.client = rev.client and rl.material_document_number = rev.material_document_number
           where rev.client = d.client
             and rev.material_document_number <> d.material_document_number
             and (
               rev.material_document_number = d.reversed_by
               or rev.reversal_of = d.material_document_number
               or (rl.reversal_of_document = l.material_document_number and rl.reversal_of_line = l.line_number)
             )
        ) rev on true
        left join lateral (
          select min(s.delivery_date)::text as delivery_date
            from purchase_order_schedule_line s
           where s.client = l.client
             and s.order_number = l.purchase_order_number
             and s.item_number = l.purchase_order_item
        ) sc on true
       where l.client = ${client}
         and po.supplier_number = ${chosen.supplier}
         and po.purchasing_org = ${chosen.purchasingOrg}
         and l.purchase_order_number is not null
         and mv.direction = 'RECEIPT'
         and d.posting_date >= ${chosen.periodFrom}
         and d.posting_date <= ${chosen.periodTo}
    `) as unknown as Array<{ quantity: string; posting_date: string; delivery_date: string | null; reversal_date: string | null }>;

    let onTime = 0n;
    let scoredQty = 0n;
    let excluded = 0;
    let standing = 0;
    for (const row of receipts) {
      if (row.reversal_date && row.reversal_date <= chosen.periodTo) continue;
      standing += 1;
      if (!row.delivery_date) {
        excluded += 1;
        continue;
      }
      const quantity = toScaled(row.quantity, 3);
      scoredQty += quantity;
      if (row.posting_date <= row.delivery_date) onTime += quantity;
    }
    const calculated: Record<string, { score: string | null; note: string }> = {
      PRICE: {
        score: price && price.n > 0 ? priceScore(price.expected, price.net) : null,
        note: !price || price.n === 0
          ? 'No posted invoice stands in the period. The score is not zero.'
          : priceScore(price.expected, price.net) == null
            ? 'The invoices have no order value to compare. The score is not zero.'
            : `${price.n} posted invoice lines. Expected ${money(price.expected)}. Invoiced ${money(price.net)}. A cancelled invoice is not evidence.`,
      },
      DELIVERY: {
        score: deliveryScore(fromScaled(onTime, 3), fromScaled(scoredQty, 3)),
        note: standing === 0
          ? 'No posted receipt stands in the period. A reversal in the period is not a successful delivery. The score is not zero.'
          : scoredQty === 0n
            ? `${excluded} receipt lines have no schedule date. They are not scored as zero.`
            : `${fromScaled(scoredQty, 3)} scored. ${fromScaled(onTime, 3)} on time.${excluded ? ` ${excluded} excluded for a missing schedule.` : ''}`,
      },
    };

    const rows: EvaluationCriterion[] = criteria.map((row) => {
      const code = text(row.criterion_code);
      const method = text(row.method) === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL';
      const evidence = text(row.evidence);
      const stored = byCode.get(code);
      const automatic = calculated[evidence];
      const score = method === 'AUTOMATIC' ? automatic?.score ?? null : stored ? money(text(stored.score)) : null;
      return {
        criterionCode: code,
        description: text(row.description),
        method,
        evidence,
        scoreMin: money(text(row.score_min)),
        scoreMax: money(text(row.score_max)),
        weight: money(text(row.weight)),
        score,
        evidenceNote: method === 'AUTOMATIC'
          ? (automatic?.note ?? 'That automatic evidence is not configured. The score is not zero.')
          : 'Manual. It is not calculated from purchasing history.',
        reason: method === 'AUTOMATIC' || !stored ? null : text(stored.reason),
        version: method === 'AUTOMATIC' || !stored ? null : Number(stored.version),
        evaluatedBy: method === 'AUTOMATIC' || !stored ? null : text(stored.changed_by || stored.created_by),
        evaluatedAt: method === 'AUTOMATIC' || !stored ? null : when((stored.changed_at ?? stored.created_at) as string),
      };
    });
    const derived = overall(rows);
    const scored = rows.filter((row) => row.score != null).length;
    return {
      supplierNumber: chosen.supplier,
      supplierName: segment.name,
      purchasingOrg: chosen.purchasingOrg,
      periodFrom: chosen.periodFrom,
      periodTo: chosen.periodTo,
      asOfDate: chosen.periodTo,
      blocked: segment.is_blocked === true,
      criteria: rows,
      scored,
      applicable: rows.length,
      overallScore: derived.weightTotal === '100.00' ? derived.score : null,
      weightTotal: derived.weightTotal,
      message: derived.weightTotal !== '100.00'
        ? `The configured weights total ${derived.weightTotal}, not 100. The overall score is not guessed.`
        : derived.score == null
          ? `Coverage ${scored} of ${rows.length}. A missing score is not zero, and the weights are not redistributed.`
          : `The overall score is ${derived.score}. It is derived.`,
    };
  });
}

export async function listVendorEvaluation(client: string, params: Record<string, string>): Promise<VendorEvaluation> {
  return load(client, selection(params));
}

/** The same read as the list. It writes nothing. */
export async function checkVendorEvaluation(client: string, params: Record<string, string>): Promise<VendorEvaluation> {
  const evaluation = await listVendorEvaluation(client, params);
  return { ...evaluation, message: `${evaluation.message} Nothing was written.` };
}

export async function saveManualScore(input: {
  client: string;
  changedBy: string;
  supplier: string;
  purchasingOrg: string;
  periodFrom: string;
  periodTo: string;
  criterionCode: string;
  score: string;
  reason: string;
  requestKey: string;
  expectedVersion?: number | null;
  named?: Record<string, string>;
}): Promise<ManualScoreResult> {
  refuseNamed(input.named ?? {});
  const chosen = selection({
    supplier: input.supplier,
    purchasingOrg: input.purchasingOrg,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
  });
  const criterionCode = key(input.criterionCode);
  const requestKey = input.requestKey.trim();
  const reason = input.reason.trim();
  if (!requestKey || requestKey.length > 64) fail('The request key does not stand.');
  if (!reason || reason.length > 100) fail('A reason is required.', 'Say why this score stands.');
  return withTenant(input.client, async (tx) => {
    const [segment] = await tx.execute(sql`
      select is_blocked, purchasing_status
        from supplier_purchasing_org
       where client = ${input.client}
         and partner_number = ${chosen.supplier}
         and purchasing_org = ${chosen.purchasingOrg}
    `) as unknown as Array<{ is_blocked: boolean; purchasing_status: string }>;
    if (!segment || segment.purchasing_status === 'INCOMPLETE') fail(UNAVAILABLE);
    const [criterion] = await tx.execute(sql`
      select method, score_min::text as score_min, score_max::text as score_max
        from vendor_evaluation_criterion
       where client = ${input.client} and criterion_code = ${criterionCode}
    `) as unknown as Array<{ method: string; score_min: string; score_max: string }>;
    if (!criterion) fail(`Criterion ${criterionCode} is not configured.`);
    if (criterion.method !== 'MANUAL') fail(`Criterion ${criterionCode} is automatic. A manual score is refused.`, 'Read the calculated score. Do not enter one.');
    const score = scoreText(input.score, criterion.score_min, criterion.score_max);
    const [byKey] = await tx.execute(sql`
      select supplier_number, purchasing_org, period_from::text as period_from, period_to::text as period_to,
             criterion_code, score::text as score, reason, version
        from vendor_evaluation_assessment
       where client = ${input.client} and request_key = ${requestKey}
    `) as unknown as Array<Record<string, unknown>>;
    if (byKey) {
      const same = text(byKey.supplier_number) === chosen.supplier
        && text(byKey.purchasing_org) === chosen.purchasingOrg
        && text(byKey.period_from) === chosen.periodFrom
        && text(byKey.period_to) === chosen.periodTo
        && text(byKey.criterion_code) === criterionCode
        && money(text(byKey.score)) === score
        && text(byKey.reason) === reason;
      if (!same) fail('That request already stood for a different assessment.');
      return { wrote: false, criterionCode, score, version: Number(byKey.version) };
    }
    if (segment.is_blocked) fail(`Supplier ${chosen.supplier} is blocked for purchasing organisation ${chosen.purchasingOrg}.`);
    const [existing] = await tx.execute(sql`
      select score::text as score, reason, version
        from vendor_evaluation_assessment
       where client = ${input.client}
         and supplier_number = ${chosen.supplier}
         and purchasing_org = ${chosen.purchasingOrg}
         and period_from = ${chosen.periodFrom}
         and period_to = ${chosen.periodTo}
         and criterion_code = ${criterionCode}
       for update
    `) as unknown as Array<{ score: string; reason: string; version: number }>;
    const versionNow = existing ? Number(existing.version) : 0;
    if (existing && input.expectedVersion !== versionNow) {
      fail('The assessment changed since it was read.', 'Read it again, then save.');
    }
    if (!existing && input.expectedVersion) fail('The assessment changed since it was read.', 'Read it again, then save.');
    const objectKey = `${chosen.supplier}/${chosen.purchasingOrg}/${chosen.periodFrom}/${chosen.periodTo}/${criterionCode}`;
    if (!existing) {
      await tx.execute(sql`
        insert into vendor_evaluation_assessment (
          client, supplier_number, purchasing_org, period_from, period_to, criterion_code,
          score, reason, request_key, version, created_by
        ) values (
          ${input.client}, ${chosen.supplier}, ${chosen.purchasingOrg}, ${chosen.periodFrom}, ${chosen.periodTo},
          ${criterionCode}, ${score}, ${reason}, ${requestKey}, 1, ${input.changedBy}
        )
      `);
      await recordChange(tx, {
        client: input.client,
        objectClass: OBJECT_CLASS,
        objectKey,
        changeType: 'CREATE',
        changedBy: input.changedBy,
        transactionCode: VENDOR_EVALUATION_CAPABILITY,
        reason,
        correlationId: requestKey,
        after: { score, reason, criterionCode },
      });
      return { wrote: true, criterionCode, score, version: 1 };
    }
    if (money(existing.score) === score && existing.reason === reason) {
      return { wrote: false, criterionCode, score, version: versionNow };
    }
    const version = versionNow + 1;
    await tx.execute(sql`
      update vendor_evaluation_assessment
         set score = ${score}, reason = ${reason}, request_key = ${requestKey}, version = ${version},
             changed_by = ${input.changedBy}, changed_at = now()
       where client = ${input.client}
         and supplier_number = ${chosen.supplier}
         and purchasing_org = ${chosen.purchasingOrg}
         and period_from = ${chosen.periodFrom}
         and period_to = ${chosen.periodTo}
         and criterion_code = ${criterionCode}
    `);
    await recordChange(tx, {
      client: input.client,
      objectClass: OBJECT_CLASS,
      objectKey,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: VENDOR_EVALUATION_CAPABILITY,
      reason,
      correlationId: requestKey,
      before: { score: money(existing.score), reason: existing.reason },
      after: { score, reason },
    });
    return { wrote: true, criterionCode, score, version };
  });
}
