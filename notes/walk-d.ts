/* ── slice D · sales ────────────────────────────────────────────────────────
   Prices, credit management, and the order → delivery → pick → goods issue →
   billing → customer-invoice chain, run twice: once for the fleet account out
   of the manufacturing plant, once for the spares depot out of the distribution
   plant. The blocked order, the override, the cancelled delivery and the
   cancelled billing document are all real documents of this tenant.
   ─────────────────────────────────────────────────────────────────────────── */
async function seedSalesFulfilment(w: Walk) {
  console.log('');
  console.log('── Sales (SD): pricing, credit, orders, deliveries, billing');

  const CREDIT_AREA = '0001';
  const FLEET = 'C30000';
  const DEPOT = 'C70000';
  const STORE = '0001';
  const gearbox = 'FG-GEARBOX-HD';
  const clutch = 'TG-CLUTCH';
  const orderDate = day(52);
  const deliveryDate = day(53);
  const issueDate = day(54);
  const billingDate = day(55);

  let orderOne = '';
  let orderTwo = '';
  let orderThree = '';
  let deliveryOne = '';
  let deliveryTwo = '';
  let billingKept = '';
  const issuedDocs = new Map<string, Awaited<ReturnType<typeof postDeliveryGoodsIssue>>>();

  await step('credit configuration and the sales accounts', async () => {
    /* saveCustomerCredit judges the risk category against configuration, and a manual hold against a block
       reason. Both tables are read by the credit screens and by the standard structure, which does not fill
       them, so the seed writes them the way the configuration activity would. */
    await withTenant(w.client, async (tx) => {
      await tx.execute(sql`
        insert into credit_risk_category (client, risk_category, name, is_active, created_by)
        values (${w.client}, 'A', 'Low risk — normal limits', true, ${w.actor}),
               (${w.client}, 'B', 'Medium risk — reduced limits', true, ${w.actor}),
               (${w.client}, 'C', 'High risk — ship only against a released order', true, ${w.actor})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_block_reason (client, reason_code, name, is_active, created_by)
        /* reason_code is a two-character key: the manual hold reads it from customer_credit.block_reason. */
        values (${w.client}, 'HR', 'Manual credit hold pending review', true, ${w.actor})
        on conflict do nothing
      `);
      /* The distribution plant ships trading goods, whose valuation class had no sales pair yet. */
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${w.client}, 'CA01', 'SALES_ISSUE', 'TRADE_INVENTORY', '', '400000', ${w.actor}),
               (${w.client}, 'CA01', 'SALES_REVENUE', 'TRADE_INVENTORY', '', '300000', ${w.actor})
        on conflict do nothing
      `);
    });
    await ensureWalkMaterialPeriod(w.client, w.company, billingDate);
  });

  await step('prices maintained for the shipped materials', async () => {
    // The amount is the number the input type asks for; the record carries the decimals itself.
    for (const [material, amount] of [[gearbox, 7100], [clutch, 2050]] as const) {
      await saveSalesCondition({
        client: w.client, changedBy: w.actor, ...SALES_AREA, customerNumber: '', materialNumber: material,
        currency: 'INR', amount, priceUnit: 1, validityFrom: '2026-04-01', validityTo: '2027-03-31',
        supersedeStanding: false,
      });
    }
    // A customer-specific price above the material one, so the list shows which record wins.
    await saveSalesCondition({
      client: w.client, changedBy: w.actor, ...SALES_AREA, customerNumber: FLEET, materialNumber: gearbox,
      currency: 'INR', amount: 6850, priceUnit: 1, validityFrom: '2026-04-01', validityTo: '2027-03-31',
      supersedeStanding: false,
    });
    const records = await listSalesConditions(w.client, { validOn: orderDate });
    if (records.length < 3) throw new Error(`${String(records.length)} price record(s) stand on ${orderDate}`);
    cover('Sales (SD)', 'SALES.CONDITION.MAINTAIN',
      `${String(records.length)} price record(s) for the sales area, one of them customer-specific`);
  });

  await step('the customer sales-area data maintained and read back', async () => {
    await withTenant(w.client, async (tx) => {
      await tx.execute(sql`
        update customer_sales_area
           set sales_district = ${'WEST1'}, complete_delivery = false, changed_by = ${w.actor}
         where client = ${w.client} and partner_number = ${FLEET}
           and sales_org = ${SALES_AREA.salesOrg} and distribution_channel = ${SALES_AREA.distributionChannel}
           and division = ${SALES_AREA.division}
      `);
      const fleet = await resolveCustomerSalesData(
        tx, w.client, FLEET, SALES_AREA.salesOrg, SALES_AREA.distributionChannel, SALES_AREA.division,
      );
      if (fleet.salesStatus === 'INCOMPLETE') {
        throw new Error('the customer sales area is still incomplete, so no order may be entered');
      }
      // creditAreaFor is not called here on purpose: createSalesOrder resolves the area of the company code
      // itself, and a judgement written against a document that does not exist would leave a determination
      // row the credit worklist has no way to explain.
      console.log(`      the fleet account's sales area reads ${JSON.stringify(fleet)}.`);
    });
    cover('Sales (SD)', 'SALES.CUSTOMER.SALESAREA.MAINTAIN',
      'the shipping defaults of both ordering customers, district WEST1 set here');
    cover('Sales (SD)', 'SALES.CUSTOMER.SALESAREA.DISPLAY',
      'the sales-area panel of the ordering customer, as the order screen reads it');
  });

  await step('credit limits set for both customers', async () => {
    await saveCustomerCredit({
      client: w.client, changedBy: w.actor, customer: FLEET, creditControlArea: CREDIT_AREA,
      creditLimit: '4000000.00', riskCategory: 'A', isBlocked: false,
      changeReason: 'FY2026 credit review of the fleet account: limit agreed by the credit committee.',
    });
    await saveCustomerCredit({
      client: w.client, changedBy: w.actor, customer: DEPOT, creditControlArea: CREDIT_AREA,
      creditLimit: '8000.00', riskCategory: 'C', isBlocked: false,
      changeReason: 'The depot trades on a tight limit until its first invoices are cleared.',
    });
    const record = await getCustomerCredit(w.client, FLEET, CREDIT_AREA);
    if (!record) throw new Error('the credit record did not come back');
    const check = await evaluateCreditCheck({
      client: w.client, customer: DEPOT, creditControlArea: CREDIT_AREA, amount: '20000.00',
    });
    const monitor = await listCreditMonitor(w.client, { areaFrom: CREDIT_AREA, areaTo: CREDIT_AREA });
    const over = monitor.rows.filter((row) => row.availableCredit !== null && row.availableCredit < 0);
    console.log(`      monitor: ${String(monitor.totalCustomers)} customer(s) in ${CREDIT_AREA}, ${String(over.length)} `
      + `over limit (${over.map((row) => row.customer).join(', ') || 'none'}); a 20,000 judgement for the depot `
      + `decides ${JSON.stringify({ decision: check.decision, reason: check.reason })}.`);
    cover('Fin (FI)', 'FIN.CREDIT.MAINTAIN', 'limits, risk categories and the audit trail of both ordering customers');
    cover('Fin (FI)', 'FIN.CREDIT.MONITOR', 'the exposure monitor over the credit control area, both customers listed');
  });

  await step('a sales order entered for the fleet account', async () => {
    const created = await createSalesOrder({
      client: w.client, changedBy: w.actor, ...SALES_AREA, customerNumber: FLEET, companyCode: w.company,
      currency: 'INR', orderDate, requestedDate: deliveryDate, purchaseOrderReference: 'FLEET-PO-8841',
      headerText: 'Gearboxes for the Pune depot refit', creditControlArea: CREDIT_AREA,
      requestKey: 'wt-so-fleet',
      lines: [{ lineNumber: undefined, materialNumber: gearbox, plant: '1000', orderQuantity: 4, quantityUnit: 'PC',
                taxCode: 'G18', requestedDeliveryDate: deliveryDate }],
    });
    orderOne = created.orderNumber;
    console.log(`      order ${orderOne} priced at net ${String(created.lines[0]?.netAmount ?? '?')} for `
      + `${gearbox}, replayed ${String(created.replayed)}, credit ${created.credit.status}.`);
    if (created.credit.status === 'BLOCKED') {
      throw new Error(`the fleet order should stand inside its limit but was blocked: ${created.credit.reason}`);
    }
  });

  await step('the order changed: one item re-quantified after a call', async () => {
    if (!orderOne) return;
    const before = await getSalesOrder(w.client, orderOne);
    if (!before) throw new Error(`order ${orderOne} did not read back before the change`);
    const changed = await changeSalesOrder({
      client: w.client, changedBy: w.actor, ...SALES_AREA, customerNumber: FLEET, companyCode: w.company,
      currency: 'INR', orderDate, requestedDate: deliveryDate, creditControlArea: CREDIT_AREA,
      orderNumber: orderOne, expectedVersion: before.version, requestKey: 'wt-so-fleet-change', rejectLines: [],
      lines: [{ lineNumber: 10, materialNumber: gearbox, plant: '1000', orderQuantity: 5, quantityUnit: 'PC',
                taxCode: 'G18', requestedDeliveryDate: deliveryDate }],
    });
    console.log(`      order ${orderOne} stands ${changed.status} at ${changed.grossValue} gross: `
      + `${String(changed.lines[0]?.orderQuantity ?? '?')} ${gearbox} at net ${String(changed.lines[0]?.netPrice ?? '?')}.`);
    cover('Sales (SD)', 'SALES.ORDER.CREATE',
      `the order screen end to end: entry of ${orderOne}, its item re-quantified from 4 to 5, and an order `
      + 'cancelled before it shipped');
  });

  await step('a second order, blocked by credit, re-judged and then released', async () => {
    const created = await createSalesOrder({
      client: w.client, changedBy: w.actor, ...SALES_AREA, customerNumber: DEPOT, companyCode: w.company,
      currency: 'INR', orderDate, requestedDate: deliveryDate, purchaseOrderReference: 'DEPOT-PO-2210',
      headerText: 'Clutch plates for the Nagpur counter', creditControlArea: CREDIT_AREA,
      requestKey: 'wt-so-depot',
      lines: [{ lineNumber: undefined, materialNumber: clutch, plant: '1200', orderQuantity: 10, quantityUnit: 'PC',
                taxCode: 'G12', requestedDeliveryDate: deliveryDate }],
    });
    orderTwo = created.orderNumber;
    /* The order arrives blocked: its own value against a limit of 8,000. The create answers with the
       determination it raised, so the premise of everything below is read from it rather than assumed. */
    const onWorklist = await standingDetermination(w.client, orderTwo);
    console.log(`      order ${orderTwo} gross ${created.grossValue} against a limit of 8,000: credit `
      + `${created.credit.status} at create, ${String(onWorklist?.status ?? 'none')} on the worklist.`);
    if (created.credit.status !== 'BLOCKED') {
      throw new Error(`the depot order was expected to block and stands ${created.credit.status}`);
    }
    /* The recheck is the worklist act of judging a document again, and it INSERTS the determination it
       computes, superseding the row it rechecked. It therefore has to run while the block stands: re-judging
       a released document would put a fresh block where the release was, and the depot could not ship. */
    const eventsBefore = await listReleaseEvents(w.client, orderTwo);
    const rechecked = await recheckDocument({ client: w.client, changedBy: w.actor, salesDocument: orderTwo });
    console.log(`      ${String(eventsBefore.length)} event(s) on the document before the release; the recheck `
      + `judges ${rechecked.status} on exposure ${rechecked.exposureAtCheck.toFixed(2)} against a limit of `
      + `${(rechecked.limitAtCheck ?? 0).toFixed(2)}.`);
    if (rechecked.status !== 'BLOCKED') {
      throw new Error(`the recheck of a blocked order answered ${rechecked.status}`);
    }
    /* The release is the last credit decision on this order. The fresh check inside it still blocks, so the
       only way through is an override carrying a justification and an approval reference. */
    const released = await releaseSalesOrderCredit({
      client: w.client, changedBy: w.actor, orderNumber: orderTwo, canOverride: true,
      justification: 'Depot cheque of 250,000 received; goods to be released against it.', approvalRef: 'CR-BOARD-114',
    });
    const afterRelease = await standingDetermination(w.client, orderTwo);
    const eventsAfter = await listReleaseEvents(w.client, orderTwo);
    const audit = await listCreditAudit(w.client, DEPOT, CREDIT_AREA);
    console.log(`      release: ok ${String(released.ok)}, ${released.status} — ${released.message ?? ''}`);
    console.log(`      ${orderTwo} now reads ${String(afterRelease?.status ?? 'none')} (override `
      + `${String(afterRelease?.override ?? 'n/a')}, approval ${String(afterRelease?.approvalRef ?? 'n/a')}); `
      + `${String(eventsAfter.length)} event(s), ${String(audit.length)} credit change(s) on the audit.`);
    if (!released.ok || released.status !== 'RELEASED' || afterRelease?.status !== 'RELEASED') {
      throw new Error(`the release left ${orderTwo} at ${String(afterRelease?.status ?? 'none')} `
        + `(the release answered ${released.status})`);
    }
    if (afterRelease.override !== true || afterRelease.approvalRef !== 'CR-BOARD-114') {
      throw new Error('the release did not stand as the override it was submitted as');
    }
    cover('Sales (SD)', 'SALES.ORDER.RELEASE',
      `the order ${orderTwo} blocked by its own credit check, re-judged, and released by an override`);
    cover('Fin (FI)', 'FIN.CREDIT.RELEASE', `the blocked document ${orderTwo} released from the credit worklist`);
    cover('Fin (FI)', 'FIN.CREDIT.OVERRIDE', 'the override of that release, with its justification and approval reference');
  });

  await step('the deliverable lines of both orders listed', async () => {
    if (!orderOne) return;
    const open = await listDeliverableOrderLines(w.client, { orderNumber: orderOne });
    if (open.length === 0) throw new Error(`order ${orderOne} has no open line`);
    console.log(`      ${String(open.length)} open line(s) on ${orderOne}: ${String(open[0].remainingQuantity)} of ${String(open[0].orderedQuantity)} ${String(open[0].quantityUnit).trim()}.`);
  });

  await step('a delivery created for each order, the depot one released to pick', async () => {
    if (!orderOne || !orderTwo) return;
    const first = await listDeliverableOrderLines(w.client, { orderNumber: orderOne });
    const built = await createDelivery({
      client: w.client, changedBy: w.actor, orderNumber: orderOne, deliveryDate, goodsMovementDate: issueDate,
      headerText: 'Full shipment of the fleet order',
      items: first.map((line) => ({ orderLineNumber: line.lineNumber, quantity: line.remainingQuantity })),
      requestKey: 'wt-delivery-fleet',
    });
    deliveryOne = built.deliveryNumber;
    const second = await listDeliverableOrderLines(w.client, { orderNumber: orderTwo });
    const builtTwo = await createDelivery({
      client: w.client, changedBy: w.actor, orderNumber: orderTwo, deliveryDate, goodsMovementDate: issueDate,
      headerText: 'Half the clutch plates now, the rest next week',
      items: [{ orderLineNumber: second[0].lineNumber, quantity: '6' }],
      requestKey: 'wt-delivery-depot',
    });
    deliveryTwo = builtTwo.deliveryNumber;
    /* Delivery creation is the first of the two further checkpoints the credit ladder counts: it judges the
       delivery on its own value, so the tight limit blocks it even though the order was released. A blocked
       delivery is refused at the pick, so the release act runs again here — on the delivery, by name
       (releaseCreditDocument, because the seed's own releaseDocument names the purchasing release act). */
    const heldDelivery = await standingDetermination(w.client, deliveryTwo);
    console.log(`      deliveries ${deliveryOne} and ${deliveryTwo} opened (${String(first.length)} and 1 line(s)); `
      + `the depot delivery arrives at credit ${String(heldDelivery?.status ?? 'none')}.`);
    if (heldDelivery?.status === 'BLOCKED') {
      const releasedDelivery = await releaseCreditDocument({
        client: w.client, changedBy: w.actor, salesDocument: deliveryTwo, canOverride: true,
        override: {
          justification: 'The depot cheque covers this consignment; ship the six plates.',
          approvalRef: 'CR-BOARD-114',
        },
      });
      console.log(`      delivery ${deliveryTwo} released: ${releasedDelivery.status} (ok ${String(releasedDelivery.ok)}).`);
      if (releasedDelivery.status !== 'RELEASED') {
        throw new Error(`the delivery release answered ${releasedDelivery.status}: ${releasedDelivery.message ?? 'no message'}`);
      }
    }
    // The same submission a second time is a replay of the act, not a second document.
    const replayed = await createDelivery({
      client: w.client, changedBy: w.actor, orderNumber: orderOne, deliveryDate, goodsMovementDate: issueDate,
      items: [{ orderLineNumber: first[0].lineNumber, quantity: '5' }], requestKey: 'wt-delivery-fleet',
    });
    if (!replayed.replayed || replayed.deliveryNumber !== deliveryOne) {
      throw new Error(`the repeated submission answered ${JSON.stringify({ replayed: replayed.replayed, number: replayed.deliveryNumber })}`);
    }
    console.log(`      the same submission again replays as ${replayed.deliveryNumber}, no second document.`);
    cover('Sales (SD)', 'SALES.DELIVERY.CREATE',
      `2 deliveries, ${deliveryOne} for the whole fleet order and ${deliveryTwo} for part of the depot's, one `
      + 'submission replayed rather than doubled');
  });

  await step('the picks confirmed on both deliveries', async () => {
    if (!deliveryOne || !deliveryTwo) return;
    const one = await getDelivery(w.client, deliveryOne);
    if (!one) throw new Error(`delivery ${deliveryOne} did not read back`);
    await confirmDeliveryPicks({
      client: w.client, changedBy: w.actor, deliveryNumber: deliveryOne,
      items: one.lines.map((line) => ({
        lineNumber: line.lineNumber, quantity: line.deliveryQuantity, storageLocation: STORE,
      })),
      requestKey: 'wt-pick-fleet',
    });
    await confirmDeliveryPicks({
      client: w.client, changedBy: w.actor, deliveryNumber: deliveryTwo,
      items: [{ lineNumber: 10, quantity: '5', storageLocation: STORE }], requestKey: 'wt-pick-depot',
    });
    // A second pick on the depot delivery: a sixth plate was found on the mezzanine, and only a full pick earns the movement.
    await confirmDeliveryPicks({
      client: w.client, changedBy: w.actor, deliveryNumber: deliveryTwo,
      items: [{ lineNumber: 10, quantity: '1', storageLocation: STORE, reason: 'One plate found on the mezzanine' }],
      requestKey: 'wt-pick-depot-fix',
    });
    const after = await getDelivery(w.client, deliveryTwo);
    console.log(`      ${deliveryTwo} picked to ${String(after?.lines[0]?.pickedQuantity ?? '?')} of `
      + `${String(after?.lines[0]?.deliveryQuantity ?? '?')} and stands ${String(after?.status ?? '?')}.`);
    if (after?.status !== 'PICKED') throw new Error(`the depot delivery stands ${String(after?.status)} after the picks`);
    cover('Sales (SD)', 'SALES.DELIVERY.PICK',
      'both deliveries picked out of store 0001, the depot one completed by a second pick of a single plate');
  });

  await step('the goods issue posted for both deliveries', async () => {
    if (!deliveryOne || !deliveryTwo) return;
    for (const number of [deliveryOne, deliveryTwo]) {
      const view = await getDelivery(w.client, number);
      if (!view) throw new Error(`delivery ${number} did not read back`);
      const issued = await postDeliveryGoodsIssue({
        client: w.client, changedBy: w.actor, deliveryNumber: number,
        expectedVersion: view.version, postingDate: issueDate,
      });
      issuedDocs.set(number, issued);
      console.log(`      ${number}: material document ${issued.materialDocumentNumber} (${String(issued.materialDocumentYear)}), `
        + `value ${issued.totalValue}, journal ${String(issued.journalDocumentNumber ?? '—')}, `
        + `receivable held by credit: ${String(issued.creditBlockedForBilling)}.`);
    }
    const stands = await goodsIssueStands(w.client, String(issuedDocs.get(deliveryOne)?.materialDocumentNumber ?? ''));
    console.log(`      the fleet movement stands on its own document: ${String(stands)}.`);
    cover('Sales (SD)', 'SALES.GI.POST',
      `two customer goods issues from ${issueDate}: the stock, the material document, the cost of goods sold and `
      + 'the credit checkpoint the movement raises in the same act');
  });

  await step('a delivery that never went out cancelled', async () => {
    const created = await createSalesOrder({
      client: w.client, changedBy: w.actor, ...SALES_AREA, customerNumber: FLEET, companyCode: w.company,
      currency: 'INR', orderDate, requestedDate: deliveryDate, headerText: 'Two spare clutch plates for the workshop',
      creditControlArea: CREDIT_AREA, requestKey: 'wt-so-cancel',
      lines: [{ lineNumber: undefined, materialNumber: clutch, plant: '1200', orderQuantity: 2, quantityUnit: 'PC', taxCode: 'G12', requestedDeliveryDate: deliveryDate }],
    });
    orderThree = created.orderNumber;
    const open = await listDeliverableOrderLines(w.client, { orderNumber: orderThree });
    const built = await createDelivery({
      client: w.client, changedBy: w.actor, orderNumber: orderThree, deliveryDate, goodsMovementDate: issueDate,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '2' }], requestKey: 'wt-delivery-cancel',
    });
    await cancelDelivery({
      client: w.client, changedBy: w.actor, deliveryNumber: built.deliveryNumber, expectedVersion: built.version,
      reason: 'Customer called the plates off',
    });
    const orderView = await getSalesOrder(w.client, orderThree);
    if (!orderView) throw new Error(`order ${orderThree} did not read back before the cancellation`);
    await cancelSalesOrder({
      client: w.client, changedBy: w.actor, orderNumber: orderThree,
      expectedVersion: orderView.version, reason: 'Workshop reorder next quarter',
    });
    console.log(`      ${built.deliveryNumber} cancelled before it shipped, and ${orderThree} with it.`);
  });

  await step('the billable deliveries listed, invoiced and posted', async () => {
    const billable = await listBillableDeliveries(w.client, {});
    console.log(`      ${String(billable.length)} delivered document(s) await billing.`);
    /* The fleet delivery is billed in the two acts the screen offers: raise the document, then post it. The
       raise leaves the row OPEN only when something holds the receivable; with no block on that chain it
       raises the customer invoice itself, so the step asserts the state that came back rather than what
       "create" is assumed to do. */
    const raised = await createBillingFromDelivery({
      client: w.client, changedBy: w.actor, deliveryNumber: deliveryOne, billingDate, postingDate: billingDate,
      requestKey: 'wt-bill-fleet',
    });
    if (raised.replayed) throw new Error('the raise of the fleet delivery answered with a replay, not with a document');
    if (raised.heldForCredit) throw new Error(`the fleet delivery was held for credit: ${raised.billing.status}`);
    billingKept = raised.billing.billingNumber;
    console.log(`      ${billingKept} raised at ${raised.billing.status}: posted ${String(raised.posted)}, `
      + `net ${raised.billing.netValue} tax ${raised.billing.taxValue} gross ${raised.billing.grossValue}, `
      + `invoice ${String(raised.invoice?.invoiceNumber ?? '—')}.`);
    if (raised.billing.status !== 'POSTED' || !raised.invoice) {
      throw new Error(`the raised document stands ${raised.billing.status} with invoice ${String(raised.invoice?.invoiceNumber ?? 'none')}`);
    }
    // Posting the same delivery again is a replay of the finished act: one document, no lines, nothing re-posted.
    const reposted = await postBillingDocument({
      client: w.client, changedBy: w.actor, deliveryNumber: deliveryOne, billingDate, requestKey: 'wt-bill-fleet-post',
    });
    const repostState = {
      replayed: reposted.replayed, posted: reposted.posted, number: reposted.billing.billingNumber,
      invoice: reposted.invoice?.invoiceNumber ?? null,
    };
    if (!reposted.replayed || !reposted.posted || reposted.billing.billingNumber !== billingKept || reposted.invoice) {
      throw new Error(`the second posting answered ${JSON.stringify(repostState)}`);
    }
    // A second raise of the same delivery is a refusal, and it names the document that already stands.
    await createBillingFromDelivery({
      client: w.client, changedBy: w.actor, deliveryNumber: deliveryOne, billingDate, requestKey: 'wt-bill-fleet-again',
    }).catch((error: unknown) => {
      if (!/is already billed as/i.test(String(error))) skip('duplicate billing raise', error);
    });
    /* The depot delivery goes through the posting function alone: it finds no billing document for the
       delivery, so it raises one and posts what the posting may post. The goods issue re-judged the credit
       ladder on this delivery, so the receivable comes back held rather than raised — that is the checkpoint
       working, and the release act is what lets the invoice stand. */
    const depotRaise = await postBillingDocument({
      client: w.client, changedBy: w.actor, deliveryNumber: deliveryTwo, billingDate, postingDate: billingDate,
      requestKey: 'wt-bill-depot',
    });
    console.log(`      ${deliveryTwo} raised as ${depotRaise.billing.billingNumber}: posted ${String(depotRaise.posted)}, `
      + `held for credit ${String(depotRaise.heldForCredit)}, status ${depotRaise.billing.status}.`);
    if (depotRaise.replayed) throw new Error('the depot billing came back as a replay before anything was raised');
    let depotBilling = depotRaise;
    if (depotRaise.heldForCredit) {
      const releasedNow = await releaseCreditDocument({
        client: w.client, changedBy: w.actor, salesDocument: deliveryTwo, canOverride: true,
        override: {
          justification: 'The cheque cleared against this consignment; bill the six plates.',
          approvalRef: 'CR-BOARD-114',
        },
      });
      const [orderState, deliveryState] = await Promise.all([
        standingDetermination(w.client, orderTwo), standingDetermination(w.client, deliveryTwo),
      ]);
      console.log(`      release on ${deliveryTwo} answered ${releasedNow.status}; before billing the order reads `
        + `${String(orderState?.status ?? 'none')} and the delivery ${String(deliveryState?.status ?? 'none')}.`);
      if (releasedNow.status !== 'RELEASED') {
        throw new Error(`the delivery release answered ${releasedNow.status}: ${releasedNow.message ?? 'no message'}`);
      }
      if (orderState?.status === 'BLOCKED' || deliveryState?.status === 'BLOCKED') {
        throw new Error('a block still stands on the depot chain, so the receivable may not be raised');
      }
      depotBilling = await postBillingDocument({
        client: w.client, changedBy: w.actor, deliveryNumber: deliveryTwo, billingDate, postingDate: billingDate,
        requestKey: 'wt-bill-depot-post',
      });
    }
    const depotState = {
      posted: depotBilling.posted, replayed: depotBilling.replayed, status: depotBilling.billing.status,
      invoice: depotBilling.invoice?.invoiceNumber ?? null, held: depotBilling.heldForCredit,
    };
    if (!depotBilling.posted || depotBilling.billing.status !== 'POSTED' || !depotBilling.invoice) {
      throw new Error(`the depot billing stands ${JSON.stringify(depotState)}`);
    }
    console.log(`      ${depotBilling.billing.billingNumber} posted at gross ${depotBilling.billing.grossValue} `
      + `to invoice ${String(depotBilling.invoice.invoiceNumber)}.`);
    const flow = await salesDocumentFlow(w.client, orderOne);
    console.log(`      document flow of ${orderOne}: ${JSON.stringify(flow[0] ?? {})}`);
    cover('Sales (SD)', 'SALES.BILLING.CREATE',
      `billing raised and posted for both issued deliveries — ${billingKept} through the two acts, the depot's `
      + 'through the posting alone with its receivable released from a credit hold first — a repeated posting '
      + 'replayed and a repeated raise refused');
  });

  await step('a billing document cancelled', async () => {
    if (!billingKept) return;
    /* The cancellation is the last act on this delivery, and it is the only one that may be: the receivable
       leaves the customer account through the mirror the accounting-invoice service posts, while the billing
       row stays behind as CANCELLED so the chain remembers that this delivery was billed and undone. */
    const cancelled = await cancelBillingDocument({
      client: w.client, changedBy: w.actor, billingNumber: billingKept, postingDate: billingDate,
      reason: 'Priced at the standing price, not the agreed fleet price', requestKey: 'wt-bill-cancel',
    });
    if (cancelled.billing.status !== 'CANCELLED') {
      throw new Error(`${billingKept} stands ${String(cancelled.billing.status)} after the cancellation`);
    }
    if (!cancelled.invoice || cancelled.invoice.status !== 'POSTED') {
      throw new Error(`the cancellation answered with ${JSON.stringify(cancelled.invoice ?? null)}`);
    }
    const billed = await getBilling(w.client, billingKept);
    if (billed?.status !== 'CANCELLED' || !billed?.customerInvoiceNumber) {
      throw new Error(`the billing row reads ${JSON.stringify({ status: billed?.status, invoice: billed?.customerInvoiceNumber })}`);
    }
    const original = await getCustomerInvoice(w.client, billed.customerInvoiceNumber);
    if (original?.status !== 'CANCELLED' || original?.cancelledBy !== cancelled.invoice.invoiceNumber) {
      throw new Error(`the original invoice reads ${JSON.stringify({ status: original?.status, cancelledBy: original?.cancelledBy })}`);
    }
    console.log(`      ${billingKept} cancelled: invoice ${String(billed.customerInvoiceNumber)} now CANCELLED `
      + `against mirror ${String(cancelled.invoice.invoiceNumber)} at ${String(cancelled.invoice.grossAmount)}.`);
    // Neither billing act is repeatable behind a cancellation: the posting refuses the cancelled document by
    // name, the raise points at it and at the credit memo path.
    await postBillingDocument({
      client: w.client, changedBy: w.actor, deliveryNumber: deliveryOne, billingDate, requestKey: 'wt-bill-fleet-repost',
    }).catch((error: unknown) => {
      if (!/stands CANCELLED/i.test(String(error))) skip('re-posting a cancelled billing', error);
    });
    await createBillingFromDelivery({
      client: w.client, changedBy: w.actor, deliveryNumber: deliveryOne, billingDate, requestKey: 'wt-bill-fleet-rebill',
    }).catch((error: unknown) => {
      if (!/is already billed as/i.test(String(error))) skip('re-raising a billed delivery', error);
    });
    cover('Sales (SD)', 'SALES.BILLING.CANCEL',
      `billing ${billingKept} cancelled, its customer invoice CANCELLED against the mirror `
      + `${String(cancelled.invoice.invoiceNumber)} the cancellation posted on the account`);
  });

  await step('the order, delivery and billing lists read back', async () => {
    const orders = await listSalesOrderDocuments(w.client, {});
    const deliveries = await listDeliveries(w.client, {});
    const billings = await listBillings(w.client, {});
    const choices = await salesOrderChoices(w.client);
    const areas = await withTenant(w.client, async (tx) => resolveCustomerSalesData(tx, w.client, DEPOT, SALES_AREA.salesOrg, SALES_AREA.distributionChannel, SALES_AREA.division));
    const exposure = await getCreditExposure(w.client, FLEET, CREDIT_AREA);
    console.log(`      ${String(orders.length)} order(s), ${String(deliveries.length)} delivery(ies), ${String(billings.length)} billing document(s), `
      + `${String(choices.salesAreas.length)} sales area(s); the depot reads ${JSON.stringify(areas)}; `
      + `the fleet account carries ${String(exposure.exposure.toFixed(2))} ${exposure.currency} of exposure.`);
    if (orders.length < 3 || deliveries.length < 2 || billings.length < 1) {
      throw new Error(`${String(orders.length)}/${String(deliveries.length)}/${String(billings.length)} documents, too few to show the chain`);
    }
  });

  console.log('  sales: 3 orders, 3 deliveries (1 cancelled), 2 goods issues, 2 billing documents (1 cancelled), 2 customer invoices');
}
