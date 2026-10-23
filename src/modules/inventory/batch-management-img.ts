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
  {
    tcode: 'OMCT',
    title: 'Batch conversion check',
    route: '/config/batch-conversion',
    activity: 'CFG.INV.BATCHCONVERT.DEFINE',
    note: 'The last finding is read. The check does not change the level or the status.',
  },
  {
    tcode: 'ODOC',
    title: 'Document management for batches',
    route: '/config/batch-document-management',
    activity: 'CFG.INV.BATCHDOCMGMT.DEFINE',
    note: 'The flag is stored. A file is not stored from this index.',
  },
  {
    tcode: 'OMCV',
    title: 'Batch classification',
    route: '/config/batch-classification',
    activity: 'CFG.INV.BATCHCLASSIFY.DEFINE',
    note: 'The flag is stored. A class is not assigned here.',
  },
  {
    tcode: 'OMCW',
    title: 'Strategy types',
    route: '/config/batch-strategy-types',
    activity: 'CFG.INV.BATCHSTRATEGY.DEFINE',
    note: 'Inventory only. A strategy does not select a batch.',
  },
  {
    tcode: 'OMCX',
    title: 'Access sequences',
    route: '/config/batch-access-sequences',
    activity: 'CFG.INV.BATCHACCESS.DEFINE',
    note: 'The sequence is stored. A condition record is not selected.',
  },
  {
    tcode: 'OMA1',
    title: 'Condition tables',
    route: '/config/batch-condition-tables',
    activity: 'CFG.INV.BATCHCONDTABLE.DEFINE',
    note: 'The table name is stored. A condition record is not written.',
  },
  {
    tcode: 'OMCY',
    title: 'Search procedures',
    route: '/config/batch-search-procedures',
    activity: 'CFG.INV.BATCHSEARCH.DEFINE',
    note: 'The procedure is stored. A batch is not searched.',
  },
  {
    tcode: 'OMCG',
    title: 'Search procedure allocation',
    route: '/config/batch-search-allocations',
    activity: 'CFG.INV.BATCHALLOCATE.DEFINE',
    note: 'A posting reads the check flag and does not perform the check.',
  },
  {
    tcode: 'OMCWB',
    title: 'WIP batch',
    route: '/config/wip-batch',
    activity: 'CFG.PROD.WIPBATCH.DEFINE',
    note: 'An order reads the flag. A WIP batch is not created.',
  },
];

/** Transactions that already exist. Linked, not listed as IMG activities. */
export const RELATED_BATCH_NODES: readonly BatchImgNode[] = [
  {
    tcode: 'MBC1',
    title: 'Search strategy',
    route: '/inventory/batch-search-strategies',
    activity: 'INV.BATCHSTRATEGY.MAINTAIN',
    note: 'The saved strategy is not consumed by a goods movement.',
  },
  {
    tcode: 'BMC1',
    title: 'Batch class',
    route: '/inventory/batch-classes',
    activity: 'INV.BATCHCLASS.MAINTAIN',
    note: 'A class that stands is not assigned to a batch from this index.',
  },
  {
    tcode: 'CU70',
    title: 'Sort sequence',
    route: '/inventory/batch-sort-sequences',
    activity: 'INV.BATCHSORT.MAINTAIN',
    note: 'A released sequence is read and not applied.',
  },
  {
    tcode: 'MB5C',
    title: 'Batch pick-up list',
    route: '/inventory/batch-pickup',
    activity: 'INV.BATCH.PICKUP',
    note: 'The list names documents that already stand.',
  },
  {
    tcode: 'MB5M',
    title: 'Shelf life list',
    route: '/inventory/shelf-life-list',
    activity: 'INV.SLED.LIST',
    note: 'Unrestricted batch stock by the stored expiration date. It does not post.',
  },
  {
    tcode: 'BMBC',
    title: 'Batch cockpit',
    route: '/inventory/batch-cockpit',
    activity: 'INV.BATCH.COCKPIT',
    note: 'Genealogy is not inferred.',
  },
  {
    tcode: 'MSC2N',
    title: 'Change batch',
    route: '/inventory/batches/change',
    activity: 'INV.BATCH.CHANGE',
    note: 'The batch screen. A class is not assigned here.',
  },
  {
    tcode: 'MSC3N',
    title: 'Display batch',
    route: '/inventory/batches/display',
    activity: 'INV.BATCH.DISPLAY',
    note: 'The batch screen. The last conversion finding is shown and not applied.',
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
