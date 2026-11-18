/** PAYROLL.RUN.CALC and PAYROLL.RUN.POST — background payroll, queue INTENSIVE, on demand only. */
import { registerJob } from '../../../platform/job/registry';
import type { JobHandler } from '../../../platform/job/types';
import { PAYROLL_CALC_JOB, PAYROLL_POST_JOB, runPayrollCalcChunk, runPayrollPostChunk } from '../payroll-background';

export const payrollCalcJob: JobHandler = { code: PAYROLL_CALC_JOB, chunk: runPayrollCalcChunk };
export const payrollPostJob: JobHandler = { code: PAYROLL_POST_JOB, chunk: runPayrollPostChunk };

registerJob(payrollCalcJob);
registerJob(payrollPostJob);
