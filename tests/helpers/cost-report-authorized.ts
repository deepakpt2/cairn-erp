/** The order cost report with a signed-in actor holding the display authority and reach over the whole tenant. */
import { getProductionOrderCostReport as scoped } from '../../src/modules/production/order-cost-report';
import { createProductionActor } from './production-actor';

type Input = Omit<Parameters<typeof scoped>[0], 'authorization'> & { authorization?: Parameters<typeof scoped>[0]['authorization'] };

export async function getProductionOrderCostReport(input: Input) {
  const authorization = input.authorization
    ?? (await createProductionActor(input.client, { capabilities: ['PROD.ORDER.COST.DISPLAY'] })).authorization;
  return scoped({ ...input, authorization });
}
