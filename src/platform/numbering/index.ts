/** Gap-free, transactional numbering — E3, CAIRN.md §5.2, D-036/D-042/D-046. */
import { randomUUID } from 'node:crypto';
import { formatNumber } from './format';
export { formatNumber } from './format';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { numberRange, numberRangeAllocation } from '../tables/numbering';

export interface AllocateOptions {
  client: string;
  objectCode: string;
  /** Accounting ranges are company-scoped; other objects default to '*'. */
  companyCode?: string;
  subObject?: string;
  fiscalYear?: number | null;
  allocatedBy: string;
  transactionCode?: string;
}

export interface AllocatedNumber {
  value: number;
  display: string;
  objectCode: string;
  companyCode: string;
  subObject: string;
  /** Document year, not the year of the interval used. */
  fiscalYear: number;
  rangeFiscalYear: number;
  allocationId: string;
}

export class NumberRangeError extends Error {
  readonly code = 'CAIRN_NUMBER_RANGE';
  constructor(message: string, readonly remedy: string) {
    super(message);
    this.name = 'NumberRangeError';
  }
}

/** Must run in the transaction that writes the consuming document. */
export async function allocateNumber(tx: Tx, options: AllocateOptions): Promise<AllocatedNumber> {
  const subObject = options.subObject ?? '*';
  const fiscalYear = options.fiscalYear ?? 0;
  const companyCode = options.companyCode ?? '*';

  // Select the authoritative interval FIRST. A defined year-specific interval
  // that is blocked, external or exhausted must not be bypassed by a fallback.
  // The UPDATE itself takes the row lock; allocation rolls back with the document.
  const rows = (await tx.execute(sql`
    update number_range r
       set current_number = current_number + 1,
           changed_by = ${options.allocatedBy}, changed_at = now()
     where r.client = ${options.client}
       and r.object_code = ${options.objectCode}
       and r.company_code = ${companyCode}
       and r.sub_object = ${subObject}
       and r.fiscal_year = (
         select c.fiscal_year from number_range c
          where c.client = ${options.client}
            and c.object_code = ${options.objectCode}
            and c.company_code = ${companyCode}
            and c.sub_object = ${subObject}
            and c.fiscal_year in (${fiscalYear}, 0)
          order by c.fiscal_year desc limit 1
       )
       and r.status = 'ACTIVE' and not r.is_external
       and r.current_number < r.to_number
    returning r.current_number, r.prefix, r.number_length, r.display_style, r.fiscal_year
  `)) as unknown as Array<{
    current_number: string | number;
    prefix: string;
    number_length: number;
    display_style: string;
    fiscal_year: number;
  }>;

  if (rows.length === 0) {
    const found = await tx.select().from(numberRange).where(sql`
      ${numberRange.client} = ${options.client}
      and ${numberRange.objectCode} = ${options.objectCode}
      and ${numberRange.companyCode} = ${companyCode}
      and ${numberRange.subObject} = ${subObject}
      and ${numberRange.fiscalYear} in (${fiscalYear}, 0)
    `);
    const range = found.find((r) => r.fiscalYear === fiscalYear) ?? found[0];
    const label = `${options.objectCode} / ${companyCode} / ${subObject}`;
    const remedy = 'Maintain the interval in Number Range Maintenance (CFG.PLT.NUMBERRANGE.DEFINE).';
    if (!range) {
      throw new NumberRangeError(
        `No number range is defined for ${label}, neither for fiscal year ${fiscalYear} nor year-independent.`,
        remedy,
      );
    }
    if (range.status !== 'ACTIVE') {
      throw new NumberRangeError(`The number range for ${label} is ${range.status}.`, remedy);
    }
    if (range.isExternal) {
      throw new NumberRangeError(
        `The number range for ${label} requires externally supplied numbers.`,
        'Automatic allocation is not allowed for an external interval. Use an internal interval.',
      );
    }
    throw new NumberRangeError(
      `Number range for ${label} is exhausted (last number ${range.currentNumber} of ${range.toNumber}).`,
      `Extend the upper limit. ${remedy}`,
    );
  }

  const row = rows[0];
  const value = Number(row.current_number);
  const display = formatNumber({
    value, prefix: row.prefix, length: row.number_length,
    style: row.display_style, fiscalYear,
  });
  const allocationId = randomUUID();
  await tx.insert(numberRangeAllocation).values({
    id: allocationId, client: options.client, objectCode: options.objectCode,
    companyCode, subObject, fiscalYear, rangeFiscalYear: row.fiscal_year,
    allocatedNumber: value, displayedNumber: display, allocatedBy: options.allocatedBy,
  });

  return {
    value, display, objectCode: options.objectCode, companyCode, subObject,
    fiscalYear, rangeFiscalYear: row.fiscal_year, allocationId,
  };
}


export async function rangeStatus(tx: Tx, client: string, objectCode?: string) {
  return tx.select().from(numberRange).where(
    objectCode
      ? and(eq(numberRange.client, client), eq(numberRange.objectCode, objectCode))
      : eq(numberRange.client, client),
  ).orderBy(numberRange.objectCode, numberRange.companyCode, numberRange.subObject, numberRange.fiscalYear);
}

/** Bootstrap-only, insert-if-absent. NEVER resets or updates a live counter. */
export async function defineRange(tx: Tx, input: {
  client: string;
  objectCode: string;
  companyCode?: string;
  subObject?: string;
  fiscalYear?: number | null;
  prefix?: string;
  fromNumber?: number;
  toNumber?: number;
  numberLength?: number;
  displayStyle?: 'READABLE' | 'CLASSIC';
  isExternal?: boolean;
  createdBy: string;
}): Promise<void> {
  const from = input.fromNumber ?? 1;
  const to = input.toNumber ?? 999999;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
    throw new NumberRangeError('The interval must contain safe positive integers, from ≤ to.', 'Correct the interval limits.');
  }
  await tx.insert(numberRange).values({
    client: input.client, objectCode: input.objectCode, companyCode: input.companyCode ?? '*',
    subObject: input.subObject ?? '*', fiscalYear: input.fiscalYear ?? 0,
    prefix: input.prefix ?? '', fromNumber: from, toNumber: to, currentNumber: from - 1,
    numberLength: input.numberLength ?? 6, displayStyle: input.displayStyle ?? 'READABLE',
    isExternal: input.isExternal ?? false, createdBy: input.createdBy,
  }).onConflictDoNothing();
}
