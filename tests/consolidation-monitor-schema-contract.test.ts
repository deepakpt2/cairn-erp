/**
 * SCR-117 / R-165 stage 2 — CX20 execution schema contract.
 *
 * Execution history is immutable by attempt and current task
 * status stands separately. UCWB remains configuration owner.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('drizzle/0120_consolidation_monitor.sql', 'utf8');
const financeSchema = readFileSync('src/modules/finance/schema.ts', 'utf8');
const vocabulary = readFileSync('src/modules/finance/consolidation-monitor-vocabulary.ts', 'utf8');

describe('SCR-117 stage 2: CX20 execution schema stands aligned', () => {
  it('keys execution, log and current status tenant-first with UCWB foreign keys', () => {
    for (const table of ['consolidation_execution', 'consolidation_execution_log', 'consolidation_task_status']) {
      expect(migration).toContain(`create table public.${table}`);
      expect(financeSchema).toContain(`pgTable('${table}'`);
    }
    expect(migration).toContain('references public.consolidation_task (client, area, version, task)');
    expect(migration).toContain('references public.consolidation_execution (client, run_id)');
    expect(migration).toContain('configuration_version varchar(64) not null');
    expect(migration).toContain('generated_document_refs text not null');
  });

  it('guards modes, states, periods and duplicate simultaneous runs', () => {
    expect(migration).toContain("check (mode in ('TEST', 'UPDATE'))");
    expect(migration).toContain("'OPEN', 'BLOCKED', 'RUNNING', 'COMPLETED', 'WARNING', 'ERROR'");
    expect(migration).toContain('create unique index consolidation_execution_running_uq');
    expect(migration).toContain("where status = 'RUNNING'");
    expect(migration).toContain('check (period between 1 and 20)');
  });

  it('keeps the monitor separate from UCWB configuration and posting tables', () => {
    expect(vocabulary).toContain("export const CONSOLIDATE_CAPABILITY = 'FIN.CONSOLIDATE'");
    expect(vocabulary).toContain('UCWB owns');
    expect(migration).not.toContain('create table public.journal');
    expect(migration).not.toContain('create table public.consolidation_task ');
  });
});
