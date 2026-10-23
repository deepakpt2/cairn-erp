/**
 * Work center master — CR01 create, CR02 change, CR03 display.
 *
 * The key is the plant and a work center of at most 8 characters, stored as typed.
 * Category comes from tenant customizing. It is not a delivered 0001, and CR02
 * cannot change it. No TC21 standard-value parameters, no formula catalog, and
 * no shift sequence are stored. A formula key is saved and not calculated.
 * No routing is created, and a production order is not rewritten.
 */
import { and, asc, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { hasCapability } from '../../platform/auth/session';
import { unitOfMeasure } from '../../platform/tables/reference';
import { markActivityComplete } from '../../platform/tenancy';
import {
  activityType,
  controllingAreaCompany,
  costCenter,
  factoryCalendar,
  plant as plantTable,
} from '../foundation/schema';
import {
  workCenter,
  workCenterCapacity,
  workCenterCategory,
  workCenterCosting,
} from './schema';

export const WORK_CENTER_ACTIVITY = 'CFG.PROD.WORKCENTER.DEFINE';
export const WORK_CENTER_CREATE_CAPABILITY = 'PROD.WORKCENTER.CREATE';
export const WORK_CENTER_CHANGE_CAPABILITY = 'PROD.WORKCENTER.CHANGE';
export const WORK_CENTER_DISPLAY_CAPABILITY = 'PROD.WORKCENTER.DISPLAY';
export const WORK_CENTER_ROUTE = '/production/work-centers';
export const WORK_CENTER_DISPLAY_ROUTE = '/production/work-center-display';
export const WORK_CENTER_LOCK = 'WORK_CENTER';
export const WORK_CENTER_OBJECT = 'work_center';

const CREATE_ALIAS = 'CR01';
const CHANGE_ALIAS = 'CR02';

export class WorkCenterError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'WorkCenterError';
    this.remedy = remedy;
  }
}

export function workCenterCapability(mode: 'CREATE' | 'CHANGE' | 'DISPLAY'): string {
  if (mode === 'CREATE') return WORK_CENTER_CREATE_CAPABILITY;
  if (mode === 'CHANGE') return WORK_CENTER_CHANGE_CAPABILITY;
  return WORK_CENTER_DISPLAY_CAPABILITY;
}

export function holdsWorkCenterAuthority(held: readonly string[], mode: 'CREATE' | 'CHANGE' | 'DISPLAY'): boolean {
  return hasCapability([...held], workCenterCapability(mode));
}

export interface WorkCenterCapacityInput {
  capacityCategory: string;
  description?: string | null;
  factoryCalendar?: string | null;
  baseUnit?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  breakMinutes?: number | null;
  utilization?: string | null;
  individualCapacities?: number | null;
  finiteScheduling?: string | null;
  longTermPlanning?: string | null;
  severalOperations?: string | null;
}

export interface WorkCenterCostingInput {
  validFrom: string;
  validTo: string;
  costCenter: string;
  activityType?: string | null;
  formula?: string | null;
}

export interface WorkCenterInput {
  client: string;
  changedBy: string;
  plant: string;
  workCenter: string;
  category: string;
  description: string;
  personResponsible?: string | null;
  location?: string | null;
  usage?: string | null;
  standardValueKey?: string | null;
  controlKey?: string | null;
  deletionFlag?: string | null;
  schedulingCapacityCategory?: string | null;
  schedulingSetupFormula?: string | null;
  schedulingProcessingFormula?: string | null;
  schedulingTeardownFormula?: string | null;
  capacities?: WorkCenterCapacityInput[];
  costing?: WorkCenterCostingInput[];
  version?: number;
  copyFrom?: { plant: string; workCenter: string; copyChildren?: boolean } | null;
}

export interface WorkCenterCapacityView {
  capacityCategory: string;
  description: string | null;
  factoryCalendar: string | null;
  baseUnit: string | null;
  startTime: string | null;
  endTime: string | null;
  breakMinutes: number;
  utilization: string | null;
  individualCapacities: number | null;
  finiteScheduling: 'X' | ' ';
  longTermPlanning: 'X' | ' ';
  severalOperations: 'X' | ' ';
}

export interface WorkCenterCostingView {
  lineNumber: number;
  validFrom: string;
  validTo: string;
  controllingArea: string;
  costCenter: string;
  activityType: string | null;
  formula: string | null;
}

export interface WorkCenterView {
  plant: string;
  plantName: string;
  workCenter: string;
  category: string;
  categoryDescription: string;
  description: string;
  personResponsible: string | null;
  location: string | null;
  usage: string | null;
  standardValueKey: string | null;
  controlKey: string | null;
  deletionFlag: 'X' | ' ';
  schedulingCapacityCategory: string | null;
  schedulingSetupFormula: string | null;
  schedulingProcessingFormula: string | null;
  schedulingTeardownFormula: string | null;
  version: number;
  capacities: WorkCenterCapacityView[];
  costing: WorkCenterCostingView[];
  routingReferences: 0;
  productionOrderReferences: 0;
}

export interface WorkCenterCategoryInput {
  client: string;
  changedBy: string;
  category: string;
  description: string;
  requireCapacity?: boolean;
  requireScheduling?: boolean;
  requireCosting?: boolean;
  requireStandardValueKey?: boolean;
  version?: number;
}

function fail(message: string, remedy?: string): never {
  throw new WorkCenterError(message, remedy);
}

function asTyped(raw: string | null | undefined, label: string, pattern: RegExp, max: number): string | null {
  if (raw == null || raw === '') return null;
  if (raw !== raw.trim()) {
    fail(`${label} has surrounding spaces. They were not removed. Nothing was saved.`, 'Type it without surrounding spaces.');
  }
  if (raw.length > max || !pattern.test(raw)) {
    fail(`${label} "${raw}" is not a valid key. Nothing was saved.`, `Use 1 to ${max} letters or digits, as typed.`);
  }
  return raw;
}

function flag(raw: string | null | undefined, label: string): 'X' | ' ' {
  const value = raw == null || raw === '' ? ' ' : raw;
  if (value !== 'X' && value !== ' ') fail(`${label} must be X or blank. Nothing was saved.`);
  return value;
}

function clock(raw: string | null | undefined, label: string): string | null {
  if (raw == null || raw === '') return null;
  if (!/^\d{2}:\d{2}$/.test(raw)) fail(`${label} must be HH:MM. Nothing was saved.`);
  const [hour, minute] = raw.split(':').map(Number);
  if (hour > 23 || minute > 59) fail(`${label} ${raw} is not a time. Nothing was saved.`);
  return raw;
}

function minutesBetween(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

function workCenterKey(raw: string): string {
  if (raw !== raw.trim()) {
    fail('The work center has surrounding spaces. They were not removed. Nothing was saved.', 'Type the key without surrounding spaces.');
  }
  if (!/^[A-Z0-9-]{1,8}$/.test(raw)) {
    fail(`Work center "${raw}" must be 1 to 8 letters, digits, or hyphens. It was not truncated.`, 'Shorten the key. The stored value is the characters you type.');
  }
  return raw;
}

function descriptionOf(raw: string): string {
  if (raw !== raw.trim() || raw.trim() === '') {
    fail('The description is blank or has surrounding spaces. Nothing was saved.', 'Type a description of 1 to 40 characters.');
  }
  if (raw.length > 40) fail('The description is longer than 40 characters. It was not truncated.', 'Shorten the description.');
  return raw;
}

async function loadCategory(tx: Tx, client: string, category: string) {
  const key = asTyped(category, 'Work center category', /^[A-Z0-9]{1,4}$/, 4);
  if (!key) fail('A work center category is required.', 'Define a category, then create the work center.');
  const [row] = await tx.select().from(workCenterCategory).where(and(
    eq(workCenterCategory.client, client),
    eq(workCenterCategory.category, key),
  ));
  if (!row) {
    fail(
      `Work center category ${key} is not defined.`,
      'Define the category on this screen. No category list is delivered.',
    );
  }
  return row;
}

async function assertPlant(tx: Tx, client: string, plantCode: string) {
  const plant = asTyped(plantCode, 'Plant', /^[A-Z0-9]{1,10}$/, 10);
  if (!plant) fail('A plant is required.');
  const [row] = await tx.select().from(plantTable).where(and(
    eq(plantTable.client, client),
    eq(plantTable.plant, plant),
  ));
  if (!row) fail(`Plant ${plant} does not exist.`, 'Create the plant, then the work center.');
  return row;
}

function prepareCapacities(rows: WorkCenterCapacityInput[] | undefined): WorkCenterCapacityInput[] {
  const list = rows ?? [];
  const seen = new Set<string>();
  return list.map((row) => {
    const capacityCategory = asTyped(row.capacityCategory, 'Capacity category', /^[A-Z0-9]{1,3}$/, 3);
    if (!capacityCategory) fail('A capacity row needs a capacity category.');
    if (seen.has(capacityCategory)) {
      fail(`Capacity category ${capacityCategory} is repeated. Each category is used once.`, 'Remove the duplicate category.');
    }
    seen.add(capacityCategory);
    const startTime = clock(row.startTime, 'Start time');
    const endTime = clock(row.endTime, 'End time');
    const breakMinutes = row.breakMinutes ?? 0;
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0) fail('Break minutes must be a whole number of zero or more.');
    if (startTime && endTime) {
      const span = minutesBetween(startTime, endTime);
      if (span <= 0) fail('End time must be after start time. An overnight shift is not stored.', 'Enter an interval on the same day.');
      if (breakMinutes >= span) fail('Breaks are not shorter than the interval. Nothing was saved.');
    } else if (startTime || endTime) {
      fail('Start time and end time are entered together, or not at all.');
    }
    let utilization = row.utilization == null || row.utilization === '' ? null : row.utilization;
    if (utilization != null) {
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(utilization) || Number(utilization) > 100) {
        fail('Utilization must be from 0 to 100, with at most two decimal places.');
      }
    }
    if (row.individualCapacities != null && (!Number.isInteger(row.individualCapacities) || row.individualCapacities < 1)) {
      fail('Individual capacities, when entered, are a whole number of at least 1.');
    }
    return {
      ...row,
      capacityCategory,
      description: row.description ? descriptionOf(row.description) : null,
      factoryCalendar: asTyped(row.factoryCalendar, 'Factory calendar', /^[A-Z0-9]{2}$/, 2),
      baseUnit: asTyped(row.baseUnit, 'Capacity unit', /^[A-Z0-9]{1,6}$/, 6),
      startTime,
      endTime,
      breakMinutes,
      utilization,
      finiteScheduling: flag(row.finiteScheduling, 'Finite scheduling'),
      longTermPlanning: flag(row.longTermPlanning, 'Long-term planning'),
      severalOperations: flag(row.severalOperations, 'Several operations'),
    };
  });
}

function prepareCosting(rows: WorkCenterCostingInput[] | undefined): WorkCenterCostingInput[] {
  const list = rows ?? [];
  const prepared = list.map((row) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.validFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(row.validTo)) {
      fail('Costing validity dates must be YYYY-MM-DD.');
    }
    if (row.validTo < row.validFrom) fail('Costing valid-to is before valid-from. Nothing was saved.');
    const center = asTyped(row.costCenter, 'Cost center', /^[A-Z0-9]{1,10}$/, 10);
    if (!center) fail('A costing row needs a cost center.');
    return {
      validFrom: row.validFrom,
      validTo: row.validTo,
      costCenter: center,
      activityType: asTyped(row.activityType, 'Activity type', /^[A-Z0-9]{1,6}$/, 6),
      formula: asTyped(row.formula, 'Costing formula', /^[A-Z0-9]{1,6}$/, 6),
    };
  });
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const left = prepared[i];
      const right = prepared[j];
      if ((left.activityType ?? '') !== (right.activityType ?? '')) continue;
      if (left.validFrom <= right.validTo && right.validFrom <= left.validTo) {
        fail(
          `Costing intervals overlap for activity ${left.activityType ?? '(none)'}.`,
          'Shorten one interval so the same activity is not assigned twice on the same day.',
        );
      }
    }
  }
  return prepared;
}

async function assertReferences(
  tx: Tx,
  client: string,
  plantRow: { plant: string; companyCode: string | null },
  capacities: WorkCenterCapacityInput[],
  costing: WorkCenterCostingInput[],
) {
  for (const row of capacities) {
    if (row.factoryCalendar) {
      const [calendar] = await tx.select().from(factoryCalendar).where(and(
        eq(factoryCalendar.client, client),
        eq(factoryCalendar.calendarId, row.factoryCalendar),
      ));
      if (!calendar || !calendar.isActive) {
        fail(`Factory calendar ${row.factoryCalendar} is not an active calendar.`, 'Choose a calendar that already stands, or leave it blank.');
      }
    }
    if (row.baseUnit) {
      const [unit] = await tx.select().from(unitOfMeasure).where(eq(unitOfMeasure.code, row.baseUnit));
      if (!unit) fail(`Unit ${row.baseUnit} does not exist.`, 'Choose a unit that already stands, or leave it blank.');
    }
  }
  for (const row of costing) {
    if (!plantRow.companyCode) {
      fail(`Plant ${plantRow.plant} has no company code. A cost center cannot be checked.`, 'Assign the plant to a company, then save costing.');
    }
    const [link] = await tx.select().from(controllingAreaCompany).where(and(
      eq(controllingAreaCompany.client, client),
      eq(controllingAreaCompany.companyCode, plantRow.companyCode),
    ));
    if (!link) fail(`Company ${plantRow.companyCode} is not assigned to a controlling area.`);
    const centers = await tx.select().from(costCenter).where(and(
      eq(costCenter.client, client),
      eq(costCenter.controllingArea, link.controllingArea),
      eq(costCenter.costCenter, row.costCenter),
      eq(costCenter.companyCode, plantRow.companyCode),
    ));
    const covers = centers.some((item) => item.validFrom <= row.validFrom && item.validTo >= row.validTo);
    if (!covers) {
      fail(
        `Cost center ${row.costCenter} does not cover ${row.validFrom} to ${row.validTo} in company ${plantRow.companyCode}.`,
        'Use a cost center of this plant\'s company, valid for the whole interval.',
      );
    }
    if (row.activityType) {
      const types = await tx.select().from(activityType).where(and(
        eq(activityType.client, client),
        eq(activityType.controllingArea, link.controllingArea),
        eq(activityType.activityType, row.activityType),
      ));
      const typeCovers = types.some((item) => item.validFrom <= row.validFrom && item.validTo >= row.validTo);
      if (!typeCovers) {
        fail(`Activity type ${row.activityType} does not cover the costing interval.`, 'Choose an activity type that stands for the whole interval, or leave it blank.');
      }
    }
  }
}

function snapshot(view: WorkCenterView): Record<string, unknown> {
  return {
    plant: view.plant,
    workCenter: view.workCenter,
    category: view.category,
    description: view.description,
    personResponsible: view.personResponsible,
    location: view.location,
    usage: view.usage,
    standardValueKey: view.standardValueKey,
    controlKey: view.controlKey,
    deletionFlag: view.deletionFlag,
    schedulingCapacityCategory: view.schedulingCapacityCategory,
    schedulingSetupFormula: view.schedulingSetupFormula,
    schedulingProcessingFormula: view.schedulingProcessingFormula,
    schedulingTeardownFormula: view.schedulingTeardownFormula,
    capacities: view.capacities,
    costing: view.costing,
  };
}

async function readInTx(tx: Tx, client: string, plantCode: string, centerCode: string): Promise<WorkCenterView | null> {
  const [header] = await tx.select().from(workCenter).where(and(
    eq(workCenter.client, client),
    eq(workCenter.plant, plantCode),
    eq(workCenter.workCenter, centerCode),
  ));
  if (!header) return null;
  const [plantRow] = await tx.select().from(plantTable).where(and(
    eq(plantTable.client, client),
    eq(plantTable.plant, plantCode),
  ));
  const [category] = await tx.select().from(workCenterCategory).where(and(
    eq(workCenterCategory.client, client),
    eq(workCenterCategory.category, header.category),
  ));
  const capacities = await tx.select().from(workCenterCapacity).where(and(
    eq(workCenterCapacity.client, client),
    eq(workCenterCapacity.plant, plantCode),
    eq(workCenterCapacity.workCenter, centerCode),
  )).orderBy(asc(workCenterCapacity.capacityCategory));
  const costing = await tx.select().from(workCenterCosting).where(and(
    eq(workCenterCosting.client, client),
    eq(workCenterCosting.plant, plantCode),
    eq(workCenterCosting.workCenter, centerCode),
  )).orderBy(asc(workCenterCosting.lineNumber));
  return {
    plant: header.plant,
    plantName: plantRow?.name ?? '',
    workCenter: header.workCenter,
    category: header.category,
    categoryDescription: category?.description ?? '',
    description: header.description,
    personResponsible: header.personResponsible,
    location: header.location,
    usage: header.usage,
    standardValueKey: header.standardValueKey,
    controlKey: header.controlKey,
    deletionFlag: header.deletionFlag as 'X' | ' ',
    schedulingCapacityCategory: header.schedulingCapacityCategory,
    schedulingSetupFormula: header.schedulingSetupFormula,
    schedulingProcessingFormula: header.schedulingProcessingFormula,
    schedulingTeardownFormula: header.schedulingTeardownFormula,
    version: header.version,
    capacities: capacities.map((row) => ({
      capacityCategory: row.capacityCategory,
      description: row.description,
      factoryCalendar: row.factoryCalendar,
      baseUnit: row.baseUnit,
      startTime: row.startTime,
      endTime: row.endTime,
      breakMinutes: row.breakMinutes,
      utilization: row.utilization,
      individualCapacities: row.individualCapacities,
      finiteScheduling: row.finiteScheduling as 'X' | ' ',
      longTermPlanning: row.longTermPlanning as 'X' | ' ',
      severalOperations: row.severalOperations as 'X' | ' ',
    })),
    costing: costing.map((row) => ({
      lineNumber: row.lineNumber,
      validFrom: row.validFrom,
      validTo: row.validTo,
      controllingArea: row.controllingArea,
      costCenter: row.costCenter,
      activityType: row.activityType,
      formula: row.formula,
    })),
    routingReferences: 0,
    productionOrderReferences: 0,
  };
}

async function replaceChildren(
  tx: Tx,
  client: string,
  plantCode: string,
  centerCode: string,
  actor: string,
  capacities: WorkCenterCapacityInput[],
  costing: Array<WorkCenterCostingInput & { controllingArea: string }>,
) {
  await tx.delete(workCenterCapacity).where(and(
    eq(workCenterCapacity.client, client),
    eq(workCenterCapacity.plant, plantCode),
    eq(workCenterCapacity.workCenter, centerCode),
  ));
  await tx.delete(workCenterCosting).where(and(
    eq(workCenterCosting.client, client),
    eq(workCenterCosting.plant, plantCode),
    eq(workCenterCosting.workCenter, centerCode),
  ));
  for (const row of capacities) {
    await tx.insert(workCenterCapacity).values({
      client,
      plant: plantCode,
      workCenter: centerCode,
      capacityCategory: row.capacityCategory,
      description: row.description ?? null,
      factoryCalendar: row.factoryCalendar ?? null,
      baseUnit: row.baseUnit ?? null,
      startTime: row.startTime ?? null,
      endTime: row.endTime ?? null,
      breakMinutes: row.breakMinutes ?? 0,
      utilization: row.utilization ?? null,
      individualCapacities: row.individualCapacities ?? null,
      finiteScheduling: flag(row.finiteScheduling, 'Finite scheduling'),
      longTermPlanning: flag(row.longTermPlanning, 'Long-term planning'),
      severalOperations: flag(row.severalOperations, 'Several operations'),
      createdBy: actor,
    });
  }
  for (const [index, row] of costing.entries()) {
    await tx.insert(workCenterCosting).values({
      client,
      plant: plantCode,
      workCenter: centerCode,
      lineNumber: index + 1,
      validFrom: row.validFrom,
      validTo: row.validTo,
      controllingArea: row.controllingArea,
      costCenter: row.costCenter,
      activityType: row.activityType ?? null,
      formula: row.formula ?? null,
      createdBy: actor,
    });
  }
}

async function controllingAreaFor(tx: Tx, client: string, companyCode: string): Promise<string> {
  const [link] = await tx.select().from(controllingAreaCompany).where(and(
    eq(controllingAreaCompany.client, client),
    eq(controllingAreaCompany.companyCode, companyCode),
  ));
  if (!link) fail(`Company ${companyCode} is not assigned to a controlling area.`);
  return link.controllingArea;
}

export async function saveWorkCenterCategory(input: WorkCenterCategoryInput) {
  const category = asTyped(input.category, 'Work center category', /^[A-Z0-9]{1,4}$/, 4);
  if (!category) fail('A category key is required.');
  const description = descriptionOf(input.description);
  return withTenant(input.client, async (tx) => {
    const [existing] = await tx.select().from(workCenterCategory).where(and(
      eq(workCenterCategory.client, input.client),
      eq(workCenterCategory.category, category),
    ));
    if (existing && input.version != null && existing.version !== input.version) {
      fail('The category was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    }
    if (existing) {
      await tx.update(workCenterCategory).set({
        description,
        requireCapacity: input.requireCapacity === true,
        requireScheduling: input.requireScheduling === true,
        requireCosting: input.requireCosting === true,
        requireStandardValueKey: input.requireStandardValueKey === true,
        version: existing.version + 1,
        changedBy: input.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(workCenterCategory.client, input.client),
        eq(workCenterCategory.category, category),
        eq(workCenterCategory.version, existing.version),
      ));
    } else {
      await tx.insert(workCenterCategory).values({
        client: input.client,
        category,
        description,
        requireCapacity: input.requireCapacity === true,
        requireScheduling: input.requireScheduling === true,
        requireCosting: input.requireCosting === true,
        requireStandardValueKey: input.requireStandardValueKey === true,
        createdBy: input.changedBy,
      });
    }
    const [saved] = await tx.select().from(workCenterCategory).where(and(
      eq(workCenterCategory.client, input.client),
      eq(workCenterCategory.category, category),
    ));
    return saved;
  });
}

export async function listWorkCenterCategories(client: string) {
  return withTenant(client, (tx) => tx.select().from(workCenterCategory).where(eq(workCenterCategory.client, client)).orderBy(asc(workCenterCategory.category)));
}

export async function listWorkCenters(client: string) {
  return withTenant(client, (tx) => tx.select({
    plant: workCenter.plant,
    workCenter: workCenter.workCenter,
    description: workCenter.description,
    category: workCenter.category,
    deletionFlag: workCenter.deletionFlag,
  }).from(workCenter).where(eq(workCenter.client, client)).orderBy(asc(workCenter.plant), asc(workCenter.workCenter)));
}

export async function getWorkCenter(client: string, plantCode: string, centerCode: string): Promise<WorkCenterView | null> {
  return withTenant(client, (tx) => readInTx(tx, client, plantCode, centerCode));
}

async function writeCenter(input: WorkCenterInput, mode: 'CREATE' | 'CHANGE'): Promise<WorkCenterView> {
  const plantCode = asTyped(input.plant, 'Plant', /^[A-Z0-9]{1,10}$/, 10);
  const centerCode = workCenterKey(input.workCenter);
  if (!plantCode) fail('A plant is required.');
  return withTenant(input.client, async (tx) => {
    const plantRow = await assertPlant(tx, input.client, plantCode);
    const before = await readInTx(tx, input.client, plantCode, centerCode);
    if (mode === 'CREATE' && before) {
      fail(`Work center ${centerCode} already exists in plant ${plantCode}.`, 'Open it in CR02, or choose another key.');
    }
    if (mode === 'CHANGE' && !before) {
      fail(`Work center ${centerCode} does not exist in plant ${plantCode}.`, 'Create it in CR01.');
    }
    if (mode === 'CHANGE' && before && input.version !== before.version) {
      fail('The work center was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    }
    let categoryKey = asTyped(input.category, 'Work center category', /^[A-Z0-9]{1,4}$/, 4) ?? '';
    let description = input.description;
    let capacities = input.capacities;
    let costing = input.costing;
    let headerRest = input;
    if (mode === 'CREATE' && input.copyFrom) {
      const source = await readInTx(tx, input.client, input.copyFrom.plant, input.copyFrom.workCenter);
      if (!source) fail(`Reference work center ${input.copyFrom.workCenter} does not exist in plant ${input.copyFrom.plant}.`);
      if (!categoryKey) categoryKey = source.category;
      if (!description) description = source.description;
      if (input.copyFrom.copyChildren !== false) {
        if (!capacities || capacities.length === 0) capacities = source.capacities;
        if (!costing || costing.length === 0) costing = source.costing;
      }
      headerRest = {
        ...source,
        ...input,
        category: categoryKey,
        description,
        deletionFlag: ' ',
      };
    }
    const category = await loadCategory(tx, input.client, categoryKey);
    if (mode === 'CHANGE' && before && category.category !== before.category) {
      fail('The work center category cannot be changed.', 'Create another work center if the category is wrong.');
    }
    const text = descriptionOf(description);
    const preparedCapacities = prepareCapacities(capacities);
    const preparedCosting = prepareCosting(costing);
    const schedulingCategory = asTyped(headerRest.schedulingCapacityCategory, 'Scheduling capacity category', /^[A-Z0-9]{1,3}$/, 3);
    const setupFormula = asTyped(headerRest.schedulingSetupFormula, 'Setup formula', /^[A-Z0-9]{1,6}$/, 6);
    const processingFormula = asTyped(headerRest.schedulingProcessingFormula, 'Processing formula', /^[A-Z0-9]{1,6}$/, 6);
    const teardownFormula = asTyped(headerRest.schedulingTeardownFormula, 'Teardown formula', /^[A-Z0-9]{1,6}$/, 6);
    if (schedulingCategory && !preparedCapacities.some((row) => row.capacityCategory === schedulingCategory)) {
      fail(`Scheduling capacity category ${schedulingCategory} is not a capacity of this work center.`, 'Add that capacity, or clear the scheduling category.');
    }
    if (category.requireCapacity && preparedCapacities.length === 0) {
      fail(`Category ${category.category} requires a capacity.`, 'Enter a capacity category, or change the category customizing.');
    }
    if (category.requireScheduling && !schedulingCategory) {
      fail(`Category ${category.category} requires a scheduling capacity category.`, 'Name a capacity category in scheduling.');
    }
    if (category.requireCosting && preparedCosting.length === 0) {
      fail(`Category ${category.category} requires a costing assignment.`, 'Enter a cost center and a validity interval.');
    }
    const standardValueKey = asTyped(headerRest.standardValueKey, 'Standard value key', /^[A-Z0-9]{1,4}$/, 4);
    if (category.requireStandardValueKey && !standardValueKey) {
      fail(`Category ${category.category} requires a standard value key.`, 'Enter the key, or change the category customizing.');
    }
    if (mode === 'CREATE' && flag(input.deletionFlag, 'Deletion flag') === 'X') {
      fail('A new work center is not created with a deletion flag.');
    }
    await assertReferences(tx, input.client, plantRow, preparedCapacities, preparedCosting);
    const area = preparedCosting.length > 0 && plantRow.companyCode
      ? await controllingAreaFor(tx, input.client, plantRow.companyCode)
      : null;
    const values = {
      description: text,
      personResponsible: asTyped(headerRest.personResponsible, 'Person responsible', /^[A-Z0-9]{1,3}$/, 3),
      location: asLocation(headerRest.location),
      usage: asTyped(headerRest.usage, 'Usage', /^[A-Z0-9]{1,3}$/, 3),
      standardValueKey,
      controlKey: asTyped(headerRest.controlKey, 'Control key', /^[A-Z0-9]{1,4}$/, 4),
      deletionFlag: mode === 'CREATE' ? ' ' as const : flag(headerRest.deletionFlag, 'Deletion flag'),
      schedulingCapacityCategory: schedulingCategory,
      schedulingSetupFormula: setupFormula,
      schedulingProcessingFormula: processingFormula,
      schedulingTeardownFormula: teardownFormula,
    };
    if (mode === 'CREATE') {
      await tx.insert(workCenter).values({
        client: input.client,
        plant: plantCode,
        workCenter: centerCode,
        category: category.category,
        ...values,
        createdBy: input.changedBy,
      });
      await markActivityComplete(tx, input.client, WORK_CENTER_ACTIVITY, input.changedBy);
    } else {
      const updated = await tx.update(workCenter).set({
        ...values,
        version: before!.version + 1,
        changedBy: input.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(workCenter.client, input.client),
        eq(workCenter.plant, plantCode),
        eq(workCenter.workCenter, centerCode),
        eq(workCenter.version, before!.version),
      )).returning({ version: workCenter.version });
      if (updated.length === 0) fail('The work center was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    }
    await replaceChildren(
      tx,
      input.client,
      plantCode,
      centerCode,
      input.changedBy,
      preparedCapacities,
      preparedCosting.map((row) => ({ ...row, controllingArea: area ?? '' })),
    );
    const after = await readInTx(tx, input.client, plantCode, centerCode);
    if (!after) fail('The work center was not saved.');
    await recordChange(tx, {
      client: input.client,
      objectClass: WORK_CENTER_OBJECT,
      objectKey: `${plantCode}/${centerCode}`,
      changeType: mode === 'CREATE' ? 'CREATE' : 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: mode === 'CREATE' ? CREATE_ALIAS : CHANGE_ALIAS,
      before: before ? snapshot(before) : undefined,
      after: snapshot(after),
    });
    return after;
  });
}

function asLocation(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null;
  if (raw !== raw.trim()) fail('Location has surrounding spaces. They were not removed. Nothing was saved.');
  if (raw.length > 10) fail('Location is longer than 10 characters. It was not truncated.');
  return raw;
}

export async function createWorkCenter(input: WorkCenterInput): Promise<WorkCenterView> {
  return writeCenter(input, 'CREATE');
}

export async function changeWorkCenter(input: WorkCenterInput): Promise<WorkCenterView> {
  return writeCenter(input, 'CHANGE');
}
