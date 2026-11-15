/**
 * BOM explosion (CS11 single-level, CS12 multi-level) and where-used (CS15). Read-only.
 *
 * The explosion reproduces MRP's walk (`mrp-explosion.ts`) exactly, so the report and the plan never
 * disagree: the same quantity formula (`componentRequirementQuantity`), the same scale, the same depth
 * limit, the same cycle rule, the same production-version selection (`context: 'PLANNING'`), the same
 * conversion of a component quantity to the component's base unit before going a level deeper, and
 * the same rule about what is exploded at all — a MAKE material; a BUY material ends its branch; a
 * phantom is passed through (its components are planned against the parent). Unlike MRP, nothing is
 * skipped silently: every stop, every row MRP would not plan, and every uncomputable quantity is
 * reported on its row. Phantom components are shown one level below the phantom (SAP's indent).
 *
 * Where-used walks upward over master data only: any BOM containing the material, whatever the
 * parent's procurement type, showing the component quantity per the parent's base quantity — never a
 * requirement, because walking upward there is no parent quantity to multiply by.
 *
 * Authority: `PROD.BOM.DISPLAY` (a read of the same data `/production/bom-display` shows) and the
 * signed-in user's Plant scope over every plant read.
 */
import { sql } from 'drizzle-orm';

import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import { hasOrgAccess } from '../../platform/auth/session';
import { type Tx, withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import { BOM_DISPLAY_CAPABILITY } from './material-bom';
import { DEPTH_LIMIT, SCALE, componentRequirementQuantity, type ExplosionDiagnostic } from './mrp-explosion';
import { ProductionVersionError, selectProductionVersion } from './production-version';

export const BOM_EXPLOSION_CAPABILITY = BOM_DISPLAY_CAPABILITY;
export const BOM_EXPLOSION_ROUTE = '/production/bom-explosion';
export type { ExplosionDiagnostic };

export class BomExplosionError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'BomExplosionError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new BomExplosionError(message, remedy);
}

type Authority = { authorization?: ServiceAuthorityContext };
type Row = Record<string, unknown>;
const rows = (tx: Tx, query: ReturnType<typeof sql>) => tx.execute(query) as unknown as Promise<Row[]>;
const scaled = (value: unknown) => (value == null || value === '' ? 0n : toScaled(String(value), SCALE));
const shown = (value: bigint) => fromScaled(value, SCALE);
const text = (value: unknown) => (value == null ? null : String(value).trim() || null);
const flag = (value: unknown) => String(value ?? '').trim() === 'X';

// ── Inputs and views ────────────────────────────────────────────────────────

export interface ExplodeBomInput {
  client: string;
  materialNumber: string;
  plant: string;
  /** Defaults to today. Everything is judged against this one date. */
  keyDate?: string;
  /** How many of the parent to explode, in its base unit. Defaults to the BOM base quantity. */
  quantity?: string;
  /** SINGLE is CS11, MULTI (default) is CS12. */
  depth?: 'SINGLE' | 'MULTI';
  /** Name the BOM instead of resolving it through the production version (both, or neither). */
  usage?: string;
  alternative?: string;
  productionVersion?: string;
}

export interface WhereUsedInput {
  client: string;
  materialNumber: string;
  plant: string;
  keyDate?: string;
  depth?: 'SINGLE' | 'MULTI';
  /** Every plant the signed-in user's Plant scope reaches, instead of the one plant. */
  allScopedPlants?: boolean;
}

export interface ExplosionRow {
  level: number;
  path: string;
  materialNumber: string | null;
  materialName: string | null;
  itemNumber: string;
  itemCategory: string;
  /** The item quantity per the parent BOM's base quantity, in the item unit. */
  quantity: string | null;
  unit: string | null;
  /** What the requested parent quantity needs, in the component's base unit. */
  requiredQuantity: string | null;
  requiredUnit: string | null;
  scrapPercent: string | null;
  isPhantom: boolean;
  isBulk: boolean;
  isCoProduct: boolean;
  isFixed: boolean;
  issuingPlant: string | null;
  followUpMaterial: string | null;
  itemText: string | null;
  /** The BOM this row's own components came from, when it was exploded. */
  explodedBom: string | null;
  diagnostics: ExplosionDiagnostic[];
}

export interface ResolvedBom {
  materialNumber: string;
  plant: string;
  usage: string;
  alternative: string;
  bomNumber: string | null;
  status: string | null;
  baseQuantity: string;
  baseUnit: string;
  validFrom: string;
  validTo: string;
  /** The production version that chose it, or null when the BOM was named. */
  productionVersion: string | null;
}

export interface ExplosionView {
  materialNumber: string;
  materialName: string | null;
  plant: string;
  keyDate: string;
  depth: 'SINGLE' | 'MULTI';
  /** The parent quantity exploded, in its base unit. */
  quantity: string;
  quantityWasDefaulted: boolean;
  bom: ResolvedBom;
  rows: ExplosionRow[];
  maxLevel: number;
  diagnostics: ExplosionDiagnostic[];
}

export interface WhereUsedRow {
  level: number;
  path: string;
  /** The component traced at this level. */
  componentMaterial: string;
  parentMaterial: string;
  parentName: string | null;
  plant: string;
  usage: string;
  alternative: string;
  itemNumber: string;
  itemCategory: string;
  /** The component quantity per the parent BOM's base quantity — a BOM quantity, not a requirement. */
  quantity: string;
  unit: string;
  baseQuantity: string;
  baseUnit: string;
  scrapPercent: string | null;
  isPhantom: boolean;
  isBulk: boolean;
  isCoProduct: boolean;
  isFixed: boolean;
  diagnostics: ExplosionDiagnostic[];
}

export interface WhereUsedView {
  materialNumber: string;
  materialName: string | null;
  plants: string[];
  keyDate: string;
  depth: 'SINGLE' | 'MULTI';
  rows: WhereUsedRow[];
  maxLevel: number;
  /** Set when the material is used in no BOM: an honest empty answer, not an error. */
  note: string | null;
}

// ── Shared checks ───────────────────────────────────────────────────────────

function keyDateOf(value: string | undefined): string {
  const date = (value ?? '').trim() || new Date().toISOString().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const probe = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !probe || probe.toISOString().slice(0, 10) !== date) fail(`Key date ${date} is not a calendar date.`, 'Enter the date as YYYY-MM-DD.');
  return date;
}

async function judge(tx: Tx, client: string, authorization: ServiceAuthorityContext | undefined, plants: string[]): Promise<void> {
  const verdict = await verifyServiceAuthorityInTx(tx, client, authorization, BOM_EXPLOSION_CAPABILITY, { requirePlantScope: true });
  if (!verdict.ok) {
    fail(verdict.refusal.message.startsWith('You do not hold the authority') ? `You do not hold ${BOM_EXPLOSION_CAPABILITY}.` : verdict.refusal.message, verdict.refusal.remedy);
  }
  for (const plant of plants) {
    if (!hasOrgAccess(verdict.restrictions, 'PLANT', plant)) fail(`Your Plant scope does not cover plant ${plant}.`, 'Ask an administrator to extend your Plant scope, then repeat the report.');
  }
}

async function scopedPlants(tx: Tx, client: string, authorization: ServiceAuthorityContext | undefined): Promise<string[]> {
  const verdict = await verifyServiceAuthorityInTx(tx, client, authorization, BOM_EXPLOSION_CAPABILITY, { requirePlantScope: true });
  if (!verdict.ok) fail(verdict.refusal.message, verdict.refusal.remedy);
  const all = (await rows(tx, sql`select plant from plant where client = ${client} order by plant`)).map((r) => String(r.plant).trim());
  return all.filter((p) => hasOrgAccess(verdict.restrictions, 'PLANT', p));
}

async function materialHead(tx: Tx, client: string, materialNumber: string) {
  const [row] = await rows(tx, sql`select material_number, description, base_unit from material where client = ${client} and material_number = ${materialNumber}`);
  if (!row) fail(`Material ${materialNumber} does not stand.`, 'Choose a material from the material master (/inventory/materials).');
  return { name: text(row.description), baseUnit: String(row.base_unit ?? '') };
}

async function procurementType(tx: Tx, client: string, materialNumber: string, plant: string): Promise<string | null | undefined> {
  const [row] = await rows(tx, sql`select procurement_type from material_plant where client = ${client} and material_number = ${materialNumber} and plant = ${plant}`);
  return row ? text(row.procurement_type) : undefined;
}

const names = new Map<string, string | null>();
async function nameOf(tx: Tx, client: string, materialNumber: string): Promise<string | null> {
  const key = `${client}/${materialNumber}`;
  if (!names.has(key)) {
    const [row] = await rows(tx, sql`select description from material where client = ${client} and material_number = ${materialNumber}`);
    names.set(key, row ? text(row.description) : null);
    if (names.size > 5000) names.clear();
  }
  return names.get(key)!;
}

async function bomHeader(tx: Tx, client: string, key: { materialNumber: string; plant: string; usage: string; alternative: string }) {
  const [row] = await rows(tx, sql`
    select material_number, plant, usage, alternative, bom_number, status, base_quantity::text as base_quantity, base_unit,
           valid_from::text as valid_from, valid_to::text as valid_to, deletion_flag
      from material_bom
     where client = ${client} and material_number = ${key.materialNumber} and plant = ${key.plant}
       and usage = ${key.usage} and alternative = ${key.alternative}`);
  return row ?? null;
}

async function bomItems(tx: Tx, client: string, bom: ResolvedBom, keyDate: string): Promise<Row[]> {
  return rows(tx, sql`
    select i.item_number, i.item_category, i.component_material, i.quantity::text as quantity, i.unit,
           i.scrap_percent::text as scrap_percent, i.fixed_quantity, i.bulk_material, i.phantom, i.coproduct,
           i.follow_up_material, i.issuing_plant, i.special_procurement, i.item_text,
           c.material_entry
      from material_bom_item i
      left join bom_item_category c on c.client = i.client and c.category = i.item_category
     where i.client = ${client} and i.material_number = ${bom.materialNumber} and i.plant = ${bom.plant}
       and i.usage = ${bom.usage} and i.alternative = ${bom.alternative}
       and i.deletion_flag <> 'X'
       and i.valid_from <= ${keyDate}::date and i.valid_to >= ${keyDate}::date
     order by i.item_number`);
}

function resolvedOf(row: Row, productionVersion: string | null): ResolvedBom {
  return {
    materialNumber: String(row.material_number), plant: String(row.plant), usage: String(row.usage), alternative: String(row.alternative),
    bomNumber: text(row.bom_number), status: text(row.status), baseQuantity: shown(scaled(row.base_quantity)), baseUnit: String(row.base_unit ?? ''),
    validFrom: String(row.valid_from), validTo: String(row.valid_to), productionVersion,
  };
}

/**
 * The BOM a material explodes with on the key date: through its production version (as MRP), or the
 * one named. Throws a ProductionVersionError when the version path finds nothing.
 */
async function resolveBom(tx: Tx, client: string, materialNumber: string, plant: string, keyDate: string, quantity: string, unit: string, productionVersion?: string): Promise<ResolvedBom> {
  const version = await selectProductionVersion(client, {
    materialNumber, plant, keyDate, quantity, unit, productionVersion: productionVersion || null, context: 'PLANNING',
  }, tx);
  const header = await bomHeader(tx, client, { materialNumber, plant, usage: version.bomUsage, alternative: version.bomAlternative });
  if (!header) fail(`Production version ${version.productionVersion} of ${materialNumber} names BOM ${version.bomUsage}/${version.bomAlternative}, which does not stand.`, 'Correct the production version at /production/production-versions.');
  return resolvedOf(header, version.productionVersion);
}

function checkHeader(bom: ResolvedBom, header: Row, keyDate: string): void {
  if (flag(header.deletion_flag)) fail(`BOM ${bom.usage}/${bom.alternative} of ${bom.materialNumber} in plant ${bom.plant} is marked for deletion.`, 'Choose another alternative, or restore the BOM at /production/boms.');
  if (bom.validFrom > keyDate || bom.validTo < keyDate) {
    fail(`BOM ${bom.usage}/${bom.alternative} of ${bom.materialNumber} in plant ${bom.plant} is valid ${bom.validFrom} to ${bom.validTo}, not on ${keyDate}.`, 'Choose a key date inside the BOM\'s validity, or another alternative.');
  }
}

// ── The downward walk (CS11 / CS12) ─────────────────────────────────────────

/** The multi-level structure of one material, downwards, as MRP would plan it. */
export async function explodeBom(input: ExplodeBomInput, options: Authority = {}): Promise<ExplosionView> {
  const materialNumber = String(input.materialNumber ?? '').trim().toUpperCase();
  const plant = String(input.plant ?? '').trim().toUpperCase();
  const keyDate = keyDateOf(input.keyDate);
  const depth = input.depth === 'SINGLE' ? 'SINGLE' : 'MULTI';
  const usage = (input.usage ?? '').trim();
  const alternative = (input.alternative ?? '').trim();
  if ((usage === '') !== (alternative === '')) fail('Name a BOM by its usage and its alternative together, or neither.', 'Fill both, or clear both to use the production version.');
  let requested: bigint | null = null;
  if ((input.quantity ?? '').trim()) {
    try {
      requested = toScaled(input.quantity!.trim(), SCALE);
    } catch {
      fail(`Quantity ${input.quantity} is not a number.`, 'Enter a positive quantity in the material\'s base unit.');
    }
    if (requested <= 0n) fail(`Quantity ${input.quantity} is not positive.`, 'Enter a positive quantity in the material\'s base unit.');
  }

  return withTenant(input.client, async (tx) => {
    await judge(tx, input.client, options.authorization, [plant]);
    const head = await materialHead(tx, input.client, materialNumber);
    if ((await procurementType(tx, input.client, materialNumber, plant)) === undefined) {
      fail(`Material ${materialNumber} is not maintained in plant ${plant}.`, 'Choose a plant the material is extended to (MM01 plant view).');
    }

    // Which BOM: the named one, else the production version's, resolved with quantity 1 before the
    // BOM — and so its base quantity — is known.
    let bom: ResolvedBom;
    if (usage) {
      const header = await bomHeader(tx, input.client, { materialNumber, plant, usage, alternative });
      if (!header) fail(`BOM ${usage}/${alternative} of ${materialNumber} does not stand in plant ${plant}.`, 'Choose a usage and alternative that stand (/production/bom-display).');
      bom = resolvedOf(header, null);
      checkHeader(bom, header, keyDate);
    } else {
      try {
        bom = await resolveBom(tx, input.client, materialNumber, plant, keyDate, requested !== null ? shown(requested) : '1', head.baseUnit, input.productionVersion);
      } catch (error) {
        if (error instanceof ProductionVersionError) {
          const named = (input.productionVersion ?? '').trim();
          fail(
            named
              ? `Production version ${named} of ${materialNumber} does not select a BOM on ${keyDate}: ${error.message}`
              : `No BOM resolves for ${materialNumber} in plant ${plant} on ${keyDate}: ${error.message}`,
            `${error.remedy ? `${error.remedy} ` : ''}Maintain the production version at /production/production-versions, or name a BOM usage and alternative.`,
          );
        }
        throw error;
      }
      checkHeader(bom, (await bomHeader(tx, input.client, bom))!, keyDate);
    }
    const quantity = requested ?? scaled(bom.baseQuantity);

    const out: ExplosionRow[] = [];
    const all: ExplosionDiagnostic[] = [];
    await walk(tx, input.client, { bom, quantity, level: 1, path: materialNumber, keyDate, plant, multi: depth === 'MULTI' }, out, all);
    return {
      materialNumber, materialName: head.name, plant, keyDate, depth, quantity: shown(quantity), quantityWasDefaulted: requested === null,
      bom, rows: out, maxLevel: out.reduce((m, r) => Math.max(m, r.level), 0), diagnostics: all,
    };
  });
}

interface WalkFrame {
  bom: ResolvedBom;
  /** The parent quantity, in its base unit. */
  quantity: bigint;
  /** The level of the rows this frame emits. */
  level: number;
  path: string;
  keyDate: string;
  plant: string;
  multi: boolean;
}

async function walk(tx: Tx, client: string, frame: WalkFrame, out: ExplosionRow[], all: ExplosionDiagnostic[]): Promise<void> {
  const items = await bomItems(tx, client, frame.bom, frame.keyDate);
  for (const item of items) {
    const diagnostics: ExplosionDiagnostic[] = [];
    const note = (severity: ExplosionDiagnostic['severity'], code: string, message: string) => {
      const d = { severity, code, message };
      diagnostics.push(d);
      all.push(d);
    };
    const itemNumber = String(item.item_number);
    const component = text(item.component_material);
    const isText = String(item.material_entry ?? '').trim() === '-' || !component;
    const row: ExplosionRow = {
      level: frame.level,
      path: component ? `${frame.path}/${component}` : `${frame.path}/#${itemNumber}`,
      materialNumber: isText ? null : component,
      materialName: isText || !component ? null : await nameOf(tx, client, component),
      itemNumber,
      itemCategory: String(item.item_category ?? '').trim(),
      quantity: item.quantity == null ? null : shown(scaled(item.quantity)),
      unit: text(item.unit),
      requiredQuantity: null,
      requiredUnit: null,
      scrapPercent: text(item.scrap_percent),
      isPhantom: flag(item.phantom),
      isBulk: flag(item.bulk_material),
      isCoProduct: flag(item.coproduct),
      isFixed: flag(item.fixed_quantity),
      issuingPlant: text(item.issuing_plant),
      followUpMaterial: text(item.follow_up_material),
      itemText: text(item.item_text),
      explodedBom: null,
      diagnostics,
    };
    out.push(row);

    if (isText) {
      note('INFO', 'TEXT_ITEM', `Item ${itemNumber} is a text item${row.itemText ? `: ${row.itemText}` : ''}. It names no material.`);
      continue;
    }
    // The quantity, as MRP computes it: item unit first, then the component base unit.
    const raw = componentRequirementQuantity({
      parentQuantity: frame.quantity,
      itemQuantity: scaled(item.quantity),
      baseQuantity: scaled(frame.bom.baseQuantity),
      scrapPercent: item.scrap_percent == null ? null : String(item.scrap_percent),
      fixed: row.isFixed,
    });
    if (row.isCoProduct) note('INFO', 'COPRODUCT', `Item ${itemNumber} is a co-product (an output, not a component demand); no requirement is computed.`);
    else if (raw == null) note('WARNING', 'COMPONENT_QUANTITY', `Item ${itemNumber} has no positive quantity; no requirement is computed.`);
    let required: bigint | null = null;
    if (raw != null && !row.isCoProduct) {
      try {
        const converted = await toBaseQuantity(tx, client, { materialNumber: component!, quantity: Number(shown(raw)), entryUnit: row.unit ?? '' });
        required = scaled(converted.baseQuantity);
        row.requiredQuantity = shown(required);
        row.requiredUnit = converted.baseUnit;
        if (required <= 0n) {
          note('WARNING', 'COMPONENT_QUANTITY', `Item ${itemNumber} rounded to zero in the base unit.`);
          required = null;
        }
      } catch (error) {
        const message = error instanceof UnitConversionError ? error.message : 'The component unit could not be converted.';
        note('WARNING', 'UNIT', message.slice(0, 200));
        row.requiredQuantity = shown(raw);
        row.requiredUnit = row.unit;
        required = null;
      }
    }

    // What MRP would not plan, said on the row.
    if (row.isBulk) note('INFO', 'BULK_NOT_PLANNED', `Item ${itemNumber} is bulk. MRP does not plan it.`);
    if (row.issuingPlant && row.issuingPlant !== frame.plant) note('INFO', 'ISSUING_PLANT', `Item ${itemNumber} issues from plant ${row.issuingPlant}. A stock transfer is not planned; the walk stays in plant ${frame.plant}.`);
    const special = text(item.special_procurement);
    if (special) note('INFO', 'SPECIAL_PROCUREMENT', `Item ${itemNumber} has special procurement ${special}. MRP does not redirect it.`);
    if (row.followUpMaterial) note('INFO', 'FOLLOW_UP_NOT_APPLIED', `Item ${itemNumber} names follow-up material ${row.followUpMaterial}. The stored component is shown.`);

    if (!frame.multi) continue;
    // Recursion: the same rules MRP applies.
    const plannedHere = !row.isCoProduct && !row.isBulk && !(row.issuingPlant && row.issuingPlant !== frame.plant) && !special;
    if (!plannedHere) continue;
    if (frame.path.split('/').includes(component!)) {
      note('WARNING', 'BOM_CYCLE', `${component} is already on this explosion (${row.path}). The branch stopped.`);
      continue;
    }
    if (required == null) {
      note('WARNING', 'NOT_EXPLODED', `${component} was not exploded: its quantity could not be computed.`);
      continue;
    }
    if (frame.level >= DEPTH_LIMIT) {
      note('WARNING', 'DEPTH_LIMIT', `${component} is below the explosion depth (${DEPTH_LIMIT}). The branch stopped.`);
      continue;
    }
    if (row.isPhantom) {
      note('INFO', 'PHANTOM', `${component} is a phantom: passed through — not planned as an assembly; its components are planned against the parent.`);
    } else {
      const type = await procurementType(tx, client, component!, frame.plant);
      if (type === 'BUY') {
        note('INFO', 'BUY_NOT_EXPLODED', `${component} is bought. It was not exploded.`);
        continue;
      }
      if (type !== 'MAKE') {
        note('INFO', 'NOT_MAKE', `${component} has procurement type ${type ?? 'none'} in plant ${frame.plant}, not MAKE; MRP does not explode it. The branch ends here.`);
        continue;
      }
    }
    let child: ResolvedBom;
    try {
      child = await resolveBom(tx, client, component!, frame.plant, frame.keyDate, shown(required), row.requiredUnit ?? '');
    } catch (error) {
      if (error instanceof ProductionVersionError || error instanceof BomExplosionError) {
        note('WARNING', error instanceof ProductionVersionError ? error.code : 'NO_BOM', error.message.slice(0, 200));
        continue;
      }
      throw error;
    }
    const header = await bomHeader(tx, client, child);
    if (!header || flag(header.deletion_flag) || child.validFrom > frame.keyDate || child.validTo < frame.keyDate) {
      note('WARNING', 'BOM_NOT_VALID', `BOM ${child.usage}/${child.alternative} of ${component} is not valid on ${frame.keyDate}. The branch stopped.`);
      continue;
    }
    row.explodedBom = `${child.usage}/${child.alternative}${child.productionVersion ? ` (version ${child.productionVersion})` : ''}`;
    await walk(tx, client, { ...frame, bom: child, quantity: required, level: frame.level + 1, path: row.path }, out, all);
  }
}

// ── The upward walk (CS15) ──────────────────────────────────────────────────

/** Every BOM that contains one material, upwards; BOM quantities, never requirements. */
export async function whereUsedBom(input: WhereUsedInput, options: Authority = {}): Promise<WhereUsedView> {
  const materialNumber = String(input.materialNumber ?? '').trim().toUpperCase();
  const plant = String(input.plant ?? '').trim().toUpperCase();
  const keyDate = keyDateOf(input.keyDate);
  const depth = input.depth === 'SINGLE' ? 'SINGLE' : 'MULTI';
  return withTenant(input.client, async (tx) => {
    let plants: string[];
    if (input.allScopedPlants) {
      plants = await scopedPlants(tx, input.client, options.authorization);
      if (plants.length === 0) fail('Your Plant scope covers no plant.', 'Ask an administrator for a Plant scope.');
    } else {
      await judge(tx, input.client, options.authorization, [plant]);
      plants = [plant];
    }
    const head = await materialHead(tx, input.client, materialNumber);
    const out: WhereUsedRow[] = [];
    const up = async (component: string, level: number, path: string[]): Promise<void> => {
      const hits = await rows(tx, sql`
        select i.material_number as parent, i.plant, i.usage, i.alternative, i.item_number, i.item_category,
               i.quantity::text as quantity, i.unit, i.scrap_percent::text as scrap_percent, i.fixed_quantity,
               i.bulk_material, i.phantom, i.coproduct, h.base_quantity::text as base_quantity, h.base_unit
          from material_bom_item i
          join material_bom h on h.client = i.client and h.material_number = i.material_number and h.plant = i.plant
                             and h.usage = i.usage and h.alternative = i.alternative
         where i.client = ${input.client} and i.component_material = ${component}
           and i.plant in (${sql.join(plants.map((p) => sql`${p}`), sql`, `)})
           and i.deletion_flag <> 'X' and i.valid_from <= ${keyDate}::date and i.valid_to >= ${keyDate}::date
           and h.deletion_flag <> 'X' and h.valid_from <= ${keyDate}::date and h.valid_to >= ${keyDate}::date
         order by i.plant, i.material_number, i.usage, i.alternative, i.item_number`);
      const parents: Array<{ parent: string }> = [];
      for (const hit of hits) {
        const parent = String(hit.parent);
        const diagnostics: ExplosionDiagnostic[] = [];
        const row: WhereUsedRow = {
          level, path: [...path, parent].join('/'), componentMaterial: component, parentMaterial: parent,
          parentName: await nameOf(tx, input.client, parent), plant: String(hit.plant), usage: String(hit.usage),
          alternative: String(hit.alternative), itemNumber: String(hit.item_number), itemCategory: String(hit.item_category ?? '').trim(),
          quantity: shown(scaled(hit.quantity)), unit: String(hit.unit ?? ''), baseQuantity: shown(scaled(hit.base_quantity)),
          baseUnit: String(hit.base_unit ?? ''), scrapPercent: text(hit.scrap_percent), isPhantom: flag(hit.phantom),
          isBulk: flag(hit.bulk_material), isCoProduct: flag(hit.coproduct), isFixed: flag(hit.fixed_quantity), diagnostics,
        };
        out.push(row);
        if (depth === 'SINGLE') continue;
        if (path.includes(parent)) {
          diagnostics.push({ severity: 'WARNING', code: 'BOM_CYCLE', message: `${parent} is already on this where-used path (${row.path}). The branch stopped.` });
          continue;
        }
        if (level >= DEPTH_LIMIT) {
          diagnostics.push({ severity: 'WARNING', code: 'DEPTH_LIMIT', message: `${parent} is above the where-used depth (${DEPTH_LIMIT}). The branch stopped.` });
          continue;
        }
        if (!parents.some((p) => p.parent === parent)) parents.push({ parent });
      }
      for (const { parent } of parents) await up(parent, level + 1, [...path, parent]);
    };
    await up(materialNumber, 1, [materialNumber]);
    return {
      materialNumber, materialName: head.name, plants, keyDate, depth, rows: out,
      maxLevel: out.reduce((m, r) => Math.max(m, r.level), 0),
      note: out.length === 0 ? `${materialNumber} is used in no BOM valid on ${keyDate} in plant${plants.length > 1 ? 's' : ''} ${plants.join(', ')}.` : null,
    };
  });
}
