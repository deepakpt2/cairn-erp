/**
 * Plant structural bill levels.
 *
 * The result is a potential level, not a chosen production version and not
 * a quantity explosion. It writes nothing: no run row, no dependent
 * requirement, no planned order, and no requisition. Diagnostics are
 * returned to the caller and are not stored as run warnings.
 *
 * A version is included when quantity selection could return it for some
 * date and quantity. Date, lot range, and overlap are not filters. The
 * first version is not chosen. Findings are not run again. Staleness is
 * the same comparison used when a version is read for selection.
 */
import { and, asc, eq } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { materialPlant } from '../inventory/schema';
import { materialBom, materialBomItem, productionVersion, routing } from './schema';

/** Matches the quantity-explosion depth. A component below this level is not assigned. */
export const STRUCTURAL_DEPTH_LIMIT = 20;

export interface StructuralRoot {
  materialNumber: string;
  plant: string;
}

export interface StructuralLevel {
  materialNumber: string;
  plant: string;
  level: number;
}

export interface StructuralDiagnostic {
  severity: 'WARNING';
  code: 'BOM_CYCLE' | 'DEPTH_LIMIT';
  materialNumber: string;
  plant: string;
  message: string;
}

export interface StructuralBomLevels {
  levels: StructuralLevel[];
  diagnostics: StructuralDiagnostic[];
}

interface VersionCandidate {
  productionVersion: string;
  bomUsage: string;
  bomAlternative: string;
}

function keyOf(plant: string, materialNumber: string): string {
  return `${plant}/${materialNumber}`;
}

function isStale(
  checkStatus: string,
  checkedBomVersion: number | null,
  checkedRoutingVersion: number | null,
  checkedPlantVersion: number | null,
  bomVersion: number | null,
  routingVersion: number | null,
  plantVersion: number | null,
): boolean {
  return checkStatus !== ' ' && (
    checkedBomVersion !== bomVersion
    || checkedRoutingVersion !== routingVersion
    || checkedPlantVersion !== plantVersion
  );
}

/**
 * Levels for the given roots and every component reached through an included bill.
 * Unselected components are returned in the map and are not inserted anywhere.
 */
export async function structuralBomLevels(
  tx: Tx,
  input: { client: string; roots: readonly StructuralRoot[] },
): Promise<StructuralBomLevels> {
  const client = input.client;
  const levels = new Map<string, number>();
  const names = new Map<string, { materialNumber: string; plant: string }>();
  const diagnostics: StructuralDiagnostic[] = [];
  const seenDiagnostic = new Set<string>();
  const procurement = new Map<string, string | null>();
  const versionsByMaterial = new Map<string, VersionCandidate[]>();
  const walked = new Set<string>();

  const remember = (plant: string, materialNumber: string) => {
    const key = keyOf(plant, materialNumber);
    if (!names.has(key)) names.set(key, { materialNumber, plant });
    return key;
  };

  const raise = (plant: string, materialNumber: string, level: number) => {
    const key = remember(plant, materialNumber);
    const current = levels.get(key);
    if (current == null || level > current) levels.set(key, level);
  };

  const record = (diagnostic: StructuralDiagnostic) => {
    const key = `${diagnostic.code}/${diagnostic.plant}/${diagnostic.materialNumber}/${diagnostic.message}`;
    if (seenDiagnostic.has(key)) return;
    seenDiagnostic.add(key);
    diagnostics.push(diagnostic);
  };

  const procurementOf = async (plant: string, materialNumber: string): Promise<string | null> => {
    const key = keyOf(plant, materialNumber);
    const cached = procurement.get(key);
    if (cached !== undefined) return cached;
    const [row] = await tx.select({ procurementType: materialPlant.procurementType }).from(materialPlant).where(and(
      eq(materialPlant.client, client),
      eq(materialPlant.materialNumber, materialNumber),
      eq(materialPlant.plant, plant),
    ));
    const value = row?.procurementType ?? null;
    procurement.set(key, value);
    return value;
  };

  const eligibleVersions = async (plant: string, materialNumber: string): Promise<VersionCandidate[]> => {
    const key = keyOf(plant, materialNumber);
    const cached = versionsByMaterial.get(key);
    if (cached) return cached;
    const headers = await tx.select().from(productionVersion).where(and(
      eq(productionVersion.client, client),
      eq(productionVersion.materialNumber, materialNumber),
      eq(productionVersion.plant, plant),
      eq(productionVersion.deletionFlag, ' '),
    )).orderBy(asc(productionVersion.productionVersion));
    const eligible: VersionCandidate[] = [];
    for (const header of headers) {
      if (header.lockIndicator === '1') continue;
      if (header.checkStatus !== '1' && header.checkStatus !== '2') continue;
      const [bom] = await tx.select({ version: materialBom.version }).from(materialBom).where(and(
        eq(materialBom.client, client),
        eq(materialBom.materialNumber, materialNumber),
        eq(materialBom.plant, plant),
        eq(materialBom.usage, header.bomUsage),
        eq(materialBom.alternative, header.bomAlternative),
      ));
      const [route] = await tx.select({ version: routing.version }).from(routing).where(and(
        eq(routing.client, client),
        eq(routing.taskListType, header.taskListType),
        eq(routing.routingGroup, header.routingGroup),
        eq(routing.groupCounter, header.groupCounter),
      ));
      const [plantView] = await tx.select({ version: materialPlant.version }).from(materialPlant).where(and(
        eq(materialPlant.client, client),
        eq(materialPlant.materialNumber, materialNumber),
        eq(materialPlant.plant, plant),
      ));
      if (isStale(
        header.checkStatus,
        header.checkedBomVersion,
        header.checkedRoutingVersion,
        header.checkedPlantVersion,
        bom?.version ?? null,
        route?.version ?? null,
        plantView?.version ?? null,
      )) continue;
      eligible.push({
        productionVersion: header.productionVersion,
        bomUsage: header.bomUsage,
        bomAlternative: header.bomAlternative,
      });
    }
    versionsByMaterial.set(key, eligible);
    return eligible;
  };

  const itemsOf = async (plant: string, materialNumber: string, version: VersionCandidate) => {
    const [header] = await tx.select({ deletionFlag: materialBom.deletionFlag }).from(materialBom).where(and(
      eq(materialBom.client, client),
      eq(materialBom.materialNumber, materialNumber),
      eq(materialBom.plant, plant),
      eq(materialBom.usage, version.bomUsage),
      eq(materialBom.alternative, version.bomAlternative),
    ));
    if (!header || header.deletionFlag === 'X') return [];
    return tx.select({
      itemNumber: materialBomItem.itemNumber,
      componentMaterial: materialBomItem.componentMaterial,
      bulkMaterial: materialBomItem.bulkMaterial,
      phantom: materialBomItem.phantom,
      coproduct: materialBomItem.coproduct,
      specialProcurement: materialBomItem.specialProcurement,
      issuingPlant: materialBomItem.issuingPlant,
      deletionFlag: materialBomItem.deletionFlag,
    }).from(materialBomItem).where(and(
      eq(materialBomItem.client, client),
      eq(materialBomItem.materialNumber, materialNumber),
      eq(materialBomItem.plant, plant),
      eq(materialBomItem.usage, version.bomUsage),
      eq(materialBomItem.alternative, version.bomAlternative),
      eq(materialBomItem.deletionFlag, ' '),
    )).orderBy(asc(materialBomItem.itemNumber));
  };

  const walk = async (plant: string, materialNumber: string, level: number, path: readonly string[]): Promise<void> => {
    const mark = `${keyOf(plant, materialNumber)}/${level}`;
    if (walked.has(mark)) return;
    walked.add(mark);
    if (level >= STRUCTURAL_DEPTH_LIMIT) {
      record({
        severity: 'WARNING',
        code: 'DEPTH_LIMIT',
        materialNumber,
        plant,
        message: `${materialNumber} is below the explosion depth. The branch stopped.`,
      });
      return;
    }
    if ((await procurementOf(plant, materialNumber)) !== 'MAKE') return;
    for (const version of await eligibleVersions(plant, materialNumber)) {
      for (const item of await itemsOf(plant, materialNumber, version)) {
        const component = item.componentMaterial?.trim() ?? '';
        if (!component || item.coproduct === 'X') continue;
        if (item.bulkMaterial === 'X') continue;
        if (item.issuingPlant && item.issuingPlant !== plant) continue;
        if (item.specialProcurement?.trim()) continue;
        if (path.includes(component)) {
          record({
            severity: 'WARNING',
            code: 'BOM_CYCLE',
            materialNumber: component,
            plant,
            message: `${component} is already on this explosion. The branch stopped.`,
          });
          continue;
        }
        if (item.phantom === 'X') {
          await walkPhantom(plant, component, level, [...path, component]);
          continue;
        }
        raise(plant, component, level + 1);
        await walk(plant, component, level + 1, [...path, component]);
      }
    }
  };

  const walkPhantom = async (plant: string, phantom: string, parentLevel: number, path: readonly string[]): Promise<void> => {
    if (parentLevel >= STRUCTURAL_DEPTH_LIMIT) {
      record({
        severity: 'WARNING',
        code: 'DEPTH_LIMIT',
        materialNumber: phantom,
        plant,
        message: `${phantom} is below the explosion depth. The branch stopped.`,
      });
      return;
    }
    for (const version of await eligibleVersions(plant, phantom)) {
      for (const item of await itemsOf(plant, phantom, version)) {
        const component = item.componentMaterial?.trim() ?? '';
        if (!component || item.phantom === 'X' || item.bulkMaterial === 'X') continue;
        if (path.includes(component)) {
          record({
            severity: 'WARNING',
            code: 'BOM_CYCLE',
            materialNumber: component,
            plant,
            message: `${component} is already on this explosion. The branch stopped.`,
          });
          continue;
        }
        raise(plant, component, parentLevel + 1);
        await walk(plant, component, parentLevel + 1, [...path, component]);
      }
    }
  };

  const roots = [...input.roots].sort((left, right) => (
    left.plant === right.plant
      ? left.materialNumber < right.materialNumber ? -1 : left.materialNumber > right.materialNumber ? 1 : 0
      : left.plant < right.plant ? -1 : 1
  ));
  for (const root of roots) {
    const materialNumber = root.materialNumber.trim();
    const plant = root.plant.trim();
    if (!materialNumber || !plant) continue;
    raise(plant, materialNumber, 0);
  }
  for (const root of roots) {
    const materialNumber = root.materialNumber.trim();
    const plant = root.plant.trim();
    if (!materialNumber || !plant) continue;
    const level = levels.get(keyOf(plant, materialNumber)) ?? 0;
    await walk(plant, materialNumber, level, [materialNumber]);
  }

  return {
    levels: [...names.values()]
      .map((row) => ({ ...row, level: levels.get(keyOf(row.plant, row.materialNumber)) ?? 0 }))
      .sort((left, right) => (
        left.plant === right.plant
          ? left.materialNumber < right.materialNumber ? -1 : left.materialNumber > right.materialNumber ? 1 : 0
          : left.plant < right.plant ? -1 : 1
      )),
    diagnostics: diagnostics.sort((left, right) => (
      left.code === right.code
        ? left.plant === right.plant
          ? left.materialNumber === right.materialNumber
            ? left.message < right.message ? -1 : left.message > right.message ? 1 : 0
            : left.materialNumber < right.materialNumber ? -1 : 1
          : left.plant < right.plant ? -1 : 1
        : left.code < right.code ? -1 : 1
    )),
  };
}
