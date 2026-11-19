/** LEAVE.BALANCE.EXPORT - large leave-balance CSV, queue INTENSIVE, on demand only. */
import { registerJob } from '../../../platform/job/registry';
import type { JobHandler } from '../../../platform/job/types';
import { LEAVE_EXPORT_JOB, runLeaveExportChunk } from '../leave-export';

export const leaveExportJob: JobHandler = { code: LEAVE_EXPORT_JOB, chunk: runLeaveExportChunk };

registerJob(leaveExportJob);
