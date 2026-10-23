/**
 * OCHA is IMG Batch Management, program RMIMGDIRECTOCHA.
 * It is not CT04 (SAPLCTMV). This index does not define a characteristic,
 * assign a class, store a batch value, or post.
 */

export const ACTIVITY = 'CFG.INV.BATCHIMG.DISPLAY';
export const ROUTE = '/config/batch-management';
export const ALIAS = 'OCHA';

export interface BatchImgNode {
  tcode: string;
  title: string;
  route: string;
  activity: string;
  note: string;
}

/** Configuration screens this IMG opens. Each one already exists. */
export const BATCH_IMG_NODES: readonly BatchImgNode[] = [
  {
    tcode: 'OMCE',
    title: 'Define batch level',
    route: '/config/batch-level',
    activity: 'CFG.INV.BATCHLEVEL.DEFINE',
    note: 'One level for the client. The stored code is 0, 1, or 2. It does not post.',
  },
  {
    tcode: 'OMCS',
    title: 'Activate batch status management',
    route: '/config/batch-status',
    activity: 'CFG.INV.BATCHSTATUS.DEFINE',
    note: 'Client indicator. Active is the character 1. It does not select a plant.',
  },
  {
    tcode: 'OMCU',
    title: 'Batch status management in plant',
    route: '/config/batch-status-plants',
    activity: 'CFG.INV.BATCHSTATUSPLANT.DEFINE',
    note: 'Plant selection. Selected is the character X. It applies only when the level is plant.',
  },
  {
    tcode: 'OMAB',
    title: 'Initial status of a new batch',
    route: '/config/batch-initial-status',
    activity: 'CFG.INV.BATCHINITIAL.DEFINE',
    note: 'Material type. X restricts a new batch. Blank does not. An existing batch is not rewritten.',
  },
  {
    tcode: 'OMCZ',
    title: 'Activate internal batch number assignment',
    route: '/config/batch-number-assignment',
    activity: 'CFG.INV.BATCHNUMBER.DEFINE',
    note: 'Client flag, and a plant flag for an account-assigned receipt. It does not create BATCH_CLT.',
  },
  {
    tcode: 'OMAD',
    title: 'Number ranges for batch numbers',
    route: '/config/batch-number-ranges',
    activity: 'CFG.INV.BATCHRANGE.DEFINE',
    note: 'Object BATCH_CLT. Opening it does not create interval 01.',
  },
];

/** Different transactions. Linked so they are not mistaken for OCHA. */
export const NOT_OCHA: readonly BatchImgNode[] = [
  {
    tcode: 'CT04',
    title: 'Characteristics',
    route: '/config/characteristics',
    activity: 'CFG.PROC.CHARACTERISTIC.DEFINE',
    note: 'Characteristic definitions. OCHA does not maintain them.',
  },
  {
    tcode: 'CL02',
    title: 'Classes',
    route: '/config/classes',
    activity: 'CFG.PROC.CLASS.DEFINE',
    note: 'Class and characteristic assignment. OCHA does not assign a class.',
  },
  {
    tcode: 'MSC1N',
    title: 'Create batch',
    route: '/inventory/batches/new',
    activity: 'INV.BATCH.CREATE',
    note: 'Batch master. OCHA does not create a batch.',
  },
];

/** Named so they are not opened from this screen. No route is invented for them. */
export const NOT_OPENED = [
  'batch determination',
  'movement 341',
  'movement 342',
  'class type 023',
] as const;
