import { and, count, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { DEFAULT_LOCALE, LOCALES } from '../../platform/i18n';
import { businessPartner, industry, industryText } from './business-partner-schema';

/**
 * Industry definition (SCR-077 / OB44; R-125).
 *
 * The classification a business partner carries, maintained as a tenant
 * master in the standing shape: the code of at most four uppercase
 * letters or digits is never renamed, descriptions stand per configured
 * language at the reference width of 20 characters, the standard
 * industries are delivered per tenant, deletion is hard and refused
 * while partners carry the industry with the count named, and
 * deactivation stands beside it. One change document per write, a
 * reason on every write. Distinct from the industry sector a material
 * is created under.
 */

export const ACTIVITY = 'CFG.ORG.INDUSTRY.DEFINE';

export class IndustryError extends Error {
  constructor(
    message: string,
    public remedy?: string,
  ) {
    super(message);
    this.name = 'IndustryError';
  }
}

const OBJECT_CLASS = 'industry';
const PRODUCTION = process.env.NODE_ENV === 'production';

/** The delivered standard industries (R-125), seeded for every tenant. */
export const INDUSTRY_DEFAULTS = [
  { code: 'MEC1', description: 'Mechanical Eng.' },
  { code: 'CHEM', description: 'Chemical' },
  { code: 'PHAR', description: 'Pharmaceutical' },
  { code: 'RETL', description: 'Retail' },
  { code: 'CONS', description: 'Construction' },
] as const;

function requireClient(client: string): string {
  const value = client?.trim() ?? '';
  if (!value) throw new IndustryError('The tenant is missing.', 'Sign in again.');
  return value;
}

function requireActor(changedBy: string): string {
  const value = changedBy?.trim() ?? '';
  if (!value) throw new IndustryError('The acting user is missing.', 'Sign in again.');
  return PRODUCTION ? value : value.toUpperCase();
}

function requireReason(reason: string): string {
  const value = reason?.trim() ?? '';
  if (!value) {
    throw new IndustryError(
      'A reason is required for every industry change.',
      'State why this change is being made.',
    );
  }
  return value;
}

function requireKey(raw: string): string {
  const key = (raw ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(key)) {
    throw new IndustryError(
      'The industry is one to four uppercase letters or digits.',
      'Correct the industry code and save again.',
    );
  }
  return key;
}

function requireLanguage(raw: string): string {
  const language = (raw ?? '').trim().toLowerCase();
  if (!(LOCALES as readonly string[]).includes(language)) {
    throw new IndustryError(
      `Language ${language || '(blank)'} is not a configured system language.`,
      `Maintain the description in one of: ${LOCALES.join(', ')}.`,
    );
  }
  return language;
}

function requireDescription(raw: string): string {
  const value = (raw ?? '').trim();
  if (!value || value.length > 20) {
    throw new IndustryError(
      'The description is required and may be at most 20 characters.',
      'Enter a description within the limit and save again.',
    );
  }
  return value;
}

export interface IndustryTextInput {
  language: string;
  description: string;
}

function prepareTexts(texts: IndustryTextInput[]): Array<{ language: string; description: string }> {
  if (!texts || texts.length === 0) {
    throw new IndustryError(
      'Enter at least one description.',
      `Give the description in the default language (${DEFAULT_LOCALE}) first.`,
    );
  }
  const seen = new Set<string>();
  return texts.map((row) => {
    const language = requireLanguage(row.language);
    if (seen.has(language)) {
      throw new IndustryError(
        `The description for language ${language} stands entered twice.`,
        'Keep one description per language.',
      );
    }
    seen.add(language);
    return { language, description: requireDescription(row.description) };
  });
}

// ── Reads ────────────────────────────────────────────────────────────────

export interface IndustryRow {
  code: string;
  isActive: boolean;
  partnerCount: number;
  /** The description in the standing (default) language, if maintained. */
  description: string;
  texts: Record<string, string>;
}

export async function listIndustries(client: string): Promise<IndustryRow[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select()
      .from(industry)
      .where(eq(industry.client, tenant))
      .orderBy(industry.industryCode);
    const texts = await tx
      .select()
      .from(industryText)
      .where(eq(industryText.client, tenant));
    const byCode = new Map<string, Record<string, string>>();
    for (const row of texts) {
      const entry = byCode.get(row.industryCode) ?? {};
      entry[row.languageCode] = row.description;
      byCode.set(row.industryCode, entry);
    }
    const out: IndustryRow[] = [];
    for (const row of rows) {
      const [usage] = await tx
        .select({ n: count() })
        .from(businessPartner)
        .where(and(eq(businessPartner.client, tenant), eq(businessPartner.industry, row.industryCode)));
      const map = byCode.get(row.industryCode) ?? {};
      out.push({
        code: row.industryCode,
        isActive: row.isActive,
        partnerCount: Number(usage?.n ?? 0),
        description: map[DEFAULT_LOCALE] ?? '',
        texts: map,
      });
    }
    return out;
  });
}

// ── Writes ───────────────────────────────────────────────────────────────

export interface IndustryInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  code: string;
  texts: IndustryTextInput[];
  reason: string;
}

export async function saveIndustry(input: IndustryInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = requireKey(input.code);
  const texts = prepareTexts(input.texts);
  if (input.mode === 'CREATE' && !texts.some((row) => row.language === DEFAULT_LOCALE)) {
    throw new IndustryError(
      `A new industry requires its description in the default language (${DEFAULT_LOCALE}).`,
      'Enter the default-language description, then add further languages.',
    );
  }

  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(industry)
      .where(and(eq(industry.client, client), eq(industry.industryCode, key)))
      .for('update');

    if (input.mode === 'CREATE') {
      if (existing) {
        throw new IndustryError(
          `Industry ${key} already stands.`,
          'Change the standing industry, or choose a new code.',
        );
      }
      await tx.insert(industry).values({
        client,
        industryCode: key,
        isActive: true,
        createdBy: changedBy,
      });
      for (const row of texts) {
        await tx.insert(industryText).values({
          client, industryCode: key, languageCode: row.language, description: row.description,
        });
      }
      await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey: key,
        changeType: 'CREATE',
        changedBy,
        reason,
        transactionCode: ACTIVITY,
        after: { code: key, texts },
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { code: key, changed: true };
    }

    if (!existing) {
      throw new IndustryError(
        `Industry ${key} does not stand.`,
        'Create it first, then change it.',
      );
    }
    const before: Record<string, string> = {};
    for (const row of await tx.select().from(industryText)
      .where(and(eq(industryText.client, client), eq(industryText.industryCode, key)))) {
      before[row.languageCode] = row.description;
    }
    const changed = texts.some((row) => before[row.language] !== row.description);
    if (!changed) return { code: key, changed: false };
    for (const row of texts) {
      await tx.insert(industryText)
        .values({ client, industryCode: key, languageCode: row.language, description: row.description })
        .onConflictDoUpdate({
          target: [industryText.client, industryText.industryCode, industryText.languageCode],
          set: { description: row.description },
        });
    }
    await tx
      .update(industry)
      .set({ changedBy, changedAt: new Date() })
      .where(and(eq(industry.client, client), eq(industry.industryCode, key)));
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: key,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { texts: before },
      after: { texts: { ...before, ...Object.fromEntries(texts.map((r) => [r.language, r.description])) } },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { code: key, changed: true };
  });
}

export interface IndustryKeyInput {
  client: string;
  changedBy: string;
  code: string;
  reason: string;
}

export async function setIndustryActive(input: IndustryKeyInput & { active: boolean }) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = requireKey(input.code);
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(industry)
      .where(and(eq(industry.client, client), eq(industry.industryCode, key)))
      .for('update');
    if (!existing) throw new IndustryError(`Industry ${key} does not stand.`);
    if (existing.isActive === input.active) return { code: key, changed: false };
    await tx
      .update(industry)
      .set({ isActive: input.active, changedBy, changedAt: new Date() })
      .where(and(eq(industry.client, client), eq(industry.industryCode, key)));
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: key,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { isActive: existing.isActive },
      after: { isActive: input.active },
      securityRelevantFields: ['isActive'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { code: key, changed: true };
  });
}

export async function deleteIndustry(input: IndustryKeyInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = requireKey(input.code);
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(industry)
      .where(and(eq(industry.client, client), eq(industry.industryCode, key)))
      .for('update');
    if (!existing) throw new IndustryError(`Industry ${key} does not stand.`);
    const [usage] = await tx
      .select({ n: count() })
      .from(businessPartner)
      .where(and(eq(businessPartner.client, client), eq(businessPartner.industry, key)));
    const used = Number(usage?.n ?? 0);
    if (used > 0) {
      throw new IndustryError(
        `Industry ${key} cannot be deleted: ${used} business partner${used === 1 ? '' : 's'} carr${used === 1 ? 'ies' : 'y'} it.`,
        'Move those partners to another industry or deactivate this one instead; it stops new assignments while its partners stand.',
      );
    }
    const texts = await tx.select().from(industryText)
      .where(and(eq(industryText.client, client), eq(industryText.industryCode, key)));
    await tx
      .delete(industryText)
      .where(and(eq(industryText.client, client), eq(industryText.industryCode, key)));
    await tx
      .delete(industry)
      .where(and(eq(industry.client, client), eq(industry.industryCode, key)));
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: key,
      changeType: 'DELETE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { code: key, isActive: existing.isActive, texts },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { code: key, changed: true };
  });
}
