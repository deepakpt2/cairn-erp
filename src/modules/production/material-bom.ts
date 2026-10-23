/**
 * Material BOM — CS01 create, CS02 change, CS03 display.
 *
 * The key is material, plant, usage, and alternative. Usage, status, and item
 * category are tenant customizing. None is delivered. Engineering change
 * management does not stand, so a change number is refused and validity is the
 * from and to dates. A blank valid-to is stored as 9999-12-31.
 *
 * Plant, material, and unit lengths are this system's masters, not CHAR 4,
 * CHAR 18, or UNIT 3. There is no group BOM. A recursive structure is warned
 * and saved; it is not a hard error. Formulas are not this screen. Saving does
 * not explode the BOM, post a cost, or rewrite a production order.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { unitOfMeasure } from '../../platform/tables/reference';
import { markActivityComplete } from '../../platform/tenancy';
import { plant as plantTable } from '../foundation/schema';
import { material, materialPlant, productionOrder } from '../inventory/schema';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import {
  bomItemCategory,
  bomStatus,
  bomUsage,
  materialBom,
  materialBomItem,
} from './schema';

export const BOM_ACTIVITY = 'CFG.PROD.BOM.DEFINE';
export const BOM_CREATE_CAPABILITY = 'PROD.BOM.CREATE';
export const BOM_CHANGE_CAPABILITY = 'PROD.BOM.CHANGE';
export const BOM_DISPLAY_CAPABILITY = 'PROD.BOM.DISPLAY';
export const BOM_ROUTE = '/production/boms';
export const BOM_DISPLAY_ROUTE = '/production/bom-display';
export const BOM_LOCK = 'MATERIAL_BOM';
export const BOM_OBJECT = 'material_bom';
const OPEN_ENDED = '9999-12-31';

export class MaterialBomError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'MaterialBomError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new MaterialBomError(message, remedy);
}

export function bomCapability(mode: 'CREATE' | 'CHANGE' | 'DISPLAY'): string {
  if (mode === 'CREATE') return BOM_CREATE_CAPABILITY;
  if (mode === 'CHANGE') return BOM_CHANGE_CAPABILITY;
  return BOM_DISPLAY_CAPABILITY;
}

export function holdsMaterialBomAuthority(held: readonly string[], mode: 'CREATE' | 'CHANGE' | 'DISPLAY'): boolean {
  return hasCapability([...held], bomCapability(mode));
}

export interface MaterialBomItemInput {
  itemNumber?: string | null;
  itemCategory: string;
  componentMaterial?: string | null;
  quantity?: string | null;
  unit?: string | null;
  scrapPercent?: string | null;
  sortString?: string | null;
  itemText?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  fixedQuantity?: string | null;
  bulkMaterial?: string | null;
  phantom?: string | null;
  coproduct?: string | null;
  followUpMaterial?: string | null;
  specialProcurement?: string | null;
  issuingPlant?: string | null;
  deletionFlag?: string | null;
}

export interface MaterialBomInput {
  client: string;
  changedBy: string;
  materialNumber: string;
  plant: string;
  usage: string;
  alternative?: string | null;
  status?: string | null;
  baseQuantity: string;
  baseUnit: string;
  validFrom: string;
  validTo?: string | null;
  headerText?: string | null;
  deletionFlag?: string | null;
  changeNumber?: string | null;
  items?: MaterialBomItemInput[];
  version?: number;
  requestKey?: string | null;
  copyFrom?: { materialNumber: string; plant: string; usage: string; alternative: string; copyItems?: boolean } | null;
}

export interface MaterialBomItemView {
  itemNumber: string;
  itemCategory: string;
  itemCategoryDescription: string;
  componentMaterial: string | null;
  componentDescription: string | null;
  quantity: string | null;
  unit: string | null;
  scrapPercent: string | null;
  sortString: string | null;
  itemText: string | null;
  validFrom: string;
  validTo: string;
  fixedQuantity: 'X' | ' ';
  bulkMaterial: 'X' | ' ';
  phantom: 'X' | ' ';
  coproduct: 'X' | ' ';
  followUpMaterial: string | null;
  specialProcurement: string | null;
  issuingPlant: string | null;
  deletionFlag: 'X' | ' ';
  effective: boolean;
}

export interface MaterialBomView {
  materialNumber: string;
  materialDescription: string;
  plant: string;
  plantName: string;
  usage: string;
  usageDescription: string;
  alternative: string;
  bomNumber: string;
  status: string | null;
  statusDescription: string | null;
  releasedForMrp: 'X' | ' ';
  releasedForCosting: 'X' | ' ';
  releasedForOrders: 'X' | ' ';
  baseQuantity: string;
  baseUnit: string;
  validFrom: string;
  validTo: string;
  headerText: string | null;
  deletionFlag: 'X' | ' ';
  version: number;
  requestKey: string | null;
  items: MaterialBomItemView[];
  warnings: string[];
  effective: boolean;
  unchangedProductionOrders: number;
}

export interface BomUsageInput {
  client: string;
  changedBy: string;
  usage: string;
  description: string;
  productionRelevance: string;
  engineeringRelevance: string;
  costingRelevance: string;
  salesRelevance: string;
  version?: number;
}

export interface BomStatusInput {
  client: string;
  changedBy: string;
  status: string;
  description: string;
  releasedForMrp?: string | null;
  releasedForCosting?: string | null;
  releasedForOrders?: string | null;
  version?: number;
}

export interface BomItemCategoryInput {
  client: string;
  changedBy: string;
  category: string;
  description: string;
  materialEntry: string;
  quantityEntry: string;
  allowFixedQuantity?: string | null;
  allowBulk?: string | null;
  allowPhantom?: string | null;
  allowCoproduct?: string | null;
  allowFollowUp?: string | null;
  allowSpecialProcurement?: string | null;
  allowNegativeQuantity?: string | null;
  version?: number;
}

function dateOf(value: string, label: string): string {
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${label} is not a calendar date.`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) fail(`${label} is not a calendar date.`);
  return text;
}

function flag(value: string | null | undefined, label: string): 'X' | ' ' {
  const text = (value ?? '').trim().toUpperCase();
  if (text === '' || text === ' ') return ' ';
  if (text === 'X') return 'X';
  fail(`${label} must be X or blank. It was not stored.`);
}

function entryOf(value: string, label: string): '+' | '.' | '-' {
  const text = value.trim();
  if (text === '+' || text === '.' || text === '-') return text;
  fail(`${label} must be +, ., or -. Nothing was saved.`);
}

function textOf(value: string | null | undefined, label: string, max: number): string | null {
  if (value == null) return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) fail(`${label} is longer than ${max} characters. It was not truncated.`);
  return text;
}

function descriptionOf(value: string, label: string): string {
  const text = textOf(value, label, 40);
  if (!text) fail(`${label} is required.`);
  return text;
}

function usageKey(value: string): string {
  const text = value.trim().toUpperCase();
  if (!/^[A-Z0-9]$/.test(text)) fail(`BOM usage ${value || '(blank)'} must be one letter or digit.`);
  return text;
}

function statusKey(value: string): string {
  const text = value.trim();
  if (!/^[0-9]{1,2}$/.test(text)) fail(`BOM status ${value} is not a one- or two-digit status.`);
  return text.padStart(2, '0');
}

function categoryKey(value: string): string {
  const text = value.trim().toUpperCase();
  if (!/^[A-Z0-9]$/.test(text)) fail(`Item category ${value || '(blank)'} must be one letter or digit.`);
  return text;
}

function alternativeKey(value: string): string {
  const text = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,2}$/.test(text)) fail(`Alternative ${value} must be one or two letters or digits.`);
  return /^[0-9]$/.test(text) ? text.padStart(2, '0') : text;
}

function itemNumberOf(value: string): string {
  const text = value.trim().toUpperCase();
  if (/^[0-9]{1,4}$/.test(text)) {
    if (Number(text) === 0) fail('Item number 0 is not used.');
    return text.padStart(4, '0');
  }
  if (!/^[A-Z0-9]{4}$/.test(text)) fail(`Item number ${value} must be four characters, or a number up to 9999.`);
  return text;
}

function quantityOf(value: string, label: string, decimals: number, allowNegative: boolean): string {
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) fail(`${label} ${value} is not a quantity. It was not rounded.`);
  const fraction = text.split('.')[1] ?? '';
  if (fraction.length > Math.min(3, decimals)) fail(`${label} has more decimal places than the unit allows. It was not rounded.`);
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount === 0) fail(`${label} must not be zero.`);
  if (amount < 0 && !allowNegative) fail(`${label} must be positive. A negative quantity was not stored.`);
  return text;
}

function scrapOf(value: string): string {
  const text = value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) fail(`Component scrap ${value} is not a percentage. It was not clamped.`);
  if ((text.split('.')[1] ?? '').length > 2) fail('Component scrap has more than two decimal places. It was not rounded.');
  if (Number(text) > 999.99) fail('Component scrap is above 999.99. It was not clamped.');
  return text;
}

async function decimalsOf(tx: Tx, code: string): Promise<number> {
  const [row] = await tx.select({ decimalPlaces: unitOfMeasure.decimalPlaces }).from(unitOfMeasure).where(eq(unitOfMeasure.code, code));
  if (!row) fail(`Unit of measure ${code} does not exist.`);
  return row.decimalPlaces;
}

async function proveUnit(tx: Tx, client: string, materialNumber: string, unit: string): Promise<void> {
  try {
    await toBaseQuantity(tx, client, { materialNumber, quantity: 1, entryUnit: unit });
  } catch (error) {
    if (error instanceof UnitConversionError) fail(error.message, error.remedy);
    throw error;
  }
}

async function materialRow(tx: Tx, client: string, materialNumber: string) {
  const [row] = await tx.select({
    materialNumber: material.materialNumber,
    description: material.description,
    baseUnit: material.baseUnit,
    isBlocked: material.isBlocked,
    markedForDeletion: material.markedForDeletion,
  }).from(material).where(and(eq(material.client, client), eq(material.materialNumber, materialNumber)));
  return row ?? null;
}

function assertUsableMaterial(row: { materialNumber: string; isBlocked: boolean; markedForDeletion: boolean } | null, materialNumber: string): asserts row {
  if (!row) fail(`Material ${materialNumber} does not exist. It was not substituted.`);
  if (row.isBlocked) fail(`Material ${materialNumber} is blocked. It was not substituted.`);
  if (row.markedForDeletion) fail(`Material ${materialNumber} is marked for deletion. It was not substituted.`);
}

async function assertExtended(tx: Tx, client: string, materialNumber: string, plant: string): Promise<void> {
  const [row] = await tx.select({ materialNumber: materialPlant.materialNumber }).from(materialPlant).where(and(
    eq(materialPlant.client, client),
    eq(materialPlant.materialNumber, materialNumber),
    eq(materialPlant.plant, plant),
  ));
  if (!row) fail(`Material ${materialNumber} is not extended to plant ${plant}.`);
}

function effectiveOn(from: string, to: string, deletion: string, keyDate: string | null): boolean {
  if (deletion === 'X') return false;
  if (!keyDate) return true;
  return keyDate >= from && keyDate <= to;
}

async function cycleWarning(
  tx: Tx,
  client: string,
  plant: string,
  usage: string,
  materialNumber: string,
  alternative: string,
  validFrom: string,
  items: Array<{ componentMaterial: string | null; deletionFlag: string }>,
): Promise<string | null> {
  const links = await tx.select({
    parent: materialBom.materialNumber,
    alternative: materialBom.alternative,
    validFrom: materialBom.validFrom,
    validTo: materialBom.validTo,
    headerDeletion: materialBom.deletionFlag,
    component: materialBomItem.componentMaterial,
    itemDeletion: materialBomItem.deletionFlag,
  }).from(materialBomItem).innerJoin(materialBom, and(
    eq(materialBomItem.client, materialBom.client),
    eq(materialBomItem.materialNumber, materialBom.materialNumber),
    eq(materialBomItem.plant, materialBom.plant),
    eq(materialBomItem.usage, materialBom.usage),
    eq(materialBomItem.alternative, materialBom.alternative),
  )).where(and(
    eq(materialBom.client, client),
    eq(materialBom.plant, plant),
    eq(materialBom.usage, usage),
  ));
  const graph = new Map<string, Set<string>>();
  const add = (parent: string, component: string) => {
    const next = graph.get(parent) ?? new Set<string>();
    next.add(component);
    graph.set(parent, next);
  };
  for (const link of links) {
    if (link.parent === materialNumber && link.alternative === alternative) continue;
    if (!link.component || link.itemDeletion === 'X' || link.headerDeletion === 'X') continue;
    if (validFrom < link.validFrom || validFrom > link.validTo) continue;
    add(link.parent, link.component);
  }
  for (const item of items) {
    if (item.deletionFlag === 'X' || !item.componentMaterial) continue;
    add(materialNumber, item.componentMaterial);
  }
  const stack = new Set<string>();
  const seen = new Set<string>();
  const walk = (node: string): boolean => {
    if (stack.has(node)) return node === materialNumber || stack.has(materialNumber);
    if (seen.has(node)) return false;
    seen.add(node);
    stack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (next === materialNumber || walk(next)) return true;
    }
    stack.delete(node);
    return false;
  };
  if (!walk(materialNumber)) return null;
  return `The component structure of material ${materialNumber} in plant ${plant} and usage ${usage} is circular. The save was kept. A recursive BOM is a warning, not a hard error. No explosion was run.`;
}

async function readInTx(
  tx: Tx,
  client: string,
  materialNumber: string,
  plant: string,
  usage: string,
  alternative: string,
  keyDate: string | null,
): Promise<MaterialBomView | null> {
  const [header] = await tx.select().from(materialBom).where(and(
    eq(materialBom.client, client),
    eq(materialBom.materialNumber, materialNumber),
    eq(materialBom.plant, plant),
    eq(materialBom.usage, usage),
    eq(materialBom.alternative, alternative),
  ));
  if (!header) return null;
  const [usageRow] = await tx.select().from(bomUsage).where(and(eq(bomUsage.client, client), eq(bomUsage.usage, usage)));
  const [statusRow] = header.status
    ? await tx.select().from(bomStatus).where(and(eq(bomStatus.client, client), eq(bomStatus.status, header.status)))
    : [undefined];
  const [plantRow] = await tx.select({ name: plantTable.name }).from(plantTable).where(and(
    eq(plantTable.client, client), eq(plantTable.plant, plant),
  ));
  const [headerMaterial] = await tx.select({ description: material.description }).from(material).where(and(
    eq(material.client, client), eq(material.materialNumber, materialNumber),
  ));
  const itemRows = await tx.select().from(materialBomItem).where(and(
    eq(materialBomItem.client, client),
    eq(materialBomItem.materialNumber, materialNumber),
    eq(materialBomItem.plant, plant),
    eq(materialBomItem.usage, usage),
    eq(materialBomItem.alternative, alternative),
  )).orderBy(asc(materialBomItem.sortString), asc(materialBomItem.itemNumber));
  const componentNumbers = [...new Set(itemRows.flatMap((row) => [row.componentMaterial, row.followUpMaterial].filter((value): value is string => Boolean(value))))];
  const componentRows = componentNumbers.length === 0 ? [] : await tx.select({
    materialNumber: material.materialNumber,
    description: material.description,
  }).from(material).where(and(eq(material.client, client), inArray(material.materialNumber, componentNumbers)));
  const descriptions = new Map(componentRows.map((row) => [row.materialNumber, row.description]));
  const categories = await tx.select().from(bomItemCategory).where(eq(bomItemCategory.client, client));
  const categoryNames = new Map(categories.map((row) => [row.category, row.description]));
  const [orderCount] = await tx.select({ n: sql<number>`count(*)::int` }).from(productionOrder).where(and(
    eq(productionOrder.client, client),
    eq(productionOrder.materialNumber, materialNumber),
    eq(productionOrder.plant, plant),
  ));
  const items: MaterialBomItemView[] = itemRows.map((row) => ({
    itemNumber: row.itemNumber,
    itemCategory: row.itemCategory,
    itemCategoryDescription: categoryNames.get(row.itemCategory) ?? '',
    componentMaterial: row.componentMaterial,
    componentDescription: row.componentMaterial ? descriptions.get(row.componentMaterial) ?? null : null,
    quantity: row.quantity,
    unit: row.unit,
    scrapPercent: row.scrapPercent,
    sortString: row.sortString,
    itemText: row.itemText,
    validFrom: row.validFrom,
    validTo: row.validTo,
    fixedQuantity: row.fixedQuantity === 'X' ? 'X' : ' ',
    bulkMaterial: row.bulkMaterial === 'X' ? 'X' : ' ',
    phantom: row.phantom === 'X' ? 'X' : ' ',
    coproduct: row.coproduct === 'X' ? 'X' : ' ',
    followUpMaterial: row.followUpMaterial,
    specialProcurement: row.specialProcurement,
    issuingPlant: row.issuingPlant,
    deletionFlag: row.deletionFlag === 'X' ? 'X' : ' ',
    effective: effectiveOn(row.validFrom, row.validTo, row.deletionFlag, keyDate),
  }));
  const warning = await cycleWarning(tx, client, plant, usage, materialNumber, alternative, header.validFrom, items);
  return {
    materialNumber,
    materialDescription: headerMaterial?.description ?? '',
    plant,
    plantName: plantRow?.name ?? '',
    usage,
    usageDescription: usageRow?.description ?? '',
    alternative,
    bomNumber: header.bomNumber,
    status: header.status,
    statusDescription: statusRow?.description ?? null,
    releasedForMrp: statusRow?.releasedForMrp === 'X' ? 'X' : ' ',
    releasedForCosting: statusRow?.releasedForCosting === 'X' ? 'X' : ' ',
    releasedForOrders: statusRow?.releasedForOrders === 'X' ? 'X' : ' ',
    baseQuantity: header.baseQuantity,
    baseUnit: header.baseUnit,
    validFrom: header.validFrom,
    validTo: header.validTo,
    headerText: header.headerText,
    deletionFlag: header.deletionFlag === 'X' ? 'X' : ' ',
    version: header.version,
    requestKey: header.requestKey,
    items,
    warnings: warning ? [warning] : [],
    effective: effectiveOn(header.validFrom, header.validTo, header.deletionFlag, keyDate),
    unchangedProductionOrders: orderCount?.n ?? 0,
  };
}

function snapshot(view: MaterialBomView): Record<string, unknown> {
  const flat: Record<string, unknown> = {
    status: view.status,
    baseQuantity: view.baseQuantity,
    baseUnit: view.baseUnit,
    validFrom: view.validFrom,
    validTo: view.validTo,
    headerText: view.headerText,
    deletionFlag: view.deletionFlag,
  };
  for (const item of view.items) {
    const prefix = `item.${item.itemNumber}`;
    flat[`${prefix}.category`] = item.itemCategory;
    flat[`${prefix}.component`] = item.componentMaterial;
    flat[`${prefix}.quantity`] = item.quantity;
    flat[`${prefix}.unit`] = item.unit;
    flat[`${prefix}.scrap`] = item.scrapPercent;
    flat[`${prefix}.text`] = item.itemText;
    flat[`${prefix}.validFrom`] = item.validFrom;
    flat[`${prefix}.validTo`] = item.validTo;
    flat[`${prefix}.deletion`] = item.deletionFlag;
  }
  return flat;
}

async function nextBomNumber(tx: Tx, client: string): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/material-bom-number`}, 0))`);
  const [row] = await tx.select({ n: sql<string | null>`max(${materialBom.bomNumber})` }).from(materialBom);
  const current = row?.n ? Number(row.n) : 0;
  if (!Number.isSafeInteger(current)) fail('The internal BOM number could not be read.');
  const next = String(current + 1).padStart(8, '0');
  if (next.length > 8) fail('No internal BOM number remains.');
  return next;
}

async function nextAlternative(tx: Tx, client: string, materialNumber: string, plant: string, usage: string): Promise<string> {
  const rows = await tx.select({ alternative: materialBom.alternative }).from(materialBom).where(and(
    eq(materialBom.client, client),
    eq(materialBom.materialNumber, materialNumber),
    eq(materialBom.plant, plant),
    eq(materialBom.usage, usage),
  ));
  const used = new Set(rows.map((row) => row.alternative));
  for (let n = 1; n <= 99; n += 1) {
    const key = String(n).padStart(2, '0');
    if (!used.has(key)) return key;
  }
  fail('No alternative from 01 to 99 is free. Enter an alternative.');
}

interface PreparedItem {
  itemNumber: string;
  itemCategory: string;
  componentMaterial: string | null;
  quantity: string | null;
  unit: string | null;
  scrapPercent: string | null;
  sortString: string | null;
  itemText: string | null;
  validFrom: string;
  validTo: string;
  fixedQuantity: 'X' | ' ';
  bulkMaterial: 'X' | ' ';
  phantom: 'X' | ' ';
  coproduct: 'X' | ' ';
  followUpMaterial: string | null;
  specialProcurement: string | null;
  issuingPlant: string | null;
  deletionFlag: 'X' | ' ';
}

async function prepareItems(
  tx: Tx,
  client: string,
  headerMaterial: string,
  headerPlant: string,
  headerFrom: string,
  headerTo: string,
  incoming: MaterialBomItemInput[],
  reserved: Set<string>,
  deletionAllowed: boolean,
): Promise<PreparedItem[]> {
  const categories = await tx.select().from(bomItemCategory).where(eq(bomItemCategory.client, client));
  const byCategory = new Map(categories.map((row) => [row.category, row]));
  const prepared: PreparedItem[] = [];
  const used = new Set<string>();
  let cursor = 10;
  for (const raw of incoming) {
    let itemNumber = raw.itemNumber?.trim() ? itemNumberOf(raw.itemNumber) : '';
    if (!itemNumber) {
      while (cursor <= 9990 && (used.has(String(cursor).padStart(4, '0')) || reserved.has(String(cursor).padStart(4, '0')))) cursor += 10;
      if (cursor > 9990) fail('No item number remains.');
      itemNumber = String(cursor).padStart(4, '0');
      cursor += 10;
    }
    if (used.has(itemNumber)) fail(`Item number ${itemNumber} is repeated.`);
    used.add(itemNumber);
    const categoryCode = categoryKey(raw.itemCategory);
    const category = byCategory.get(categoryCode);
    if (!category) fail(`Item category ${categoryCode} is not defined.`);
    const deletionFlag = deletionAllowed ? flag(raw.deletionFlag, 'Item deletion flag') : ' ';
    const componentText = (raw.componentMaterial ?? '').trim();
    let componentMaterial: string | null = null;
    if (category.materialEntry === '-' && componentText) fail(`Item category ${categoryCode} does not allow a component material.`);
    if (category.materialEntry === '+' && !componentText) fail(`Item category ${categoryCode} requires a component material.`);
    if (componentText) {
      const component = await materialRow(tx, client, componentText);
      assertUsableMaterial(component, componentText);
      componentMaterial = component.materialNumber;
    }
    const quantityText = (raw.quantity ?? '').trim();
    let quantity: string | null = null;
    let unit: string | null = null;
    if (category.quantityEntry === '-' && quantityText) fail(`Item category ${categoryCode} does not allow a quantity.`);
    if (category.quantityEntry === '+' && !quantityText) fail(`Item category ${categoryCode} requires a quantity.`);
    if (quantityText) {
      if (!componentMaterial) fail(`Item ${itemNumber} has a quantity and no component material.`);
      const component = await materialRow(tx, client, componentMaterial);
      unit = (raw.unit ?? '').trim().toUpperCase() || component?.baseUnit || '';
      if (!unit) fail(`Item ${itemNumber} has no unit, and the component has no base unit.`);
      quantity = quantityOf(quantityText, `Item ${itemNumber} quantity`, await decimalsOf(tx, unit), category.allowNegativeQuantity === 'X');
      await proveUnit(tx, client, componentMaterial, unit);
    }
    const scrapText = (raw.scrapPercent ?? '').trim();
    if (scrapText && !quantity) fail(`Item ${itemNumber} has scrap and no quantity.`);
    const scrapPercent = scrapText ? scrapOf(scrapText) : null;
    const fixedQuantity = flag(raw.fixedQuantity, 'Fixed quantity');
    const bulkMaterial = flag(raw.bulkMaterial, 'Bulk material');
    const phantom = flag(raw.phantom, 'Phantom');
    const coproduct = flag(raw.coproduct, 'Co-product');
    if (fixedQuantity === 'X' && category.allowFixedQuantity !== 'X') fail(`Item category ${categoryCode} does not allow a fixed quantity.`);
    if (bulkMaterial === 'X' && category.allowBulk !== 'X') fail(`Item category ${categoryCode} does not allow a bulk material.`);
    if (phantom === 'X' && category.allowPhantom !== 'X') fail(`Item category ${categoryCode} does not allow a phantom.`);
    if (coproduct === 'X' && category.allowCoproduct !== 'X') fail(`Item category ${categoryCode} does not allow a co-product.`);
    const followUpText = (raw.followUpMaterial ?? '').trim();
    if (followUpText && category.allowFollowUp !== 'X') fail(`Item category ${categoryCode} does not allow a follow-up material.`);
    let followUpMaterial: string | null = null;
    if (followUpText) {
      const follow = await materialRow(tx, client, followUpText);
      assertUsableMaterial(follow, followUpText);
      followUpMaterial = follow.materialNumber;
    }
    const procurementText = (raw.specialProcurement ?? '').trim().toUpperCase();
    if (procurementText && category.allowSpecialProcurement !== 'X') fail(`Item category ${categoryCode} does not allow special procurement.`);
    if (procurementText && !/^[A-Z0-9]{1,2}$/.test(procurementText)) fail(`Special procurement ${procurementText} must be one or two letters or digits. It is stored and not executed.`);
    const issuingText = (raw.issuingPlant ?? '').trim();
    if (issuingText) {
      const [issuing] = await tx.select({ plant: plantTable.plant }).from(plantTable).where(and(
        eq(plantTable.client, client), eq(plantTable.plant, issuingText),
      ));
      if (!issuing) fail(`Issuing plant ${issuingText} does not exist.`);
    }
    if (componentMaterial) await assertExtended(tx, client, componentMaterial, issuingText || headerPlant);
    const validFrom = raw.validFrom?.trim() ? dateOf(raw.validFrom, `Item ${itemNumber} valid from`) : headerFrom;
    const validTo = raw.validTo?.trim() ? dateOf(raw.validTo, `Item ${itemNumber} valid to`) : headerTo;
    if (validTo < validFrom) fail(`Item ${itemNumber} valid-to is before valid-from.`);
    if (validFrom < headerFrom || validTo > headerTo) fail(`Item ${itemNumber} validity is outside the BOM validity.`);
    prepared.push({
      itemNumber,
      itemCategory: categoryCode,
      componentMaterial,
      quantity,
      unit,
      scrapPercent,
      sortString: textOf(raw.sortString, 'Sort string', 10),
      itemText: textOf(raw.itemText, 'Item text', 40),
      validFrom,
      validTo,
      fixedQuantity,
      bulkMaterial,
      phantom,
      coproduct,
      followUpMaterial,
      specialProcurement: procurementText || null,
      issuingPlant: issuingText || null,
      deletionFlag,
    });
  }
  return prepared;
}

async function writeBom(input: MaterialBomInput, mode: 'CREATE' | 'CHANGE'): Promise<MaterialBomView> {
  if ((input.changeNumber ?? '').trim()) {
    fail('Engineering change management is not implemented. A change number is not stored.', 'Save without a change number. Validity is the from and to dates.');
  }
  const materialNumber = input.materialNumber.trim();
  const plant = input.plant.trim();
  const usage = usageKey(input.usage);
  if (!materialNumber) fail('Material is required.');
  if (!plant) fail('Plant is required. A group BOM is not implemented.');
  const validFrom = dateOf(input.validFrom, 'Valid from');
  const validTo = input.validTo?.trim() ? dateOf(input.validTo, 'Valid to') : OPEN_ENDED;
  if (validTo < validFrom) fail('Valid-to is before valid-from.');
  const headerText = textOf(input.headerText, 'Header text', 40);
  const baseUnit = input.baseUnit.trim().toUpperCase();
  if (!baseUnit) fail('Base unit is required.');
  const requestKey = textOf(input.requestKey, 'Request key', 64);

  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/material-bom/${plant}/${materialNumber}/${usage}`}, 0))`);
    if (mode === 'CREATE' && requestKey) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/material-bom-request/${requestKey}`}, 0))`);
      const [prior] = await tx.select().from(materialBom).where(and(
        eq(materialBom.client, input.client), eq(materialBom.requestKey, requestKey),
      ));
      if (prior) {
        const standing = await readInTx(tx, input.client, prior.materialNumber, prior.plant, prior.usage, prior.alternative, null);
        if (!standing) fail('The earlier request could not be read.');
        standing.warnings = ['This request was already saved. The standing BOM was returned. The new values were not applied.', ...standing.warnings];
        return standing;
      }
    }
    const headerMaterial = await materialRow(tx, input.client, materialNumber);
    assertUsableMaterial(headerMaterial, materialNumber);
    const [plantRow] = await tx.select({ plant: plantTable.plant }).from(plantTable).where(and(
      eq(plantTable.client, input.client), eq(plantTable.plant, plant),
    ));
    if (!plantRow) fail(`Plant ${plant} does not exist.`);
    await assertExtended(tx, input.client, materialNumber, plant);
    const [usageRow] = await tx.select().from(bomUsage).where(and(eq(bomUsage.client, input.client), eq(bomUsage.usage, usage)));
    if (!usageRow) fail(`BOM usage ${usage} is not defined.`);
    const baseDecimals = await decimalsOf(tx, baseUnit);
    const baseQuantity = quantityOf(input.baseQuantity, 'Base quantity', baseDecimals, false);
    if (Number(baseQuantity) < 0) fail('Base quantity must be positive.');
    await proveUnit(tx, input.client, materialNumber, baseUnit);

    const alternative = input.alternative?.trim()
      ? alternativeKey(input.alternative)
      : mode === 'CREATE'
        ? await nextAlternative(tx, input.client, materialNumber, plant, usage)
        : fail('Alternative is required to change a BOM.');
    const [beforeRow] = await tx.select().from(materialBom).where(and(
      eq(materialBom.client, input.client),
      eq(materialBom.materialNumber, materialNumber),
      eq(materialBom.plant, plant),
      eq(materialBom.usage, usage),
      eq(materialBom.alternative, alternative),
    ));
    if (mode === 'CREATE' && beforeRow) fail(`BOM ${materialNumber} / ${plant} / ${usage} / ${alternative} already exists.`);
    if (mode === 'CHANGE' && !beforeRow) fail(`BOM ${materialNumber} / ${plant} / ${usage} / ${alternative} does not exist.`);
    if (mode === 'CHANGE' && (input.version == null || input.version !== beforeRow!.version)) {
      fail('The BOM was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    }
    let status: string | null = mode === 'CHANGE' ? beforeRow?.status ?? null : null;
    if (input.status !== undefined) {
      status = input.status?.trim() ? statusKey(input.status) : null;
      if (status) {
        const [statusRow] = await tx.select().from(bomStatus).where(and(eq(bomStatus.client, input.client), eq(bomStatus.status, status)));
        if (!statusRow) fail(`BOM status ${status} is not defined.`);
      }
    }
    const before = beforeRow ? await readInTx(tx, input.client, materialNumber, plant, usage, alternative, null) : null;
    let sourceItems = input.items;
    if (mode === 'CREATE' && input.copyFrom && input.copyFrom.copyItems !== false && (!sourceItems || sourceItems.length === 0)) {
      const copied = await readInTx(
        tx,
        input.client,
        input.copyFrom.materialNumber.trim(),
        input.copyFrom.plant.trim(),
        usageKey(input.copyFrom.usage),
        alternativeKey(input.copyFrom.alternative),
        null,
      );
      if (!copied) fail('The reference BOM does not exist.');
      sourceItems = copied.items.filter((item) => item.deletionFlag !== 'X').map((item) => ({
        ...item,
        deletionFlag: ' ',
        validFrom,
        validTo,
      }));
    }
    const existingNumbers = new Set((before?.items ?? []).map((item) => item.itemNumber));
    const prepared = await prepareItems(
      tx,
      input.client,
      materialNumber,
      plant,
      validFrom,
      validTo,
      sourceItems ?? [],
      existingNumbers,
      mode === 'CHANGE',
    );
    const deletionFlag = mode === 'CREATE' ? ' ' : flag(input.deletionFlag, 'Deletion flag');
    let bomNumber = beforeRow?.bomNumber;
    if (!bomNumber) {
      const [shared] = await tx.select({ bomNumber: materialBom.bomNumber }).from(materialBom).where(and(
        eq(materialBom.client, input.client),
        eq(materialBom.materialNumber, materialNumber),
        eq(materialBom.plant, plant),
        eq(materialBom.usage, usage),
      )).limit(1);
      bomNumber = shared?.bomNumber ?? await nextBomNumber(tx, input.client);
    }
    if (mode === 'CREATE') {
      await tx.insert(materialBom).values({
        client: input.client,
        materialNumber,
        plant,
        usage,
        alternative,
        bomNumber,
        status,
        baseQuantity,
        baseUnit,
        validFrom,
        validTo,
        headerText,
        deletionFlag,
        requestKey,
        createdBy: input.changedBy,
      });
      await markActivityComplete(tx, input.client, BOM_ACTIVITY, input.changedBy);
    } else {
      const updated = await tx.update(materialBom).set({
        status,
        baseQuantity,
        baseUnit,
        validFrom,
        validTo,
        headerText,
        deletionFlag,
        version: beforeRow!.version + 1,
        changedBy: input.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(materialBom.client, input.client),
        eq(materialBom.materialNumber, materialNumber),
        eq(materialBom.plant, plant),
        eq(materialBom.usage, usage),
        eq(materialBom.alternative, alternative),
        eq(materialBom.version, beforeRow!.version),
      )).returning({ version: materialBom.version });
      if (updated.length === 0) fail('The BOM was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    }
    const key = and(
      eq(materialBomItem.client, input.client),
      eq(materialBomItem.materialNumber, materialNumber),
      eq(materialBomItem.plant, plant),
      eq(materialBomItem.usage, usage),
      eq(materialBomItem.alternative, alternative),
    );
    const existing = mode === 'CHANGE'
      ? await tx.select().from(materialBomItem).where(key)
      : [];
    const incomingNumbers = new Set(prepared.map((item) => item.itemNumber));
    for (const row of existing) {
      if (incomingNumbers.has(row.itemNumber)) continue;
      await tx.update(materialBomItem).set({
        deletionFlag: 'X',
        changedBy: input.changedBy,
        changedAt: new Date(),
      }).where(and(key, eq(materialBomItem.itemNumber, row.itemNumber)));
    }
    for (const item of prepared) {
      const values = {
        itemCategory: item.itemCategory,
        componentMaterial: item.componentMaterial,
        quantity: item.quantity,
        unit: item.unit,
        scrapPercent: item.scrapPercent,
        sortString: item.sortString,
        itemText: item.itemText,
        validFrom: item.validFrom,
        validTo: item.validTo,
        fixedQuantity: item.fixedQuantity,
        bulkMaterial: item.bulkMaterial,
        phantom: item.phantom,
        coproduct: item.coproduct,
        followUpMaterial: item.followUpMaterial,
        specialProcurement: item.specialProcurement,
        issuingPlant: item.issuingPlant,
        deletionFlag: item.deletionFlag,
      };
      const standing = existing.find((row) => row.itemNumber === item.itemNumber);
      if (standing) {
        await tx.update(materialBomItem).set({ ...values, changedBy: input.changedBy, changedAt: new Date() })
          .where(and(key, eq(materialBomItem.itemNumber, item.itemNumber)));
      } else {
        await tx.insert(materialBomItem).values({
          client: input.client,
          materialNumber,
          plant,
          usage,
          alternative,
          itemNumber: item.itemNumber,
          ...values,
          createdBy: input.changedBy,
        });
      }
    }
    const after = await readInTx(tx, input.client, materialNumber, plant, usage, alternative, null);
    if (!after) fail('The BOM was not saved.');
    await recordChange(tx, {
      client: input.client,
      objectClass: BOM_OBJECT,
      objectKey: `${plant}/${materialNumber}/${usage}/${alternative}`,
      changeType: mode === 'CREATE' ? 'CREATE' : 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: mode === 'CREATE' ? 'CS01' : 'CS02',
      correlationId: requestKey ?? undefined,
      before: before ? snapshot(before) : undefined,
      after: snapshot(after),
    });
    return after;
  });
}

export function createMaterialBom(input: MaterialBomInput): Promise<MaterialBomView> {
  return writeBom(input, 'CREATE');
}

export function changeMaterialBom(input: MaterialBomInput): Promise<MaterialBomView> {
  return writeBom(input, 'CHANGE');
}

export async function getMaterialBom(
  client: string,
  materialNumber: string,
  plant: string,
  usage: string,
  alternative: string,
  keyDate?: string | null,
): Promise<MaterialBomView | null> {
  const parsedDate = keyDate?.trim() ? dateOf(keyDate, 'Valid-on date') : null;
  return withTenant(client, (tx) => readInTx(
    tx,
    client,
    materialNumber.trim(),
    plant.trim(),
    usageKey(usage),
    alternativeKey(alternative),
    parsedDate,
  ));
}

export async function listMaterialBoms(client: string, filter: {
  materialNumber?: string;
  plant?: string;
  usage?: string;
} = {}): Promise<Array<{ materialNumber: string; plant: string; usage: string; alternative: string; bomNumber: string; validFrom: string; validTo: string; deletionFlag: string }>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      materialNumber: materialBom.materialNumber,
      plant: materialBom.plant,
      usage: materialBom.usage,
      alternative: materialBom.alternative,
      bomNumber: materialBom.bomNumber,
      validFrom: materialBom.validFrom,
      validTo: materialBom.validTo,
      deletionFlag: materialBom.deletionFlag,
    }).from(materialBom).where(eq(materialBom.client, client)).orderBy(asc(materialBom.materialNumber), asc(materialBom.alternative));
    return rows.filter((row) => {
      if (filter.materialNumber && row.materialNumber !== filter.materialNumber.trim()) return false;
      if (filter.plant && row.plant !== filter.plant.trim()) return false;
      if (filter.usage && row.usage !== usageKey(filter.usage)) return false;
      return true;
    });
  });
}

export async function resolveMaterialBom(
  client: string,
  materialNumber: string,
  plant: string,
  usage: string,
  alternative?: string | null,
  keyDate?: string | null,
): Promise<MaterialBomView | null> {
  if (alternative?.trim()) return getMaterialBom(client, materialNumber, plant, usage, alternative, keyDate);
  const rows = await listMaterialBoms(client, { materialNumber, plant, usage });
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    fail(`More than one BOM matches. Choose an alternative: ${rows.map((row) => row.alternative).join(', ')}.`, 'Select the alternative. The first row was not opened.');
  }
  return getMaterialBom(client, materialNumber, plant, usage, rows[0].alternative, keyDate);
}

/** Downstream selection. Does not write. MD01 and CO01 do not call this. */
export async function selectEffectiveMaterialBom(client: string, input: {
  materialNumber: string;
  plant: string;
  usage: string;
  alternative?: string | null;
  keyDate: string;
  forUse?: 'MRP' | 'COSTING' | 'ORDER' | null;
}): Promise<MaterialBomView | null> {
  const keyDate = dateOf(input.keyDate, 'Key date');
  const usage = usageKey(input.usage);
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(materialBom).where(and(
      eq(materialBom.client, client),
      eq(materialBom.materialNumber, input.materialNumber.trim()),
      eq(materialBom.plant, input.plant.trim()),
      eq(materialBom.usage, usage),
    ));
    const effective = rows.filter((row) => row.deletionFlag !== 'X' && keyDate >= row.validFrom && keyDate <= row.validTo);
    let alternative = input.alternative?.trim() ? alternativeKey(input.alternative) : '';
    if (!alternative) {
      if (effective.length === 0) return null;
      if (effective.length > 1) {
        fail(`More than one BOM is effective on ${keyDate}. Choose an alternative: ${effective.map((row) => row.alternative).join(', ')}.`);
      }
      alternative = effective[0].alternative;
    }
    const view = await readInTx(tx, client, input.materialNumber.trim(), input.plant.trim(), usage, alternative, keyDate);
    if (!view || !view.effective) return null;
    if (input.forUse) {
      const released = input.forUse === 'MRP'
        ? view.releasedForMrp
        : input.forUse === 'COSTING'
          ? view.releasedForCosting
          : view.releasedForOrders;
      if (released !== 'X') {
        fail(`BOM status ${view.status ?? '(none)'} is not released for ${input.forUse}. The BOM was not selected.`, 'Set the release flag on the status, or choose another status.');
      }
    }
    return { ...view, items: view.items.filter((item) => item.effective) };
  });
}

export async function listBomUsages(client: string) {
  return withTenant(client, (tx) => tx.select().from(bomUsage).where(eq(bomUsage.client, client)).orderBy(asc(bomUsage.usage)));
}

export async function listBomStatuses(client: string) {
  return withTenant(client, (tx) => tx.select().from(bomStatus).where(eq(bomStatus.client, client)).orderBy(asc(bomStatus.status)));
}

export async function listBomItemCategories(client: string) {
  return withTenant(client, (tx) => tx.select().from(bomItemCategory).where(eq(bomItemCategory.client, client)).orderBy(asc(bomItemCategory.category)));
}

export async function saveBomUsage(input: BomUsageInput) {
  const usage = usageKey(input.usage);
  const description = descriptionOf(input.description, 'Usage description');
  const relevance = {
    productionRelevance: entryOf(input.productionRelevance, 'Production relevance'),
    engineeringRelevance: entryOf(input.engineeringRelevance, 'Engineering relevance'),
    costingRelevance: entryOf(input.costingRelevance, 'Costing relevance'),
    salesRelevance: entryOf(input.salesRelevance, 'Sales relevance'),
  };
  return withTenant(input.client, async (tx) => {
    const [existing] = await tx.select().from(bomUsage).where(and(eq(bomUsage.client, input.client), eq(bomUsage.usage, usage)));
    if (existing && input.version != null && existing.version !== input.version) fail('The usage was changed by someone else. Nothing was saved.');
    if (existing) {
      await tx.update(bomUsage).set({ description, ...relevance, version: existing.version + 1, changedBy: input.changedBy, changedAt: new Date() })
        .where(and(eq(bomUsage.client, input.client), eq(bomUsage.usage, usage), eq(bomUsage.version, existing.version)));
    } else {
      await tx.insert(bomUsage).values({ client: input.client, usage, description, ...relevance, createdBy: input.changedBy });
    }
    return { usage };
  });
}

export async function saveBomStatus(input: BomStatusInput) {
  const status = statusKey(input.status);
  const description = descriptionOf(input.description, 'Status description');
  const flags = {
    releasedForMrp: flag(input.releasedForMrp, 'Released for MRP'),
    releasedForCosting: flag(input.releasedForCosting, 'Released for costing'),
    releasedForOrders: flag(input.releasedForOrders, 'Released for orders'),
  };
  return withTenant(input.client, async (tx) => {
    const [existing] = await tx.select().from(bomStatus).where(and(eq(bomStatus.client, input.client), eq(bomStatus.status, status)));
    if (existing && input.version != null && existing.version !== input.version) fail('The status was changed by someone else. Nothing was saved.');
    if (existing) {
      await tx.update(bomStatus).set({ description, ...flags, version: existing.version + 1, changedBy: input.changedBy, changedAt: new Date() })
        .where(and(eq(bomStatus.client, input.client), eq(bomStatus.status, status), eq(bomStatus.version, existing.version)));
    } else {
      await tx.insert(bomStatus).values({ client: input.client, status, description, ...flags, createdBy: input.changedBy });
    }
    return { status };
  });
}

export async function saveBomItemCategory(input: BomItemCategoryInput) {
  const category = categoryKey(input.category);
  const description = descriptionOf(input.description, 'Item category description');
  const values = {
    description,
    materialEntry: entryOf(input.materialEntry, 'Material entry'),
    quantityEntry: entryOf(input.quantityEntry, 'Quantity entry'),
    allowFixedQuantity: flag(input.allowFixedQuantity, 'Fixed quantity'),
    allowBulk: flag(input.allowBulk, 'Bulk material'),
    allowPhantom: flag(input.allowPhantom, 'Phantom'),
    allowCoproduct: flag(input.allowCoproduct, 'Co-product'),
    allowFollowUp: flag(input.allowFollowUp, 'Follow-up'),
    allowSpecialProcurement: flag(input.allowSpecialProcurement, 'Special procurement'),
    allowNegativeQuantity: flag(input.allowNegativeQuantity, 'Negative quantity'),
  };
  return withTenant(input.client, async (tx) => {
    const [existing] = await tx.select().from(bomItemCategory).where(and(
      eq(bomItemCategory.client, input.client), eq(bomItemCategory.category, category),
    ));
    if (existing && input.version != null && existing.version !== input.version) fail('The item category was changed by someone else. Nothing was saved.');
    if (existing) {
      await tx.update(bomItemCategory).set({ ...values, version: existing.version + 1, changedBy: input.changedBy, changedAt: new Date() })
        .where(and(eq(bomItemCategory.client, input.client), eq(bomItemCategory.category, category), eq(bomItemCategory.version, existing.version)));
    } else {
      await tx.insert(bomItemCategory).values({ client: input.client, category, ...values, createdBy: input.changedBy });
    }
    return { category };
  });
}
