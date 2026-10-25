/**
 * The batch-classification vocabulary OMCV shows.
 *
 * Kept apart from the maintenance service so the screen can offer the same
 * words without pulling the database into the client bundle — the same
 * separation `movement-type-vocabulary.ts` uses. Nothing here reads or writes:
 * no capability is checked, no row is loaded, and no refusal is raised.
 *
 * `batchClassificationRefusal`, the capability gate, the lock, and every writer
 * that changes or completes a classification stay in `batch-classification.ts`.
 */

export const CLASSIFICATION_CODES = [' ', '1', '2', '3', '4'] as const;

export const CLASSIFICATION_MEANING: Record<ClassificationCode, string> = {
  ' ': 'No branching to batch classification',
  '1': 'Classification carried out in background (all batches)',
  '2': 'Classification only in foreground for mandatory characteristics (all batches)',
  '3': 'Classification always in foreground (all batches)',
  '4': 'Classification in foreground for new batches only',
};

export type ClassificationCode = (typeof CLASSIFICATION_CODES)[number];

export interface BatchClassificationRow {
  movementType: string;
  description: string;
  classification: ClassificationCode;
  changedBy: string | null;
  changedAt: Date | null;
}
