/** AUDIT.PERIOD.PACK - period-close evidence pack, queue INTENSIVE, on demand only. */
import { registerJob } from '../../../platform/job/registry';
import type { JobHandler } from '../../../platform/job/types';
import { AUDIT_PERIOD_PACK_JOB, runPeriodPackChunk } from '../period-evidence';

export const periodPackJob: JobHandler = { code: AUDIT_PERIOD_PACK_JOB, chunk: runPeriodPackChunk };

registerJob(periodPackJob);
