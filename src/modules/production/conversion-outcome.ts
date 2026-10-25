/**
 * Conversion outcome. Status and reconciliation are a pair. A failed conversion
 * is never described as a created order with incomplete reconciliation.
 */
export const CONVERSION_STATUSES = ['CONVERTED', 'ALREADY_CONVERTED', 'FAILED', 'NOT_ATTEMPTED'] as const;
export type ConversionStatus = typeof CONVERSION_STATUSES[number];

export const DEMAND_RECONCILIATIONS = [
  'COMPLETE',
  'PARTIAL',
  'NONE',
  'NOT_RERUN',
  'ROLLED_BACK',
  'NOT_ATTEMPTED',
] as const;
export type DemandReconciliation = typeof DEMAND_RECONCILIATIONS[number];

export function pairedConversion(status: ConversionStatus, reconciliation: DemandReconciliation): boolean {
  if (status === 'CONVERTED') return reconciliation === 'COMPLETE' || reconciliation === 'PARTIAL' || reconciliation === 'NONE';
  if (status === 'ALREADY_CONVERTED') return reconciliation === 'NOT_RERUN';
  if (status === 'FAILED') return reconciliation === 'ROLLED_BACK';
  return reconciliation === 'NOT_ATTEMPTED';
}

/** One sentence for the pair. An unknown pair is not reported as a successful reconciliation. */
export function conversionOutcomeText(status: ConversionStatus, reconciliation: DemandReconciliation): string {
  if (!pairedConversion(status, reconciliation)) {
    return 'The conversion outcome is not a known pair. It was not treated as a successful reconciliation.';
  }
  if (status === 'FAILED') return 'Conversion failed. Nothing was saved. This is not an incomplete reconciliation.';
  if (status === 'NOT_ATTEMPTED') return 'Conversion was not attempted. Reconciliation did not run.';
  if (status === 'ALREADY_CONVERTED') {
    return 'The order was already converted. Reconciliation was not run again, and the prior reconciliation was not revalidated.';
  }
  if (reconciliation === 'PARTIAL') return 'The production order was created. Demand reconciliation is incomplete.';
  if (reconciliation === 'COMPLETE') return 'Every open dependent requirement was reconciled.';
  return 'No open dependent requirement stood. No component requirement date was invented.';
}

export function summarizeConversionResults(results: Array<{ status: ConversionStatus; reconciliation: DemandReconciliation }>): string {
  const count = (reconciliation: DemandReconciliation) => results.filter((row) => row.reconciliation === reconciliation).length;
  const sentences: string[] = [];
  const rolledBack = count('ROLLED_BACK');
  if (rolledBack > 0) {
    sentences.push(`${rolledBack} conversion${rolledBack === 1 ? '' : 's'} failed and rolled back. That is not an incomplete reconciliation.`);
    if (results.length > rolledBack) sentences.push('The other orders were not rolled back.');
  }
  const partial = count('PARTIAL');
  if (partial > 0) {
    sentences.push(`${partial} production order${partial === 1 ? '' : 's'} created. Demand reconciliation is incomplete.`);
  }
  const complete = count('COMPLETE');
  if (complete > 0) {
    sentences.push(`${complete} conversion${complete === 1 ? '' : 's'} reconciled every open dependent requirement.`);
  }
  const none = count('NONE');
  if (none > 0) {
    sentences.push(`${none} conversion${none === 1 ? '' : 's'} had no open dependent requirement. No component requirement date was invented.`);
  }
  const notRerun = count('NOT_RERUN');
  if (notRerun > 0) {
    sentences.push(`${notRerun} order${notRerun === 1 ? '' : 's'} already converted. Reconciliation was not run again, and the prior reconciliation was not revalidated.`);
  }
  const notAttempted = count('NOT_ATTEMPTED');
  if (notAttempted > 0) sentences.push('Conversion was not attempted. Reconciliation did not run.');
  return sentences.length === 0 ? 'No conversion outcome was returned.' : sentences.join(' ');
}
