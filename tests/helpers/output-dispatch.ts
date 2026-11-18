/**
 * Runs the OUTPUT.DISPATCH job the way the worker would: chunk after chunk until the cursor is
 * exhausted. Output dispatch is a job (MAIL-03), so a test that posts a document and then asks what
 * was sent has to run it first.
 */
import { outputDispatchJob, OUTPUT_DISPATCH_JOB } from '../../src/modules/output/jobs/dispatch';
import type { Cursor } from '../../src/platform/job/types';

export async function runOutputDispatch(client: string, chunkSize = 25): Promise<{ chunks: number; progress: string[] }> {
  let cursor: Cursor | null = null;
  let chunks = 0;
  const progress: string[] = [];
  do {
    const result = await outputDispatchJob.chunk({
      client,
      runId: `test-${Date.now()}`,
      jobCode: OUTPUT_DISPATCH_JOB,
      parameters: {},
      cursor,
      chunkSize,
      isCancelRequested: () => false,
      epoch: 0,
      isLeaseLost: () => false,
      fence: async () => {},
      log: async () => {},
    });
    chunks += 1;
    if (result.progressText) progress.push(result.progressText);
    cursor = result.cursor;
  } while (cursor && chunks < 100);
  return { chunks, progress };
}
