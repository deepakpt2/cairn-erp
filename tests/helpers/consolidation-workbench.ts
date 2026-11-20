/**
 * The consolidation workbench with its configuration writes called through a real session: the services require a
 * verified `authorization`, so a setup call here is made by the standing finance test actor. Reads and everything
 * else are re-exported unchanged.
 */
import {
  activateArea as activateAreaService, assignUnit as assignUnitService, saveArea as saveAreaService,
  saveDataBasis as saveDataBasisService, saveGroup as saveGroupService, saveGroupAccount as saveGroupAccountService,
  saveMapping as saveMappingService, saveMethod as saveMethodService, saveTask as saveTaskService,
  saveUnit as saveUnitService, saveVersion as saveVersionService,
} from '../../src/modules/finance/consolidation-workbench';
import { withFinanceAuth } from './finance-actor';

export * from '../../src/modules/finance/consolidation-workbench';

export const activateArea = withFinanceAuth(activateAreaService);
export const assignUnit = withFinanceAuth(assignUnitService);
export const saveArea = withFinanceAuth(saveAreaService);
export const saveDataBasis = withFinanceAuth(saveDataBasisService);
export const saveGroup = withFinanceAuth(saveGroupService);
export const saveGroupAccount = withFinanceAuth(saveGroupAccountService);
export const saveMapping = withFinanceAuth(saveMappingService);
export const saveMethod = withFinanceAuth(saveMethodService);
export const saveTask = withFinanceAuth(saveTaskService);
export const saveUnit = withFinanceAuth(saveUnitService);
export const saveVersion = withFinanceAuth(saveVersionService);
