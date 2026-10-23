/**
 * Total planning — SCR-166 / MD01 (PROD.MRP.RUN).
 *
 * A run calculates a shortage and reconciles the proposal that already stands.
 * It posts nothing: no material document, no journal, no stock. A closed
 * financial period is not read.
 *
 * The planning file is the net-change marker. There is no second change table.
 * A purchase requisition is the purchasing document. A planned order is not a
 * production order. This run does not explode a bill of material. Dependent demand is
 * the open reservation. An MRP area does not stand.
 */
import { sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { createRequisition, changeRequisition } from '../purchasing/requisitions';

export const MRP_RUN_CAPABILITY = 'PROD.MRP.RUN';
export const MRP_REGENERATE_CAPABILITY = 'PROD.MRP.REGENERATE';
export const MRP_RUN_ROUTE = '/production/mrp-run';
export const MRP_RUN_ALIASES = ['MD01'] as const;
export const MRP_FOREGROUND_LIMIT = 40;

const SCALE = 3;
const PROCESSING_KEYS = ['NETCH', 'NETPL', 'NEUPL'] as const;

const REFUSED: Record<string, string> = {
  mrpArea: 'An MRP area does not stand. The plant is the planning scope.',
  scheduleLine: 'A scheduling-agreement schedule line is not created by this run.',
  background: 'A background run is not carried. Narrow the scope and plan in the foreground.',
  parallel: 'Parallel processing is not carried. The run plans one material at a time.',
  deleteAndRecreate: 'Delete and recreate is not this planning mode. An existing proposal is not removed.',
  recreate: 'Recreate is not this planning mode. An eligible proposal is adapted, not replaced.',
  calendar: 'A factory calendar is not carried. Lead time is a number of days.',
  bom: 'This run does not explode a bill of material. Dependent demand is the open reservation.',
  companyCode: 'The company code is read from the plant. It is not a key of the run.',
  uuid: 'A uuid is not the key of the run. The run number is.',
  post: 'A planning run posts nothing.',
  outbox: 'An outbox is not this run.',
  period: 'A financial period is not read. Planning is not a posting.',
  proposalQuantity: 'A proposal quantity is calculated. It is not entered.',
  bookQuantity: 'The book quantity is stock on hand. It is not entered.',
};

export class MrpRunError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'MrpRunError';
  }
}

export interface MrpRunRequest {
  client: string;
  requestedBy: string;
  requestKey: string;
  processingKey: string;
  plantFrom: string;
  plantTo?: string;
  materialFrom?: string;
  materialTo?: string;
  mrpController?: string;
  horizonStart?: string;
  horizonEnd?: string;
  simulationOnly?: boolean;
  confirmRegenerative?: boolean;
  executionMode?: string;
  planningMode?: string;
  named?: Record<string, string | undefined>;
}

export interface MrpProposalView {
  lineNumber: number;
  materialNumber: string;
  plant: string;
  proposalType: string;
  action: string;
  documentNumber: string | null;
  itemNumber: number | null;
  quantity: string;
  unit: string;
  receiptDate: string;
  startDate: string;
  status: string;
  reason: string;
}

export interface MrpMaterialView {
  materialNumber: string;
  plant: string;
  companyCode: string;
  status: string;
  supplyQuantity: string;
  demandQuantity: string;
  shortageQuantity: string;
  proposalsCreated: number;
  proposalsChanged: number;
  proposalsRetained: number;
  diagnosticCode: string | null;
  message: string | null;
}

export interface MrpDiagnosticView {
  lineNumber: number;
  materialNumber: string | null;
  plant: string | null;
  severity: string;
  diagnosticCode: string;
  message: string;
}

export interface MrpRunView {
  runNumber: string;
  processingKey: string;
  executionMode: string;
  planningMode: string;
  simulationOnly: boolean;
  plantFrom: string;
  plantTo: string;
  materialFrom: string | null;
  materialTo: string | null;
  mrpController: string | null;
  horizonStart: string | null;
  horizonEnd: string | null;
  status: string;
  requestKey: string;
  materialsSelected: number;
  materialsPlanned: number;
  materialsSkipped: number;
  materialsFailed: number;
  proposalsCreated: number;
  proposalsChanged: number;
  proposalsRetained: number;
  errorSummary: string | null;
  materials: MrpMaterialView[];
  proposals: MrpProposalView[];
  diagnostics: MrpDiagnosticView[];
}

interface Selection {
  processingKey: (typeof PROCESSING_KEYS)[number];
  plantFrom: string;
  plantTo: string;
  materialFrom: string | null;
  materialTo: string | null;
  mrpController: string | null;
  horizonStart: string | null;
  horizonEnd: string | null;
  simulationOnly: boolean;
  confirmRegenerative: boolean;
}

interface Candidate {
  materialNumber: string;
  plant: string;
  companyCode: string;
  mrpType: string;
  procurementType: string;
  lotSizing: string;
  fixedLot: string;
  minimumLot: string;
  maximumLot: string;
  safetyStock: string;
  reorderPoint: string;
  deliveryDays: number;
  productionDays: number;
  purchasingGroup: string | null;
  baseUnit: string;
  description: string;
  netChange: boolean | null;
  planningChangedAt: string | Date | null;
}

function fail(message: string, remedy?: string): never {
  throw new MrpRunError(message, remedy);
}

function clean(value: string | undefined): string {
  return value?.trim() ?? '';
}

function dateOf(value: string | undefined, label: string): string | null {
  const parsed = clean(value);
  if (!parsed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) fail(`${label} is not a date.`, 'Use a calendar date.');
  const day = new Date(`${parsed}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== parsed) fail(`${label} is not a date.`);
  return parsed;
}

function addDays(value: string, days: number): string {
  const day = new Date(`${value}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function scaled(value: unknown): bigint {
  if (value == null || value === '') return 0n;
  return toScaled(String(value), SCALE);
}

function shown(value: bigint): string {
  return fromScaled(value, SCALE);
}

function asNumber(value: bigint): number {
  return Number(shown(value));
}

export function mrpNamedRefusal(fields: Record<string, string | undefined> | undefined): string | null {
  if (!fields) return null;
  for (const [name, value] of Object.entries(fields)) {
    if (!value?.trim()) continue;
    return REFUSED[name] ?? `${name} is not a field of this run.`;
  }
  return null;
}

function refuseNamed(fields: Record<string, string | undefined> | undefined): void {
  const refusal = mrpNamedRefusal(fields);
  if (refusal) fail(refusal, 'Plan a plant. A run posts nothing.');
}

function selectionOf(input: MrpRunRequest): Selection {
  refuseNamed(input.named);
  const execution = clean(input.executionMode).toUpperCase() || 'FOREGROUND';
  if (execution !== 'FOREGROUND') fail(REFUSED.background, 'Narrow the plant or the material range.');
  const mode = clean(input.planningMode).toUpperCase() || 'ADAPT_EXISTING';
  if (mode === 'DELETE_AND_RECREATE') fail(REFUSED.deleteAndRecreate, 'Adapt the proposal that stands.');
  if (mode !== 'ADAPT_EXISTING') fail(REFUSED.recreate, 'Adapt the proposal that stands.');
  const processing = clean(input.processingKey).toUpperCase();
  if (!PROCESSING_KEYS.includes(processing as Selection['processingKey'])) {
    fail(`The processing key ${input.processingKey || 'blank'} does not stand.`, 'Choose net change, net change in the horizon, or regenerative.');
  }
  const plantFrom = clean(input.plantFrom).toUpperCase();
  const plantTo = clean(input.plantTo).toUpperCase() || plantFrom;
  if (!plantFrom) fail('A plant is required.', 'Name the plant to plan.');
  if (plantFrom > plantTo) fail('The plant range is reversed.', 'Put the lower plant first.');
  const materialFrom = clean(input.materialFrom).toUpperCase();
  const materialTo = clean(input.materialTo).toUpperCase();
  if ((materialFrom && !materialTo) || (!materialFrom && materialTo)) {
    fail('A material range needs both ends.', 'Name the material from and the material to, or neither.');
  }
  if (materialFrom && materialTo && materialFrom > materialTo) fail('The material range is reversed.');
  const controller = clean(input.mrpController).toUpperCase();
  if (controller.length > 3) fail('The MRP controller is too long.');
  const horizonStart = dateOf(input.horizonStart, 'The horizon start');
  const horizonEnd = dateOf(input.horizonEnd, 'The horizon end');
  if ((horizonStart && !horizonEnd) || (!horizonStart && horizonEnd)) {
    fail('A planning horizon needs both ends.', 'Name the horizon start and the horizon end, or neither.');
  }
  if (horizonStart && horizonEnd && horizonStart > horizonEnd) fail('The planning horizon is reversed.');
  if (processing === 'NETPL' && !horizonStart) {
    fail('Net change in the horizon needs a horizon.', 'Name the horizon, or choose another processing key.');
  }
  if (processing !== 'NETPL' && horizonStart) {
    fail('A planning horizon is the net-change-in-horizon key. It is not a filter on this run.', 'Clear the horizon, or choose net change in the horizon.');
  }
  if (!clean(input.requestKey) || clean(input.requestKey).length > 64) fail('A request key is required.');
  return {
    processingKey: processing as Selection['processingKey'],
    plantFrom,
    plantTo,
    materialFrom: materialFrom || null,
    materialTo: materialTo || null,
    mrpController: controller || null,
    horizonStart,
    horizonEnd,
    simulationOnly: input.simulationOnly === true,
    confirmRegenerative: input.confirmRegenerative === true,
  };
}

function sameSelection(row: Record<string, unknown>, selection: Selection): boolean {
  const text = (value: unknown) => (value == null ? '' : String(value));
  return text(row.processing_key) === selection.processingKey
    && text(row.plant_from) === selection.plantFrom
    && text(row.plant_to) === selection.plantTo
    && text(row.material_from) === (selection.materialFrom ?? '')
    && text(row.material_to) === (selection.materialTo ?? '')
    && text(row.mrp_controller) === (selection.mrpController ?? '')
    && text(row.horizon_start) === (selection.horizonStart ?? '')
    && text(row.horizon_end) === (selection.horizonEnd ?? '')
    && Boolean(row.simulation_only) === selection.simulationOnly;
}

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return await tx.execute(query) as unknown as Array<Record<string, unknown>>;
}

async function viewOf(tx: Tx, client: string, runNumber: string): Promise<MrpRunView | null> {
  const header = await rows(tx, sql`
    select run_number, processing_key, execution_mode, planning_mode, simulation_only,
           plant_from, plant_to, material_from, material_to, mrp_controller,
           horizon_start::text as horizon_start, horizon_end::text as horizon_end, status, request_key,
           materials_selected, materials_planned, materials_skipped, materials_failed,
           proposals_created, proposals_changed, proposals_retained, error_summary
      from mrp_run
     where client = ${client} and run_number = ${runNumber}
  `);
  if (!header[0]) return null;
  const h = header[0];
  const materials = await rows(tx, sql`
    select m.material_number, m.plant, coalesce(p.company_code, '') as company_code, m.status,
           m.supply_quantity::text as supply_quantity, m.demand_quantity::text as demand_quantity,
           m.shortage_quantity::text as shortage_quantity, m.proposals_created, m.proposals_changed,
           m.proposals_retained, m.diagnostic_code, m.message
      from mrp_run_material m
      left join plant p on p.client = m.client and p.plant = m.plant
     where m.client = ${client} and m.run_number = ${runNumber}
     order by m.plant, m.material_number
  `);
  const proposals = await rows(tx, sql`
    select line_number, material_number, plant, proposal_type, action, document_number, item_number,
           quantity::text as quantity, unit, receipt_date::text as receipt_date, start_date::text as start_date,
           status, reason
      from mrp_run_proposal
     where client = ${client} and run_number = ${runNumber}
     order by line_number
  `);
  const diagnostics = await rows(tx, sql`
    select line_number, material_number, plant, severity, diagnostic_code, message
      from mrp_run_diagnostic
     where client = ${client} and run_number = ${runNumber}
     order by line_number
  `);
  const num = (value: unknown) => Number(value ?? 0);
  return {
    runNumber: String(h.run_number),
    processingKey: String(h.processing_key),
    executionMode: String(h.execution_mode),
    planningMode: String(h.planning_mode),
    simulationOnly: Boolean(h.simulation_only),
    plantFrom: String(h.plant_from),
    plantTo: String(h.plant_to),
    materialFrom: h.material_from == null ? null : String(h.material_from),
    materialTo: h.material_to == null ? null : String(h.material_to),
    mrpController: h.mrp_controller == null ? null : String(h.mrp_controller),
    horizonStart: h.horizon_start == null ? null : String(h.horizon_start),
    horizonEnd: h.horizon_end == null ? null : String(h.horizon_end),
    status: String(h.status),
    requestKey: String(h.request_key),
    materialsSelected: num(h.materials_selected),
    materialsPlanned: num(h.materials_planned),
    materialsSkipped: num(h.materials_skipped),
    materialsFailed: num(h.materials_failed),
    proposalsCreated: num(h.proposals_created),
    proposalsChanged: num(h.proposals_changed),
    proposalsRetained: num(h.proposals_retained),
    errorSummary: h.error_summary == null ? null : String(h.error_summary),
    materials: materials.map((row) => ({
      materialNumber: String(row.material_number),
      plant: String(row.plant),
      companyCode: String(row.company_code ?? ''),
      status: String(row.status),
      supplyQuantity: String(row.supply_quantity),
      demandQuantity: String(row.demand_quantity),
      shortageQuantity: String(row.shortage_quantity),
      proposalsCreated: num(row.proposals_created),
      proposalsChanged: num(row.proposals_changed),
      proposalsRetained: num(row.proposals_retained),
      diagnosticCode: row.diagnostic_code == null ? null : String(row.diagnostic_code),
      message: row.message == null ? null : String(row.message),
    })),
    proposals: proposals.map((row) => ({
      lineNumber: num(row.line_number),
      materialNumber: String(row.material_number),
      plant: String(row.plant),
      proposalType: String(row.proposal_type),
      action: String(row.action),
      documentNumber: row.document_number == null ? null : String(row.document_number),
      itemNumber: row.item_number == null ? null : num(row.item_number),
      quantity: String(row.quantity),
      unit: String(row.unit),
      receiptDate: String(row.receipt_date),
      startDate: String(row.start_date),
      status: String(row.status),
      reason: String(row.reason),
    })),
    diagnostics: diagnostics.map((row) => ({
      lineNumber: num(row.line_number),
      materialNumber: row.material_number == null ? null : String(row.material_number),
      plant: row.plant == null ? null : String(row.plant),
      severity: String(row.severity),
      diagnosticCode: String(row.diagnostic_code),
      message: String(row.message),
    })),
  };
}

async function candidates(tx: Tx, client: string, selection: Selection): Promise<Candidate[]> {
  const found = await rows(tx, sql`
    select mp.material_number, mp.plant, coalesce(p.company_code, '') as company_code,
           mp.mrp_type, mp.procurement_type, mp.lot_sizing,
           mp.fixed_lot_size::text as fixed_lot, mp.minimum_lot_size::text as minimum_lot,
           mp.maximum_lot_size::text as maximum_lot, mp.safety_stock::text as safety_stock,
           mp.reorder_point::text as reorder_point, mp.planned_delivery_days, mp.in_house_production_days,
           mp.purchasing_group, m.base_unit, m.description,
           pf.net_change, pf.last_changed_at
      from material_plant mp
      join material m on m.client = mp.client and m.material_number = mp.material_number
      join plant p on p.client = mp.client and p.plant = mp.plant
      left join planning_file pf
        on pf.client = mp.client and pf.material_number = mp.material_number and pf.plant = mp.plant
     where mp.client = ${client}
       and mp.plant >= ${selection.plantFrom} and mp.plant <= ${selection.plantTo}
       and mp.mrp_status in ('CREATED', 'MAINTAINED')
       and mp.mrp_type in ('REQUIREMENTS', 'REORDER', 'NONE')
       and (${selection.mrpController}::text is null or mp.mrp_controller = ${selection.mrpController})
       and (${selection.materialFrom}::text is null or mp.material_number >= ${selection.materialFrom})
       and (${selection.materialTo}::text is null or mp.material_number <= ${selection.materialTo})
     order by mp.plant, m.low_level_code, mp.material_number
  `);
  return found.map((row) => ({
    materialNumber: String(row.material_number),
    plant: String(row.plant),
    companyCode: String(row.company_code ?? ''),
    mrpType: String(row.mrp_type),
    procurementType: String(row.procurement_type ?? ''),
    lotSizing: String(row.lot_sizing ?? ''),
    fixedLot: String(row.fixed_lot ?? '0'),
    minimumLot: String(row.minimum_lot ?? '0'),
    maximumLot: String(row.maximum_lot ?? '0'),
    safetyStock: String(row.safety_stock ?? '0'),
    reorderPoint: String(row.reorder_point ?? '0'),
    deliveryDays: Number(row.planned_delivery_days ?? 0),
    productionDays: Number(row.in_house_production_days ?? 0),
    purchasingGroup: row.purchasing_group == null ? null : String(row.purchasing_group),
    baseUnit: String(row.base_unit ?? ''),
    description: String(row.description ?? ''),
    netChange: row.net_change == null ? null : Boolean(row.net_change),
    planningChangedAt: (row.last_changed_at as string | Date | null) ?? null,
  }));
}

interface Lot {
  quantity: bigint;
  receiptDate: string;
  startDate: string;
}

interface Calculation {
  status: 'COMPLETED' | 'SKIPPED' | 'FAILED';
  acknowledge: boolean;
  supply: bigint;
  demand: bigint;
  shortage: bigint;
  proposalType: 'PURCHASE_REQUISITION' | 'PLANNED_ORDER' | null;
  lots: Lot[];
  diagnostics: Array<{ severity: 'INFO' | 'WARNING' | 'ERROR'; code: string; message: string }>;
  message: string;
}

function lotSizes(shortage: bigint, candidate: Candidate): bigint[] | string {
  const fixed = scaled(candidate.fixedLot);
  const minimum = scaled(candidate.minimumLot);
  const maximum = scaled(candidate.maximumLot);
  if (candidate.lotSizing === 'FIXED') {
    if (fixed <= 0n) return 'LOT_NOT_CONFIGURED';
    if (maximum > 0n && fixed > maximum) return 'LOT_ABOVE_MAXIMUM';
    const size = fixed < minimum ? minimum : fixed;
    const count = Number((shortage + size - 1n) / size);
    if (count > 12) return 'LOT_SPLIT_UNBOUNDED';
    return Array.from({ length: count }, () => size);
  }
  let size = shortage < minimum ? minimum : shortage;
  if (maximum <= 0n || size <= maximum) return [size];
  const lots: bigint[] = [];
  let left = size;
  while (left > maximum) {
    lots.push(maximum);
    left -= maximum;
    if (lots.length > 12) return 'LOT_SPLIT_UNBOUNDED';
  }
  if (left > 0n) lots.push(left < minimum ? minimum : left);
  return lots;
}

async function calculate(tx: Tx, client: string, selection: Selection, candidate: Candidate): Promise<Calculation> {
  const diagnostics: Calculation['diagnostics'] = [];
  if (candidate.mrpType === 'NONE') {
    return {
      status: 'SKIPPED', acknowledge: true, supply: 0n, demand: 0n, shortage: 0n,
      proposalType: null, lots: [], diagnostics: [{ severity: 'INFO', code: 'NOT_PLANNED', message: 'The MRP type is none. Nothing was proposed.' }],
      message: 'The MRP type is none. Nothing was proposed.',
    };
  }
  if (candidate.procurementType === 'BOTH') {
    return {
      status: 'FAILED', acknowledge: false, supply: 0n, demand: 0n, shortage: 0n,
      proposalType: null, lots: [], diagnostics: [{ severity: 'ERROR', code: 'UNSUPPORTED_PROCUREMENT', message: 'Mixed procurement is not planned. Choose buy or make.' }],
      message: 'Mixed procurement is not planned. Choose buy or make.',
    };
  }
  if (candidate.procurementType !== 'BUY' && candidate.procurementType !== 'MAKE') {
    return {
      status: 'FAILED', acknowledge: false, supply: 0n, demand: 0n, shortage: 0n,
      proposalType: null, lots: [], diagnostics: [{ severity: 'ERROR', code: 'PROCUREMENT_MISSING', message: 'The procurement type is not maintained.' }],
      message: 'The procurement type is not maintained.',
    };
  }
  if (candidate.procurementType === 'BUY' && !candidate.purchasingGroup) {
    return {
      status: 'FAILED', acknowledge: false, supply: 0n, demand: 0n, shortage: 0n,
      proposalType: null, lots: [], diagnostics: [{ severity: 'ERROR', code: 'NO_PURCHASING_GROUP', message: 'A buy proposal needs the purchasing group on the material.' }],
      message: 'A buy proposal needs the purchasing group on the material.',
    };
  }

  const stock = await rows(tx, sql`
    select coalesce(sum(quantity), 0)::text as quantity
      from stock_quantity
     where client = ${client} and material_number = ${candidate.materialNumber} and plant = ${candidate.plant}
       and stock_type in ('UNRESTRICTED', 'QUALITY')
  `);
  const requisitions = await rows(tx, sql`
    select r.requisition_number, r.item_number, r.quantity::text as quantity, r.delivery_date::text as delivery_date,
           r.planning_run_number, coalesce(conv.converted, 0)::text as converted,
           coalesce(rel.status, '') as release_status
      from purchase_requisition_item r
      left join (
        select requisition_number, requisition_item, sum(quantity) as converted
          from purchase_order_item
         where client = ${client} and requisition_number is not null and not marked_for_deletion
         group by requisition_number, requisition_item
      ) conv on conv.requisition_number = r.requisition_number and conv.requisition_item = r.item_number
      left join document_release rel
        on rel.client = r.client and rel.document_category = 'PURCHASE_REQUISITION' and rel.document_number = r.requisition_number
     where r.client = ${client} and r.material_number = ${candidate.materialNumber} and r.plant = ${candidate.plant}
       and not r.marked_for_deletion
  `);
  const orders = await rows(tx, sql`
    select i.order_number, i.item_number, i.quantity::text as quantity,
           coalesce(sc.delivery_date::text, po.document_date::text) as delivery_date,
           coalesce(gr.delivered, 0)::text as delivered
      from purchase_order_item i
      join purchase_order po on po.client = i.client and po.order_number = i.order_number
      left join (
        select l.purchase_order_number, l.purchase_order_item,
               sum(case when m.direction = 'REVERSAL' then -l.base_quantity else l.base_quantity end) as delivered
          from material_document_line l
          join material_document d on d.client = l.client and d.material_document_number = l.material_document_number and d.status = 'POSTED'
          join movement_type m on m.client = l.client and m.movement_type = l.movement_type
         where l.client = ${client} and l.purchase_order_number is not null
         group by l.purchase_order_number, l.purchase_order_item
      ) gr on gr.purchase_order_number = i.order_number and gr.purchase_order_item = i.item_number
      left join (
        select order_number, item_number, min(delivery_date) as delivery_date
          from purchase_order_schedule_line where client = ${client}
         group by order_number, item_number
      ) sc on sc.order_number = i.order_number and sc.item_number = i.item_number
     where i.client = ${client} and i.material_number = ${candidate.materialNumber} and i.plant = ${candidate.plant}
       and not i.marked_for_deletion
  `);
  const planned = await rows(tx, sql`
    select order_number, quantity::text as quantity, finish_date::text as finish_date, firming_status, version
      from planned_order
     where client = ${client} and material_number = ${candidate.materialNumber} and plant = ${candidate.plant}
  `);
  const reservations = await rows(tx, sql`
    select (i.required_quantity - i.withdrawn_quantity)::text as quantity, h.base_date
      from reservation_item i
      join reservation_header h on h.client = i.client and h.reservation_number = i.reservation_number
     where i.client = ${client} and i.material_number = ${candidate.materialNumber} and i.plant = ${candidate.plant}
       and not i.is_completed
  `);
  const production = await rows(tx, sql`
    select o.order_number, o.order_quantity::text as quantity, o.scheduled_finish,
           coalesce(gr.received, 0)::text as received
      from production_order o
      left join (
        select l.production_order_number,
               sum(case when m.direction = 'REVERSAL' then -l.base_quantity else l.base_quantity end) as received
          from material_document_line l
          join material_document d on d.client = l.client and d.material_document_number = l.material_document_number and d.status = 'POSTED'
          join movement_type m on m.client = l.client and m.movement_type = l.movement_type
         where l.client = ${client} and l.production_order_number is not null
         group by l.production_order_number
      ) gr on gr.production_order_number = o.order_number
     where o.client = ${client} and o.material_number = ${candidate.materialNumber} and o.plant = ${candidate.plant}
       and o.status in ('CREATED', 'RELEASED')
  `);

  const day = today();
  const elements: Array<{ date: string; delta: bigint }> = [];
  const opening = scaled(stock[0]?.quantity);
  elements.push({ date: day, delta: opening });
  let supply = opening;
  let demand = 0n;
  if (candidate.mrpType === 'REQUIREMENTS') {
    const safety = scaled(candidate.safetyStock);
    if (safety > 0n) {
      elements.push({ date: day, delta: -safety });
      demand += safety;
    }
  }
  for (const row of requisitions) {
    const open = scaled(row.quantity) - scaled(row.converted);
    if (open <= 0n) continue;
    const adaptable = row.planning_run_number != null && String(row.planning_run_number) !== ''
      && scaled(row.converted) === 0n && String(row.release_status) !== 'RELEASED';
    // An adaptable proposal is what this run reconciles. Counting it as supply and
    // then writing the residual back onto it would shrink the proposal.
    if (adaptable) continue;
    elements.push({ date: String(row.delivery_date), delta: open });
    supply += open;
  }
  for (const row of orders) {
    const open = scaled(row.quantity) - scaled(row.delivered);
    if (open <= 0n) continue;
    elements.push({ date: String(row.delivery_date || day), delta: open });
    supply += open;
  }
  for (const row of planned) {
    if (String(row.firming_status) !== 'FIRMED') continue;
    const open = scaled(row.quantity);
    elements.push({ date: String(row.finish_date), delta: open });
    supply += open;
  }
  for (const row of production) {
    const open = scaled(row.quantity) - scaled(row.received);
    if (open <= 0n) continue;
    elements.push({ date: String(row.scheduled_finish), delta: open });
    supply += open;
    diagnostics.push({
      severity: 'INFO', code: 'PRODUCTION_ORDER_COUNTED',
      message: `Production order ${row.order_number} is supply. It is not a planned order, and its components are not exploded.`,
    });
  }
  for (const row of reservations) {
    const open = scaled(row.quantity);
    if (open <= 0n) continue;
    elements.push({ date: String(row.base_date), delta: -open });
    demand += open;
  }

  const walk = (source: Array<{ date: string; delta: bigint }>) => {
    const ordered = [...source].sort((a, b) => a.date === b.date ? (a.delta > b.delta ? -1 : 1) : a.date < b.date ? -1 : 1);
    const found: Array<{ date: string; quantity: bigint }> = [];
    let balance = 0n;
    const reorder = scaled(candidate.reorderPoint);
    for (const element of ordered) {
      balance += element.delta;
      if (candidate.mrpType === 'REQUIREMENTS' && balance < 0n) {
        found.push({ date: element.date, quantity: -balance });
        balance = 0n;
      }
      if (candidate.mrpType === 'REORDER' && balance < reorder) {
        found.push({ date: element.date, quantity: reorder - balance });
        balance = reorder;
      }
    }
    return found;
  };

  let found = walk(elements);
  let acknowledge = true;
  if (selection.processingKey === 'NETPL' && selection.horizonStart && selection.horizonEnd) {
    const outside = found.filter((item) => item.date < selection.horizonStart! || item.date > selection.horizonEnd!);
    let openingBalance = 0n;
    const inside: Array<{ date: string; delta: bigint }> = [];
    for (const element of elements) {
      if (element.date < selection.horizonStart) openingBalance += element.delta;
      else if (element.date <= selection.horizonEnd) inside.push(element);
    }
    inside.unshift({ date: selection.horizonStart, delta: openingBalance });
    found = walk(inside);
    if (found.length === 0 && outside.length > 0) {
      acknowledge = false;
      diagnostics.push({
        severity: 'WARNING', code: 'OUTSIDE_HORIZON',
        message: 'The change falls outside the horizon. The planning file stays marked.',
      });
      return {
        status: 'SKIPPED', acknowledge, supply, demand, shortage: 0n, proposalType: null, lots: [], diagnostics,
        message: 'The change falls outside the horizon. The planning file stays marked.',
      };
    }
  }

  const shortage = found.reduce((sum, item) => sum + item.quantity, 0n);
  if (shortage === 0n) {
    return {
      status: 'COMPLETED', acknowledge, supply, demand, shortage, proposalType: null, lots: [], diagnostics,
      message: 'No shortage. Nothing was proposed.',
    };
  }
  const sized = lotSizes(shortage, candidate);
  if (typeof sized === 'string') {
    const message = sized === 'LOT_NOT_CONFIGURED'
      ? 'The fixed lot size is not maintained.'
      : sized === 'LOT_ABOVE_MAXIMUM'
        ? 'The fixed lot is above the maximum lot.'
        : 'The shortage would split into more lots than this run will create.';
    return {
      status: 'FAILED', acknowledge: false, supply, demand, shortage, proposalType: null, lots: [],
      diagnostics: [...diagnostics, { severity: 'ERROR', code: sized, message }],
      message,
    };
  }
  const lead = candidate.procurementType === 'BUY' ? candidate.deliveryDays : candidate.productionDays;
  const lots: Lot[] = [];
  let index = 0;
  for (const item of found) {
    let left = item.quantity;
    while (left > 0n && index < sized.length) {
      const quantity = sized[index] > left && index === sized.length - 1 ? sized[index] : sized[index] <= left ? sized[index] : left;
      const receiptDate = item.date;
      const startDate = addDays(receiptDate, -lead);
      if (startDate < day) {
        diagnostics.push({
          severity: 'WARNING', code: 'LATE_PROPOSAL',
          message: `The proposal for ${receiptDate} cannot start in the past. The date was not moved.`,
        });
      }
      lots.push({ quantity, receiptDate, startDate });
      left -= quantity;
      index += 1;
    }
  }
  return {
    status: 'COMPLETED', acknowledge, supply, demand, shortage,
    proposalType: candidate.procurementType === 'BUY' ? 'PURCHASE_REQUISITION' : 'PLANNED_ORDER',
    lots, diagnostics,
    message: lots.length === 0 ? 'No shortage. Nothing was proposed.' : 'The shortage was planned.',
  };
}

async function nextLine(tx: Tx, client: string, runNumber: string, table: 'proposal' | 'diagnostic'): Promise<number> {
  const found = await rows(tx, table === 'proposal'
    ? sql`select coalesce(max(line_number), 0) as line from mrp_run_proposal where client = ${client} and run_number = ${runNumber}`
    : sql`select coalesce(max(line_number), 0) as line from mrp_run_diagnostic where client = ${client} and run_number = ${runNumber}`);
  return Number(found[0]?.line ?? 0) + 1;
}

async function writeDiagnostics(
  tx: Tx, client: string, runNumber: string, candidate: Candidate,
  diagnostics: Calculation['diagnostics'],
): Promise<void> {
  let line = await nextLine(tx, client, runNumber, 'diagnostic');
  for (const diagnostic of diagnostics) {
    await tx.execute(sql`
      insert into mrp_run_diagnostic (client, run_number, line_number, material_number, plant, severity, diagnostic_code, message)
      values (${client}, ${runNumber}, ${line}, ${candidate.materialNumber}, ${candidate.plant},
              ${diagnostic.severity}, ${diagnostic.code}, ${diagnostic.message})
    `);
    line += 1;
  }
}

async function recordProposal(
  tx: Tx, client: string, runNumber: string, actor: string, candidate: Candidate,
  proposal: {
    type: string; action: string; documentNumber: string | null; itemNumber: number | null;
    quantity: bigint; receiptDate: string; startDate: string; status: string; reason: string;
  },
): Promise<void> {
  const line = await nextLine(tx, client, runNumber, 'proposal');
  await tx.execute(sql`
    insert into mrp_run_proposal (
      client, run_number, line_number, material_number, plant, proposal_type, action,
      document_number, item_number, quantity, unit, receipt_date, start_date, status, reason, created_by
    ) values (
      ${client}, ${runNumber}, ${line}, ${candidate.materialNumber}, ${candidate.plant}, ${proposal.type}, ${proposal.action},
      ${proposal.documentNumber}, ${proposal.itemNumber}, ${shown(proposal.quantity)}, ${candidate.baseUnit},
      ${proposal.receiptDate}, ${proposal.startDate}, ${proposal.status}, ${proposal.reason}, ${actor}
    )
  `);
}

async function reconcile(
  tx: Tx, client: string, runNumber: string, actor: string, selection: Selection, candidate: Candidate, calculation: Calculation,
): Promise<{ created: number; changed: number; retained: number }> {
  if (!calculation.proposalType || calculation.lots.length === 0) return { created: 0, changed: 0, retained: 0 };
  const existing = calculation.proposalType === 'PURCHASE_REQUISITION'
    ? await rows(tx, sql`
        select r.requisition_number as document_number, r.item_number, r.quantity::text as quantity,
               r.delivery_date::text as receipt_date, r.planning_run_number,
               coalesce(conv.converted, 0)::text as converted, coalesce(rel.status, '') as release_status
          from purchase_requisition_item r
          left join (
            select requisition_number, requisition_item, sum(quantity) as converted
              from purchase_order_item
             where client = ${client} and not marked_for_deletion
             group by requisition_number, requisition_item
          ) conv on conv.requisition_number = r.requisition_number and conv.requisition_item = r.item_number
          left join document_release rel
            on rel.client = r.client and rel.document_category = 'PURCHASE_REQUISITION' and rel.document_number = r.requisition_number
         where r.client = ${client} and r.material_number = ${candidate.materialNumber} and r.plant = ${candidate.plant}
           and r.planning_run_number is not null and not r.marked_for_deletion
         order by r.delivery_date, r.requisition_number
      `)
    : await rows(tx, sql`
        select order_number as document_number, 0 as item_number, quantity::text as quantity,
               finish_date::text as receipt_date, firming_status, version
          from planned_order
         where client = ${client} and material_number = ${candidate.materialNumber} and plant = ${candidate.plant}
         order by finish_date, order_number
      `);
  const used = new Set<number>();
  let created = 0;
  let changed = 0;
  let retained = 0;
  for (const lot of calculation.lots) {
    const match = existing.findIndex((row, index) => !used.has(index) && String(row.receipt_date) === lot.receiptDate);
    if (match < 0) {
      if (selection.simulationOnly) {
        await recordProposal(tx, client, runNumber, actor, candidate, {
          type: calculation.proposalType, action: 'CREATE', documentNumber: null, itemNumber: null,
          quantity: lot.quantity, receiptDate: lot.receiptDate, startDate: lot.startDate,
          status: 'PROPOSED', reason: 'Simulation. Nothing was written.',
        });
      } else if (calculation.proposalType === 'PURCHASE_REQUISITION') {
        const made = await createRequisition({
          client, changedBy: actor, planningRunNumber: runNumber,
          items: [{
            materialNumber: candidate.materialNumber,
            shortText: `MRP ${candidate.materialNumber}`.slice(0, 40),
            quantity: asNumber(lot.quantity),
            unit: candidate.baseUnit,
            deliveryDate: lot.receiptDate,
            plant: candidate.plant,
            purchasingGroup: candidate.purchasingGroup!,
          }],
        });
        await recordProposal(tx, client, runNumber, actor, candidate, {
          type: calculation.proposalType, action: 'CREATE', documentNumber: made.requisitionNumber, itemNumber: 10,
          quantity: lot.quantity, receiptDate: lot.receiptDate, startDate: lot.startDate,
          status: 'APPLIED', reason: 'The shortage had no eligible proposal.',
        });
      } else {
        const key = `${runNumber}/${candidate.materialNumber}/${lot.receiptDate}/${shown(lot.quantity)}`;
        const standing = await rows(tx, sql`
          select order_number from planned_order where client = ${client} and request_key = ${key}
        `);
        let number = standing[0] ? String(standing[0].order_number) : '';
        if (!number) {
          const drawn = await allocateNumber(tx, {
            client, objectCode: 'PLANORD', companyCode: '*', subObject: '*', fiscalYear: 0, allocatedBy: actor,
          });
          number = drawn.display;
          await tx.execute(sql`
            insert into planned_order (
              client, order_number, material_number, plant, quantity, unit, start_date, finish_date,
              firming_status, origin, request_key, version, created_by
            ) values (
              ${client}, ${number}, ${candidate.materialNumber}, ${candidate.plant}, ${shown(lot.quantity)},
              ${candidate.baseUnit}, ${lot.startDate}, ${lot.receiptDate}, 'OPEN', 'MRP', ${key}, 1, ${actor}
            )
          `);
        }
        await recordProposal(tx, client, runNumber, actor, candidate, {
          type: calculation.proposalType, action: 'CREATE', documentNumber: number, itemNumber: null,
          quantity: lot.quantity, receiptDate: lot.receiptDate, startDate: lot.startDate,
          status: 'APPLIED', reason: 'The shortage had no eligible planned order.',
        });
      }
      created += 1;
      continue;
    }
    used.add(match);
    const row = existing[match]!;
    const lastApplied = await rows(tx, sql`
      select quantity::text as quantity
        from mrp_run_proposal
       where client = ${client} and document_number = ${String(row.document_number)}
         and status = 'APPLIED' and action in ('CREATE', 'UPDATE')
       order by created_at desc, line_number desc
       limit 1
    `);
    const manuallyChanged = lastApplied[0] != null && scaled(lastApplied[0].quantity) !== scaled(row.quantity);
    const protectedProposal = manuallyChanged || (calculation.proposalType === 'PURCHASE_REQUISITION'
      ? scaled(row.converted) > 0n || String(row.release_status) === 'RELEASED'
      : String(row.firming_status) === 'FIRMED');
    const same = scaled(row.quantity) === lot.quantity;
    if (same || protectedProposal) {
      await recordProposal(tx, client, runNumber, actor, candidate, {
        type: calculation.proposalType,
        action: protectedProposal && !same ? 'CONFLICT' : 'RETAIN',
        documentNumber: String(row.document_number),
        itemNumber: row.item_number == null ? null : Number(row.item_number),
        quantity: scaled(row.quantity),
        receiptDate: lot.receiptDate,
        startDate: lot.startDate,
        status: protectedProposal && !same ? 'CONFLICT' : 'APPLIED',
        reason: manuallyChanged
          ? 'The proposal was changed after planning. It was not overwritten.'
          : protectedProposal && !same
            ? 'The proposal is firmed, released, or already converted. It was not changed.'
            : 'The proposal already covers the shortage.',
      });
      retained += 1;
      continue;
    }
    if (selection.simulationOnly) {
      await recordProposal(tx, client, runNumber, actor, candidate, {
        type: calculation.proposalType, action: 'UPDATE', documentNumber: String(row.document_number),
        itemNumber: row.item_number == null ? null : Number(row.item_number),
        quantity: lot.quantity, receiptDate: lot.receiptDate, startDate: lot.startDate,
        status: 'PROPOSED', reason: 'Simulation. The standing proposal was not changed.',
      });
      changed += 1;
      continue;
    }
    if (calculation.proposalType === 'PURCHASE_REQUISITION') {
      await changeRequisition({
        client, changedBy: actor, requisitionNumber: String(row.document_number),
        items: [{
          itemNumber: Number(row.item_number),
          materialNumber: candidate.materialNumber,
          shortText: `MRP ${candidate.materialNumber}`.slice(0, 40),
          quantity: asNumber(lot.quantity),
          unit: candidate.baseUnit,
          deliveryDate: lot.receiptDate,
          plant: candidate.plant,
          purchasingGroup: candidate.purchasingGroup!,
        }],
      });
    } else {
      const updated = await rows(tx, sql`
        update planned_order
           set quantity = ${shown(lot.quantity)}, start_date = ${lot.startDate}, finish_date = ${lot.receiptDate},
               version = version + 1, changed_by = ${actor}, changed_at = now()
         where client = ${client} and order_number = ${String(row.document_number)}
           and firming_status = 'OPEN' and version = ${Number(row.version)}
        returning order_number
      `);
      if (updated.length === 0) {
        await recordProposal(tx, client, runNumber, actor, candidate, {
          type: calculation.proposalType, action: 'CONFLICT', documentNumber: String(row.document_number),
          itemNumber: null, quantity: scaled(row.quantity), receiptDate: lot.receiptDate, startDate: lot.startDate,
          status: 'CONFLICT', reason: 'The planned order changed after it was read.',
        });
        retained += 1;
        continue;
      }
    }
    await recordProposal(tx, client, runNumber, actor, candidate, {
      type: calculation.proposalType, action: 'UPDATE', documentNumber: String(row.document_number),
      itemNumber: row.item_number == null ? null : Number(row.item_number),
      quantity: lot.quantity, receiptDate: lot.receiptDate, startDate: lot.startDate,
      status: 'APPLIED', reason: 'The shortage changed. The eligible proposal was adapted.',
    });
    changed += 1;
  }
  return { created, changed, retained };
}

async function finishMaterial(
  tx: Tx, client: string, runNumber: string, actor: string, candidate: Candidate, calculation: Calculation,
  counts: { created: number; changed: number; retained: number },
): Promise<void> {
  await writeDiagnostics(tx, client, runNumber, candidate, calculation.diagnostics);
  await tx.execute(sql`
    update mrp_run_material
       set status = ${calculation.status},
           supply_quantity = ${shown(calculation.supply)},
           demand_quantity = ${shown(calculation.demand)},
           shortage_quantity = ${shown(calculation.shortage)},
           proposals_created = ${counts.created},
           proposals_changed = ${counts.changed},
           proposals_retained = ${counts.retained},
           diagnostic_code = ${calculation.diagnostics[0]?.code ?? null},
           message = ${calculation.message},
           changed_by = ${actor},
           changed_at = now()
     where client = ${client} and run_number = ${runNumber}
       and material_number = ${candidate.materialNumber} and plant = ${candidate.plant}
       and status = 'RUNNING'
  `);
  if (!calculation.acknowledge) return;
  if (candidate.planningChangedAt == null) return;
  const cleared = await rows(tx, sql`
    update planning_file
       set net_change = false, reason = 'Planned', last_changed_by = ${actor}, last_changed_at = now()
     where client = ${client} and material_number = ${candidate.materialNumber} and plant = ${candidate.plant}
       and net_change = true and last_changed_at = ${candidate.planningChangedAt}
    returning material_number
  `);
  if (cleared.length === 0 && candidate.netChange) {
    await tx.execute(sql`
      insert into mrp_run_diagnostic (client, run_number, line_number, material_number, plant, severity, diagnostic_code, message)
      values (${client}, ${runNumber}, ${await nextLine(tx, client, runNumber, 'diagnostic')}, ${candidate.materialNumber},
              ${candidate.plant}, 'WARNING', 'CHANGE_DURING_RUN',
              'The planning file changed during the run. It stays marked for the next run.')
    `);
  }
}

async function closeRun(tx: Tx, client: string, runNumber: string, status: string): Promise<void> {
  const summary = await rows(tx, sql`
    select count(*) filter (where status <> 'PENDING') as selected,
           count(*) filter (where status = 'COMPLETED') as planned,
           count(*) filter (where status = 'SKIPPED') as skipped,
           count(*) filter (where status in ('FAILED', 'CANCELLED')) as failed
      from mrp_run_material
     where client = ${client} and run_number = ${runNumber}
  `);
  const proposals = await rows(tx, sql`
    select count(*) filter (where action = 'CREATE' and status = 'APPLIED') as created,
           count(*) filter (where action = 'UPDATE' and status = 'APPLIED') as changed,
           count(*) filter (where action = 'RETAIN') as retained
      from mrp_run_proposal
     where client = ${client} and run_number = ${runNumber}
  `);
  const warnings = await rows(tx, sql`
    select count(*) as warnings from mrp_run_diagnostic
     where client = ${client} and run_number = ${runNumber} and severity in ('WARNING', 'ERROR')
  `);
  let terminal = status;
  if (status !== 'CANCELLED') {
    const failed = Number(summary[0]?.failed ?? 0);
    const planned = Number(summary[0]?.planned ?? 0);
    const warningCount = Number(warnings[0]?.warnings ?? 0);
    terminal = failed > 0 && planned === 0 ? 'FAILED' : warningCount > 0 || failed > 0 ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED';
  }
  await tx.execute(sql`
    update mrp_run
       set status = ${terminal},
           materials_selected = ${Number(summary[0]?.selected ?? 0)},
           materials_planned = ${Number(summary[0]?.planned ?? 0)},
           materials_skipped = ${Number(summary[0]?.skipped ?? 0)},
           materials_failed = ${Number(summary[0]?.failed ?? 0)},
           proposals_created = ${Number(proposals[0]?.created ?? 0)},
           proposals_changed = ${Number(proposals[0]?.changed ?? 0)},
           proposals_retained = ${Number(proposals[0]?.retained ?? 0)},
           completed_at = now(),
           changed_at = now()
     where client = ${client} and run_number = ${runNumber}
  `);
}

export async function getMrpRun(client: string, runNumber: string): Promise<MrpRunView | null> {
  return withTenant(client, async (tx) => viewOf(tx, client, runNumber.trim()));
}

export async function listMrpRuns(client: string): Promise<Array<{ runNumber: string; status: string; plantFrom: string; processingKey: string }>> {
  return withTenant(client, async (tx) => {
    const found = await rows(tx, sql`
      select run_number, status, plant_from, processing_key
        from mrp_run
       where client = ${client}
       order by created_at desc
       limit 12
    `);
    return found.map((row) => ({
      runNumber: String(row.run_number),
      status: String(row.status),
      plantFrom: String(row.plant_from),
      processingKey: String(row.processing_key),
    }));
  });
}

export async function cancelMrpRun(client: string, runNumber: string, requestedBy: string): Promise<MrpRunView> {
  return withTenant(client, async (tx) => {
    const header = await rows(tx, sql`
      select status from mrp_run where client = ${client} and run_number = ${runNumber} for update
    `);
    if (!header[0]) fail(`Run ${runNumber} does not stand.`);
    const status = String(header[0].status);
    if (status === 'COMPLETED' || status === 'COMPLETED_WITH_WARNINGS' || status === 'FAILED' || status === 'CANCELLED') {
      fail(`Run ${runNumber} is ${status}. A finished run is not cancelled.`, 'Read the run. Already committed proposals stand.');
    }
    await tx.execute(sql`
      update mrp_run set status = 'CANCELLING', changed_by = ${requestedBy}, changed_at = now()
       where client = ${client} and run_number = ${runNumber}
    `);
    await tx.execute(sql`
      update mrp_run_material set status = 'CANCELLED', message = 'Cancelled before planning.', changed_by = ${requestedBy}, changed_at = now()
       where client = ${client} and run_number = ${runNumber} and status = 'PENDING'
    `);
    const running = await rows(tx, sql`
      select 1 as hit from mrp_run_material
       where client = ${client} and run_number = ${runNumber} and status = 'RUNNING' limit 1
    `);
    if (running.length === 0) await closeRun(tx, client, runNumber, 'CANCELLED');
    return (await viewOf(tx, client, runNumber))!;
  });
}

export async function planMaterials(input: MrpRunRequest): Promise<MrpRunView> {
  const selection = selectionOf(input);
  const opened = await withTenant(input.client, async (tx) => {
    const prior = await rows(tx, sql`
      select run_number, processing_key, plant_from, plant_to, material_from, material_to, mrp_controller,
             horizon_start::text as horizon_start, horizon_end::text as horizon_end, simulation_only, status
        from mrp_run
       where client = ${input.client} and request_key = ${clean(input.requestKey)}
       for update
    `);
    if (prior[0]) {
      if (!sameSelection(prior[0], selection)) {
        fail('This request already planned a different scope.', 'Use a new request. A retry cannot change the scope.');
      }
      const status = String(prior[0].status);
      if (status === 'COMPLETED' || status === 'COMPLETED_WITH_WARNINGS' || status === 'FAILED' || status === 'CANCELLED') {
        return { runNumber: String(prior[0].run_number), resume: false };
      }
      return { runNumber: String(prior[0].run_number), resume: true };
    }
    if (selection.processingKey === 'NEUPL' && !selection.confirmRegenerative) {
      fail('Regenerative planning needs confirmation.', 'Confirm the regenerative run, or choose net change.');
    }
    const plants = await rows(tx, sql`
      select plant from plant
       where client = ${input.client} and plant >= ${selection.plantFrom} and plant <= ${selection.plantTo}
       order by plant
    `);
    if (plants.length === 0) {
      fail(`The plant ${selection.plantFrom} does not stand.`, 'Maintain the plant before planning in it.');
    }
    const overlap = await rows(tx, sql`
      select run_number from mrp_run
       where client = ${input.client} and status in ('QUEUED', 'RUNNING', 'CANCELLING')
         and plant_from <= ${selection.plantTo} and plant_to >= ${selection.plantFrom}
       limit 1
    `);
    if (overlap[0]) {
      fail(`Run ${overlap[0].run_number} is already planning this plant.`, 'Wait for that run, or cancel it, before planning the same plant.');
    }
    const selected = await candidates(tx, input.client, selection);
    if (selection.processingKey === 'NETCH') {
      const missing = selected.find((item) => item.mrpType !== 'NONE' && item.netChange == null);
      if (missing) {
        fail(
          `Material ${missing.materialNumber} in plant ${missing.plant} has no planning file, so a net-change run cannot know what changed.`,
          'Save the MRP view, or run regenerative planning.',
        );
      }
    }
    const chosen = selection.processingKey === 'NEUPL'
      ? selected
      : selected.filter((item) => item.netChange === true);
    if (chosen.length > MRP_FOREGROUND_LIMIT) {
      fail(
        `${chosen.length} materials is above the foreground limit of ${MRP_FOREGROUND_LIMIT}.`,
        'Narrow the plant or the material range. A background run is not carried.',
      );
    }
    let drawn: Awaited<ReturnType<typeof allocateNumber>>;
    try {
      drawn = await allocateNumber(tx, {
        client: input.client, objectCode: 'MRPRUN', companyCode: '*', subObject: '*', fiscalYear: 0, allocatedBy: input.requestedBy,
      });
    } catch {
      fail('No active MRP run number range stands.', 'Define the MRPRUN interval, then plan again.');
    }
    const runNumber = drawn.display;
    await tx.execute(sql`
      insert into mrp_run (
        client, run_number, processing_key, execution_mode, planning_mode, simulation_only,
        plant_from, plant_to, material_from, material_to, mrp_controller, horizon_start, horizon_end,
        status, request_key, requested_by, materials_selected, started_at, created_by
      ) values (
        ${input.client}, ${runNumber}, ${selection.processingKey}, 'FOREGROUND', 'ADAPT_EXISTING', ${selection.simulationOnly},
        ${selection.plantFrom}, ${selection.plantTo}, ${selection.materialFrom}, ${selection.materialTo}, ${selection.mrpController},
        ${selection.horizonStart}, ${selection.horizonEnd}, 'RUNNING', ${clean(input.requestKey)}, ${input.requestedBy},
        ${chosen.length}, now(), ${input.requestedBy}
      )
    `);
    for (const item of chosen) {
      await tx.execute(sql`
        insert into mrp_run_material (client, run_number, material_number, plant, status, planning_changed_at, created_by)
        values (${input.client}, ${runNumber}, ${item.materialNumber}, ${item.plant}, 'PENDING', ${item.planningChangedAt}, ${input.requestedBy})
      `);
    }
    return { runNumber, resume: true };
  });

  if (!opened.resume) return (await getMrpRun(input.client, opened.runNumber))!;

  const pending = await withTenant(input.client, async (tx) => rows(tx, sql`
    select material_number, plant from mrp_run_material
     where client = ${input.client} and run_number = ${opened.runNumber} and status = 'PENDING'
     order by plant, material_number
  `));
  for (const item of pending) {
    const claimed = await withTenant(input.client, async (tx) => {
      const run = await rows(tx, sql`select status from mrp_run where client = ${input.client} and run_number = ${opened.runNumber}`);
      if (String(run[0]?.status) === 'CANCELLING' || String(run[0]?.status) === 'CANCELLED') return false;
      const claim = await rows(tx, sql`
        update mrp_run_material set status = 'RUNNING', changed_at = now()
         where client = ${input.client} and run_number = ${opened.runNumber}
           and material_number = ${String(item.material_number)} and plant = ${String(item.plant)}
           and status = 'PENDING'
        returning material_number
      `);
      return claim.length > 0;
    });
    if (!claimed) continue;
    try {
      await withTenant(input.client, async (tx) => {
        const selected = await candidates(tx, input.client, selection);
        const candidate = selected.find((row) => row.materialNumber === String(item.material_number) && row.plant === String(item.plant));
        if (!candidate) fail(`Material ${item.material_number} is no longer in the planning scope.`);
        const calculation = await calculate(tx, input.client, selection, candidate);
        const counts = calculation.status === 'COMPLETED'
          ? await reconcile(tx, input.client, opened.runNumber, input.requestedBy, selection, candidate, calculation)
          : { created: 0, changed: 0, retained: 0 };
        if (selection.simulationOnly) calculation.acknowledge = false;
        await finishMaterial(tx, input.client, opened.runNumber, input.requestedBy, candidate, calculation, counts);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The material could not be planned.';
      await withTenant(input.client, async (tx) => {
        await tx.execute(sql`
          update mrp_run_material
             set status = 'FAILED', diagnostic_code = 'PLAN_FAILED', message = ${message.slice(0, 200)}, changed_at = now()
           where client = ${input.client} and run_number = ${opened.runNumber}
             and material_number = ${String(item.material_number)} and plant = ${String(item.plant)}
             and status = 'RUNNING'
        `);
        await tx.execute(sql`
          insert into mrp_run_diagnostic (client, run_number, line_number, material_number, plant, severity, diagnostic_code, message)
          values (${input.client}, ${opened.runNumber}, ${await nextLine(tx, input.client, opened.runNumber, 'diagnostic')},
                  ${String(item.material_number)}, ${String(item.plant)}, 'ERROR', 'PLAN_FAILED', ${message.slice(0, 200)})
        `);
      });
    }
  }

  return withTenant(input.client, async (tx) => {
    const run = await rows(tx, sql`select status from mrp_run where client = ${input.client} and run_number = ${opened.runNumber}`);
    const cancelling = String(run[0]?.status) === 'CANCELLING';
    if (cancelling) {
      await tx.execute(sql`
        update mrp_run_material set status = 'CANCELLED', message = 'Cancelled before planning.', changed_at = now()
         where client = ${input.client} and run_number = ${opened.runNumber} and status = 'PENDING'
      `);
    }
    await closeRun(tx, input.client, opened.runNumber, cancelling ? 'CANCELLED' : 'COMPLETED');
    return (await viewOf(tx, input.client, opened.runNumber))!;
  });
}
