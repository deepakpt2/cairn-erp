'use server';

/**
 * SCR-147 / MI04 — count entry from the screen.
 *
 * The action carries the form to the service and brings back the service's own refusal. It judges
 * two things of its own, because they are about the person rather than the count: whether the
 * session holds `INV.PHYINV.COUNT` to enter and `INV.PHYINV.COUNT.CORRECT` to clear. Everything
 * else — eligibility, zero semantics, conversion, staleness — belongs to `submitCounts`, so the
 * screen and a script cannot disagree about what a count is.
 */
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  PHYSICAL_INVENTORY_COUNT_CAPABILITY,
  PHYSICAL_INVENTORY_COUNT_CORRECT_CAPABILITY,
  PHYSICAL_INVENTORY_COUNT_ROUTE,
  PhysicalInventoryCountError,
  clearCount,
  countNamedRefusal,
  submitCounts,
  type CountDocumentView,
} from '@/modules/inventory/physical-inventory-count';

export interface CountActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  document?: CountDocumentView | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Which item rows the screen rendered. Mirrors the grid, and the service ignores any it lacks. */
const LINE_COUNT = 40;

/**
 * Fields the count does not have. They are read so a posted value is refused by name,
 * not dropped. The standing screen does not render them.
 */
function namedFields(form: FormData): Record<string, string> {
  const named: Record<string, string> = {
    batch: text(form, 'batch'),
    serialNumber: text(form, 'serialNumber'),
    handlingUnit: text(form, 'handlingUnit'),
    bookQuantity: text(form, 'bookQuantity'),
    differenceQuantity: text(form, 'differenceQuantity'),
    companyCode: text(form, 'companyCode'),
    countId: text(form, 'countId'),
    post: text(form, 'post'),
    countEvent: text(form, 'countEvent'),
  };
  for (let n = 1; n <= LINE_COUNT; n += 1) {
    named.batch ||= text(form, `batch-${n}`);
    named.serialNumber ||= text(form, `serial-${n}`);
    named.handlingUnit ||= text(form, `handling-${n}`);
    named.bookQuantity ||= text(form, `book-${n}`);
    named.differenceQuantity ||= text(form, `difference-${n}`);
  }
  return named;
}

export async function submitCountsAction(
  _previous: CountActionState,
  form: FormData,
): Promise<CountActionState> {
  const session = await requireSession(PHYSICAL_INVENTORY_COUNT_ROUTE);
  if (!can(session, PHYSICAL_INVENTORY_COUNT_CAPABILITY)) {
    return { ok: false, message: `You do not hold the count entry capability (${PHYSICAL_INVENTORY_COUNT_CAPABILITY}).` };
  }
  const named = namedFields(form);
  const refused = countNamedRefusal(named);
  if (refused) return { ok: false, message: refused };

  const lines: Parameters<typeof submitCounts>[0]['lines'] = [];
  for (let n = 1; n <= LINE_COUNT; n += 1) {
    const itemNumber = Number(text(form, `item-${n}`) || '0');
    if (!itemNumber) continue;
    // Only rows the person touched: a blank quantity with no zero flag is an uncounted item, and
    // submitting it would be refused — correctly, in the service — for saying nothing.
    const zeroCount = text(form, `zero-${n}`) === 'on';
    const rawQuantity = text(form, `quantity-${n}`);
    if (!zeroCount && rawQuantity === '') continue;
    lines.push({
      itemNumber,
      // The quantity is passed through even beside a zero flag: the contradiction is the service's
      // to refuse in words, not the screen's to quietly normalise away.
      quantity: rawQuantity === '' ? undefined : Number(rawQuantity),
      zeroCount,
      entryUnit: text(form, `unit-${n}`) || undefined,
      countDate: text(form, `date-${n}`) || undefined,
      itemText: text(form, `text-${n}`) || undefined,
      expectedVersion: Number(text(form, `version-${n}`) || '0') || undefined,
    });
  }

  if (lines.length === 0) {
    return { ok: false, message: 'No count was entered: fill a counted quantity, or tick zero for an empty item.' };
  }

  try {
    const document = await submitCounts({
      client: session.user.client,
      changedBy: session.user.username,
      documentNumber: text(form, 'documentNumber'),
      fiscalYear: Number(text(form, 'fiscalYear') || '0'),
      countDate: text(form, 'countDate'),
      counterName: text(form, 'counterName') || undefined,
      reason: text(form, 'reason') || undefined,
      requestKey: text(form, 'requestKey'),
      named,
      lines,
    });
    revalidatePath(PHYSICAL_INVENTORY_COUNT_ROUTE);
    return {
      ok: true,
      message: `Count saved for ${lines.length} item${lines.length === 1 ? '' : 's'}; the document stands at ${document.status}.`,
      document,
    };
  } catch (caught) {
    if (caught instanceof PhysicalInventoryCountError) {
      return { ok: false, message: caught.message, remedy: caught.remedy };
    }
    throw caught;
  }
}

export async function clearCountAction(
  _previous: CountActionState,
  form: FormData,
): Promise<CountActionState> {
  const session = await requireSession(PHYSICAL_INVENTORY_COUNT_ROUTE);
  const refused = countNamedRefusal(namedFields(form));
  if (refused) return { ok: false, message: refused };
  if (!can(session, PHYSICAL_INVENTORY_COUNT_CORRECT_CAPABILITY)) {
    return {
      ok: false,
      message: `You do not hold the count correction capability (${PHYSICAL_INVENTORY_COUNT_CORRECT_CAPABILITY}).`,
    };
  }
  try {
    const document = await clearCount({
      client: session.user.client,
      changedBy: session.user.username,
      documentNumber: text(form, 'documentNumber'),
      fiscalYear: Number(text(form, 'fiscalYear') || '0'),
      itemNumber: Number(text(form, 'itemNumber') || '0'),
      reason: text(form, 'reason'),
      requestKey: text(form, 'requestKey'),
      named: namedFields(form),
      expectedVersion: Number(text(form, 'version') || '0') || undefined,
    });
    revalidatePath(PHYSICAL_INVENTORY_COUNT_ROUTE);
    return { ok: true, message: `The count of item ${text(form, 'itemNumber')} was cleared; the item stands uncounted.`, document };
  } catch (caught) {
    if (caught instanceof PhysicalInventoryCountError) {
      return { ok: false, message: caught.message, remedy: caught.remedy };
    }
    throw caught;
  }
}
