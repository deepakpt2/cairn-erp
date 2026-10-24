import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('CO11N screen contract', () => {
  const page = read('src/app/production/time-ticket/page.tsx');
  const form = read('src/app/production/time-ticket/TimeTicketWorkbench.tsx');
  const service = read('src/modules/production/time-ticket.ts');

  it('is a time ticket and does not offer an unimplemented control', () => {
    expect(service).toContain("TIME_TICKET_ROUTE = '/production/time-ticket'");
    expect(service).toContain("TIME_TICKET_ALIAS = 'CO11N'");
    expect(page).toContain('timeTicketRefusal');
    expect(page).toContain('data-co11n-gaps');
    expect(form).not.toContain('name="backflush"');
    expect(form).not.toContain('name="personnel"');
    expect(form).not.toContain('value="AUTOMATIC"');
    expect(form).not.toContain('name="confirmationNumber"');
    expect(service).not.toContain('postGoodsIssue');
    expect(service).not.toContain('postProductionReceipt');
  });
});
