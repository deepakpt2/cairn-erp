'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import {
  addHolidayDay, deleteCalendarPeriod, deleteHolidayCalendar, FACTORY_CALENDAR_ROUTE, FactoryCalendarError,
  removeHolidayDay, saveCalendarPeriod, saveHolidayCalendar, WEEKDAYS, type WeekdayFlags,
} from '@/modules/foundation/factory-calendar';

export interface CalendarActionState { ok: boolean; message?: string; remedy?: string }

const text = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

async function run(work: (ctx: { client: string; changedBy: string; capabilities: string[] }) => Promise<string>): Promise<CalendarActionState> {
  const session = await requireSession(FACTORY_CALENDAR_ROUTE);
  try {
    const message = await work({ client: session.user.client, changedBy: session.user.username, capabilities: session.user.capabilities });
    revalidatePath(FACTORY_CALENDAR_ROUTE);
    return { ok: true, message };
  } catch (error) {
    if (error instanceof FactoryCalendarError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

/** FormData names, exactly: calendarId, periodValidFrom, periodValidTo, monday…sunday (value 1), holidayCalendarId; originalValidFrom when editing. */
export async function savePeriodAction(_p: CalendarActionState, form: FormData): Promise<CalendarActionState> {
  return run(async (ctx) => {
    const flags = Object.fromEntries(WEEKDAYS.map((d) => [d, text(form, d) === '1'])) as WeekdayFlags;
    const { warnings } = await saveCalendarPeriod({
      ...ctx, ...flags, calendarId: text(form, 'calendarId'), validFrom: text(form, 'periodValidFrom'), validTo: text(form, 'periodValidTo'),
      holidayCalendarId: text(form, 'holidayCalendarId'), originalValidFrom: text(form, 'originalValidFrom') || null,
    });
    return ['The period was saved.', ...warnings].join(' ');
  });
}

export async function deletePeriodAction(_p: CalendarActionState, form: FormData): Promise<CalendarActionState> {
  return run(async (ctx) => {
    await deleteCalendarPeriod({ ...ctx, calendarId: text(form, 'calendarId'), validFrom: text(form, 'periodValidFrom') });
    return 'The period was deleted.';
  });
}

/** FormData names, exactly: holidayCalendarId, holidayCalendarName, validFromYear, validToYear. */
export async function saveHolidayCalendarAction(_p: CalendarActionState, form: FormData): Promise<CalendarActionState> {
  return run(async (ctx) => {
    await saveHolidayCalendar({
      ...ctx, holidayCalendarId: text(form, 'holidayCalendarId'), name: text(form, 'holidayCalendarName'),
      validFromYear: Number(text(form, 'validFromYear')), validToYear: Number(text(form, 'validToYear')),
    });
    return 'The holiday calendar was saved.';
  });
}

export async function deleteHolidayCalendarAction(_p: CalendarActionState, form: FormData): Promise<CalendarActionState> {
  return run(async (ctx) => {
    await deleteHolidayCalendar({ ...ctx, holidayCalendarId: text(form, 'holidayCalendarId') });
    return 'The holiday calendar and its holidays were deleted.';
  });
}

/** FormData names, exactly: holidayCalendarId, holidayDate, holidayDescription. */
export async function addHolidayAction(_p: CalendarActionState, form: FormData): Promise<CalendarActionState> {
  return run(async (ctx) => {
    await addHolidayDay({ ...ctx, holidayCalendarId: text(form, 'holidayCalendarId'), date: text(form, 'holidayDate'), description: text(form, 'holidayDescription') });
    return 'The holiday was added.';
  });
}

export async function removeHolidayAction(_p: CalendarActionState, form: FormData): Promise<CalendarActionState> {
  return run(async (ctx) => {
    await removeHolidayDay({ ...ctx, holidayCalendarId: text(form, 'holidayCalendarId'), date: text(form, 'holidayDate') });
    return 'The holiday was removed.';
  });
}
