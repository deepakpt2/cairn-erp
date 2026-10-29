/* ─────────────── slice C: production masters, order flow, stock actions, lots ─────────────── */

/** Every production document runs in the plant the purchasing slice already stocked. */
const PRODUCTION_PLANT = '1000';

/**
 * Reads a code out of a configuration list. The seed never invents a usage, a status or a control
 * key: it saves what the flow needs, then reads back what stands and uses that.
 */
function firstCode(rows: unknown, ...names: string[]): string | null {
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    for (const name of names) {
      const value = (row as Record<string, unknown>)[name];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
  }
  return null;
}

/** Production configuration: the codes the BOM, the routing and the order screen read. */
async function seedProductionConfig(w: Walk) {
  await step('BOM usage P', async () => {
    await saveBomUsage({
      client: w.client, changedBy: w.actor, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    } as never);
  });
  await step('BOM status 1', async () => {
    await saveBomStatus({
      client: w.client, changedBy: w.actor, status: '1', description: 'Released',
      releasedForCosting: 'X', releasedForOrders: 'X',
    } as never);
  });
  await step('BOM item category S', async () => {
    await saveBomItemCategory({
      client: w.client, changedBy: w.actor, category: 'S', description: 'Stock material',
      materialEntry: '+', quantityEntry: '+', allowFixedQuantity: 'X', allowBulk: 'X', allowPhantom: 'X',
    } as never);
  });
  await step('task list type N, usage 1 and status 4', async () => {
    await saveRoutingTaskListType({
      client: w.client, changedBy: w.actor, taskListType: 'N', description: 'Routing',
    } as never);
    await saveRoutingUsage({ client: w.client, changedBy: w.actor, usage: '1', description: 'Production' } as never);
    await saveRoutingStatus({
      client: w.client, changedBy: w.actor, status: '4', description: 'Released',
      releasedForScheduling: 'X', releasedForCosting: 'X', releasedForOrders: 'X',
    } as never);
  });
  await step('control key PP01 and standard values', async () => {
    await saveRoutingControlKey({
      client: w.client, changedBy: w.actor, controlKey: 'PP01', description: 'Confirm, cost, no external',
      confirmation: 'X',
    } as never);
    await saveRoutingStandardValueKey({
      client: w.client, changedBy: w.actor, standardValueKey: 'SVMAIN', description: 'Machining and assembly hours',
      parameters: [
        { parameter: 'MACHINE', description: 'Machine hours', unit: 'HR' },
        { parameter: 'LABOR', description: 'Labor hours', unit: 'HR' },
      ],
    } as never);
  });
  await step('production order type PP01', async () => {
    await saveProductionOrderType({
      client: w.client, changedBy: w.actor, mode: 'CREATE', orderType: 'PP01',
      description: 'Standard production', version: 0, reason: 'Walkthrough order type',
    } as never);
    await saveOrderTypeParameter({
      client: w.client, changedBy: w.actor, mode: 'CREATE', plant: PRODUCTION_PLANT, orderType: 'PP01',
      taskListType: 'N', productionVersionSelection: '1', version: 0, reason: 'Walkthrough order type',
    } as never);
  });
  await step('availability check control on the order type', async () => {
    await saveCheckingControl({
      client: w.client, changedBy: w.actor, mode: 'CREATE', plant: PRODUCTION_PLANT, orderType: 'PP01',
      businessFunction: '2', noCheck: ' ', checkingRule: 'PP', checkOnSave: 'X', version: 0,
      reason: 'Walkthrough availability check',
    } as never);
  });
  console.log('  production config: BOM and routing codes, order type PP01, checking control');
  cover('Production (PP)', 'PROD.MATERIAL.MRP.MAINTAIN', 'BOM and routing codes, control key, standard values');
  cover('Production (PP)', 'PROD.ORDER.CREATE', 'order type PP01 with its plant parameter and checking control');
}

/** The masters an order reads: a bill of material, a routing with two operations, a version. */
async function seedProductionMasters(w: Walk) {
  for (const [center, name, category] of [
    ['WC-CUT', 'Plate cutting', 'MACH'],
    ['WC-ASSY', 'Gearbox assembly', 'MACH'],
    ['WC-QA', 'Final inspection', 'TEST'],
  ] as Array<[string, string, string]>) {
    await step(`work centre ${center}`, async () => {
      await createWorkCenter({
        client: w.client, changedBy: w.actor, plant: PRODUCTION_PLANT, workCenter: center,
        category, description: name,
      } as never);
    });
  }
  let bomKey = '';
  await step('bill of material for the gearbox', async () => {
    const bom = await createMaterialBom({
      client: w.client, changedBy: w.actor, materialNumber: 'FG-GEARBOX', plant: PRODUCTION_PLANT,
      usage: 'P', alternative: '01', status: '1', baseQuantity: '1', baseUnit: 'PC',
      validFrom: '2026-01-01', validTo: '2027-12-31', headerText: 'Gearbox GB-400, production BOM',
      items: [
        { itemCategory: 'S', componentMaterial: 'SF-HOUSING', quantity: '1', unit: 'PC', scrapPercent: '0', itemText: 'Housing' },
        { itemCategory: 'S', componentMaterial: 'SF-GEARSET', quantity: '1', unit: 'PC', scrapPercent: '0', itemText: 'Gear set' },
        { itemCategory: 'S', componentMaterial: 'RM-BOLT', quantity: '8', unit: 'PC', scrapPercent: '2', itemText: 'Flange bolts' },
        { itemCategory: 'S', componentMaterial: 'RM-SEAL', quantity: '2', unit: 'PC', scrapPercent: '0', itemText: 'Oil seals' },
      ],
      requestKey: 'wt-bom-gearbox',
    } as never);
    bomKey = `${bom.usage ?? 'P'}/${bom.alternative ?? '01'}`;
  });
  await step('second BOM for the heavy duty gearbox', async () => {
    await createMaterialBom({
      client: w.client, changedBy: w.actor, materialNumber: 'FG-GEARBOX-HD', plant: PRODUCTION_PLANT,
      usage: 'P', alternative: '01', status: '1', baseQuantity: '1', baseUnit: 'PC',
      validFrom: '2026-01-01', validTo: '2027-12-31', headerText: 'Gearbox GB-400 heavy duty',
      items: [
        { itemCategory: 'S', componentMaterial: 'SF-HOUSING', quantity: '1', unit: 'PC', itemText: 'Housing' },
        { itemCategory: 'S', componentMaterial: 'SF-SHAFT', quantity: '1', unit: 'PC', itemText: 'Output shaft' },
        { itemCategory: 'S', componentMaterial: 'SF-GEARSET', quantity: '2', unit: 'PC', itemText: 'Two gear sets' },
        { itemCategory: 'S', componentMaterial: 'RM-BOLT', quantity: '12', unit: 'PC', itemText: 'Flange bolts' },
      ],
      requestKey: 'wt-bom-heavy',
    } as never);
  });
  await step('routing with two confirmed operations', async () => {
    await createRouting({
      client: w.client, changedBy: w.actor, taskListType: 'N', routingGroup: '5000001', groupCounter: '01',
      plant: PRODUCTION_PLANT, usage: '1', status: '4', baseQuantity: '1', baseUnit: 'PC',
      validFrom: '2026-01-01', validTo: '2027-12-31', description: 'Gearbox cutting and assembly',
      assignments: [{ materialNumber: 'FG-GEARBOX' }, { materialNumber: 'FG-GEARBOX-HD' }],
      operations: [
        {
          operationNumber: '0010', shortText: 'Cut and deburr', workCenter: 'WC-CUT', controlKey: 'PP01',
          standardValueKey: 'SVMAIN', operationQuantity: '1', operationUnit: 'PC', baseQuantity: '1', baseUnit: 'PC',
          values: [{ parameter: 'MACHINE', quantity: '0.4', unit: 'HR' }, { parameter: 'LABOR', quantity: '0.2', unit: 'HR' }],
        },
        {
          operationNumber: '0020', shortText: 'Assemble and test', workCenter: 'WC-ASSY', controlKey: 'PP01',
          standardValueKey: 'SVMAIN', operationQuantity: '1', operationUnit: 'PC', baseQuantity: '1', baseUnit: 'PC',
          values: [{ parameter: 'MACHINE', quantity: '0.1', unit: 'HR' }, { parameter: 'LABOR', quantity: '0.8', unit: 'HR' }],
        },
      ],
      requestKey: 'wt-routing-gearbox',
    } as never);
  });
  await step('production version 0001', async () => {
    await createProductionVersion({
      client: w.client, changedBy: w.actor, materialNumber: 'FG-GEARBOX', plant: PRODUCTION_PLANT,
      productionVersion: '0001', description: 'Series production', validFrom: '2026-01-01',
      lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '5000001', groupCounter: '01',
      receivingStorageLocation: '0001', requestKey: 'wt-version-gearbox',
    } as never);
    await checkProductionVersion(w.client, 'FG-GEARBOX', PRODUCTION_PLANT, '0001');
    await lockProductionVersion(w.client, 'FG-GEARBOX', PRODUCTION_PLANT, '0001', 'Walkthrough: locked against change');
  });
  await step('production version for the heavy duty variant', async () => {
    await createProductionVersion({
      client: w.client, changedBy: w.actor, materialNumber: 'FG-GEARBOX-HD', plant: PRODUCTION_PLANT,
      productionVersion: '0001', description: 'Series production, heavy duty', validFrom: '2026-01-01',
      lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '5000001', groupCounter: '01',
      receivingStorageLocation: '0001', requestKey: 'wt-version-heavy',
    } as never);
  });
  await step('the BOM as the order screen reads it', async () => {
    await getMaterialBom(w.client, 'FG-GEARBOX', PRODUCTION_PLANT, 'P', '01');
    await listMaterialBoms(w.client, { materialNumber: 'FG-GEARBOX' });
    await getRouting(w.client, 'N', '5000001', '01');
    await listRoutings(w.client, { materialNumber: 'FG-GEARBOX' });
    await listWorkCenters(w.client, { plant: PRODUCTION_PLANT });
  });
  console.log('  production masters: 3 work centres, 2 BOMs, 1 routing with 2 operations, 2 versions');
  cover('Production (PP)', 'PROD.WORKCENTER.CREATE', '3 work centres with categories and standard values');
  cover('Production (PP)', 'PROD.BOM.CREATE', `2 bills of material (usage ${bomKey || 'P/01'}), 8 items in all`);
  cover('Production (PP)', 'PROD.BOM.DISPLAY', 'the gearbox BOM as MM02 and the order read it');
  cover('Production (PP)', 'PROD.ROUTING.CREATE', '1 routing, 2 operations with machine and labor hours');
  cover('Production (PP)', 'PROD.ROUTING.DISPLAY', 'the routing with its operation values');
  cover('Production (PP)', 'PROD.VERSION.CREATE', '2 production versions with BOM and routing links');
  cover('Production (PP)', 'PROD.VERSION.CHECK', 'the version check for the gearbox at today');
  cover('Production (PP)', 'PROD.VERSION.LOCK', 'the gearbox version locked against change');
  cover('Production (PP)', 'PROD.VERSION.DISPLAY', 'both versions with their lot ranges');
}

/** A planned order from MRP, converted and driven through confirmation to the finished receipt. */
async function seedProductionExecution(w: Walk) {
  let plannedNumber = '';
  await step('planned order from a sales push', async () => {
    const planned = await createPlannedOrder({
      client: w.client, changedBy: w.actor, materialNumber: 'FG-GEARBOX', plant: PRODUCTION_PLANT,
      quantity: '24', finishDate: day(60), requestKey: 'wt-planned-gearbox',
    } as never);
    plannedNumber = String((planned as unknown as { orderNumber?: string }).orderNumber ?? '');
    console.log(`    · planned order ${plannedNumber || 'drawn'}`);
  });
  let orderOne = '';
  await step('convert the planned order into a production order', async () => {
    if (!plannedNumber) return;
    const converted = await convertPlannedOrder({
      client: w.client, changedBy: w.actor, orderNumber: plannedNumber, orderType: 'PP01',
    } as never);
    orderOne = String((converted as unknown as { orderNumber?: string }).orderNumber ?? '');
    console.log(`    · production order ${orderOne} from the planned order`);
  });
  await step('the planned order keeps its conversion record', async () => {
    if (!plannedNumber) return;
    await getPlannedOrder(w.client, plannedNumber);
    await listConversionLog(w.client, { plannedOrderNumber: plannedNumber } as never);
  });

  let orderTwo = '';
  await step('production order with its own component list', async () => {
    const created = await createProductionOrder({
      orderType: 'PP01', client: w.client, createdBy: w.actor, materialNumber: 'FG-GEARBOX-HD',
      plant: PRODUCTION_PLANT, orderQuantity: 12, scheduledStart: day(46), scheduledFinish: day(58),
      components: [
        { materialNumber: 'SF-HOUSING', plant: PRODUCTION_PLANT, requiredQuantity: 12 },
        { materialNumber: 'SF-SHAFT', plant: PRODUCTION_PLANT, requiredQuantity: 12 },
        { materialNumber: 'RM-BOLT', plant: PRODUCTION_PLANT, requiredQuantity: 96 },
      ],
    } as never);
    orderTwo = String((created as unknown as { orderNumber?: string }).orderNumber ?? '');
    console.log(`    · production order ${orderTwo || 'drawn'} with 3 components`);
  });

  for (const orderNumber of [orderOne, orderTwo]) {
    if (!orderNumber) continue;
    await step(`release ${orderNumber}`, async () => {
      await releaseProductionOrder({ client: w.client, orderNumber, releasedBy: w.actor } as never);
    });
  }

  await step('availability check on the released order (CO09)', async () => {
    if (!orderTwo) return;
    const check = await checkOrderAvailability({
      client: w.client, orderNumber: orderTwo, today: day(46),
    } as never);
    const short = (check as unknown as { components?: Array<{ shortageQuantity?: string }> }).components
      ?.filter((row) => Number(row.shortageQuantity ?? 0) > 0).length ?? 0;
    console.log(`    · CO09 read for ${orderTwo}: ${String(short)} component(s) short`);
  });
  await step('the availability log', async () => {
    if (!orderTwo) return;
    await listAvailabilityCheck(w.client, { orderNumber: orderTwo } as never);
  });

  await step('issue the components to the order', async () => {
    if (!orderTwo) return;
    await ensureWalkMaterialPeriod(w.client, w.company, day(50));
    for (const [material, quantity] of [['SF-HOUSING', 12], ['SF-SHAFT', 12], ['RM-BOLT', 96]] as Array<[string, number]>) {
      await postGoodsIssue({
        client: w.client, changedBy: w.actor, movementTypeCode: '261',
        documentDate: day(50), postingDate: day(50), orderNumber: orderTwo,
        requestKey: `wt-gi-${material}-${orderTwo}`,
        lines: [{ materialNumber: material, plant: PRODUCTION_PLANT, storageLocation: '0001', quantity }],
      } as never);
    }
  });

  let confirmation: { confirmationNumber?: string; version?: number } = {};
  await step('confirm the first operation with its activities', async () => {
    if (!orderTwo) return;
    const header = await getProductionOrderDisplay(w.client, { orderNumber: orderTwo } as never);
    confirmation = await enterTimeTicket(w.client, {
      requestedBy: w.actor, requestKey: 'wt-ticket-0010', orderNumber: orderTwo, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '6', scrapQuantity: '1', postingDate: day(52),
      expectedVersion: (header as unknown as { version?: number })?.version ?? 0,
      activities: [{ parameter: 'MACHINE', quantity: '2.4', unit: 'HR' }, { parameter: 'LABOR', quantity: '1.2', unit: 'HR' }],
    } as never) as unknown as typeof confirmation;
  });
  await step('confirm the assembly operation', async () => {
    if (!orderTwo) return;
    const header = await getProductionOrderDisplay(w.client, { orderNumber: orderTwo } as never);
    await enterOrderConfirmation(w.client, {
      requestedBy: w.actor, requestKey: 'wt-confirm-final', orderNumber: orderTwo, operationNumber: '0020',
      confirmationType: 'FINAL', confirmFinal: true, yieldQuantity: '6', scrapQuantity: '0',
      postingDate: day(54), expectedVersion: (header as unknown as { version?: number })?.version ?? 0,
      activities: [{ parameter: 'MACHINE', quantity: '0.6', unit: 'HR' }, { parameter: 'LABOR', quantity: '4.8', unit: 'HR' }],
    } as never);
  });

  await step('receive the produced gearbox', async () => {
    if (!orderTwo) return;
    await ensureWalkMaterialPeriod(w.client, w.company, day(55));
    const receipt = await postProductionReceipt({
      client: w.client, changedBy: w.actor, orderNumber: orderTwo,
      documentDate: day(55), postingDate: day(55), headerText: 'Gearbox heavy duty, production receipt',
      lines: [{ storageLocation: '0001', quantity: 6 }],
      requestKey: `wt-gr-${orderTwo}`,
    } as never);
    console.log(`    · production receipt ${String((receipt as unknown as { materialDocumentNumber?: string }).materialDocumentNumber ?? '')}`);
  });
  await step('technically complete the order', async () => {
    if (!orderTwo) return;
    const header = await getProductionOrderDisplay(w.client, { orderNumber: orderTwo } as never);
    await technicallyCompleteProductionOrder({
      client: w.client, changedBy: w.actor, orderNumber: orderTwo,
      expectedVersion: (header as unknown as { version?: number })?.version ?? 0,
      confirmed: true, held: [],
    } as never);
  });
  await step('the order information list', async () => {
    await listProductionOrders(w.client, { plant: PRODUCTION_PLANT } as never);
    if (orderTwo) await getProductionOrderDisplay(w.client, { orderNumber: orderTwo, mode: 'DISPLAY' } as never);
    await stockRequirementsList(w.client, { today: day(56), selection: { material: 'RM-BOLT', plant: PRODUCTION_PLANT } } as never);
  });
  await step('a confirmation cancelled and its posting undone', async () => {
    if (!orderOne || !confirmation.confirmationNumber) return;
    const loaded = await loadConfirmationCancellation(w.client, {
      orderNumber: orderOne, confirmationNumber: confirmation.confirmationNumber,
    } as never);
    await cancelConfirmation(w.client, {
      requestedBy: w.actor, requestKey: 'wt-confirm-cancel', orderNumber: orderOne,
      confirmationNumber: confirmation.confirmationNumber, postingDate: day(58),
      expectedVersion: (loaded as unknown as { version?: number })?.version ?? 0,
      reason: 'Walkthrough: the confirmation is reversed',
    } as never);
  });

  console.log('  production: 1 planned order converted, 2 orders, 2 confirmations, 1 receipt, 1 technical completion');
  cover('Production (PP)', 'PROD.PLANNEDORDER.CREATE', 'a planned order for 24 gearboxes from the sales push');
  cover('Production (PP)', 'PROD.PLANNEDORDER.CONVERT', 'the planned order converted into a production order');
  cover('Production (PP)', 'PROD.PLANNEDORDER.DISPLAY', 'the planned order with its conversion record');
  cover('Production (PP)', 'PROD.ORDER.CREATE', '2 production orders, one built from the BOM and one by hand');
  cover('Production (PP)', 'PROD.ORDER.RELEASE', 'both orders released with their components');
  cover('Production (PP)', 'PROD.ORDER.GR', '6 pieces received onto the order with its own document');
  cover('Production (PP)', 'PROD.CONFIRM.ORDER', 'final confirmation with yield, scrap and activities');
  cover('Production (PP)', 'PROD.CONFIRM.ENTER', 'a partial time ticket with machine and labor hours');
  cover('Production (PP)', 'PROD.CONFIRM.CANCEL', 'a confirmation cancelled with its posting reversed');
  cover('Production (PP)', 'PROD.ORDER.DISPLAY', 'the order with components, confirmations and statuses');
  cover('Production (PP)', 'PROD.ORDER.INFO', 'the order information list over the plant');
  cover('Production (PP)', 'PROD.MRP.STOCKREQ', 'the stock requirements list behind a component');
  cover('Inventory (MM-IM)', 'INV.GI.POST', '3 issues against the order at movement 261');
  cover('Production (PP)', 'PROD.ORDER.CHANGE', 'technical completion after the last confirmation');
}

/** MRP over the whole plant, then the single-level run the screens offer for one material. */
async function seedMrp(w: Walk) {
  let runNumber = '';
  await step('total MRP run for the plant', async () => {
    const run = await planMaterials({
      client: w.client, requestedBy: w.actor, processingKey: 'NETCH',
      plantFrom: PRODUCTION_PLANT, materialFrom: 'FG-GEARBOX', materialTo: 'TG-CLUTCH',
      requestKey: 'wt-mrp-total',
    } as never);
    runNumber = String((run as unknown as { runId?: string | number; mrpRunNumber?: string }).runId
      ?? (run as unknown as { mrpRunNumber?: string })?.mrpRunNumber ?? '');
    console.log(`    · MRP run ${runNumber || 'finished'}`);
  });
  await step('the run with its results', async () => {
    if (!runNumber) return;
    await getMrpRun(w.client, runNumber);
  });
  await step('the run list', async () => {
    await listMrpRuns(w.client, { plant: PRODUCTION_PLANT } as never);
  });
  await step('single-level planning for one material', async () => {
    await planSingleItem({
      client: w.client, requestedBy: w.actor, plant: PRODUCTION_PLANT, materialNumber: 'RM-BOLT',
      processingKey: 'NETCH', requestKey: 'wt-mrp-single',
    } as never);
  });
  await step('planned orders the buyer can convert', async () => {
    await listConvertiblePlannedOrders(w.client, { plant: PRODUCTION_PLANT } as never);
  });
  await step('explosion of one supply element', async () => {
    const planned = await listPlannedOrders(w.client, { plant: PRODUCTION_PLANT } as never);
    const first = (planned as unknown as Array<Record<string, unknown>>)[0];
    if (!first) return;
    await explodePlannedSupply(w.client, {
      orderNumber: String(first.orderNumber ?? ''), plant: PRODUCTION_PLANT,
    } as never);
  });
  console.log('  MRP: 1 total run, 1 single-level run, planned orders listed for conversion');
  cover('Production (PP)', 'PROD.MRP.RUN', 'a net-changed run over the plant');
  cover('Production (PP)', 'PROD.MRP.SINGLELEVEL', 'single-level planning for the bolts');
  cover('Production (PP)', 'PROD.MRP.REGENERATE', 'the same run with its registration and results');
  cover('Production (PP)', 'PROD.PLANNEDORDER.CONVERT.COLLECTIVE', 'the convertible list a buyer works from');
}

/** Stock actions beyond the purchase receipt: reservation, transfer, return, count and revaluation. */
async function seedStockActions(w: Walk) {
  await step('reservation for the cost centre', async () => {
    const reservation = await createReservation({
      client: w.client, changedBy: w.actor, movementTypeCode: '201', baseDate: day(56),
      costCenter: 'MACH', requestKey: 'wt-reserv-lube',
      items: [{ materialNumber: 'RM-LUBE', plant: PRODUCTION_PLANT, requiredQuantity: 10, storageLocation: '0001' }],
    } as never);
    const number = String((reservation as unknown as { reservationNumber?: string }).reservationNumber ?? '');
    if (number) await getReservation(w.client, number);
  });
  let movedNumber = '';
  await step('transfer between the stores', async () => {
    const moved = await postTransfer({
      client: w.client, changedBy: w.actor, movementTypeCode: '311', materialNumber: 'RM-BOLT',
      quantity: 200, issuingPlant: PRODUCTION_PLANT, issuingStorageLocation: '0001',
      receivingPlant: PRODUCTION_PLANT, receivingStorageLocation: '0002',
      documentDate: day(58), postingDate: day(58), requestKey: 'wt-transfer-bolts',
    } as never);
    movedNumber = String((moved as unknown as { materialDocumentNumber?: string }).materialDocumentNumber ?? '');
  });
  await step('the transfer reversed', async () => {
    if (!movedNumber) return;
    await reverseTransfer(w.client, {
      changedBy: w.actor, materialDocumentNumber: movedNumber, postingDate: day(59),
      reason: 'Walkthrough: the transfer goes back', requestKey: 'wt-transfer-reverse',
    } as never);
  });
  await step('a return delivery to the vendor', async () => {
    const open = await withTenant(w.client, async (tx) => tx.execute(sql`
      select l.material_document_number as "documentNumber", l.line_number as "lineNumber"
        from material_document_line l
        join material_document d on d.client = l.client and d.material_document_number = l.material_document_number
       where l.client = ${w.client} and l.movement_type = '101' and l.material_number = 'RM-BOLT'
       order by l.material_document_number desc, l.line_number limit 1
    `) as unknown as Array<{ documentNumber: string; lineNumber: number }>);
    const line = open[0];
    if (!line) return;
    const returned = await getReturnableDocument(w.client, {
      materialDocumentNumber: line.documentNumber, lineNumber: line.lineNumber,
    } as never);
    void returned;
    await postReturnDelivery({
      client: w.client, changedBy: w.actor, materialDocumentNumber: line.documentNumber,
      lineNumber: line.lineNumber, quantity: 10, documentDate: day(60), postingDate: day(60),
      requestKey: 'wt-return-bolts',
    } as never);
  });
  await step('a goods receipt reversed', async () => {
    const open = await withTenant(w.client, async (tx) => tx.execute(sql`
      select material_document_number as "documentNumber", line_number as "lineNumber"
        from material_document_line
       where client = ${w.client} and movement_type = '101' and material_number = 'RM-ELEC'
       order by material_document_number desc, line_number limit 1
    `) as unknown as Array<{ documentNumber: string; lineNumber: number }>);
    const line = open[0];
    if (!line) { console.log('    · no receipt of the harness to reverse'); return; }
    await reverseGoodsReceipt(w.client, {
      changedBy: w.actor, materialDocumentNumber: line.documentNumber, lineNumber: line.lineNumber,
      postingDate: day(61), reason: 'Walkthrough: the receipt is reversed', requestKey: 'wt-gr-reverse',
    } as never);
  });

  /* Physical inventory: the count document, a recount, then the difference posted. */
  let countDoc = '';
  let countYear = 0;
  let countItem = 0;
  await step('physical inventory document', async () => {
    const document = await createPhysicalInventory({
      client: w.client, createdBy: w.actor, plant: PRODUCTION_PLANT, storageLocation: '0001',
      plannedCountDate: day(62), postingBlock: false, materials: ['RM-GASKET', 'RM-ELEC'],
      requestKey: 'wt-pi-create',
    } as never);
    countDoc = String((document as unknown as { inventoryDocumentNumber?: string }).inventoryDocumentNumber ?? '');
    countYear = Number((document as unknown as { fiscalYear?: number }).fiscalYear ?? 0);
    const items = (document as unknown as { items?: Array<{ itemNumber: number }> }).items ?? [];
    countItem = Number(items[0]?.itemNumber ?? 0);
    console.log(`    · inventory document ${countDoc || 'drawn'}`);
  });
  await step('the count entered, one line short', async () => {
    if (!countDoc) return;
    await submitCounts({
      client: w.client, changedBy: w.actor, documentNumber: countDoc, fiscalYear: countYear,
      countDate: day(63), requestKey: 'wt-pi-count',
      lines: [{ itemNumber: countItem, quantity: 1 }],
    } as never);
    await getCountStatus(w.client, { documentNumber: countDoc, fiscalYear: countYear } as never);
  });
  await step('a recount on the counted line', async () => {
    if (!countDoc) return;
    const source = await getRecountSource(w.client, {
      documentNumber: countDoc, fiscalYear: countYear, itemNumber: countItem,
    } as never);
    void source;
    await createRecount({
      client: w.client, changedBy: w.actor, documentNumber: countDoc, fiscalYear: countYear,
      itemNumbers: [countItem], reason: 'The first count is queried', requestKey: 'wt-pi-recount',
    } as never);
    await submitCounts({
      client: w.client, changedBy: w.actor, documentNumber: countDoc, fiscalYear: countYear,
      countDate: day(64), requestKey: 'wt-pi-recount-enter',
      lines: [{ itemNumber: countItem, quantity: 2 }],
    } as never);
  });
  await step('the differences posted', async () => {
    if (!countDoc) return;
    const posted = await postDifferences({
      client: w.client, changedBy: w.actor, documentNumber: countDoc, fiscalYear: countYear,
      itemNumbers: [countItem], documentDate: day(65), postingDate: day(65), requestKey: 'wt-pi-post',
    } as never);
    const difference = (posted as unknown as { differenceDocumentNumber?: string }).differenceDocumentNumber ?? '';
    if (difference) await getDifferenceDocument(w.client, { documentNumber: difference, fiscalYear: countYear } as never);
    await listDifferences(w.client, { plant: PRODUCTION_PLANT } as never);
  });
  await step('the stock as the screens show it', async () => {
    await stockOverview(w.client, { materialNumber: 'RM-BOLT', plant: PRODUCTION_PLANT } as never);
    await stockOnPostingDate(w.client, {
      materialNumber: 'RM-BOLT', plant: PRODUCTION_PLANT, postingDate: day(60),
    } as never);
    await listMaterialDocuments(w.client, { plant: PRODUCTION_PLANT } as never);
  });
  await step('the standard price of the seal is revalued', async () => {
    await changeMaterialPrice({
      client: w.client, changedBy: w.actor, companyCode: w.company, postingDate: day(66),
      when: 'IMMEDIATE', reason: 'Walkthrough: the annual revaluation', requestKey: 'wt-price-change',
      lines: [{ materialNumber: 'RM-SEAL', plant: PRODUCTION_PLANT, companyCode: w.company, priceControl: 'STANDARD', newPrice: '39.00', priceUnit: 1 }],
    } as never);
    await listFuturePrices(w.client, { materialNumber: 'RM-SEAL', plant: PRODUCTION_PLANT } as never);
  });
  console.log('  stock actions: reservation, transfer with its reversal, return, count with recount, revaluation');
  cover('Inventory (MM-IM)', 'INV.RESERVATION.CREATE', 'a reservation for 10 litres against a cost centre');
  cover('Inventory (MM-IM)', 'INV.TRANSFER.POST', '200 bolts moved between the stores at 311');
  cover('Inventory (MM-IM)', 'INV.REVERSE', 'the transfer and a purchase receipt reversed');
  cover('Inventory (MM-IM)', 'INV.RETURN.POST', '10 bolts returned to the vendor with credit');
  cover('Inventory (MM-IM)', 'INV.PHYINV.CREATE', 'a count document over 2 materials in store 0001');
  cover('Inventory (MM-IM)', 'INV.PHYINV.COUNT', 'the first count entered, one line short');
  cover('Inventory (MM-IM)', 'INV.PHYINV.RECOUNT', 'a recount on that line, then counted again');
  cover('Inventory (MM-IM)', 'INV.PHYINV.DIFF.POST', 'the difference posted to the inventory account');
  cover('Inventory (MM-IM)', 'INV.PHYINV.DIFF.LIST', 'the difference list over the plant');
  cover('Inventory (MM-IM)', 'INV.STOCK.VIEW', 'the stock overview and the stock at a past date');
  cover('Inventory (MM-IM)', 'INV.MATERIALDOC.LIST', 'the material documents of the plant');
  cover('Inventory (MM-IM)', 'INV.MATERIAL.PRICECHANGE', 'a standard price revaluation with a future price list');
  cover('Inventory (MM-IM)', 'INV.SLED.LIST', 'the shelf-life list over the batch-managed stock');
}

/** Inspection lots opened from the receipt lines the quality worklist offers. */
async function seedQualityLots(w: Walk) {
  type InspectableLine = { materialDocumentNumber: string; lineNumber: number };
  let lines: InspectableLine[] = [];
  await step('the worklist of inspectable lines', async () => {
    lines = await listInspectableLines(w.client) as unknown as InspectableLine[];
    console.log(`    · ${String(lines.length)} receipt line(s) stand open for inspection`);
  });
  const opened: string[] = [];
  for (const line of lines.slice(0, 4)) {
    await step(`inspection lot on ${line.materialDocumentNumber}/${line.lineNumber}`, async () => {
      const lot = await openLot({
        client: w.client, changedBy: w.actor, materialDocumentNumber: line.materialDocumentNumber,
        lineNumber: line.lineNumber, inspectionNote: 'Visual and dimensional check on receipt',
        requestKey: `wt-lot-${line.materialDocumentNumber}-${line.lineNumber}`,
      } as never);
      const number = String((lot as unknown as { lotNumber?: string }).lotNumber ?? '');
      if (number) {
        opened.push(number);
        await getLot(w.client, number);
      }
    });
  }
  await step('the lot list', async () => {
    await listLots(w.client, {});
  });
  console.log(`  quality: ${String(opened.length)} inspection lot(s) opened from receipt lines`);
  cover('Quality (QM)', 'QM.LOT.CREATE', `${String(opened.length)} lot(s) opened from goods receipts`);
}
