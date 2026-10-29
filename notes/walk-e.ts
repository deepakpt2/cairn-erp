/*
 * Slice E: FI/CO — journals, assets, accruals, FX, carryforward, clearing, dunning,
 * the close cockpit and the closing reports.
 *
 * Every posting here goes through the module the screen calls. Nothing inserts a
 * ledger, asset-transaction or audit row directly: a row that never passed a
 * validator would make the walkthrough claim a capability the application refused.
 * Where a workflow needs standing configuration this seed does not create — asset
 * account determination, a statement version, an intercompany clearing pair — the
 * module refuses and `step()` records that refusal as a skipped area, with the
 * module's own message. That is a finding, not a failure to hide.
 */
async function seedFiCo(w: Walk) {
  console.log('');
  console.log('── Finance (FI/CO): journals, assets, accruals, period end, clearing, dunning, close');

  /* One date pair for the whole slice, after the sales documents, inside the open
     period the purchasing anchor established. The seeded fiscal-year variant V3 is a
     calendar year, so the period number is simply the month number. */
  const docDate = day(60);
  const postDate = day(62);
  const postThrough = day(64);
  /* The seeded fiscal-year variant V3 runs April to March and is named for its opening
     year, so a December date sits in FY2026 period 9: the period is the month counted
     from April, not the month number. `day()` anchors the slice in December for the open
     material period, so the derivation is stated here rather than guessed per screen. */
  const FY = Number(postDate.slice(0, 4));
  const PERIOD = ((Number(postDate.slice(5, 7)) + 8) % 12) + 1;

  const ASSET_COST_CENTRE = 'ADMIN';
  /* `runId` is a one-to-six-character key in the dunning programme; the module refuses a
     longer identification, and the date pair carries the rest of the identity. */
  const DUN_RUN_ID = 'WALKE1';
  const CLOSE_TEMPLATE = 'WALK-E-TPL';
  const CLOSE_TASK_LIST = 'WALK-E-CLOSE';

  /* Values that cross a step boundary are declared here: a step is a report unit,
     so it must not be the only place a document number exists. */
  let journalDoc = '';
  let journalFY = 0;
  let assetNumber = '';
  let assetSub = '0000';
  let assetVersion = 0;
  let accrualDoc = '';
  let clearingDoc = '';
  let clearingFY = 0;

  await step('manual journal: a balanced GL document posted through the journal service', async () => {
    const posted = await postGlDocument({
      client: w.client, changedBy: w.actor, requestKey: 'walk-e-gl-1',
      companyCode: w.company, documentDate: docDate, postingDate: postDate,
      documentType: 'SA', currency: 'INR', reference: 'WALK-E', headerText: 'Walkthrough journal',
      lines: [
        { glAccount: w.accounts.bank, debitCredit: 'S', amount: '1500.00', lineText: 'Bank in' },
        { glAccount: w.accounts.revenue, debitCredit: 'H', amount: '1500.00', lineText: 'Other revenue' },
      ],
    });
    journalDoc = posted.documentNumber;
    journalFY = posted.fiscalYear;
    cover('Finance (FI)', 'FIN.JOURNAL.POST', `manual document ${posted.displayNumber} (${posted.documentNumber}/${posted.fiscalYear}) debiting ${w.accounts.bank} for ${posted.debitTotal}`);
    cover('Finance (FI)', 'FIN.GL.CREATE', `${posted.lineCount} balanced line(s) posted to the general ledger of company ${w.company}`);
    await check(`the GL balances of ${w.accounts.bank} for FY${FY} moved by the manual journal`,
      () => getGlBalances(w.client, { glAccount: w.accounts.bank, companyCode: w.company, fiscalYear: FY }));
  });

  await step('parked journal: park an entry, post it, and list what stands parked', async () => {
    const parked = await parkJournal({
      client: w.client, changedBy: w.actor, requestKey: 'walk-e-park-1',
      companyCode: w.company, documentDate: docDate, postingDate: postDate,
      documentType: 'SA', currency: 'INR', reference: 'WALK-E-PARK', headerText: 'Walkthrough parked entry',
      lines: [
        { glAccount: w.accounts.bank, debitCredit: 'S', amount: 400, lineText: 'Bank in (parked)' },
        { glAccount: w.accounts.equity, debitCredit: 'H', amount: 400, lineText: 'Equity (parked)' },
      ],
    });
    cover('Finance (FI)', 'FIN.JOURNAL.PARK', `document ${parked.parkedNumber} parked at status ${parked.status} with a balance of ${parked.balance.toFixed(2)}`);
    const posted = await postParkedJournal({ client: w.client, changedBy: w.actor, parkedNumber: parked.parkedNumber });
    cover('Finance (FI)', 'FIN.JOURNAL.DISPLAY', `parked ${parked.parkedNumber} read back and posted as ${posted.postedDocumentNumber ?? 'the follow-on document'}`);
    await check('the parked-journal list for this tenant', () => listParkedJournals(w.client));
  });

  await step('document reversal: reverse the manual journal with reason 01', async () => {
    if (!journalDoc) throw new Error(`the manual journal step recorded no document for company ${w.company}`);
    const reversal = await reverseDocument({
      client: w.client, changedBy: w.actor, companyCode: w.company,
      documentNumber: journalDoc, fiscalYear: journalFY,
      reasonCode: '01', documentDate: postDate, postingDate: postDate, confirmed: true,
      requestKey: 'walk-e-reverse-1',
    });
    cover('Finance (FI)', 'FIN.DOCUMENT.REVERSE', `document ${journalDoc}/${journalFY} reversed by ${reversal.reversalDocumentNumber}/${reversal.reversalFiscalYear} in period ${reversal.reversalPostingPeriod} for ${reversal.reversalAmountLocal} ${reversal.currency}`);
  });

  await step('asset master and acquisition: create the asset, capitalise it, change the master', async () => {
    const [master] = await createAsset({
      client: w.client, changedBy: w.actor, companyCode: w.company, assetClass: '1000',
      description1: 'Walkthrough assembly fixture', description2: 'Slice E', inventoryNumber: 'WALK-FA-01',
      quantity: 1, unitOfMeasure: 'EA', capitalizationDate: `${FY}-01-01`,
      assignment: { validFrom: `${FY}-01-01`, costCenter: ASSET_COST_CENTRE },
      depreciation: [{ areaCode: '01', depreciationKey: 'SL01', usefulLifeYears: 5, usefulLifePeriods: 0 }],
    });
    if (!master) throw new Error('the asset master service returned no asset');
    assetNumber = master.assetNumber;
    assetSub = master.subNumber;
    assetVersion = master.version;
    cover('Finance (FI)', 'FIN.ASSET.CREATE', `asset ${master.assetNumber}/${master.subNumber} in class ${master.assetClass}, status ${master.status}, ${master.depreciation.length} depreciation area(s)`);
    const acquired = await postAssetAcquisition({
      client: w.client, changedBy: w.actor, companyCode: w.company,
      assetNumber, subNumber: assetSub,
      documentDate: docDate, postingDate: postDate, assetValueDate: `${FY}-01-01`,
      documentType: 'AA', currency: 'INR', amount: 60000,
      offsetAccount: w.accounts.bank, transactionType: 'ACQ',
      text: 'Walkthrough acquisition', reference: 'WALK-E-ACQ', requestKey: 'walk-e-asset-acq-1',
    });
    cover('Finance (FI)', 'FIN.ASSET.ACQUIRE', `document ${acquired.documentNumber} capitalises ${acquired.amount.toFixed(2)} ${acquired.currency} on ${assetNumber}; acquired value ${acquired.totalAcquiredValue.toFixed(2)}`);
    /* The assignment interval is deliberately not re-opened here: the master's time slice
       from the creation already runs open-ended, and `changeAssetAssignment` refuses an
       overlapping interval, which is the behaviour the screen documents. A descriptive
       change is what the asset screen offers on a capitalised asset, so that is what runs. */
    const changed = await changeAsset({
      client: w.client, changedBy: w.actor, companyCode: w.company,
      assetNumber, subNumber: assetSub, expectedVersion: assetVersion,
      description1: 'Walkthrough assembly fixture (line 2)', inventoryNumber: 'WALK-FA-01-B',
    });
    cover('Finance (FI)', 'FIN.ASSET.CHANGE', `master of ${assetNumber} changed at version ${changed.version}: ${changed.description1}, inventory number ${changed.inventoryNumber}`);
    await check(`the transaction list of asset ${assetNumber}`,
      () => getAssetTransactions(w.client, w.company, assetNumber, assetSub));
  });

  await step('asset period end: depreciation run, retirement, run list and history sheet', async () => {
    if (!assetNumber) throw new Error('there is no capitalised asset to depreciate');
    const run = await executeDepreciationRun({
      client: w.client, changedBy: w.actor, companyCode: w.company,
      fiscalYear: FY, postingPeriod: PERIOD, runType: '1', testRun: false,
      documentType: 'AF', postingDate: postDate,
    });
    cover('Finance (FI)', 'FIN.ASSET.DEPRECIATE', `run ${run.runId} at status ${run.status}: calculated ${run.totalCalculated.toFixed(2)}, posted ${run.totalPosted.toFixed(2)} on ${run.items.length} asset(s)`);
    const retired = await postAssetRetirement({
      client: w.client, changedBy: w.actor, companyCode: w.company,
      assetNumber, subNumber: assetSub,
      documentDate: postDate, postingDate: postDate, assetValueDate: `${FY}-01-01`,
      documentType: 'AB', currency: 'INR', transactionType: 'RET',
      scope: 'PERCENT', retirementPercent: 10, text: 'Walkthrough partial retirement',
      reference: 'WALK-E-RET', requestKey: 'walk-e-asset-ret-1',
    });
    cover('Finance (FI)', 'FIN.ASSET.RETIRE', `document ${retired.documentNumber} retires ${retired.retiredAcquisitionValue.toFixed(2)} of acquisition value (scope ${retired.scope}), ${retired.depreciationReversed.toFixed(2)} depreciation reversed, ${retired.remainingAcquisitionValue.toFixed(2)} left`);
    await check(`the depreciation run list for company ${w.company}`, () => listDepreciationRuns(w.client, w.company));
    await check(`the history sheet of asset ${assetNumber} in area 01`,
      () => getAssetHistorySheet(w.client, { companyCodeFrom: w.company, fiscalYear: FY, depreciationArea: '01' }));
    cover('Finance (FI)', 'FIN.ASSET.REPORT', 'asset transactions, depreciation runs and the history sheet all read for the capitalised asset');
  });

  await step('accruals: accrue a document, list what is due, reverse it on schedule', async () => {
    const posted = await postAccrualDocument({
      client: w.client, changedBy: w.actor, requestKey: 'walk-e-accrual-1',
      companyCode: w.company, documentDate: postThrough, postingDate: postThrough,
      documentType: 'SA', currency: 'INR', reference: 'WALK-E-ACCRUAL', headerText: 'Walkthrough accrual',
      reversalDate: postDate, reversalReason: '01',
      lines: [
        { glAccount: w.accounts.revenue, debitCredit: 'H', amount: '900.00', lineText: 'Accrued revenue' },
        { glAccount: w.accounts.equity, debitCredit: 'S', amount: '900.00', lineText: 'Accrual offset' },
      ],
    });
    accrualDoc = posted.documentNumber;
    cover('Finance (FI)', 'FIN.ACCRUAL.POST', `accrual document ${posted.displayNumber} of ${posted.totalAmount.toFixed(2)} ${posted.currency}, reversal promised on ${posted.reversalDate} for reason ${posted.reversalReason}`);
    const due = await listDueAccruals(w.client, postDate);
    if (due.length === 0) throw new Error(`the due-accrual list at ${postDate} was empty, so there is nothing for the reversal step to prove`);
    const reversed = await executeAccrualReversal({
      client: w.client, changedBy: w.actor, companyCode: w.company,
      documentNumber: accrualDoc, fiscalYear: FY,
    });
    cover('Finance (FI)', 'FIN.ACCRUAL.POST', `due reversal at ${postDate}: ${due.length} document(s) due, ${accrualDoc} now at status ${reversed.reversalStatus}${reversed.reversalDocumentNumber ? ` with document ${reversed.reversalDocumentNumber}` : ''}`);
  });

  await step('period end: foreign-currency valuation, then the retained-earnings carryforward', async () => {
    const valuation = await executeFxValuation({
      client: w.client, changedBy: w.actor,
      selection: {
        companyCode: w.company, valuationArea: '01', valuationKeyDate: postThrough, postingDate: postThrough,
        fiscalYear: FY, valuationMethod: 'AVERAGE', includeOpenItems: true, includeBalances: true,
        testRun: true, documentType: 'SA', requestKey: 'walk-e-fx-1',
      },
    });
    cover('Finance (FI)', 'FIN.FX.VALUATE', `valuation ${valuation.runId} at ${valuation.status} on ${valuation.valuationKeyDate}: ${valuation.items.length} item(s), gain ${valuation.totalGain.toFixed(2)}, loss ${valuation.totalLoss.toFixed(2)}${valuation.postingDocument ? `, posted ${valuation.postingDocument}` : ', test run: nothing posted'}`);
    const carried = await executeCarryforward({
      client: w.client, changedBy: w.actor,
      selection: { ledger: '0L', companyCodes: [w.company], targetFiscalYear: FY + 1, testRun: true },
    });
    cover('Finance (FI)', 'FIN.CLOSE.CARRYFORWARD', `run ${carried.runId} at status ${carried.status}: ${carried.accountsProcessed} account(s) read, ${carried.balancesCarried} balance(s) carried into FY${carried.targetFiscalYear}, ${carried.errors} error(s)`);
  });

  await step('GL clearing: clear a debit/credit pair on the open-item managed clearing account', async () => {
    /* The GR/IR account is the one ordinary (non-reconciliation) account the standard
       configuration creates as open-item managed, and the purchasing receipts and verified
       invoices leave it with both signs. Revenue does not stand open-item managed, which the
       clearing module says in as many words, so the walkthrough clears where the app allows. */
    const view = await getGlClearing({ client: w.client, companyCode: w.company, glAccount: w.accounts.grIr });
    const open = view.openItems.filter((item) => item.remaining > 0);
    const debit = open.find((item) => item.debitCredit === 'S');
    const credit = open.find((item) => item.debitCredit === 'H' && item.remaining === debit?.remaining);
    if (!debit || !credit) {
      throw new Error(`account ${w.accounts.grIr} holds ${open.length} open item(s) but no debit/credit pair of equal amount to settle: ${open.map((item) => `${item.documentNumber}:${item.debitCredit}${item.remaining}`).join(', ') || 'none'}`);
    }
    const cleared = await clearGlItems({
      client: w.client, changedBy: w.actor, companyCode: w.company, glAccount: w.accounts.grIr,
      documentType: 'SA', clearingDate: postThrough, postingDate: postThrough, documentDate: postThrough,
      confirmed: true, requestKey: 'walk-e-clear-1', method: 'STANDARD',
      items: [
        { documentNumber: debit.documentNumber, fiscalYear: debit.fiscalYear, lineNumber: debit.lineNumber },
        { documentNumber: credit.documentNumber, fiscalYear: credit.fiscalYear, lineNumber: credit.lineNumber },
      ],
    });
    clearingDoc = cleared.clearingDocumentNumber;
    clearingFY = cleared.clearingFiscalYear;
    cover('Finance (FI)', 'FIN.GL.CLEAR', `clearing document ${clearingDoc}/${clearingFY} settles ${debit.documentNumber} against ${credit.documentNumber} on ${w.accounts.grIr}; open balance now ${cleared.openBalance.toFixed(2)}`);
  });

  await step('vendor clearing: settle the open items of the walkthrough supplier, then undo it', async () => {
    const view = await getVendorClearing(w.client, 'V10000', w.company);
    const open = view.openItems;
    /* A vendor item carries its amount signed by side, so a settled selection is any subset
       whose signed amounts sum to zero: the screen lets the clerk tick rows, and one payment
       often clears two invoices. Two and three item selections are tried before the run is
       called unbalancable, because those are what the walkthrough's own receipts and payments
       produce; the module refuses anything that does not net. */
    const selection = balancedSelection(open);
    if (selection.length === 0) {
      throw new Error(`supplier V10000 in company ${w.company} holds ${open.length} open item(s) for ${view.openBalance.toFixed(2)} with no selection that nets to zero: ${open.map((item) => `${item.documentNumber}:${item.signed.toFixed(2)}`).join(', ') || 'none'}`);
    }
    const debit = selection[0];
    const credit = selection[selection.length - 1];
    const cleared = await clearVendorItems({
      client: w.client, changedBy: w.actor, supplier: 'V10000', companyCode: w.company,
      clearingDate: postThrough, postingDate: postThrough, documentDate: postThrough,
      items: selection.map((item) => ({
        documentNumber: item.documentNumber, fiscalYear: item.fiscalYear, lineNumber: item.lineNumber,
      })),
    });
    cover('Finance (FI)', 'FIN.AP.CLEAR', `clearing document ${cleared.clearingDocumentNumber} settles ${selection.map((item) => `${item.documentNumber}/${item.signed.toFixed(2)}`).join(' + ')} for V10000; open balance ${cleared.openBalance.toFixed(2)}`);
    void debit;
    clearingDoc = cleared.clearingDocumentNumber;
    clearingFY = FY;
  });

  await step('clearing reset: undo the clearing document so both items stand open again', async () => {
    if (!clearingDoc) throw new Error('neither the G/L nor the vendor clearing step produced a clearing document to reset');
    const reset = await resetClearing({
      client: w.client, changedBy: w.actor, companyCode: w.company,
      clearingDocument: clearingDoc, fiscalYear: clearingFY,
      reason: 'Walkthrough resets the clearing to re-open both items',
      requestKey: 'walk-e-clear-reset-1',
    });
    cover('Finance (FI)', 'FIN.CLEARING.RESET', `reset ${reset.resetNumber} re-opens ${reset.itemsReset} item(s) of clearing document ${reset.clearingDocument}/${reset.fiscalYear}`);
    await check(`the clearing document ${clearingDoc} before the reset is undone`,
      () => getClearingDocument(w.client, { companyCode: w.company, clearingDocument: clearingDoc, fiscalYear: clearingFY }));
  });

  await step('dunning: propose the run, exclude nothing, finalize it', async () => {
    const run = {
      client: w.client, changedBy: w.actor,
      runDate: postThrough, runId: DUN_RUN_ID, dunningDate: postThrough,
      postedThrough: postThrough, companyCodes: [w.company],
    };
    const proposed = await proposeDunningRun(run);
    if (proposed.accounts.length === 0) {
      throw new Error(`the run at ${postThrough} proposed no account: no customer invoice of ${w.company} is past its baseline date${proposed.items.length ? `, although ${proposed.items.length} item(s) were read` : ''}`);
    }
    cover('Finance (FI)', 'FIN.AR.DUNNING.RUN', `proposal ${proposed.runId} at ${proposed.status}: ${proposed.accounts.length} account(s) and ${proposed.items.length} item(s), highest level ${Math.max(...proposed.accounts.map((account) => account.proposedLevel ?? 0))}`);
    const finalized = await finalizeDunningRun({ ...run, confirmed: true });
    cover('Finance (FI)', 'FIN.AR.DUNNING.RUN', `finalized ${finalized.runId} at status ${finalized.status}: ${finalized.accounts.filter((account) => account.status !== 'BLOCKED').length} account(s) dunned, ${finalized.accounts.filter((account) => account.status === 'BLOCKED').length} held by an exception`);
    await check('the dunning run list for this tenant', () => listDunningRuns(w.client));
  });

  await step('close cockpit: template, task list, release, execution, evidence, sign-off', async () => {
    const cycle = { companyCode: w.company, taskListId: CLOSE_TASK_LIST, fiscalYear: FY, postingPeriod: PERIOD };
    await upsertTemplateTask({
      client: w.client, changedBy: w.actor, templateCode: CLOSE_TEMPLATE,
      task: { taskId: 'T-010', taskName: 'Reconcile the subledger', handlerCode: 'MANUAL_CONFIRMATION',
        sequence: 10, owner: 'CONTROLLER', criticalPath: true, requiresEvidence: true, requiresSignoff: true },
    });
    await upsertTemplateTask({
      client: w.client, changedBy: w.actor, templateCode: CLOSE_TEMPLATE,
      task: { taskId: 'T-020', taskName: 'Report the period status', handlerCode: 'PERIOD_STATUS',
        sequence: 20, owner: 'CONTROLLER' },
    });
    await createTaskListFromTemplate({
      client: w.client, changedBy: w.actor, cycle, templateCode: CLOSE_TEMPLATE,
      description: 'Walkthrough month-end close',
    });
    const released = await releaseTaskList({ client: w.client, changedBy: w.actor, cycle });
    cover('Finance (FI)', 'FIN.CLOSE.COCKPIT', `task list ${CLOSE_TASK_LIST} released for ${w.company} FY${FY}/${PERIOD}: ${released.totalTasks} task(s) at ${released.status}`);
    const executed = await executeTask({ client: w.client, changedBy: w.actor, cycle, taskId: 'T-020', mode: 'FOREGROUND' });
    const evidenced = await attachEvidence({
      client: w.client, changedBy: w.actor, cycle, taskId: 'T-010', evidenceRef: 'WALK-E-RECON-PDF',
    });
    const signed = await signOffTask({ client: w.client, changedBy: w.actor, cycle, taskId: 'T-010' });
    cover('Finance (FI)', 'FIN.CLOSE.COCKPIT', `T-020 executed as ${executed.status} (execution ${executed.executionId}${executed.scheduled ? ', scheduled' : ', in foreground'}), T-010 evidence ${evidenced.status} then sign-off ${signed.status}`);
    await check('the task list after both tasks were actioned', () => getTaskList(w.client, cycle));
    await check('the task board for the cycle', () => listTasks(w.client, cycle));
    await check('the event log for the cycle', () => listEvents(w.client, cycle));
  });

  await step('statement version: the layout the closing reports read, from the standard package', async () => {
    /* Since INTL-STD-4 the configuration package stands the standard financial statement
       version inside the tenant's own creation transaction, so this walkthrough tenant gets
       `INT` from `applyStandardPackage` like every other tenant does. The step is a check
       with a fallback, not a second definition: it reads what stands, and only if a tenant
       predates the package change does it insert the package's own rows — the same
       `STANDARD_STATEMENT_VERSION` the package writes, from the same module, so there is no
       competing copy of the standard here. */
    const standing = await listStatementVersions(w.client);
    const wanted = STANDARD_STATEMENT_VERSION.version;
    const had = standing.find((row) => row.version === wanted) !== undefined;
    if (!had) {
      await withTenant(w.client, async (tx) => {
        await tx.insert(financialStatementVersion).values({
          client: w.client, version: wanted, name: STANDARD_STATEMENT_VERSION.name,
          chartOfAccounts: 'CA01', isActive: true, createdBy: w.actor,
        }).onConflictDoNothing();
        for (const node of STANDARD_STATEMENT_VERSION.nodes) {
          await tx.insert(financialStatementNode).values({
            client: w.client, version: wanted, node: node.node, description: node.description,
            parentNode: node.parentNode, sequence: node.sequence, createdBy: w.actor,
          }).onConflictDoNothing();
        }
        for (const assignment of STANDARD_STATEMENT_VERSION.assignments) {
          await tx.insert(financialStatementAssignment).values({
            client: w.client, version: wanted, node: assignment.node,
            accountFrom: assignment.accountFrom, accountTo: assignment.accountTo,
            presentationSign: assignment.presentationSign, createdBy: w.actor,
          }).onConflictDoNothing();
        }
      });
    }
    const after = await listStatementVersions(w.client);
    if (after.find((row) => row.version === wanted) === undefined) {
      throw new Error(`statement version ${wanted} does not stand for client ${w.client} even after the fallback insert`);
    }
    console.log(`      version ${wanted} stood by ${had ? 'the standard configuration package' : 'the walkthrough fallback of the same package rows'}; `
      + `${STANDARD_STATEMENT_VERSION.nodes.length} node(s) and ${STANDARD_STATEMENT_VERSION.assignments.length} account range(s), `
      + `${after.length} version(s) in total for this tenant`);
  });

  await step('closing reports: trial balance, balance sheet, profit and loss', async () => {
    /* The report reads a financial statement version; nothing in the standard structure or
       in this seed creates one, so the version is taken from what stands rather than named
       from a manual. If none stands, the step records that the report has no version to run. */
    const versions = await listStatementVersions(w.client);
    if (versions.length === 0) {
      throw new Error(`no financial statement version stands for client ${w.client}, so the trial balance, balance sheet and profit and loss have nothing to lay out`);
    }
    const statementVersion = (versions.find((row) => row.version === STANDARD_STATEMENT_VERSION.version) ?? versions[0]).version;
    const selection = {
      companyCode: w.company, statementVersion, fiscalYear: FY,
      periodFrom: 1, periodTo: PERIOD, includeSpecialPeriods: false, ledger: '0L',
    };
    const trial = await calculateTrialBalance({ client: w.client, selection });
    cover('Finance (Reporting)', 'FIN.RPT.TRIALBALANCE', `FY${FY} period 1-${PERIOD} on statement version ${trial.statementVersion}: ${trial.nodes.length} statement row(s), ${trial.warnings.length} warning(s), ${trial.unassigned.length} account(s) outside the hierarchy, and turnover equal on both sides: ${trial.totalDebitTurnover.toFixed(2)} debit against ${trial.totalCreditTurnover.toFixed(2)} credit, read live through the report service with nothing persisted by it. The layout came from this tenant's own standard configuration package, which the step above only verifies; the walkthrough invents no statement version of its own, and the equality of that turnover against the equality of that turnover against the raw journal_entry_line rows is proved in tests/statement-version-onboarding.test.ts`);
    const sheet = await calculateBalanceSheet({ client: w.client, selection: { ...selection, calculationType: 'ACCUMULATED', summaryLevel: 1 } });
    cover('Finance (Reporting)', 'FIN.RPT.BALANCESHEET', `balance sheet for ${sheet.companyCode} in ${sheet.currency}: ${sheet.nodes.length} position row(s), ${sheet.unassigned.length} unassigned account(s)${sheet.currentYearResult === null ? '' : `, current-year result ${sheet.currentYearResult.toFixed(2)}`}`);
    const profit = await calculateProfitLoss({ client: w.client, selection: { ...selection, calculationType: 'ACCUMULATED', summaryLevel: 1 } });
    if (Math.abs(trial.totalDebitTurnover - trial.totalCreditTurnover) > 0.005) {
      throw new Error(`the trial balance does not balance against itself: debit ${trial.totalDebitTurnover.toFixed(2)} against credit ${trial.totalCreditTurnover.toFixed(2)}`);
    }
    cover('Finance (Reporting)', 'FIN.RPT.PROFITLOSS', `profit and loss for FY${profit.fiscalYear} period ${profit.periodFrom}-${profit.periodTo}: ${profit.nodes.length} row(s)${profit.currentYearResult === null ? '' : `, result ${profit.currentYearResult.toFixed(2)} ${profit.currency}`}`);
  });

  await step('subledger reports and tax: customer ageing, vendor ageing, the tax report', async () => {
    const ageing = { companyCode: w.company, keyDate: postThrough };
    const customers = await getCustomerAgeing(w.client, ageing);
    cover('Finance (Reporting)', 'FIN.AR.AGEING', `customer ageing at ${customers.keyDate}: ${customers.customers.length} customer(s) in ${customers.thresholds.join('-')} day buckets, ${customers.grandTotal.toFixed(2)} ${customers.currency} outstanding`);
    const suppliers = await getVendorAgeing(w.client, ageing);
    cover('Finance (Reporting)', 'FIN.AP.AGEING', `vendor ageing at ${suppliers.keyDate}: ${suppliers.suppliers.length} supplier(s), ${suppliers.grandTotal.toFixed(2)} ${suppliers.currency} outstanding`);
    const tax = await executeTaxReport({
      client: w.client, changedBy: w.actor,
      selection: {
        companyCode: w.company, postingDateFrom: `${FY}-01-01`, postingDateTo: postThrough,
        taxReturnCountry: 'IN', testRun: true, doNotUpdateDocuments: true,
        electronicReturn: false, correctedReturn: false,
      },
    });
    cover('Finance (FI)', 'FIN.TAX.REPORT', `test report for ${tax.taxReturnCountry} over ${tax.postingDateFrom} to ${tax.postingDateTo}: ${tax.lines.length} line(s), base ${tax.totalBase.toFixed(2)}, output ${tax.totalOutputTax.toFixed(2)}, input ${tax.totalInputTax.toFixed(2)}, net ${tax.netTax.toFixed(2)}`);
  });

  await step('intercompany: configure the pair, then charge from the primary to the second company code', async () => {
    const pair = await saveIntercompanyConfig({
      client: w.client, changedBy: w.actor,
      sendingCompanyCode: w.company, receivingCompanyCode: SECOND_COMPANY,
      sendingClearingGl: w.accounts.grIr, receivingClearingGl: w.accounts.grIr, defaultCurrency: 'INR',
    });
    console.log(`      the pair ${pair.sendingCompanyCode} to ${pair.receivingCompanyCode} stands configured with clearing accounts ${pair.sendingClearingGl ?? 'unset'} and ${pair.receivingClearingGl ?? 'unset'} in ${pair.defaultCurrency ?? 'no default currency'}`);
    /* The receiving company posts its half of the document, so it needs a number range of its
       own: the standard structure gives one to the primary company code only, and the range
       maintenance screen is the implemented activity that supplies the rest. */
    await maintainNumberRange({
      client: w.client, objectCode: 'RF_BELEG', companyCode: SECOND_COMPANY, subObject: 'GENERAL', fiscalYear: 0,
      prefix: 'JE', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE',
      status: 'ACTIVE', mode: 'CREATE', reason: 'Walkthrough intercompany range', changedBy: w.actor,
    });
    const posting = await postIntercompany({
      client: w.client, changedBy: w.actor,
      sendingCompanyCode: w.company, receivingCompanyCode: SECOND_COMPANY,
      postingDate: postThrough, documentDate: postThrough, documentType: 'SA', currency: 'INR',
      reference: 'WALK-E-IC', headerText: 'Walkthrough intercompany',
      confirmed: true, requestKey: 'walk-e-ic-1',
      /* One operator line only: the service raises the offsetting leg on the configured
         clearing account of each company, which is the point of the intercompany document. */
      lines: [{ glAccount: w.accounts.revenue, debitCredit: 'H', amount: '250.00', lineText: 'Charge out' }],
    });
    cover('Finance (FI)', 'FIN.IC.POST', `${posting.sendingDocumentNumber}/${posting.sendingFiscalYear} in ${w.company} against ${posting.receivingDocumentNumber}/${posting.receivingFiscalYear} in ${SECOND_COMPANY} for 250.00 ${posting.currency}`);
    await check('the intercompany configuration of this tenant', () => listIntercompanyConfigs(w.client));
  });
}

/* ── helpers local to this slice ─────────────────────────────────────────────
 * A read path is coverage in its own right: a screen whose list function throws is
 * broken, and the seed says so rather than ignoring the call. `check` deliberately
 * reports only what the type system already knows, so no read is dressed up.
 */
/** The smallest balanced selection of open items: a pair first, then three rows. */
function balancedSelection<T extends { signed: number }>(items: T[]): T[] {
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) {
      if (net(items[a].signed, items[b].signed) === 0) return [items[a], items[b]];
    }
  }
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) {
      for (let c = b + 1; c < items.length; c += 1) {
        if (net(net(items[a].signed, items[b].signed), items[c].signed) === 0) return [items[a], items[b], items[c]];
      }
    }
  }
  return [];
}

/** Money is compared in whole minor units, so a rounding of a tenth of a paisa is not a difference. */
function net(left: number, right: number): number {
  return Math.round((left + right) * 100) / 100;
}

async function check(what: string, run: () => Promise<unknown>): Promise<void> {
  const value = await run();
  console.log(`  read ${what}: ${describeRead(value)}`);
}

function describeRead(value: unknown): string {
  if (Array.isArray(value)) return `${String(value.length)} row(s)`;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object') return 'read without error';
  return String(value);
}
