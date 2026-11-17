/**
 * The document categories a release group may judge, with the words the screens use.
 * No server imports: the configuration screen is a client component and reads this.
 */
export const RELEASE_CATEGORY_LABELS: Record<string, string> = {
  PURCHASE_REQUISITION: 'Purchase requisitions',
  PURCHASE_ORDER: 'Purchase orders',
  PURCHASE_CONTRACT: 'Purchase contracts',
  SCHED_AGREEMENT: 'Scheduling agreements',
  JOURNAL_ENTRY: 'Parked journal entries',
  PAYMENT_RUN: 'Payment runs',
};
