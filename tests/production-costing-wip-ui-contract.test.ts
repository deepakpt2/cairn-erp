import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * Activity costing and financial WIP: the existing screens carry them, no new screen is created, and the wording
 * never calls a plan rate an actual rate.
 */
describe('production costing and WIP contract', () => {
  it('extends existing screens only: work center costing, settlement, cost report, confirmation display, account determination', () => {
    expect(read('src/app/production/work-centers/WorkCenterForm.tsx')).toContain('Actual quantity at plan rate');
    expect(read('src/app/production/work-centers/WorkCenterForm.tsx')).toContain('list="costing-parameters"');
    expect(read('src/app/production/order-settlement/page.tsx')).toContain('<WipForm');
    expect(read('src/app/production/order-cost-report/page.tsx')).toContain('data-cost-report-activity');
    expect(read('src/app/production/order-cost-report/page.tsx')).toContain('data-cost-report-wip');
    expect(read('src/app/production/confirmation-display/page.tsx')).toContain('data-co14-activity-cost');
    const events = read('src/modules/foundation/account-determination.ts');
    for (const event of ['PRODUCTION_ACTIVITY', 'PRODUCTION_WIP', 'PRODUCTION_WIP_CHANGE']) expect(events).toContain(`event: '${event}'`);
  });

  it('labels the basis as a plan rate at actual quantity, never an actual rate', () => {
    const service = read('src/modules/production/activity-costing.ts');
    expect(service).toContain('Actual quantity valued at a configured plan rate (not an actual-rate calculation)');
    expect(read('src/app/production/work-centers/WorkCenterForm.tsx')).toMatch(/It is not an actual-rate calculation/);
  });

  it('keeps the heavy work off a new worker: a bounded foreground run, no new job queue', () => {
    const wip = read('src/modules/production/order-wip.ts');
    expect(wip).toContain('WIP_MAX_ORDERS = 200');
    expect(wip).not.toMatch(/enqueue|job_run|INTENSIVE/);
  });

  it('settlement refuses an unfinished order and unwinds WIP inside its own transaction', () => {
    const settlement = read('src/modules/production/order-settlement.ts');
    expect(settlement).toContain('released and not technically completed');
    expect(settlement).toContain('unwindWipForSettlementInTx(tx,');
  });

  it('preview and test run are read-only: no insert or journal post on the preview path', () => {
    const costing = read('src/modules/production/activity-costing.ts');
    expect(costing).toMatch(/if \(options\.preview\) \{\s*run\.outcomes\.push\(\{ parameter: activity\.parameter, status: 'PREVIEW'/);
    const wip = read('src/modules/production/order-wip.ts');
    expect(wip).toMatch(/if \(input\.testRun\) \{\s*results\.push\(await withTenant\(client, \(tx\) => calculateWip/);
  });
});
