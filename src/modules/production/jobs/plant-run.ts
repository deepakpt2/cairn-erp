/** MRP.PLANT.RUN — the background MD01 plant run. Queue INTENSIVE, on demand only. */
import { registerJob } from '../../../platform/job/registry';
import type { JobHandler } from '../../../platform/job/types';
import { MRP_PLANT_JOB, runMrpPlantChunk } from '../mrp-background';

export const mrpPlantRunJob: JobHandler = {
  code: MRP_PLANT_JOB,
  chunk: runMrpPlantChunk,
};

registerJob(mrpPlantRunJob);
