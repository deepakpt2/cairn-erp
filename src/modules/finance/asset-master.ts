/**
 * Fixed asset master — SCR-091 / R-139 (AS01 create, AS02 change).
 *
 * Master data only: creating or changing an asset posts nothing,
 * retires nothing and depreciates nothing. Identity stands under
 * the complete key (tenant, company, main number, sub-number);
 * assignments are effective-dated intervals whose history is
 * never rewritten; depreciation parameters stand per configured
 * area with useful life as years and periods apart. Changes are
 * version-checked, identity and asset class immutable, and every
 * write lands on the standing change-document audit.
 *
 * Stage 1 carries the vocabulary only; the service lands in
 * stage 3 of R-139.
 */
export const ASSET_CREATE_CAPABILITY = 'FIN.ASSET.CREATE';
export const ASSET_CHANGE_CAPABILITY = 'FIN.ASSET.CHANGE';

export class AssetMasterError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AssetMasterError';
    this.remedy = remedy;
  }
}

export interface AssetAssignmentView {
  validFrom: string;
  validTo: string | null;
  costCenter: string | null;
  profitCenter: string | null;
  plant: string | null;
  location: string | null;
}

export interface AssetDepreciationView {
  areaCode: string;
  depreciationKey: string;
  usefulLifeYears: number;
  usefulLifePeriods: number;
  depreciationStartDate: string | null;
}

export interface AssetView {
  companyCode: string;
  assetNumber: string;
  subNumber: string;
  assetClass: string;
  description1: string;
  description2: string | null;
  inventoryNumber: string | null;
  serialNumber: string | null;
  quantity: number | null;
  unitOfMeasure: string | null;
  capitalizationDate: string | null;
  deactivationDate: string | null;
  status: 'ACTIVE' | 'DEACTIVATED' | 'RETIRED';
  version: number;
  assignments: AssetAssignmentView[];
  depreciation: AssetDepreciationView[];
}

import { and, asc, eq, isNull } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { getCompanyCode } from '../../platform/periods';
import { costCenter, plant, profitCenter } from '../foundation/schema';
import {
  assetAssignment, assetClass, assetDepreciation, depreciationArea,
  depreciationKey, fixedAsset,
} from './schema';

export const ASSET_CLASS = 'fixed_asset';

type AssetRow = typeof fixedAsset.$inferSelect;

export interface AssetDepreciationInput {
  areaCode: string;
  depreciationKey: string;
  usefulLifeYears: number;
  usefulLifePeriods: number;
  depreciationStartDate?: string;
}

export interface AssetAssignmentInput {
  validFrom: string;
  costCenter?: string;
  profitCenter?: string;
  plant?: string;
  location?: string;
}

export interface CreateAssetInput {
  client: string;
  changedBy: string;
  companyCode: string;
  assetClass: string;
  similarCount?: number;
  assetNumber?: string;
  subNumber?: string;
  description1: string;
  description2?: string;
  inventoryNumber?: string;
  serialNumber?: string;
  quantity?: number;
  unitOfMeasure?: string;
  capitalizationDate?: string;
  assignment: AssetAssignmentInput;
  depreciation?: AssetDepreciationInput[];
}

function dateOk(value: string | undefined): boolean {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function judgeAssignment(tx: Tx, client: string, companyCode: string, a: AssetAssignmentInput) {
  if (!dateOk(a.validFrom)) throw new AssetMasterError('The assignment valid-from date is not a calendar date.');
  if (a.costCenter) {
    const [cc] = await tx.select().from(costCenter).where(and(
      eq(costCenter.client, client), eq(costCenter.costCenter, a.costCenter),
    ));
    if (!cc) throw new AssetMasterError(`Cost centre ${a.costCenter} does not stand in this tenant.`, 'Correct the cost centre, then save again.');
    if (cc.companyCode !== companyCode) {
      throw new AssetMasterError(`Cost centre ${a.costCenter} stands in company ${cc.companyCode}, not ${companyCode}.`);
    }
  }
  if (a.profitCenter) {
    const [pc] = await tx.select().from(profitCenter).where(and(
      eq(profitCenter.client, client), eq(profitCenter.profitCenter, a.profitCenter),
    ));
    if (!pc) throw new AssetMasterError(`Profit centre ${a.profitCenter} does not stand in this tenant.`);
  }
  if (a.plant) {
    const [pl] = await tx.select({ plant: plant.plant }).from(plant).where(and(
      eq(plant.client, client), eq(plant.plant, a.plant),
    ));
    if (!pl) throw new AssetMasterError(`Plant ${a.plant} does not stand in this tenant.`);
  }
}

async function judgeDepreciation(
  tx: Tx, client: string, rows: AssetDepreciationInput[],
): Promise<AssetDepreciationInput[]> {
  if (rows.length === 0) {
    throw new AssetMasterError(
      'Give at least one depreciation area for the asset.',
      'Maintain the area parameters, or choose a class carrying defaults.',
    );
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.areaCode)) throw new AssetMasterError(`Depreciation area ${row.areaCode} stands twice.`);
    seen.add(row.areaCode);
    const [area] = await tx.select().from(depreciationArea).where(and(
      eq(depreciationArea.client, client), eq(depreciationArea.areaCode, row.areaCode),
    ));
    if (!area || !area.isActive) {
      throw new AssetMasterError(`Depreciation area ${row.areaCode} is not configured active in this tenant.`);
    }
    const [key] = await tx.select().from(depreciationKey).where(and(
      eq(depreciationKey.client, client), eq(depreciationKey.keyCode, row.depreciationKey),
    ));
    if (!key || !key.isActive) {
      throw new AssetMasterError(`Depreciation key ${row.depreciationKey} is not configured active in this tenant.`);
    }
    if (!(row.usefulLifeYears >= 0) || row.usefulLifePeriods < 0 || row.usefulLifePeriods > 11
      || row.usefulLifeYears * 12 + row.usefulLifePeriods <= 0) {
      throw new AssetMasterError('Useful life must stand positive: years at zero or above, periods within 0–11, and the two together above zero.');
    }
  }
  return rows;
}

async function loadView(tx: Tx, client: string, row: AssetRow): Promise<AssetView> {
  const assignments = await tx.select().from(assetAssignment).where(and(
    eq(assetAssignment.client, client), eq(assetAssignment.companyCode, row.companyCode),
    eq(assetAssignment.assetNumber, row.assetNumber), eq(assetAssignment.subNumber, row.subNumber),
  )).orderBy(asc(assetAssignment.validFrom));
  const depreciation = await tx.select().from(assetDepreciation).where(and(
    eq(assetDepreciation.client, client), eq(assetDepreciation.companyCode, row.companyCode),
    eq(assetDepreciation.assetNumber, row.assetNumber), eq(assetDepreciation.subNumber, row.subNumber),
  )).orderBy(asc(assetDepreciation.areaCode));
  return {
    companyCode: row.companyCode, assetNumber: row.assetNumber, subNumber: row.subNumber,
    assetClass: row.assetClass, description1: row.description1, description2: row.description2,
    inventoryNumber: row.inventoryNumber, serialNumber: row.serialNumber,
    quantity: row.quantity === null ? null : Number(row.quantity),
    unitOfMeasure: row.unitOfMeasure,
    capitalizationDate: row.capitalizationDate, deactivationDate: row.deactivationDate,
    status: row.status as AssetView['status'], version: row.version,
    assignments: assignments.map((a) => ({
      validFrom: a.validFrom, validTo: a.validTo, costCenter: a.costCenter,
      profitCenter: a.profitCenter, plant: a.plant, location: a.location,
    })),
    depreciation: depreciation.map((d) => ({
      areaCode: d.areaCode, depreciationKey: d.depreciationKey,
      usefulLifeYears: d.usefulLifeYears, usefulLifePeriods: d.usefulLifePeriods,
      depreciationStartDate: d.depreciationStartDate,
    })),
  };
}

const keyOf = (companyCode: string, assetNumber: string, subNumber: string) =>
  `${companyCode}/${assetNumber}/${subNumber}`;

export async function createAsset(input: CreateAssetInput): Promise<AssetView[]> {
  const count = input.similarCount ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new AssetMasterError('The number of similar assets must stand between 1 and 100.');
  }
  if (!input.description1?.trim()) throw new AssetMasterError('Description 1 is required.');
  if (input.description1.length > 50) throw new AssetMasterError('Description 1 may be at most 50 characters.');
  if (input.description2 && input.description2.length > 25) {
    throw new AssetMasterError('Description 2 may be at most 25 characters.');
  }
  const subNumber = (input.subNumber ?? '0000').trim() || '0000';
  if (subNumber !== '0000' && count > 1) {
    throw new AssetMasterError('Similar assets create distinct main numbers; sub-numbers are created one at a time.');
  }
  if (!dateOk(input.capitalizationDate)) throw new AssetMasterError('The capitalization date is not a calendar date.');

  return withTenant(input.client, async (tx) => {
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company) throw new AssetMasterError(`Company code ${input.companyCode} is not configured in this tenant.`);
    const [klass] = await tx.select().from(assetClass).where(and(
      eq(assetClass.client, input.client), eq(assetClass.assetClass, input.assetClass),
    ));
    if (!klass || !klass.isActive) {
      throw new AssetMasterError(
        `Asset class ${input.assetClass} is not configured active in this tenant.`,
        'Configure the asset class, then create the asset.',
      );
    }
    if (klass.quantityManaged && (input.quantity === undefined || !input.unitOfMeasure)) {
      throw new AssetMasterError(`Asset class ${input.assetClass} manages quantity: give a quantity and unit of measure.`);
    }
    if (input.quantity !== undefined && !(input.quantity > 0)) {
      throw new AssetMasterError('Quantity must stand above zero.');
    }
    await judgeAssignment(tx, input.client, input.companyCode, input.assignment);

    let depreciation = input.depreciation ?? [];
    if (depreciation.length === 0 && klass.defaultDepreciationKey) {
      const [firstArea] = await tx.select().from(depreciationArea).where(and(
        eq(depreciationArea.client, input.client), eq(depreciationArea.isActive, true),
      )).orderBy(asc(depreciationArea.areaCode));
      if (firstArea) {
        depreciation = [{
          areaCode: firstArea.areaCode, depreciationKey: klass.defaultDepreciationKey,
          usefulLifeYears: klass.defaultUsefulLifeYears ?? 0,
          usefulLifePeriods: klass.defaultUsefulLifePeriods ?? 0,
        }];
      }
    }
    depreciation = await judgeDepreciation(tx, input.client, depreciation);

    const numbers: string[] = [];
    if (subNumber !== '0000') {
      const main = (input.assetNumber ?? '').trim();
      if (!main) throw new AssetMasterError('A sub-number names its main asset number.');
      const [mainRow] = await tx.select({ assetNumber: fixedAsset.assetNumber }).from(fixedAsset).where(and(
        eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
        eq(fixedAsset.assetNumber, main), eq(fixedAsset.subNumber, '0000'),
      ));
      if (!mainRow) {
        throw new AssetMasterError(`Main asset ${main} does not stand in company ${input.companyCode}; create it before its sub-numbers.`);
      }
      numbers.push(main);
    } else if (klass.numbering === 'EXTERNAL') {
      const supplied = (input.assetNumber ?? '').trim();
      if (!supplied) {
        throw new AssetMasterError(`Asset class ${input.assetClass} numbers externally: supply the asset number.`);
      }
      if (count > 1) {
        throw new AssetMasterError('External numbering names one asset; similar assets under external numbering are created one at a time.');
      }
      numbers.push(supplied);
    } else {
      if ((input.assetNumber ?? '').trim()) {
        throw new AssetMasterError(`Asset class ${input.assetClass} numbers internally; the number is drawn, not supplied.`);
      }
      for (let i = 0; i < count; i += 1) {
        const allocated = await allocateNumber(tx, {
          client: input.client, objectCode: 'ASSETNR', allocatedBy: input.changedBy,
        });
        numbers.push(allocated.display);
      }
    }

    if (input.inventoryNumber && count > 1) {
      throw new AssetMasterError(
        'Inventory numbers are unique per asset; similar assets cannot share one.',
        'Create them one at a time so each carries its own inventory number.',
      );
    }
    if (input.inventoryNumber) {
      const [dupe] = await tx.select({ assetNumber: fixedAsset.assetNumber }).from(fixedAsset).where(and(
        eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
        eq(fixedAsset.inventoryNumber, input.inventoryNumber),
      ));
      if (dupe) {
        throw new AssetMasterError(`Inventory number ${input.inventoryNumber} already stands on asset ${dupe.assetNumber} in company ${input.companyCode}.`);
      }
    }

    const created: AssetView[] = [];
    for (const assetNumber of numbers) {
      const [existing] = await tx.select({ assetNumber: fixedAsset.assetNumber }).from(fixedAsset).where(and(
        eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
        eq(fixedAsset.assetNumber, assetNumber), eq(fixedAsset.subNumber, subNumber),
      ));
      if (existing) {
        throw new AssetMasterError(`Asset ${assetNumber}/${subNumber} already stands in company ${input.companyCode}.`);
      }
      await tx.insert(fixedAsset).values({
        client: input.client, companyCode: input.companyCode,
        assetNumber, subNumber, assetClass: input.assetClass,
        description1: input.description1, description2: input.description2 ?? null,
        inventoryNumber: input.inventoryNumber ?? null, serialNumber: input.serialNumber ?? null,
        quantity: input.quantity === undefined ? null : String(input.quantity),
        unitOfMeasure: input.unitOfMeasure ?? null,
        capitalizationDate: input.capitalizationDate ?? null,
        status: 'ACTIVE', version: 1, createdBy: input.changedBy,
      });
      await tx.insert(assetAssignment).values({
        client: input.client, companyCode: input.companyCode, assetNumber, subNumber,
        validFrom: input.assignment.validFrom,
        costCenter: input.assignment.costCenter ?? null,
        profitCenter: input.assignment.profitCenter ?? null,
        plant: input.assignment.plant ?? null, location: input.assignment.location ?? null,
        createdBy: input.changedBy,
      });
      for (const row of depreciation) {
        await tx.insert(assetDepreciation).values({
          client: input.client, companyCode: input.companyCode, assetNumber, subNumber,
          areaCode: row.areaCode, depreciationKey: row.depreciationKey,
          usefulLifeYears: row.usefulLifeYears, usefulLifePeriods: row.usefulLifePeriods,
          depreciationStartDate: row.depreciationStartDate ?? null,
          createdBy: input.changedBy,
        });
      }
      await recordChange(tx, {
        client: input.client, objectClass: ASSET_CLASS,
        objectKey: keyOf(input.companyCode, assetNumber, subNumber),
        changeType: 'CREATE', changedBy: input.changedBy, transactionCode: ASSET_CREATE_CAPABILITY,
        after: { assetClass: input.assetClass, status: 'ACTIVE', version: 1 },
      });
      const [row] = await tx.select().from(fixedAsset).where(and(
        eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
        eq(fixedAsset.assetNumber, assetNumber), eq(fixedAsset.subNumber, subNumber),
      ));
      created.push(await loadView(tx, input.client, row));
    }
    return created;
  });
}

async function lockedAsset(
  tx: Tx, client: string, companyCode: string, assetNumber: string, subNumber: string,
): Promise<AssetRow> {
  const [row] = await tx.select().from(fixedAsset).where(and(
    eq(fixedAsset.client, client), eq(fixedAsset.companyCode, companyCode),
    eq(fixedAsset.assetNumber, assetNumber), eq(fixedAsset.subNumber, subNumber),
  )).for('update');
  if (!row) {
    throw new AssetMasterError(
      `Asset ${assetNumber}/${subNumber} does not stand in company ${companyCode}.`,
      'Reload the asset list, then change it again.',
    );
  }
  return row;
}

function judgeVersion(row: AssetRow, expectedVersion: number) {
  if (row.version !== expectedVersion) {
    throw new AssetMasterError(
      `Asset ${row.assetNumber}/${row.subNumber} has changed since it was loaded (version ${row.version}).`,
      'Reload the asset, then apply your changes again.',
    );
  }
  if (row.status !== 'ACTIVE') {
    throw new AssetMasterError(`Asset ${row.assetNumber}/${row.subNumber} stands deactivated and takes no master changes.`);
  }
}

export async function changeAsset(input: {
  client: string; changedBy: string; companyCode: string; assetNumber: string; subNumber: string;
  expectedVersion: number;
  description1?: string; description2?: string | null; inventoryNumber?: string | null;
  serialNumber?: string | null; quantity?: number | null; unitOfMeasure?: string | null;
  capitalizationDate?: string | null;
}): Promise<AssetView> {
  if (input.description1 !== undefined) {
    if (!input.description1.trim()) throw new AssetMasterError('Description 1 is required.');
    if (input.description1.length > 50) throw new AssetMasterError('Description 1 may be at most 50 characters.');
  }
  if (input.description2 && input.description2.length > 25) {
    throw new AssetMasterError('Description 2 may be at most 25 characters.');
  }
  return withTenant(input.client, async (tx) => {
    const row = await lockedAsset(tx, input.client, input.companyCode, input.assetNumber, input.subNumber);
    judgeVersion(row, input.expectedVersion);
    if (input.inventoryNumber) {
      const [dupe] = await tx.select({ assetNumber: fixedAsset.assetNumber }).from(fixedAsset).where(and(
        eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
        eq(fixedAsset.inventoryNumber, input.inventoryNumber),
      ));
      if (dupe && dupe.assetNumber !== input.assetNumber) {
        throw new AssetMasterError(`Inventory number ${input.inventoryNumber} already stands on asset ${dupe.assetNumber}.`);
      }
    }
    const patch: Partial<AssetRow> = { version: row.version + 1, changedBy: input.changedBy, changedAt: new Date() };
    if (input.description1 !== undefined) patch.description1 = input.description1;
    if (input.description2 !== undefined) patch.description2 = input.description2;
    if (input.inventoryNumber !== undefined) patch.inventoryNumber = input.inventoryNumber;
    if (input.serialNumber !== undefined) patch.serialNumber = input.serialNumber;
    if (input.quantity !== undefined) patch.quantity = input.quantity === null ? null : String(input.quantity);
    if (input.unitOfMeasure !== undefined) patch.unitOfMeasure = input.unitOfMeasure;
    if (input.capitalizationDate !== undefined) patch.capitalizationDate = input.capitalizationDate;
    await tx.update(fixedAsset).set(patch).where(and(
      eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
      eq(fixedAsset.assetNumber, input.assetNumber), eq(fixedAsset.subNumber, input.subNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: ASSET_CLASS,
      objectKey: keyOf(input.companyCode, input.assetNumber, input.subNumber),
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: ASSET_CHANGE_CAPABILITY,
      before: { description1: row.description1, version: row.version },
      after: { description1: patch.description1 ?? row.description1, version: row.version + 1 },
    });
    const [fresh] = await tx.select().from(fixedAsset).where(and(
      eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
      eq(fixedAsset.assetNumber, input.assetNumber), eq(fixedAsset.subNumber, input.subNumber),
    ));
    return loadView(tx, input.client, fresh);
  });
}

export async function changeAssetAssignment(input: {
  client: string; changedBy: string; companyCode: string; assetNumber: string; subNumber: string;
  expectedVersion: number; assignment: AssetAssignmentInput;
}): Promise<AssetView> {
  return withTenant(input.client, async (tx) => {
    const row = await lockedAsset(tx, input.client, input.companyCode, input.assetNumber, input.subNumber);
    judgeVersion(row, input.expectedVersion);
    await judgeAssignment(tx, input.client, input.companyCode, input.assignment);
    const [open] = await tx.select().from(assetAssignment).where(and(
      eq(assetAssignment.client, input.client), eq(assetAssignment.companyCode, input.companyCode),
      eq(assetAssignment.assetNumber, input.assetNumber), eq(assetAssignment.subNumber, input.subNumber),
      isNull(assetAssignment.validTo),
    ));
    if (open) {
      if (input.assignment.validFrom <= open.validFrom) {
        throw new AssetMasterError(
          `The new assignment from ${input.assignment.validFrom} would overlap the standing interval from ${open.validFrom}.`,
          'Choose a later valid-from date; history is never rewritten.',
        );
      }
      await tx.update(assetAssignment).set({
        validTo: input.assignment.validFrom, changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(assetAssignment.client, input.client), eq(assetAssignment.companyCode, input.companyCode),
        eq(assetAssignment.assetNumber, input.assetNumber), eq(assetAssignment.subNumber, input.subNumber),
        eq(assetAssignment.validFrom, open.validFrom),
      ));
    }
    await tx.insert(assetAssignment).values({
      client: input.client, companyCode: input.companyCode,
      assetNumber: input.assetNumber, subNumber: input.subNumber,
      validFrom: input.assignment.validFrom,
      costCenter: input.assignment.costCenter ?? null,
      profitCenter: input.assignment.profitCenter ?? null,
      plant: input.assignment.plant ?? null, location: input.assignment.location ?? null,
      createdBy: input.changedBy,
    });
    await tx.update(fixedAsset).set({
      version: row.version + 1, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
      eq(fixedAsset.assetNumber, input.assetNumber), eq(fixedAsset.subNumber, input.subNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: ASSET_CLASS,
      objectKey: keyOf(input.companyCode, input.assetNumber, input.subNumber),
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: ASSET_CHANGE_CAPABILITY,
      after: { assignmentFrom: input.assignment.validFrom, version: row.version + 1 },
    });
    const [fresh] = await tx.select().from(fixedAsset).where(and(
      eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
      eq(fixedAsset.assetNumber, input.assetNumber), eq(fixedAsset.subNumber, input.subNumber),
    ));
    return loadView(tx, input.client, fresh);
  });
}

export async function changeAssetDepreciation(input: {
  client: string; changedBy: string; companyCode: string; assetNumber: string; subNumber: string;
  expectedVersion: number; depreciation: AssetDepreciationInput;
}): Promise<AssetView> {
  return withTenant(input.client, async (tx) => {
    const row = await lockedAsset(tx, input.client, input.companyCode, input.assetNumber, input.subNumber);
    judgeVersion(row, input.expectedVersion);
    const [judged] = await judgeDepreciation(tx, input.client, [input.depreciation]);
    const [existing] = await tx.select().from(assetDepreciation).where(and(
      eq(assetDepreciation.client, input.client), eq(assetDepreciation.companyCode, input.companyCode),
      eq(assetDepreciation.assetNumber, input.assetNumber), eq(assetDepreciation.subNumber, input.subNumber),
      eq(assetDepreciation.areaCode, judged.areaCode),
    ));
    if (existing) {
      await tx.update(assetDepreciation).set({
        depreciationKey: judged.depreciationKey,
        usefulLifeYears: judged.usefulLifeYears, usefulLifePeriods: judged.usefulLifePeriods,
        depreciationStartDate: judged.depreciationStartDate ?? null,
        changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(assetDepreciation.client, input.client), eq(assetDepreciation.companyCode, input.companyCode),
        eq(assetDepreciation.assetNumber, input.assetNumber), eq(assetDepreciation.subNumber, input.subNumber),
        eq(assetDepreciation.areaCode, judged.areaCode),
      ));
    } else {
      await tx.insert(assetDepreciation).values({
        client: input.client, companyCode: input.companyCode,
        assetNumber: input.assetNumber, subNumber: input.subNumber,
        areaCode: judged.areaCode, depreciationKey: judged.depreciationKey,
        usefulLifeYears: judged.usefulLifeYears, usefulLifePeriods: judged.usefulLifePeriods,
        depreciationStartDate: judged.depreciationStartDate ?? null,
        createdBy: input.changedBy,
      });
    }
    await tx.update(fixedAsset).set({
      version: row.version + 1, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
      eq(fixedAsset.assetNumber, input.assetNumber), eq(fixedAsset.subNumber, input.subNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: ASSET_CLASS,
      objectKey: keyOf(input.companyCode, input.assetNumber, input.subNumber),
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: ASSET_CHANGE_CAPABILITY,
      before: existing ? { area: judged.areaCode, key: existing.depreciationKey, years: existing.usefulLifeYears } : undefined,
      after: { area: judged.areaCode, key: judged.depreciationKey, years: judged.usefulLifeYears, effect: 'PROSPECTIVE', version: row.version + 1 },
    });
    const [fresh] = await tx.select().from(fixedAsset).where(and(
      eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
      eq(fixedAsset.assetNumber, input.assetNumber), eq(fixedAsset.subNumber, input.subNumber),
    ));
    return loadView(tx, input.client, fresh);
  });
}

export async function deactivateAsset(input: {
  client: string; changedBy: string; companyCode: string; assetNumber: string; subNumber: string;
  expectedVersion: number; deactivationDate: string; reason?: string;
}): Promise<AssetView> {
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new AssetMasterError('A reason is required to deactivate an asset.', 'State why the asset is deactivated.');
  if (!dateOk(input.deactivationDate)) throw new AssetMasterError('The deactivation date is not a calendar date.');
  return withTenant(input.client, async (tx) => {
    const row = await lockedAsset(tx, input.client, input.companyCode, input.assetNumber, input.subNumber);
    if (row.status === 'DEACTIVATED') return loadView(tx, input.client, row);
    judgeVersion(row, input.expectedVersion);
    if (row.capitalizationDate && input.deactivationDate < row.capitalizationDate) {
      throw new AssetMasterError('The deactivation date precedes the capitalization date.');
    }
    await tx.update(fixedAsset).set({
      status: 'DEACTIVATED', deactivationDate: input.deactivationDate,
      version: row.version + 1, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
      eq(fixedAsset.assetNumber, input.assetNumber), eq(fixedAsset.subNumber, input.subNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: ASSET_CLASS,
      objectKey: keyOf(input.companyCode, input.assetNumber, input.subNumber),
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: ASSET_CHANGE_CAPABILITY,
      reason, after: { status: 'DEACTIVATED', deactivationDate: input.deactivationDate, version: row.version + 1 },
    });
    const [fresh] = await tx.select().from(fixedAsset).where(and(
      eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
      eq(fixedAsset.assetNumber, input.assetNumber), eq(fixedAsset.subNumber, input.subNumber),
    ));
    return loadView(tx, input.client, fresh);
  });
}

export async function getAsset(
  client: string, companyCode: string, assetNumber: string, subNumber: string,
): Promise<AssetView | null> {
  return withTenant(client, async (tx) => {
    const [row] = await tx.select().from(fixedAsset).where(and(
      eq(fixedAsset.client, client), eq(fixedAsset.companyCode, companyCode),
      eq(fixedAsset.assetNumber, assetNumber), eq(fixedAsset.subNumber, subNumber),
    ));
    return row ? loadView(tx, client, row) : null;
  });
}

export async function listAssets(client: string, companyCode?: string): Promise<AssetView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(fixedAsset).where(eq(fixedAsset.client, client))
      .orderBy(asc(fixedAsset.companyCode), asc(fixedAsset.assetNumber), asc(fixedAsset.subNumber));
    const views: AssetView[] = [];
    for (const row of rows) {
      if (companyCode && row.companyCode !== companyCode) continue;
      views.push(await loadView(tx, client, row));
    }
    return views;
  });
}
