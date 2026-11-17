'use client';

import { useActionState } from 'react';

import type { HolidayCalendarView, PeriodView } from '@/modules/foundation/factory-calendar';
import { WEEKDAYS } from '@/modules/foundation/factory-calendar-constants';
import {
  addHolidayAction, deleteHolidayCalendarAction, deletePeriodAction, removeHolidayAction,
  saveHolidayCalendarAction, savePeriodAction, type CalendarActionState,
} from './actions';

const EMPTY: CalendarActionState = { ok: false };
const DAY_LABEL: Record<(typeof WEEKDAYS)[number], string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

function Notice({ state }: { state: CalendarActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success p-3 text-sm' : 'panel panel-danger p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
    </div>
  );
}

/** One period: its rules as an editable form, and the sample month it produces beside it. */
export function PeriodForm({ calendarId, period, holidayCalendars, sample }: {
  calendarId: string; period: PeriodView | null; holidayCalendars: HolidayCalendarView[];
  sample: { label: string; working: number; days: Array<{ date: string; working: boolean; holiday: boolean }> } | null;
}) {
  const [state, save, saving] = useActionState(savePeriodAction, EMPTY);
  const [delState, remove, removing] = useActionState(deletePeriodAction, EMPTY);
  return (
    <div className="panel space-y-3 p-4">
      <form action={save} className="grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="calendarId" value={calendarId} />
        {period ? <input type="hidden" name="originalValidFrom" value={period.validFrom} /> : null}
        <label className="block"><span className="field-label">Valid from</span>
          <input name="periodValidFrom" type="date" required className="input" defaultValue={period?.validFrom ?? ''} /></label>
        <label className="block"><span className="field-label">Valid to</span>
          <input name="periodValidTo" type="date" required className="input" defaultValue={period?.validTo ?? ''} /></label>
        <fieldset className="sm:col-span-2">
          <legend className="field-label">Working weekdays</legend>
          <div className="flex flex-wrap gap-3">
            {WEEKDAYS.map((d) => (
              <label key={d} className="flex items-center gap-1 text-sm">
                <input type="checkbox" name={d} value="1" defaultChecked={period ? period[d] : ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].includes(d)} />
                {DAY_LABEL[d]}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block"><span className="field-label">Holiday calendar</span>
          <select name="holidayCalendarId" className="input" defaultValue={period?.holidayCalendarId ?? ''}>
            <option value="">None</option>
            {holidayCalendars.map((h) => <option key={h.holidayCalendarId} value={h.holidayCalendarId}>{h.holidayCalendarId} · {h.name}</option>)}
          </select></label>
        <div className="flex items-end gap-2">
          <button type="submit" disabled={saving} className="btn btn-primary min-h-11 sm:min-h-8">{period ? 'Save period' : 'Add period'}</button>
        </div>
      </form>
      <Notice state={state} />
      {sample ? (
        <div aria-label={`Sample month ${sample.label}`}>
          <p className="text-xs text-ink-soft">Sample month {sample.label}: {sample.working} working days.</p>
          <ol className="mt-1 flex flex-wrap gap-1 text-2xs">
            {sample.days.map((d) => (
              <li key={d.date} title={d.holiday ? 'Holiday' : d.working ? 'Working' : 'Not working'}
                className={`w-7 rounded border border-line px-1 py-0.5 text-center ${d.working ? 'bg-surface-raised font-semibold' : 'text-ink-faint line-through'}`}>
                {Number(d.date.slice(8))}{d.holiday ? '*' : ''}
              </li>
            ))}
          </ol>
          <p className="mt-1 text-2xs text-ink-faint">Crossed out is not working; * is a holiday.</p>
        </div>
      ) : null}
      {period ? (
        <form action={remove}>
          <input type="hidden" name="calendarId" value={calendarId} />
          <input type="hidden" name="periodValidFrom" value={period.validFrom} />
          <button type="submit" disabled={removing} className="btn btn-default min-h-11 sm:min-h-8">Delete period</button>
          <Notice state={delState} />
        </form>
      ) : null}
    </div>
  );
}

export function HolidayCalendarPanel({ holiday }: { holiday: HolidayCalendarView | null }) {
  const [state, save, saving] = useActionState(saveHolidayCalendarAction, EMPTY);
  const [delState, remove, removing] = useActionState(deleteHolidayCalendarAction, EMPTY);
  const [addState, add, adding] = useActionState(addHolidayAction, EMPTY);
  const [rmState, rm, rming] = useActionState(removeHolidayAction, EMPTY);
  return (
    <div className="panel space-y-3 p-4">
      <form action={save} className="grid gap-3 sm:grid-cols-4">
        <label className="block"><span className="field-label">Key</span>
          <input name="holidayCalendarId" maxLength={2} required className="input uppercase" defaultValue={holiday?.holidayCalendarId ?? ''} readOnly={!!holiday} /></label>
        <label className="block sm:col-span-3"><span className="field-label">Name</span>
          <input name="holidayCalendarName" maxLength={80} required className="input" defaultValue={holiday?.name ?? ''} /></label>
        <label className="block"><span className="field-label">From year</span>
          <input name="validFromYear" type="number" min={1900} max={9999} required className="input" defaultValue={holiday?.validFromYear ?? new Date().getFullYear()} /></label>
        <label className="block"><span className="field-label">To year</span>
          <input name="validToYear" type="number" min={1900} max={9999} required className="input" defaultValue={holiday?.validToYear ?? new Date().getFullYear()} /></label>
        <div className="flex items-end"><button type="submit" disabled={saving} className="btn btn-primary min-h-11 sm:min-h-8">{holiday ? 'Save holiday calendar' : 'Create holiday calendar'}</button></div>
      </form>
      <Notice state={state} />
      {holiday ? (
        <>
          <table className="w-full text-sm">
            <caption className="sr-only">Holidays of {holiday.name}</caption>
            <thead><tr className="text-left text-ink-soft"><th className="py-1">Date</th><th>Description</th><th /></tr></thead>
            <tbody>
              {holiday.days.length === 0 ? <tr><td colSpan={3} className="py-2 text-ink-soft">No holidays yet.</td></tr> : null}
              {holiday.days.map((d) => (
                <tr key={d.date} className="border-t border-line">
                  <td className="py-1 code">{d.date}</td><td>{d.description}</td>
                  <td className="text-right">
                    <form action={rm}>
                      <input type="hidden" name="holidayCalendarId" value={holiday.holidayCalendarId} />
                      <input type="hidden" name="holidayDate" value={d.date} />
                      <button type="submit" disabled={rming} className="btn btn-default min-h-11 sm:min-h-8">Remove</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Notice state={rmState} />
          <form action={add} className="grid gap-3 sm:grid-cols-4">
            <input type="hidden" name="holidayCalendarId" value={holiday.holidayCalendarId} />
            <label className="block"><span className="field-label">Date</span>
              <input name="holidayDate" type="date" required className="input" /></label>
            <label className="block sm:col-span-2"><span className="field-label">Description</span>
              <input name="holidayDescription" maxLength={80} required className="input" /></label>
            <div className="flex items-end"><button type="submit" disabled={adding} className="btn btn-default min-h-11 sm:min-h-8">Add holiday</button></div>
          </form>
          <Notice state={addState} />
          <form action={remove}>
            <input type="hidden" name="holidayCalendarId" value={holiday.holidayCalendarId} />
            <button type="submit" disabled={removing} className="btn btn-default min-h-11 sm:min-h-8">Delete this holiday calendar</button>
          </form>
          <Notice state={delState} />
        </>
      ) : null}
    </div>
  );
}
