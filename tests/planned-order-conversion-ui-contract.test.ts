import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { conversionOutcomeText, summarizeConversionResults } from '../src/modules/production/conversion-outcome';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('CO40 and CO41 screen contract', () => {
  const single = read('src/app/production/planned-order-conversion/page.tsx');
  const collective = read('src/app/production/planned-order-conversion-collective/page.tsx');
  const service = read('src/modules/production/planned-order-conversion.ts');
  const seed = read('scripts/seed.ts');

  it('uses one conversion service and does not open the first match', () => {
    expect(service).toContain("PLANNED_ORDER_CONVERT_ROUTE = '/production/planned-order-conversion'");
    expect(service).toContain("PLANNED_ORDER_CONVERT_ALIAS = 'CO40'");
    expect(service).toContain("PLANNED_ORDER_CONVERT_COLLECTIVE_ALIAS = 'CO41'");
    expect(service).toContain('createProductionOrder');
    expect(service).toContain('selectProductionVersion');
    expect(service).toContain('componentRequirementQuantity');
    expect(service).not.toContain('explodePlannedSupply');
    expect(service).not.toContain('insert(productionOrder)');
    expect(single).toContain('The first was not opened.');
    expect(collective).toContain('Search did not convert.');
    expect(collective).not.toContain('convertPlannedOrder(');
    expect(seed).toContain("aliases: ['CO40']");
    expect(seed).toContain("aliases: ['CO41']");
    expect(single).not.toContain('name="mrpArea"');
    expect(collective).not.toContain('name="availability"');
    const form = read('src/app/production/planned-order-conversion/ConvertForm.tsx');
    const collectiveForm = read('src/app/production/planned-order-conversion-collective/CollectiveForm.tsx');
    const collectiveAction = read('src/app/production/planned-order-conversion-collective/actions.ts');
    const singleAction = read('src/app/production/planned-order-conversion/actions.ts');
    const display = read('src/app/production/planned-order-display/page.tsx');
    const outcome = read('src/modules/production/conversion-outcome.ts');
    const stock = read('src/app/production/stock-requirements/StockRequirementsShell.tsx');
    expect(form).toContain('data-co40-reconciliation');
    expect(form).toContain('data-co40-outcome');
    expect(form).toContain('conversionOutcomeText');
    expect(form).not.toContain('Reconciliation was not run.');
    expect(collectiveForm).toContain('data-co41-reconciliation');
    expect(collectiveForm).toContain('conversionOutcomeText');
    expect(collectiveForm).not.toContain('Reconciliation was not run.');
    expect(singleAction).toContain('rolledBackConversion');
    expect(singleAction).toContain('notAttemptedConversion');
    expect(collectiveAction).toContain('summarizeConversionResults');
    expect(collectiveAction).toContain('notAttemptedConversion');
    expect(outcome).toContain('Demand reconciliation is incomplete.');
    expect(outcome).toContain('This is not an incomplete reconciliation.');
    expect(outcome).toContain('prior reconciliation was not revalidated');
    expect(outcome).toContain('Conversion was not attempted.');
    expect(display).toContain('data-md13-demand="active"');
    expect(display).toContain('data-md13-demand="replaced"');
    expect(display).toContain('active planning demand');
    expect(display).toContain('not counted again');
    expect(stock).toContain("data-demand={row.elementType === 'DEPENDENT_REQUIREMENT' ? 'active'");
    expect(service).toContain("reconciliation: 'NOT_RERUN'");
    expect(service).toContain("reconciliation: 'ROLLED_BACK'");
    expect(service).not.toContain("reconciliation: 'NOT_RUN'");
  });

  it('does not describe a failed conversion as incomplete reconciliation', () => {
    expect(conversionOutcomeText('FAILED', 'ROLLED_BACK')).toMatch(/not an incomplete reconciliation/);
    expect(conversionOutcomeText('FAILED', 'PARTIAL')).toMatch(/not a known pair/);
    expect(conversionOutcomeText('FAILED', 'PARTIAL')).not.toMatch(/incomplete/);
    expect(conversionOutcomeText('ALREADY_CONVERTED', 'NOT_RERUN')).toMatch(/not revalidated/);
    expect(conversionOutcomeText('ALREADY_CONVERTED', 'COMPLETE')).toMatch(/not a known pair/);
    expect(conversionOutcomeText('NOT_ATTEMPTED', 'NOT_ATTEMPTED')).toMatch(/not attempted/);
    expect(conversionOutcomeText('CONVERTED', 'PARTIAL')).toMatch(/Demand reconciliation is incomplete/);
    expect(conversionOutcomeText('CONVERTED', 'COMPLETE')).toMatch(/Every open dependent requirement was reconciled/);
    expect(conversionOutcomeText('CONVERTED', 'NONE')).toMatch(/No component requirement date was invented/);
    const mixed = summarizeConversionResults([
      { status: 'FAILED', reconciliation: 'ROLLED_BACK' },
      { status: 'CONVERTED', reconciliation: 'PARTIAL' },
      { status: 'ALREADY_CONVERTED', reconciliation: 'NOT_RERUN' },
    ]);
    expect(mixed).toMatch(/not an incomplete reconciliation/);
    expect(mixed).toMatch(/Demand reconciliation is incomplete/);
    expect(mixed).toMatch(/not revalidated/);
    expect(mixed.indexOf('failed and rolled back')).toBeLessThan(mixed.indexOf('Demand reconciliation is incomplete'));
  });
});
