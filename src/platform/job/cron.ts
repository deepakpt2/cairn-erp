/**
 * Cron expressions — Phase 7.
 *
 * Standard five fields: minute, hour, day of month, month, day of week.
 * Supports a star, plain numbers, ranges (`8-17`), lists (`1,15`) and steps —
 * a slash after a range or a star, meaning every N. Month and day names are
 * not supported: a schedule lives in a row nobody edits by hand, and the
 * moment it does it should become a real scheduling table rather than a more
 * forgiving grammar here.
 *
 * (The step syntax is deliberately not written out in this comment: the two
 * characters that spell it are also the two that close a block comment, which
 * is how this file came to be mis-parsed on its first compile.)
 *
 * Deliberately dependency-free. A cron library would be one more thing to keep
 * in step with the job runtime for a grammar that fits in a screen.
 */
export interface CronSpec {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

/** How far ahead a next-run search will look before giving up. */
const HORIZON_MINUTES = 366 * 24 * 60;

/** Sunday is 0, matching JavaScript, not POSIX where it is 7. */
export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `A schedule is five fields (minute hour day-of-month month day-of-week), got ${fields.length}: ${expression}`,
    );
  }
  return {
    minutes: parseField(fields[0]!, 0, 59),
    hours: parseField(fields[1]!, 0, 23),
    daysOfMonth: parseField(fields[2]!, 1, 31),
    months: parseField(fields[3]!, 1, 12),
    daysOfWeek: parseField(fields[4]!, 0, 6),
  };
}

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '') throw new Error(`Empty cron field part in "${field}"`);
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Cron step must be a positive whole number: "${part}"`);
    }

    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = min;
      to = max;
    } else if (rangePart!.includes('-')) {
      const [a, b] = rangePart!.split('-');
      from = Number(a);
      to = Number(b);
    } else {
      from = Number(rangePart);
      to = stepPart === undefined ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new Error(`Cron range out of bounds for ${min}-${max}: "${part}"`);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/** Does this instant match? Seconds are not a cron field, so they are ignored. */
export function cronMatches(spec: CronSpec, at: Date): boolean {
  return (
    spec.minutes.includes(at.getMinutes())
    && spec.hours.includes(at.getHours())
    && spec.daysOfMonth.includes(at.getDate())
    && spec.months.includes(at.getMonth() + 1)
    && spec.daysOfWeek.includes(at.getDay())
  );
}

/**
 * The first instant strictly after `from` that the expression names.
 *
 * Stepping one minute at a time is not clever, and it does not need to be:
 * the search runs once per schedule per tick, and every realistic schedule
 * matches within a day. A schedule that genuinely never fires again —
 * `0 0 30 2 *`, the thirtieth of February — costs one walk of the horizon and
 * then returns null rather than hanging a worker.
 */
export function nextDueAfter(expression: string, from: Date): Date | null {
  const spec = parseCron(expression);
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const limit = HORIZON_MINUTES;
  for (let i = 0; i < limit; i++) {
    if (cronMatches(spec, candidate)) return new Date(candidate.getTime());
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}
