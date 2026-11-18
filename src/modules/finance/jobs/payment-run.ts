/** PAYMENT.RUN.PROPOSAL and PAYMENT.RUN.EXECUTE — background payment run, queue INTENSIVE, on demand only. */
import { registerJob } from '../../../platform/job/registry';
import type { JobHandler } from '../../../platform/job/types';
import {
  PAYMENT_EXECUTE_JOB, PAYMENT_PROPOSAL_JOB, runPaymentExecuteChunk, runPaymentProposalChunk,
} from '../payment-run-background';

export const paymentProposalJob: JobHandler = { code: PAYMENT_PROPOSAL_JOB, chunk: runPaymentProposalChunk };
export const paymentExecuteJob: JobHandler = { code: PAYMENT_EXECUTE_JOB, chunk: runPaymentExecuteChunk };

registerJob(paymentProposalJob);
registerJob(paymentExecuteJob);
