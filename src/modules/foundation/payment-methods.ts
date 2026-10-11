/** Tenant-scoped Payment Methods reads and audited maintenance (§14.6, B-037–B-038). */
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { country as countryReference } from '../../platform/tables/reference';
import { paymentMethod, PAYMENT_METHOD_DIRECTIONS, type PaymentMethodDirection } from './payment-method-schema';

const PAYMENT_METHOD_ACTIVITY = 'CFG.FIN.PAYMENTMETHOD.DEFINE';

export type PaymentMethodUse = Exclude<PaymentMethodDirection, 'BOTH'>;
export interface PaymentMethodListOptions {
  /** Requested transaction use. Methods configured for BOTH are included as well. */
  direction?: PaymentMethodUse;
  /** Defaults to false so configuration/review reads retain inactive definitions. */
  activeOnly?: boolean;
}

export class PaymentMethodReadError extends Error {
  constructor(message: string, readonly remedy = 'Check the country, method code and requested direction.') {
    super(message);
  }
}

export class PaymentMethodError extends Error {
  constructor(message: string, readonly remedy = 'Review the Payment Method configuration and try again.') {
    super(message);
  }
}

const clientSchema = z.string().regex(/^[A-Za-z0-9]{2,4}$/, 'Tenant key must contain 2–4 letters or digits.');
const countrySchema = z.string().trim().regex(/^[A-Za-z]{2}$/, 'Country must be a two-letter code.').transform(value => value.toUpperCase());
const methodCodeSchema = z.string().trim().regex(/^[A-Za-z0-9]{1,2}$/, 'Method code must contain 1–2 letters or digits.').transform(value => value.toUpperCase());
const getInputSchema = z.object({ client: clientSchema, country: countrySchema, methodCode: methodCodeSchema });
const listInputSchema = z.object({
  client: clientSchema,
  country: countrySchema,
  direction: z.enum(['OUTGOING', 'INCOMING']).optional(),
  activeOnly: z.boolean().default(false),
});
const valuesSchema = z.object({
  description: z.string().trim().min(1).max(160),
  allowedDirection: z.enum(PAYMENT_METHOD_DIRECTIONS),
  isActive: z.boolean(),
});
const maintenanceInputSchema = z.object({
  client: clientSchema,
  country: countrySchema,
  methodCode: methodCodeSchema,
  expectedVersion: z.number().int().nonnegative(),
  changedBy: z.string().trim().min(1).max(60),
  reason: z.string().trim().min(3).max(500),
  values: valuesSchema,
});
const retireInputSchema = z.object({
  client: clientSchema,
  country: countrySchema,
  methodCode: methodCodeSchema,
  expectedVersion: z.number().int().nonnegative(),
  changedBy: z.string().trim().min(1).max(60),
  reason: z.string().trim().min(3).max(500),
});

export type PaymentMethodValues = z.input<typeof valuesSchema>;
export type PaymentMethodInput = z.input<typeof maintenanceInputSchema>;
export type RetirePaymentMethodInput = z.input<typeof retireInputSchema>;

const key = (client: string, country: string, methodCode: string) => and(
  eq(paymentMethod.client, client),
  eq(paymentMethod.country, country),
  eq(paymentMethod.methodCode, methodCode),
);
const snapshot = (row: Pick<typeof paymentMethod.$inferSelect, 'country' | 'methodCode' | 'description' | 'allowedDirection' | 'isActive'>) => ({
  country: row.country,
  methodCode: row.methodCode,
  description: row.description,
  allowedDirection: row.allowedDirection,
  isActive: row.isActive,
});

async function lockMethod(tx: Tx, client: string, country: string, methodCode: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/payment_method/${country}/${methodCode}`}, 0))`);
}

function invalidInput(error: z.ZodError) {
  return new PaymentMethodError(error.issues[0]?.message ?? 'Payment Method input is invalid.');
}

function staleVersion() {
  return new PaymentMethodError('Payment Method changed after it was opened.', 'Reload the current definition before saving.');
}

/** Reads a definition by its tenant/country/code key, including inactive rows. */
export async function getPaymentMethod(client: string, country: string, methodCode: string) {
  const parsed = getInputSchema.safeParse({ client, country, methodCode });
  if (!parsed.success) throw new PaymentMethodReadError(parsed.error.issues[0].message);
  const input = parsed.data;
  return withTenant(input.client, async tx => (await tx.select().from(paymentMethod).where(key(input.client, input.country, input.methodCode)))[0] ?? null);
}

/**
 * Lists definitions for one country, including inactive rows by default and in code order.
 * A direction filter means "usable for this direction", so BOTH rows also match.
 */
export async function listPaymentMethods(client: string, country: string, options: PaymentMethodListOptions = {}) {
  const parsed = listInputSchema.safeParse({ ...options, client, country });
  if (!parsed.success) throw new PaymentMethodReadError(parsed.error.issues[0].message);
  const { client: tenant, country: countryCode, direction, activeOnly } = parsed.data;
  return withTenant(tenant, tx => tx.select().from(paymentMethod).where(and(
    eq(paymentMethod.client, tenant),
    eq(paymentMethod.country, countryCode),
    direction ? or(
      eq(paymentMethod.allowedDirection, direction),
      eq(paymentMethod.allowedDirection, 'BOTH'),
    ) : undefined,
    activeOnly ? eq(paymentMethod.isActive, true) : undefined,
  )).orderBy(asc(paymentMethod.methodCode)));
}

/** Create or maintain one definition. The tenant/country/code key is immutable after creation. */
export async function savePaymentMethod(raw: PaymentMethodInput) {
  const parsed = maintenanceInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, country, methodCode, expectedVersion, changedBy, reason, values } = parsed.data;

  return withTenant(client, async tx => {
    await lockMethod(tx, client, country, methodCode);
    const [before] = await tx.select().from(paymentMethod).where(key(client, country, methodCode)).for('update');
    if ((before?.version ?? 0) !== expectedVersion) throw staleVersion();

    const [knownCountry] = await tx.select({ code: countryReference.code }).from(countryReference)
      .where(eq(countryReference.code, country));
    if (!knownCountry) throw new PaymentMethodError('Country is not configured.', 'Choose a country in the reference country catalogue.');

    if (before && before.description === values.description
      && before.allowedDirection === values.allowedDirection && before.isActive === values.isActive) {
      await markActivityComplete(tx, client, PAYMENT_METHOD_ACTIVITY, changedBy);
      return { changed: false, version: before.version };
    }

    const version = (before?.version ?? 0) + 1;
    const after = { country, methodCode, ...values };
    if (before) {
      await tx.update(paymentMethod).set({ ...values, version, changedBy, changedAt: new Date() })
        .where(key(client, country, methodCode));
    } else {
      await tx.insert(paymentMethod).values({ ...after, client, version, createdBy: changedBy });
    }

    await recordChange(tx, {
      client,
      objectClass: 'payment_method',
      objectKey: `${country}/${methodCode}`,
      changeType: before ? 'CHANGE' : 'CREATE',
      changedBy,
      reason,
      transactionCode: 'CFG.FIN.PAYMENTMETHOD.DEFINE',
      before: before ? snapshot(before) : undefined,
      after: snapshot(after),
      securityRelevantFields: ['country', 'methodCode', 'allowedDirection', 'isActive'],
      fieldLabels: { methodCode: 'Method code', allowedDirection: 'Allowed direction', isActive: 'Active' },
    });
    await markActivityComplete(tx, client, PAYMENT_METHOD_ACTIVITY, changedBy);
    return { changed: true, version };
  });
}

/** Retires a method by setting it inactive; the definition and its audit trail are retained. */
export async function retirePaymentMethod(raw: RetirePaymentMethodInput) {
  const parsed = retireInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, country, methodCode, expectedVersion, changedBy, reason } = parsed.data;

  return withTenant(client, async tx => {
    await lockMethod(tx, client, country, methodCode);
    const [before] = await tx.select().from(paymentMethod).where(key(client, country, methodCode)).for('update');
    if (!before) throw new PaymentMethodError('Payment Method does not exist.', 'Reload the country-specific method list.');
    if (before.version !== expectedVersion) throw staleVersion();
    if (!before.isActive) {
      await markActivityComplete(tx, client, PAYMENT_METHOD_ACTIVITY, changedBy);
      return { changed: false, version: before.version };
    }

    const version = before.version + 1;
    await tx.update(paymentMethod).set({ isActive: false, version, changedBy, changedAt: new Date() })
      .where(key(client, country, methodCode));
    await recordChange(tx, {
      client,
      objectClass: 'payment_method',
      objectKey: `${country}/${methodCode}`,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: 'CFG.FIN.PAYMENTMETHOD.DEFINE',
      before: snapshot(before),
      after: { ...snapshot(before), isActive: false },
      securityRelevantFields: ['country', 'methodCode', 'allowedDirection', 'isActive'],
      fieldLabels: { methodCode: 'Method code', allowedDirection: 'Allowed direction', isActive: 'Active' },
    });
    await markActivityComplete(tx, client, PAYMENT_METHOD_ACTIVITY, changedBy);
    return { changed: true, version };
  });
}
