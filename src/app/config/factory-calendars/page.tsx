
import { can, requireSession } from '@/platform/auth/current';
import {
  FACTORY_CALENDAR_CAPABILITY, FACTORY_CALENDAR_ROUTE, loadFactoryCalendars, sampleMonth,
} from '@/modules/foundation/factory-calendar';
import { HolidayCalendarPanel, PeriodForm } from './FactoryCalendarForms';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * Factory calendars — SCAL as a search alias only.
 *
 * Two panels on one screen: the working weekdays of a factory calendar over dated periods, and the
 * holiday calendars those periods name. Each period shows the month it produces, so a wrong weekday flag
 * is visible before it reaches a report. A calendar with no period is not a five-day week: it has no rules.
 */
export default async function FactoryCalendarsPage({ searchParams }: {
  searchParams: Promise<{ calendarId?: string; holiday?: string }>;
}) {
  const session = await requireSession(FACTORY_CALENDAR_ROUTE);
  const params = await searchParams;
  const allowed = can(session, FACTORY_CALENDAR_CAPABILITY);
  const bench = allowed ? await loadFactoryCalendars(session.user.client, session.user.capabilities) : null;
  const calendar = bench?.calendars.find((c) => c.calendarId === (params.calendarId ?? '').trim().toUpperCase()) ?? bench?.calendars[0] ?? null;
  const holiday = bench?.holidayCalendars.find((h) => h.holidayCalendarId === (params.holiday ?? '').trim().toUpperCase()) ?? null;

  return (
    <Page
      title="Factory calendars" code={FACTORY_CALENDAR_CAPABILITY} width="5xl"
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">
              The working weekdays of a factory calendar over dated periods, less the holidays of the holiday calendar a
              period names. A date no period covers has no answer; nothing assumes a five-day week. Movable holidays are
              entered as explicit dates, inside the holiday calendar&apos;s years.
            </p>
        </>
      }
    >

      {!bench ? (
        <p role="alert" className="text-sm text-signal-error">
          This screen needs {FACTORY_CALENDAR_CAPABILITY}, which this session does not hold.
        </p>
      ) : (
        <>
          <section aria-labelledby="fc-periods" className="space-y-3">
            <h2 id="fc-periods" className="text-sm font-semibold">Factory calendars</h2>
            {bench.calendars.length === 0 ? (
              <p className="text-sm text-ink-soft">This tenant has no factory calendars yet; they are created with the plant or sales organisation setup.</p>
            ) : (
              <>
                <form method="get" action={FACTORY_CALENDAR_ROUTE} className="panel flex flex-wrap items-end gap-3 p-4">
                  <label className="block"><span className="field-label">Factory calendar</span>
                    <select name="calendarId" className="input w-72" defaultValue={calendar?.calendarId}>
                      {bench.calendars.map((c) => <option key={c.calendarId} value={c.calendarId}>{c.calendarId} · {c.name}</option>)}
                    </select></label>
                  <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Show</button>
                </form>
                {calendar ? (
                  <>
                    {calendar.periods.length === 0
                      ? <p className="text-sm text-ink-soft">Calendar {calendar.calendarId} has no rules yet. Reports that need them will refuse until a period is added.</p>
                      : null}
                    {calendar.periods.map((p) => (
                      <div key={p.validFrom}>
                        <h3 className="mb-1 text-sm font-medium">{p.validFrom} to {p.validTo}</h3>
                        <PeriodForm calendarId={calendar.calendarId} period={p} holidayCalendars={bench.holidayCalendars} sample={sampleMonth(p)} />
                      </div>
                    ))}
                    <div>
                      <h3 className="mb-1 text-sm font-medium">New period</h3>
                      <PeriodForm calendarId={calendar.calendarId} period={null} holidayCalendars={bench.holidayCalendars} sample={null} />
                    </div>
                  </>
                ) : null}
              </>
            )}
          </section>

          <section aria-labelledby="fc-holidays" className="space-y-3">
            <h2 id="fc-holidays" className="text-sm font-semibold">Holiday calendars</h2>
            <form method="get" action={FACTORY_CALENDAR_ROUTE} className="panel flex flex-wrap items-end gap-3 p-4">
              {calendar ? <input type="hidden" name="calendarId" value={calendar.calendarId} /> : null}
              <label className="block"><span className="field-label">Holiday calendar</span>
                <select name="holiday" className="input w-72" defaultValue={holiday?.holidayCalendarId ?? ''}>
                  <option value="">New holiday calendar</option>
                  {bench.holidayCalendars.map((h) => <option key={h.holidayCalendarId} value={h.holidayCalendarId}>{h.holidayCalendarId} · {h.name}</option>)}
                </select></label>
              <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Show</button>
            </form>
            <HolidayCalendarPanel key={holiday?.holidayCalendarId ?? 'new'} holiday={holiday} />
          </section>
        </>
      )}
    </Page>
  );
}
