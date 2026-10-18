/**
 * Characteristics for classification — SCR-057 / R-105 (CT04).
 *
 * The tenant vocabulary classification judges by. A characteristic is
 * born DRAFT, activates through its act, and blocks rather than
 * deletes once it has lived; hard deletion stands only for a draft
 * that never carried values. The lifecycle is a Cairn workflow, not an
 * SAP status. Maintenance is never a period act. Language-dependent
 * descriptions are deferred (B-223) — the description stands in the
 * tenant language. Class assignments do not exist yet, so the usage
 * count stands at zero; the structural judges read it so the class
 * round only has to give it rows.
 */
import { and, asc, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { currency as currencyReference, unitOfMeasure } from '../../platform/tables/reference';
import { characteristic, characteristicValue } from './characteristic-schema';

export const ACTIVITY = 'CFG.PROC.CHARACTERISTIC.DEFINE';
const OBJECT_CLASS = 'characteristic';
const PRODUCTION = process.env.NODE_ENV === 'production';

export const DATA_FORMATS = ['CHAR', 'NUM', 'DATE', 'TIME', 'CURR'] as const;
export type DataFormat = (typeof DATA_FORMATS)[number];

export class CharacteristicError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CharacteristicError';
    this.remedy = remedy;
  }
}

function requireClient(client: string): string {
  const value = client?.trim() ?? '';
  if (!value) throw new CharacteristicError('The tenant is missing.', 'Sign in again.');
  return value;
}

function requireActor(changedBy: string): string {
  const value = changedBy?.trim() ?? '';
  if (!value) throw new CharacteristicError('The acting user is missing.', 'Sign in again.');
  return PRODUCTION ? value : value.toUpperCase();
}

function requireReason(reason: string): string {
  const value = reason?.trim() ?? '';
  if (!value) {
    throw new CharacteristicError(
      'A reason is required for every characteristic change.',
      'State why this change is being made.',
    );
  }
  return value;
}

function requireName(raw: string): string {
  const name = (raw ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,30}$/.test(name)) {
    throw new CharacteristicError(
      'The characteristic name is at most 30 characters of uppercase letters, digits and underscores.',
      'Correct the name and save again.',
    );
  }
  return name;
}

/** Class assignments land with the class round; until then usage is zero. */
async function usageCount(): Promise<number> {
  return 0;
}

export interface CharacteristicRow {
  characteristicName: string;
  description: string;
  dataFormat: string;
  valueLength: number;
  decimalPlaces: number;
  unit: string | null;
  currency: string | null;
  negativeValuesAllowed: boolean;
  caseSensitive: boolean;
  intervalsAllowed: boolean;
  additionalValuesAllowed: boolean;
  valueAssignment: string;
  requiredEntry: boolean;
  lifecycleStatus: string;
  values: string[];
  createdBy: string;
  changedBy: string | null;
}

export async function listCharacteristics(clientKey: string): Promise<CharacteristicRow[]> {
  const client = requireClient(clientKey);
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(characteristic)
      .where(eq(characteristic.client, client))
      .orderBy(asc(characteristic.characteristicName));
    const values = await tx.select().from(characteristicValue)
      .where(eq(characteristicValue.client, client))
      .orderBy(asc(characteristicValue.characteristicName), asc(characteristicValue.sortOrder), asc(characteristicValue.valueText));
    return rows.map((row) => ({
      characteristicName: row.characteristicName,
      description: row.description,
      dataFormat: row.dataFormat,
      valueLength: row.valueLength,
      decimalPlaces: row.decimalPlaces,
      unit: row.unit,
      currency: row.currency,
      negativeValuesAllowed: row.negativeValuesAllowed,
      caseSensitive: row.caseSensitive,
      intervalsAllowed: row.intervalsAllowed,
      additionalValuesAllowed: row.additionalValuesAllowed,
      valueAssignment: row.valueAssignment,
      requiredEntry: row.requiredEntry,
      lifecycleStatus: row.lifecycleStatus,
      values: values.filter((v) => v.characteristicName === row.characteristicName).map((v) => v.valueText),
      createdBy: row.createdBy,
      changedBy: row.changedBy,
    }));
  });
}

export interface CharacteristicInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  characteristicName: string;
  description: string;
  dataFormat: string;
  valueLength: number;
  decimalPlaces: number;
  unit: string;
  currency: string;
  negativeValuesAllowed: boolean;
  caseSensitive: boolean;
  intervalsAllowed: boolean;
  additionalValuesAllowed: boolean;
  valueAssignment: string;
  requiredEntry: boolean;
  values: string[];
  reason: string;
}

function judgeValues(input: CharacteristicInput): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const raw of input.values) {
    const text = (raw ?? '').trim();
    if (!text) continue;
    if (text.length > 30) {
      throw new CharacteristicError(`Allowed value ${text} exceeds 30 characters.`, 'Shorten the value and save again.');
    }
    const key = input.caseSensitive ? text : text.toUpperCase();
    if (seen.has(key)) {
      throw new CharacteristicError(
        `Allowed value ${text} stands twice${input.caseSensitive ? '' : ' (comparison is not case-sensitive)'}.`,
        'Remove the duplicate and save again.',
      );
    }
    seen.add(key);
    values.push(text);
  }
  return values;
}

export async function saveCharacteristic(input: CharacteristicInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const name = requireName(input.characteristicName);
  const description = (input.description ?? '').trim();
  if (!description || description.length > 30) {
    throw new CharacteristicError('The description is required and may be at most 30 characters.', 'Enter a description within the limit.');
  }
  if (!(DATA_FORMATS as readonly string[]).includes(input.dataFormat)) {
    throw new CharacteristicError(`Data format ${input.dataFormat} does not stand.`, 'Pick CHAR, NUM, DATE, TIME or CURR.');
  }
  const format = input.dataFormat as DataFormat;
  if (!Number.isInteger(input.valueLength) || input.valueLength < 1) {
    throw new CharacteristicError('The length must be a positive whole number.');
  }
  if (!Number.isInteger(input.decimalPlaces) || input.decimalPlaces < 0 || input.decimalPlaces > input.valueLength) {
    throw new CharacteristicError('Decimal places must stand between zero and the length.');
  }
  if ((format === 'CHAR' || format === 'DATE' || format === 'TIME') && input.decimalPlaces !== 0) {
    throw new CharacteristicError(`Decimal places belong to NUM and CURR; ${format} carries none.`);
  }
  if (input.intervalsAllowed && !(format === 'NUM' || format === 'DATE' || format === 'TIME')) {
    throw new CharacteristicError('Interval values stand only on NUM, DATE and TIME characteristics.');
  }
  if (input.valueAssignment !== 'SINGLE' && input.valueAssignment !== 'MULTIPLE') {
    throw new CharacteristicError('Value assignment is Single or Multiple.');
  }
  const values = judgeValues(input);

  return withTenant(client, async (tx) => {
    if (input.unit) {
      if (format !== 'NUM' && format !== 'CURR') {
        throw new CharacteristicError('A unit of measure belongs to NUM and CURR characteristics.');
      }
      const [unit] = await tx.select().from(unitOfMeasure).where(eq(unitOfMeasure.code, input.unit));
      if (!unit) throw new CharacteristicError(`Unit ${input.unit} is not a standing unit of measure.`);
    }
    if (format === 'CURR') {
      if (!input.currency) throw new CharacteristicError('A CURR characteristic names its currency.', 'Pick the currency its values are counted in.');
      const [curr] = await tx.select().from(currencyReference).where(eq(currencyReference.code, input.currency));
      if (!curr) throw new CharacteristicError(`Currency ${input.currency} does not stand.`);
    } else if (input.currency) {
      throw new CharacteristicError('Only a CURR characteristic names a currency.');
    }

    const [existing] = await tx.select().from(characteristic)
      .where(and(eq(characteristic.client, client), eq(characteristic.characteristicName, name)))
      .for('update');

    const fields = {
      description,
      dataFormat: format,
      valueLength: input.valueLength,
      decimalPlaces: input.decimalPlaces,
      unit: input.unit || null,
      currency: input.currency || null,
      negativeValuesAllowed: input.negativeValuesAllowed,
      caseSensitive: input.caseSensitive,
      intervalsAllowed: input.intervalsAllowed,
      additionalValuesAllowed: input.additionalValuesAllowed,
      valueAssignment: input.valueAssignment,
      requiredEntry: input.requiredEntry,
    };

    if (input.mode === 'CREATE') {
      if (existing) {
        throw new CharacteristicError(`Characteristic ${name} already stands.`, 'Change the standing characteristic, or choose a new name.');
      }
      await tx.insert(characteristic).values({
        client, characteristicName: name, lifecycleStatus: 'DRAFT', createdBy: changedBy, ...fields,
      });
      for (const [index, valueText] of values.entries()) {
        await tx.insert(characteristicValue).values({
          client, characteristicName: name, valueText, sortOrder: index, createdBy: changedBy,
        });
      }
      await recordChange(tx, {
        client, objectClass: OBJECT_CLASS, objectKey: name, changeType: 'CREATE',
        changedBy, reason, transactionCode: ACTIVITY,
        after: { characteristicName: name, ...fields, values },
        securityRelevantFields: ['dataFormat'],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { characteristicName: name, changed: true };
    }

    if (!existing) {
      throw new CharacteristicError(`Characteristic ${name} does not stand.`, 'Create it first, then change it.');
    }
    const structural =
      existing.dataFormat !== fields.dataFormat
      || existing.valueLength !== fields.valueLength
      || existing.decimalPlaces !== fields.decimalPlaces
      || existing.valueAssignment !== fields.valueAssignment
      || existing.intervalsAllowed !== fields.intervalsAllowed;
    if (structural && existing.lifecycleStatus === 'BLOCKED') {
      throw new CharacteristicError(
        `Characteristic ${name} is blocked; its structure cannot change while blocked.`,
        'Reactivate the characteristic first, or change only its description.',
      );
    }
    if (structural && (await usageCount()) > 0) {
      throw new CharacteristicError(
        `Characteristic ${name} is in use; its structure cannot change under standing assignments.`,
      );
    }
    await tx.update(characteristic).set({ ...fields, changedBy, changedAt: new Date() })
      .where(and(eq(characteristic.client, client), eq(characteristic.characteristicName, name)));
    await tx.delete(characteristicValue)
      .where(and(eq(characteristicValue.client, client), eq(characteristicValue.characteristicName, name)));
    for (const [index, valueText] of values.entries()) {
      await tx.insert(characteristicValue).values({
        client, characteristicName: name, valueText, sortOrder: index, createdBy: changedBy,
      });
    }
    await recordChange(tx, {
      client, objectClass: OBJECT_CLASS, objectKey: name, changeType: 'CHANGE',
      changedBy, reason, transactionCode: ACTIVITY,
      before: {
        description: existing.description, dataFormat: existing.dataFormat,
        valueLength: existing.valueLength, decimalPlaces: existing.decimalPlaces,
        valueAssignment: existing.valueAssignment,
      },
      after: { ...fields, values },
      securityRelevantFields: ['dataFormat'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { characteristicName: name, changed: true };
  });
}

export interface CharacteristicKeyInput {
  client: string;
  changedBy: string;
  characteristicName: string;
  reason: string;
}

export async function setCharacteristicStatus(input: CharacteristicKeyInput & { status: 'ACTIVE' | 'BLOCKED' }) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const name = requireName(input.characteristicName);

  return withTenant(client, async (tx) => {
    const [existing] = await tx.select().from(characteristic)
      .where(and(eq(characteristic.client, client), eq(characteristic.characteristicName, name)))
      .for('update');
    if (!existing) throw new CharacteristicError(`Characteristic ${name} does not stand.`);
    if (existing.lifecycleStatus === input.status) {
      return { characteristicName: name, changed: false };
    }
    await tx.update(characteristic).set({
      lifecycleStatus: input.status, changedBy, changedAt: new Date(),
    }).where(and(eq(characteristic.client, client), eq(characteristic.characteristicName, name)));
    await recordChange(tx, {
      client, objectClass: OBJECT_CLASS, objectKey: name, changeType: 'CHANGE',
      changedBy, reason, transactionCode: ACTIVITY,
      before: { lifecycleStatus: existing.lifecycleStatus },
      after: { lifecycleStatus: input.status },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { characteristicName: name, changed: true };
  });
}

export async function deleteCharacteristic(input: CharacteristicKeyInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const name = requireName(input.characteristicName);

  return withTenant(client, async (tx) => {
    const [existing] = await tx.select().from(characteristic)
      .where(and(eq(characteristic.client, client), eq(characteristic.characteristicName, name)))
      .for('update');
    if (!existing) throw new CharacteristicError(`Characteristic ${name} does not stand.`);
    if (existing.lifecycleStatus !== 'DRAFT') {
      throw new CharacteristicError(
        `Characteristic ${name} has lived as ${existing.lifecycleStatus}; it blocks rather than deletes.`,
        'Block the characteristic instead — deletion stands only for a draft that never carried values.',
      );
    }
    const values = await tx.select().from(characteristicValue)
      .where(and(eq(characteristicValue.client, client), eq(characteristicValue.characteristicName, name)));
    if (values.length > 0) {
      throw new CharacteristicError(
        `Characteristic ${name} carries ${values.length} allowed values; it blocks rather than deletes.`,
        'Remove the values and delete it as a draft, or block it.',
      );
    }
    await tx.delete(characteristic)
      .where(and(eq(characteristic.client, client), eq(characteristic.characteristicName, name)));
    await recordChange(tx, {
      client, objectClass: OBJECT_CLASS, objectKey: name, changeType: 'DELETE',
      changedBy, reason, transactionCode: ACTIVITY,
      before: { characteristicName: name, dataFormat: existing.dataFormat },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { characteristicName: name, changed: true };
  });
}
