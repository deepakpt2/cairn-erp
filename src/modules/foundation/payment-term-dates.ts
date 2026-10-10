/** Pure calendar-day calculation. Invoice services must persist this result and terms version. */
export const BASELINE_SOURCES = ['DOCUMENT_DATE', 'POSTING_DATE', 'ENTRY_DATE'] as const;
export type BaselineSource = typeof BASELINE_SOURCES[number];
export interface PaymentTermRule {
  termsCode: string; version: number; baselineSource: BaselineSource; netDays: number;
  discount1Days: number | null; discount1Percent: string;
  discount2Days: number | null; discount2Percent: string;
}
export function calendarDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0,4)==='0000') throw new Error('Use a valid ISO calendar date.');
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==value) throw new Error('Use a valid ISO calendar date.');
  return date;
}
function addDays(base: string, days: number) {
  if (!Number.isInteger(days) || days<0 || days>3650) throw new Error('Term days must be between 0 and 3650.');
  const date=calendarDate(base);date.setUTCDate(date.getUTCDate()+days);
  const result=date.toISOString().slice(0,10);
  if (!/^\d{4}-/.test(result)) throw new Error('Calculated date is outside the supported calendar range.');
  return result;
}
export function calculatePaymentSchedule(rule: PaymentTermRule, dates: Partial<Record<BaselineSource,string>>) {
  const baseline=dates[rule.baselineSource];
  if (!baseline) throw new Error(`The ${rule.baselineSource} baseline date is required.`);
  calendarDate(baseline);
  return { termsCode: rule.termsCode, termsVersion: rule.version, baselineSource: rule.baselineSource,
    baselineDate: baseline, netDueDate: addDays(baseline,rule.netDays),
    discounts: [
      ...(rule.discount1Days===null ? [] : [{ untilDate:addDays(baseline,rule.discount1Days), percent:rule.discount1Percent }]),
      ...(rule.discount2Days===null ? [] : [{ untilDate:addDays(baseline,rule.discount2Days), percent:rule.discount2Percent }]),
    ],
  };
}
