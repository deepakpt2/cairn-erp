'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  PRICE_CHANGE_CAPABILITY,
  PRICE_CHANGE_ROUTE,
  PriceChangeError,
  changeMaterialPrice,
  releaseFuturePrices,
  type PriceWhen,
} from '@/modules/inventory/price-change';

export interface PriceChangeState {
  ok: boolean;
  message: string;
  remedy?: string;
  warnings?: string[];
  documentNumber?: string | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function linesOf(form: FormData) {
  const count = Number(text(form, 'lineCount') || '0');
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    const materialNumber = text(form, `line${index}Material`);
    const plant = text(form, `line${index}Plant`);
    const price = text(form, `line${index}Price`);
    const priceUnit = text(form, `line${index}PriceUnit`);
    if (!materialNumber && !plant && !price) continue;
    lines.push({
      materialNumber,
      plant,
      price: Number(price),
      priceUnit: Number(priceUnit || '1'),
    });
  }
  return lines;
}

function whenOf(value: string): PriceWhen {
  if (value === 'PREVIOUS' || value === 'FUTURE') return value;
  return 'CURRENT';
}

export async function savePriceChangeAction(
  _previous: PriceChangeState,
  form: FormData,
): Promise<PriceChangeState> {
  const session = await requireSession(PRICE_CHANGE_ROUTE);
  if (!can(session, PRICE_CHANGE_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${PRICE_CHANGE_CAPABILITY}.` };
  }
  try {
    const result = await changeMaterialPrice({
      client: session.user.client,
      changedBy: session.user.username,
      companyCode: text(form, 'companyCode'),
      postingDate: text(form, 'postingDate'),
      when: whenOf(text(form, 'when')),
      reason: text(form, 'reason'),
      requestKey: text(form, 'requestKey'),
      lines: linesOf(form),
    });
    revalidatePath(PRICE_CHANGE_ROUTE);
    return {
      ok: true,
      message: result.message,
      warnings: result.warnings,
      documentNumber: result.documentNumber,
    };
  } catch (error) {
    if (error instanceof PriceChangeError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function releaseFuturePriceAction(
  _previous: PriceChangeState,
  form: FormData,
): Promise<PriceChangeState> {
  const session = await requireSession(PRICE_CHANGE_ROUTE);
  if (!can(session, PRICE_CHANGE_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${PRICE_CHANGE_CAPABILITY}.` };
  }
  const selected = form.getAll('release').filter((value): value is string => typeof value === 'string');
  try {
    const result = await releaseFuturePrices({
      client: session.user.client,
      changedBy: session.user.username,
      companyCode: text(form, 'companyCode'),
      postingDate: text(form, 'postingDate'),
      reason: text(form, 'reason') || 'Release future price',
      requestKey: text(form, 'requestKey'),
      materials: selected.map((value) => {
        const [materialNumber, plant] = value.split('|');
        return { materialNumber, plant };
      }),
    });
    revalidatePath(PRICE_CHANGE_ROUTE);
    return {
      ok: true,
      message: result.message,
      warnings: result.warnings,
      documentNumber: result.documentNumber,
    };
  } catch (error) {
    if (error instanceof PriceChangeError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
