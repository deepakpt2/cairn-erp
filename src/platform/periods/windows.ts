/**
 * The fiscal period window rule — CAIRN.md §14.3
 *
 * Split out of the period engine because it is pure: it takes the ends that are stored and
 * returns the windows they imply, with no transaction and no database. That lets a screen show
 * a maintainer the consequence of an end while it is still being typed, from the same rule
 * posting will apply, instead of a copy of it that could drift.
 */
/**
 * Each period's calendar window, derived from the ends that are stored.
 *
 * A period starts the day after the one before it ends, and the first period starts the day
 * after the last period of the fiscal year before it — which is what makes a shifted year
 * work without storing a start that could disagree with its neighbour. `day` 31 means the
 * last day of the month, so a period ending in February ends on the 28th or 29th.
 */
export function periodWindows(
  regular: Array<{ period: number; month: number; day: number; yearShift: number }>,
  fiscalYear: number,
): Array<{ period: number; start: number; end: number }> {
  const endOf = (period: { month: number; day: number; yearShift: number }, year: number) => {
    const calendarYear = year + period.yearShift;
    const lastDay = new Date(Date.UTC(calendarYear, period.month, 0)).getUTCDate();
    return Date.UTC(calendarYear, period.month - 1, Math.min(period.day, lastDay));
  };

  return regular.map((period, index) => {
    const previous = index === 0 ? regular[regular.length - 1]! : regular[index - 1]!;
    const previousEnd = endOf(previous, index === 0 ? fiscalYear - 1 : fiscalYear);
    return {
      period: period.period,
      start: previousEnd + 86_400_000,
      end: endOf(period, fiscalYear),
    };
  });
}

