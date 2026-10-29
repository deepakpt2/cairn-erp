/* ══ Purchasing: sources, requisitions, RFQ, contracts, orders, receipts, invoices ══ */

/** One run-one-report block, so a single refusal cannot take the rest of the seed with it. */
async function step(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    skip(label, error);
  }
}

/** A date `days` after the walkthrough's anchor, as the app stores it. */
function day(offset: number): string {
  const base = new Date(Date.UTC(2026, 3, 1));
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

async function seedReleaseConfiguration(w: Walk) {
  await saveReleaseGroup({
    client: w.client, changedBy: w.actor, mode: 'CREATE', groupCode: 'PO', documentCategory: 'PURCHASE_ORDER',
    description: 'Purchase order releases', reason: 'Walkthrough release procedure',
    codes: [{ code: 'MGR', description: 'Purchasing manager' }, { code: 'FIN', description: 'Finance approver' }],
  }).catch((error) => { if (!/exist/i.test(String(error))) skip('release group PO', error); });
  await saveReleaseGroup({
    client: w.client, changedBy: w.actor, mode: 'CREATE', groupCode: 'PR', documentCategory: 'PURCHASE_REQUISITION',
    description: 'Requisition releases', reason: 'Walkthrough release procedure',
    codes: [{ code: 'MGR', description: 'Purchasing manager' }],
  }).catch((error) => { if (!/exist/i.test(String(error))) skip('release group PR', error); });
  for (const [groupCode, strategyCode, className, priority, steps, from] of [
    ['PO', 'MEGA', 'PO_RELEASE', 10, ['MGR', 'FIN'], '50000'],
    ['PR', 'STD', 'PR_RELEASE', 100, ['MGR'], '10000'],
  ] as Array<[string, string, string, number, string[], string]>) {
    await saveReleaseStrategy({
      client: w.client, changedBy: w.actor, mode: 'CREATE', groupCode, strategyCode,
      description: `${strategyCode} walkthrough strategy`, className, priority,
      criteria: [{ characteristicName: 'TOTAL_VALUE', operator: 'GE', valueFrom: from, valueTo: '' }],
      steps, reason: 'Walkthrough release procedure',
    }).catch((error) => skip(`release strategy ${groupCode}/${strategyCode}`, error));
    await setReleaseStrategyStatus({
      client: w.client, changedBy: w.actor, groupCode, strategyCode, status: 'ACTIVE', reason: 'Walkthrough release procedure',
    }).catch((error) => skip(`activate ${groupCode}/${strategyCode}`, error));
  }
  console.log('  release procedures: PR on one stage, PO on two, both active');
  cover('Procurement (MM)', 'CFG.MM.PURCH.RELEASE', '2 groups, 2 active strategies');
}

async function seedPurchasingSources(w: Walk) {
  /* Purchasing info records: the price the order reads when none is typed. */
  const records: Array<[string, string, number, number, string]> = [
    ['V10000', 'RM-STEEL01', 79.5, 100, 'KG'],
    ['V10000', 'RM-STEEL02', 72.0, 500, 'KG'],
    ['V20000', 'RM-POLY', 205.0, 50, 'KG'],
    ['V50000', 'RM-BEARING', 139.0, 200, 'PC'],
    ['V40000', 'RM-BOLT', 4.05, 5000, 'PC'],
    ['V60000', 'RM-PAINT', 378.0, 40, 'L'],
    ['V80000', 'TG-CLUTCH', 1765.0, 20, 'PC'],
  ];
  for (const [supplier, material, price, minimum, unit] of records) {
    await step(`info record ${supplier}/${material}`, async () => {
      await createPurchasingInfoRecord({
        client: w.client, changedBy: w.actor, partnerNumber: supplier, materialNumber: material,
        purchasingOrg: w.company, price, plannedDeliveryDays: 7, minimumOrderQuantity: minimum, minimumOrderUnit: unit,
      });
    });
  }
  /* Source list: one fixed source, one blocked alternative the order must refuse. */
  const sources: Array<[string, string, boolean, boolean]> = [
    ['RM-STEEL01', 'V10000', true, false],
    ['RM-POLY', 'V20000', true, false],
    ['RM-BEARING', 'V50000', false, false],
    ['RM-BOLT', 'V40000', false, false],
    ['TG-CLUTCH', 'V80000', true, false],
  ];
  for (const [material, supplier, fixed, blocked] of sources) {
    await step(`source list ${material}`, async () => {
      await createSourceListEntry({
        client: w.client, changedBy: w.actor, materialNumber: material, plant: '1000', partnerNumber: supplier,
        purchasingOrg: w.company, validFrom: '2026-04-01', validTo: '2029-03-31', fixedSource: fixed, blocked,
      });
    });
  }
  /* A quota arrangement over two suppliers, and the requisition that adopts it. */
  await step('quota arrangement', async () => {
    await createQuotaArrangement({
      client: w.client, changedBy: w.actor, materialNumber: 'RM-BOLT', plant: '1000',
      validFrom: '2026-04-01', validTo: '2029-03-31',
      items: [
        { partnerNumber: 'V40000', purchasingOrg: w.company, quota: 70 },
        { partnerNumber: 'V10000', purchasingOrg: w.company, quota: 30 },
      ],
    });
  });
  console.log(`  sources: ${records.length} info records, ${sources.length} source-list entries, 1 quota arrangement`);
  cover('Procurement (MM)', 'PROC.INFO.RECORD.MAINTAIN', `${records.length} records with price and lead time`);
  cover('Procurement (MM)', 'PROC.SOURCE.LIST.MAINTAIN', `${sources.length} entries, 3 fixed sources`);
  cover('Procurement (MM)', 'PROC.QUOTA.MAINTAIN', 'RM-BOLT split 70/30 over two suppliers');
}

async function seedPurchasingDocuments(w: Walk) {
  const order = async (label: string, input: Parameters<typeof createOrder>[0]) => {
    try {
      const created = await createOrder(input);
      console.log(`    · ${label}: ${created.orderNumber}`);
      return created.orderNumber;
    } catch (error) {
      skip(`${label}`, error);
      return '';
    }
  };

  /* Requisitions: two planned, one account-assigned, one a service — then release one. */
  const requisitions: Array<{ label: string; items: unknown[] }> = [
    { label: 'steel for April', items: [{ materialNumber: 'RM-STEEL01', shortText: 'Steel plate for April runs', quantity: 400, unit: 'KG', deliveryDate: day(20), plant: '1000', storageLocation: '0001', purchasingGroup: '001', priceUnit: 1, currency: '', markedForDeletion: false, assignments: [] }] },
    { label: 'polymer for April', items: [{ materialNumber: 'RM-POLY', shortText: 'Resin pellets', quantity: 120, unit: 'KG', deliveryDate: day(24), plant: '1000', storageLocation: '', purchasingGroup: '001', priceUnit: 1, currency: '', markedForDeletion: false, assignments: [] }] },
    { label: 'lubricant to cost centre', items: [{ materialNumber: 'RM-LUBE', shortText: 'Machine lubricant', quantity: 60, unit: 'L', deliveryDate: day(18), plant: '1000', storageLocation: '', purchasingGroup: '001', estimatedPrice: 220, priceUnit: 1, currency: '', accountAssignmentCategory: 'COST_CENTER', markedForDeletion: false, assignments: [{ glAccount: '410000', costCenter: 'MACH', distributionPercentage: 100 }] }] },
    { label: 'contract maintenance hours', items: [{ materialNumber: 'SG-CONTRACT', shortText: 'Maintenance hours', quantity: 24, unit: 'HR', deliveryDate: day(30), plant: '1000', storageLocation: '', purchasingGroup: '001', estimatedPrice: 900, priceUnit: 1, currency: '', accountAssignmentCategory: 'COST_CENTER', markedForDeletion: false, assignments: [{ glAccount: '410000', costCenter: 'MACH', distributionPercentage: 100 }] }] },
  ];
  const requisitionNumbers: string[] = [];
  for (const spec of requisitions) {
    await step(`requisition ${spec.label}`, async () => {
      const created = await createRequisition({
        client: w.client, changedBy: w.actor, items: spec.items as never,
      });
      requisitionNumbers.push(created.requisitionNumber);
      console.log(`    · requisition ${spec.label}: ${created.requisitionNumber}`);
    });
  }
  await step('release the first requisition', async () => {
    if (!requisitionNumbers[0]) return;
    await releaseDocument({
      client: w.client, changedBy: w.actor, documentNumber: requisitionNumbers[0], releaseCode: 'MGR',
      reason: 'Approved in the walkthrough',
    } as never);
  });
  /* A requisition converted into an order, keeping the link visible in both documents. */
  let convertedFrom: { requisition: string; item: number; material: string; quantity: number; unit: string; plant: string } | null = null;
  await step('read the first requisition for conversion', async () => {
    const detail = await getRequisition(w.client, requisitionNumbers[0]);
    const line = detail?.items[0];
    if (line) {
      convertedFrom = {
        requisition: requisitionNumbers[0], item: line.itemNumber, material: line.materialNumber ?? '',
        quantity: Number(line.quantity), unit: line.unit, plant: line.plant,
      };
    }
  });

  /* RFQ → two quotations → comparison → order from the winning quotation. */
  let rfqNumber = '';
  await step('request for quotation', async () => {
    const rfq = await createRequestForQuotation({
      client: w.client, changedBy: w.actor, purchasingOrg: w.company, purchasingGroup: '001',
      rfqDate: day(2), quotationDeadline: day(16), currency: 'INR',
      suppliers: [{ partnerNumber: 'V10000' }, { partnerNumber: 'V40000' }],
      lines: [
        { materialNumber: 'RM-STEEL01', quantity: 800, unit: 'KG', plant: '1000', deliveryDate: day(30) },
        { materialNumber: 'RM-BOLT', quantity: 4000, unit: 'PC', plant: '1000', deliveryDate: day(30) },
      ],
    });
    rfqNumber = rfq.eventNumber;
  });
  const quotations: string[] = [];
  for (const [supplier, steel, bolt] of [['V10000', 78.5, 3.95], ['V40000', 80.0, 3.80]] as Array<[string, number, number]>) {
    await step(`quotation from ${supplier}`, async () => {
      const opened = await openQuotation(w.client, rfqNumber);
      const q = await createQuotation({
        client: w.client, changedBy: w.actor, rfqNumber, supplierNumber: supplier,
        quotationNumber: opened?.quotationNumber ?? undefined,
        validityDate: day(45), currency: 'INR',
        lines: [
          { itemNumber: 10, supplierMaterialNumber: `${supplier}-ST`, quantity: 800, unit: 'KG', netPrice: steel, priceUnit: 1, deliveryDate: day(32) },
          { itemNumber: 20, supplierMaterialNumber: `${supplier}-BT`, quantity: 4000, unit: 'PC', netPrice: bolt, priceUnit: 1, deliveryDate: day(32) },
        ],
      } as never);
      quotations.push(q.quotationNumber);
    });
  }
  await step('quotation comparison', async () => {
    const comparison = await compareQuotations({ client: w.client, eventNumber: rfqNumber, purchasingOrg: w.company });
    const best = (comparison as unknown as { rows?: Array<{ quotationNumber?: string }> }).rows?.[0]?.quotationNumber;
    if (best) console.log(`    · comparison ranks ${best} first`);
  });

  /* A quantity contract, called off twice; and a scheduling agreement with released forecasts. */
  let contractNumber = '';
  await step('purchase contract', async () => {
    const created = await createPurchaseContract({
      client: w.client, changedBy: w.actor, documentType: 'MK', supplierNumber: 'V10000',
      purchasingOrg: w.company, purchasingGroup: '001', companyCode: w.company, currency: 'INR',
      agreementDate: day(1), validityStart: '2026-04-01', validityEnd: '2027-03-31',
      yourReference: 'MER-ANNUAL-STEEL', ourReference: 'PROC-2026',
      items: [
        { materialNumber: 'RM-STEEL01', shortText: 'Steel plate, annual quantity', targetQuantity: 5000, unit: 'KG', netPrice: 79.5, priceUnit: 1, plant: '1000', storageLocation: '0001' },
        { materialNumber: 'RM-STEEL02', shortText: 'Steel coil, annual quantity', targetQuantity: 3000, unit: 'KG', netPrice: 72, priceUnit: 1, plant: '1000', storageLocation: '0001' },
      ],
    } as never);
    contractNumber = created.contractNumber;
    console.log(`    · contract ${contractNumber}`);
  });
  let agreementNumber = '';
  await step('scheduling agreement release profile', async () => {
    await saveReleaseProfile({
      client: w.client, changedBy: w.actor, profileCode: 'FR01', description: 'Forecast, weekly horizon',
      releaseType: 'FRC', horizonDays: 30, aggregation: 'DAY', comparisonMode: 'LINE', tolerancePercent: null,
    } as never);
  });
  await step('scheduling agreement release assignment', async () => {
    await assignReleaseProfile({
      client: w.client, changedBy: w.actor, supplierNumber: 'V50000', purchasingOrg: w.company, plant: '1000',
      releaseType: 'FRC', profileCode: 'FR01',
    } as never);
  });
  await step('scheduling agreement', async () => {
    await withTenant(w.client, (tx) => tx.execute(sql`
      insert into scheduling_agreement_type (client, document_type, description, category, release_documentation, created_by)
      values (${w.client}, 'LP', 'Scheduling agreement', 'SCHEDULING', false, ${w.actor}) on conflict do nothing
    `));
    const created = await createSchedulingAgreement({
      client: w.client, changedBy: w.actor, documentType: 'LP', supplierNumber: 'V50000',
      purchasingOrg: w.company, purchasingGroup: '001', companyCode: w.company, currency: 'INR',
      agreementDate: day(1), validityStart: '2026-04-01', validityEnd: '2027-03-31',
      items: [{ materialNumber: 'RM-BEARING', shortText: 'Bearings on call-off', targetQuantity: 600, unit: 'PC', netPrice: 139, priceUnit: 1, plant: '1000' }],
    } as never);
    agreementNumber = created.agreementNumber;
    console.log(`    · scheduling agreement ${agreementNumber}`);
  });
  await step('delivery schedule on the agreement', async () => {
    if (!agreementNumber) return;
    await maintainDeliverySchedule({
      client: w.client, changedBy: w.actor, agreementNumber, itemNumber: 10,
      lines: [
        { deliveryDate: day(40), quantity: 120 },
        { deliveryDate: day(68), quantity: 180 },
      ],
    } as never);
  });
  await step('release the agreement forecasts', async () => {
    if (!agreementNumber) return;
    const released = await createSchedulingAgreementReleases({
      client: w.client, changedBy: w.actor, agreementFrom: agreementNumber, releaseTypes: ['FRC'], generationDate: day(35),
    } as never);
    console.log(`    · ${String((released as { created?: number } | undefined)?.created ?? 'forecast')} release document(s) generated`);
  });

  /* Orders, one per sourcing route, each received and invoiced at a different date. */
  type Cycle = {
    label: string; vendor: string; material: string; qty: number; price: number; unit: string;
    plant: string; store: string; orderDate: string; receiveDate: string; invoiceDate: string;
    account?: string; costCenter?: string; batch?: boolean; short?: boolean; contract?: boolean;
    quotation?: string; requisition?: { number: string; item: number }; service?: boolean;
  };
  const cycles: Cycle[] = [
    { label: 'steel, contract call-off', vendor: 'V10000', material: 'RM-STEEL01', qty: 600, price: 79.5, unit: 'KG', plant: '1000', store: '0001', orderDate: day(6), receiveDate: day(14), invoiceDate: day(16), contract: true },
    { label: 'bolts, from the winning quotation', vendor: 'V40000', material: 'RM-BOLT', qty: 4000, price: 3.8, unit: 'PC', plant: '1000', store: '0001', orderDate: day(18), receiveDate: day(26), invoiceDate: day(28), quotation: quotations[1] },
    { label: 'resin, batch with shelf life', vendor: 'V20000', material: 'RM-POLY', qty: 100, price: 205, unit: 'KG', plant: '1000', store: '0001', orderDate: day(20), receiveDate: day(30), invoiceDate: day(33), batch: true },
    { label: 'seals for the assembly plant', vendor: 'V10000', material: 'RM-SEAL', qty: 900, price: 36, unit: 'PC', plant: '1100', store: '0001', orderDate: day(22), receiveDate: day(34), invoiceDate: day(36) },
    { label: 'trading clutches for the depot', vendor: 'V80000', material: 'TG-CLUTCH', qty: 40, price: 1765, unit: 'PC', plant: '1200', store: '0001', orderDate: day(24), receiveDate: day(38), invoiceDate: day(41) },
    { label: 'lubricant consumed on receipt', vendor: 'V40000', material: 'RM-LUBE', qty: 60, price: 215, unit: 'L', plant: '1000', store: '', orderDate: day(26), receiveDate: day(33), invoiceDate: day(35), account: '410000', costCenter: 'MACH', service: true },
    { label: 'maintenance hours', vendor: 'V70000', material: 'SG-CONTRACT', qty: 24, price: 900, unit: 'HR', plant: '1000', store: '', orderDate: day(28), receiveDate: day(40), invoiceDate: day(44), account: '410000', costCenter: 'MACH', service: true },
    { label: 'resin short-delivered', vendor: 'V20000', material: 'RM-POLY', qty: 80, price: 205, unit: 'KG', plant: '1000', store: '0001', orderDate: day(46), receiveDate: day(54), invoiceDate: day(57), short: true },
    { label: 'paint for assembly', vendor: 'V60000', material: 'RM-PAINT', qty: 60, price: 378, unit: 'L', plant: '1100', store: '0001', orderDate: day(50), receiveDate: day(58), invoiceDate: day(61), batch: true },
    { label: 'from the released requisition', vendor: 'V10000', material: 'RM-STEEL01', qty: 400, price: 82, unit: 'KG', plant: '1000', store: '0001', orderDate: day(21), receiveDate: day(29), invoiceDate: day(31), requisition: convertedFrom ? { number: convertedFrom.requisition, item: convertedFrom.item } : undefined },
    { label: 'left open for GR/IR', vendor: 'V50000', material: 'RM-BEARING', qty: 300, price: 139, unit: 'PC', plant: '1000', store: '0001', orderDate: day(60), receiveDate: day(70), invoiceDate: '', },
  ];

  const receipts: Array<{ order: string; cycle: Cycle; materialDocument: string }> = [];
  const invoices: Array<{ order: string; invoice: string; cycle: Cycle }> = [];
  for (const cycle of cycles) {
    let orderNumber = '';
    await step(`order: ${cycle.label}`, async () => {
      orderNumber = await order(cycle.label, {
        client: w.client, changedBy: w.actor, supplierNumber: cycle.vendor, purchasingOrg: w.company,
        purchasingGroup: '001', companyCode: w.company, currency: 'INR',
        items: [{
          materialNumber: cycle.material, shortText: cycle.label.slice(0, 40), quantity: cycle.qty, unit: cycle.unit,
          netPrice: cycle.price, priceUnit: 1, taxCode: cycle.service ? '' : 'I18', plant: cycle.plant,
          storageLocation: cycle.store, markedForDeletion: false,
          accountAssignmentCategory: cycle.account ? 'COST_CENTER' : null,
          assignments: cycle.account ? [{ glAccount: cycle.account, costCenter: cycle.costCenter!, distributionPercentage: 100 }] : [],
          contractNumber: cycle.contract ? contractNumber : '', contractItem: cycle.contract ? 10 : null,
          quotationNumber: cycle.quotation ?? '', quotationItem: cycle.quotation ? 10 : undefined,
          requisitionNumber: cycle.requisition?.number ?? '', requisitionItem: cycle.requisition?.item,
          scheduleLines: [{ deliveryDate: cycle.receiveDate, quantity: cycle.qty }],
        }],
      });
    });
    if (!orderNumber) continue;

    await step(`goods receipt: ${cycle.label}`, async () => {
      await ensureMaterialPeriod(cycle.receiveDate);
      const received = cycle.short ? Math.round(cycle.qty * 0.75) : cycle.qty;
      const posted = await postGoodsReceipt({
        client: w.client, changedBy: w.actor, orderNumber, documentDate: cycle.receiveDate, postingDate: cycle.receiveDate,
        requestKey: `walk-gr-${orderNumber}`,
        lines: [{ itemNumber: 10, quantity: received, ...(cycle.batch ? { batchNumber: `B-${orderNumber.replace(/\W/g, '').slice(-6)}` } : {}) }],
      } as never);
      const documentNumber = (posted as unknown as { materialDocumentNumber?: string }).materialDocumentNumber ?? '';
      receipts.push({ order: orderNumber, cycle, materialDocument: documentNumber });
    });

    if (!cycle.invoiceDate) continue;
    await step(`supplier invoice: ${cycle.label}`, async () => {
      const invoice = await postSupplierInvoice({
        client: w.client, changedBy: w.actor, orderNumber, supplierReference: `WT-${orderNumber}`,
        invoiceDate: cycle.invoiceDate, postingDate: cycle.invoiceDate,
        grossAmount: cycle.qty * cycle.price * (cycle.short ? 0.75 : 1) * 1.18, requestKey: `walk-iv-${orderNumber}`,
        lines: [{ itemNumber: 10, quantity: cycle.short ? Math.round(cycle.qty * 0.75) : cycle.qty, netAmount: cycle.qty * cycle.price * (cycle.short ? 0.75 : 1) }],
      } as never);
      invoices.push({ order: orderNumber, invoice: (invoice as unknown as { invoiceNumber: string }).invoiceNumber, cycle });
    });
  }

  /* A parked invoice, a blocked one released again, and a credit memo against a posted invoice. */
  await step('parked invoice', async () => {
    const target = invoices[2];
    if (!target) return;
    await parkSupplierInvoice({
      client: w.client, changedBy: w.actor, orderNumber: target.order, supplierReference: 'WT-PARKED',
      invoiceDate: day(63), postingDate: day(63), grossAmount: 11800, requestKey: `walk-park-${target.order}`,
      lines: [{ itemNumber: 10, quantity: 50, netAmount: 10000 }],
    } as never);
  });
  await step('payment block then release', async () => {
    const target = invoices[3];
    if (!target) return;
    await placePaymentBlock({
      client: w.client, changedBy: w.actor, invoiceNumber: target.invoice, comment: 'Waiting on the delivery note', requestKey: `walk-block-${target.invoice}`,
    } as never);
    await releasePaymentBlock({
      client: w.client, changedBy: w.actor, invoiceNumber: target.invoice, comment: 'Note received', requestKey: `walk-unblock-${target.invoice}`,
    } as never);
  });
  await step('vendor credit memo', async () => {
    const target = invoices[4];
    if (!target) return;
    await postVendorCreditMemo({
      client: w.client, changedBy: w.actor, vendorNumber: target.cycle.vendor, companyCode: w.company,
      documentDate: day(66), postingDate: day(66), reference: 'WT-RETURN-GOODS', currency: 'INR',
      grossAmount: Math.round(target.cycle.qty * target.cycle.price * 0.18 * 100) / 100,
      creditOf: target.invoice, requestKey: `walk-cm-${target.invoice}`,
      lines: [{ glAccount: '410200', netAmount: Math.round(target.cycle.qty * target.cycle.price * 0.18 * 100) / 100 }],
    } as never);
  });

  /* Vendor evaluation: four criteria on three suppliers, so the scorecards are not empty. */
  for (const supplier of ['V10000', 'V20000', 'V50000']) {
    for (const [criterion, score] of [['PRICE', '72'], ['QUALITY', '88'], ['DELIVERY', '65'], ['SERVICE', '79']] as Array<[string, string]>) {
      await step(`vendor evaluation ${supplier}/${criterion}`, async () => {
        await saveManualScore({
          client: w.client, changedBy: w.actor, supplier, purchasingOrg: w.company,
          periodFrom: '2026-04-01', periodTo: '2027-03-31',
          criterionCode: criterion, score, reason: 'Walkthrough scorecard', requestKey: `wt-ve-${supplier}-${criterion}`,
        } as never);
      });
    }
  }

  /* A down payment cycle: request, pay, clear. */
  let downPaymentInvoice = '';
  await step('vendor down payment request', async () => {
    const created = await createVendorDownPaymentRequest({
      client: w.client, changedBy: w.actor, vendorNumber: 'V10000', companyCode: w.company,
      documentDate: day(70), postingDate: day(70), currency: 'INR', amount: 50000,
      requestKey: 'wt-vdp-request',
    } as never);
    console.log(`    · down payment request ${String((created as { documentNumber?: string }).documentNumber ?? created?.downPaymentNumber ?? '')}`);
  });
  await step('vendor down payment', async () => {
    const paid = await postVendorDownPayment({
      client: w.client, changedBy: w.actor, vendorNumber: 'V10000', companyCode: w.company,
      documentDate: day(72), postingDate: day(72), bankGlAccount: w.accounts.bank, amount: 50000, currency: 'INR',
      specialGlIndicator: 'A', requestKey: 'wt-vdp-pay',
    } as never);
    downPaymentInvoice = String((paid as { documentNumber?: string }).documentNumber ?? '');
  });
  await step('clear the vendor down payment', async () => {
    const open = await withTenant(w.client, async (tx) => tx.execute(sql`
      select document_number, fiscal_year, line_number from journal_entry_line
       where client = ${w.client} and business_partner = 'V10000' and special_gl_indicator = 'A'
       and cleared_at is null and debit_credit = 'H' order by document_number limit 1
    `) as unknown as Array<{ document_number: string; fiscal_year: number; line_number: number }>);
    if (!open[0]) throw new Error('no open down payment item stands to clear');
    await clearDownPayments({
      client: w.client, changedBy: w.actor, vendorNumber: 'V10000', companyCode: w.company,
      documentDate: day(76), postingDate: day(76), amount: 50000, currency: 'INR',
      requestKey: 'wt-vdp-clear', items: [{ documentNumber: open[0].document_number, fiscalYear: open[0].fiscal_year, lineNumber: open[0].line_number }],
    } as never);
    void downPaymentInvoice;
  });

  /* GR/IR: one residual written off, one cleared against the invoice, then reversed. */
  await step('gr/ir residual clearing', async () => {
    const open = receipts.find((row) => row.cycle.short);
    if (!open) throw new Error('no short receipt to clear');
    const listed = await listGrIrMaintenance({ client: w.client, selection: {} as never });
    const row = (listed as unknown as Array<{ orderNumber: string; itemNumber: number; fingerprint: string }>)
      .find((candidate) => candidate.orderNumber === open.order);
    if (!row) throw new Error('the short receipt has no GR/IR line to clear');
    await postGrIrClearing({
      client: w.client, changedBy: w.actor, orderNumber: open.order, itemNumber: row.itemNumber,
      keyDate: day(80), postingDate: day(80), fingerprint: row.fingerprint,
      comment: 'Short delivery accepted as final', requestKey: 'wt-grir-1', acknowledgeFurtherActivity: true,
    } as never);
  });

  console.log(`  purchasing: ${requisitionNumbers.length} requisitions, ${quotations.length} quotations, 1 contract, 1 scheduling agreement, ${cycles.length} orders, ${receipts.length} receipts, ${invoices.length} invoices`);
  cover('Procurement (MM)', 'PROC.PR.CREATE', `${requisitionNumbers.length} requisitions, 2 account-assigned, 1 released`);
  cover('Procurement (MM)', 'PROC.REQ.LIST', 'the same requisitions with their conversion state');
  cover('Procurement (MM)', 'PROC.RFQ.CREATE', `1 event, ${quotations.length} quotations`);
  cover('Procurement (MM)', 'PROC.RFQ.QUOTATION', '2 supplier quotations with their own prices');
  cover('Procurement (MM)', 'PROC.RFQ.COMPARISON', 'both quotations ranked for one event');
  cover('Procurement (MM)', 'PROC.CONTRACT.CREATE', `contract ${contractNumber || 'MK'} with 2 items`);
  cover('Procurement (MM)', 'PROC.CONTRACT.CALLOFF', 'a steel order drawn against the contract');
  cover('Procurement (MM)', 'PROC.SCHAGREEMENT.CREATE', `agreement ${agreementNumber || 'LP'} on supplier V50000`);
  cover('Procurement (MM)', 'PROC.SCHAGREEMENT.RELEASE', 'forecast releases generated for the agreement');
  cover('Procurement (MM)', 'PROC.SCHAGREEMENT.SCHEDULE', 'a two-date delivery schedule on the agreement');
  cover('Procurement (MM)', 'PROC.PO.CREATE', `${cycles.length} orders across 3 plants and 6 suppliers`);
  cover('Procurement (MM)', 'PROC.PO.DISPLAY', 'each order with its schedule lines and origin');
  cover('Procurement (MM)', 'PROC.PO.LIST', 'the orders listed by supplier, plant and status');
  cover('Procurement (MM)', 'PROC.PO.ACCOUNTASSIGN', '2 orders posted straight to a cost centre');
  cover('Inventory (MM-IM)', 'INV.GR.POST', `${receipts.length} goods receipts, 2 with batches, 1 short`);
  cover('Procurement (MM)', 'PROC.INV.RECORD', `${invoices.length} invoices verified against orders and receipts`);
  cover('Procurement (MM)', 'PROC.INV.PARK', '1 parked invoice awaiting its release');
  cover('Procurement (MM)', 'PROC.INV.BLOCK', '1 invoice blocked for payment and released again');
  cover('Procurement (MM)', 'PROC.VENDOR.EVALUATE', '12 manual scores over 3 suppliers');
  cover('Finance (FI)', 'FIN.AP.DOWNPAYMENT.REQUEST', 'a down payment request on V10000');
  cover('Finance (FI)', 'FIN.AP.DOWNPAYMENT.POST', 'the request paid to a special G/L indicator');
  cover('Finance (FI)', 'FIN.AP.DOWNPAYMENT.CLEAR', 'the down payment cleared against an invoice');
}

async function seedPurchasingFollowOn(w: Walk) {
  await step('gr/ir reclassification', async () => {
    await executeGrIrAnalysis({ client: w.client, changedBy: w.actor, companyCode: w.company, keyDate: day(80), requestKey: 'wt-reclass-1' } as never);
  });
  await step('delivery schedule read', async () => {
    const receipts = await withTenant(w.client, async (tx) => tx.execute(sql`
      select order_number from purchase_order where client = ${w.client} order by order_number limit 1
    `) as unknown as Array<{ order_number: string }>);
    if (!receipts[0]) throw new Error('no order to read a schedule for');
    await openPurchaseOrderDisplay(w.client, { orderNumber: receipts[0].order_number, mode: 'DISPLAY' } as never);
  });
  cover('Procurement (MM)', 'PROC.GRIR.MAINTAIN', 'residuals listed, one written off');
  cover('Finance (FI)', 'FIN.GRIR.RECLASS', 'one reclassification document for the month');
}
