import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { walkthroughCreditPrerequisiteError } from '../src/modules/finance/walkthrough-credit-preflight';

const seed = readFileSync('walkthrough-seed.ts', 'utf8');
const operations = readFileSync('Dockerfile', 'utf8').split('FROM dependencies AS operations')[1]?.split('FROM dependencies AS builder')[0] ?? '';

describe('manual walkthrough seed safety contract', () => {
  it('is development-only, tenant-scoped, app-role-only and never provisions a tenant', () => {
    expect(seed).toContain("process.env.CAIRN_ENV !== 'development'");
    expect(seed).toContain("tenant === '0100'");
    expect(seed).toContain('validateTarget(database');
    expect(seed).toContain("roleRows[0]?.role !== 'cairn_app'");
    expect(seed).toContain('assertApplicationRole()');
    expect(seed).toContain('withTenant(');
    expect(seed).not.toContain('createTenant(');
    expect(seed).not.toContain('directSql(');
    expect(seed).not.toContain('MIGRATION_DATABASE_URL');
  });

  it('requires an explicit database, tenant and date and guards mismatched business records', () => {
    expect(seed).toContain("required('CAIRN_SEED_DATABASE')");
    expect(seed).toContain("required('CAIRN_SEED_TENANT')");
    expect(seed).toContain("required('CAIRN_SEED_DATE')");
    expect(seed).toContain('refusing to change it');
    expect(seed).toContain('refusing to guess');
    expect(seed).toContain('refusing to modify or replay it');
  });

  it('authenticates the real first administrator, provisions exact persisted scopes through the audited domain service, and then verifies them', () => {
    const scopes = readFileSync('src/modules/platform/organisation-scope-admin.ts', 'utf8');
    expect(seed).toContain("required('CAIRN_SEED_ORIGIN')");
    expect(seed).toContain("required('CAIRN_SEED_USERNAME')");
    expect(seed).toContain("required('CAIRN_SEED_PASSWORD')");
    expect(seed).toContain("'/api/auth/signin'");
    expect(seed).toContain('resolveSession(tx, { client: tenant, token: parsed.token })');
    expect(seed).toContain("'FIN.AP.PAYMENT.POST'");
    expect(seed).toContain("'FIN.AR.CLEAR'");
    expect(seed).toContain("'PROD.MRP.RUN'");
    expect(seed).toContain('!companyGranted || !plantGranted');
    expect(seed).toContain('provisionWalkthroughFirstAdminScopesInTransaction');
    expect(seed).toContain('assertWalkthroughScopes(tenant, auth, checkpoint)');
    expect(scopes).toContain("scopeType: 'COMPANY_CODE', scopeValue: '1000'");
    expect(scopes).toContain("scopeType: 'PLANT', scopeValue: '1000'");
    expect(scopes).toContain('WALKTHROUGH_INSTALL_REASON');
    expect(scopes).toContain('auditCorrelationId: input.correlationId');
    expect(scopes).toContain('if (actor.userId === targetUserId)');
    expect(scopes).toContain('assertWalkthroughSeedRuntime');
    expect(seed).toContain('authorization: { userId: auth.session.user.userId, sessionId: auth.session.sessionId! }');
    expect(seed).toContain("'/api/auth/signout'");
    expect(seed).not.toContain('createSession(');
    expect(seed).not.toContain('INSERT INTO auth_org_restriction');
    expect(seed).not.toContain('INSERT INTO user_session');
  });

  it('uses request-key lifecycle services, explicitly picks before delivery goods issue, and reconciles stock and ledgers', () => {
    expect(seed).toContain('postSupplierInvoice(');
    expect(seed).toContain('planMaterials(');
    expect(seed).toContain('changePlannedOrder(');
    expect(seed).toContain('convertPlannedOrder(');
    expect(seed).not.toContain('createProductionOrder(');
    expect(seed).toContain('postGoodsIssue(');
    expect(seed).toContain('postProductionReceipt(');
    expect(seed).toContain('confirmDeliveryPicks(');
    expect(seed).toContain('postDeliveryGoodsIssue(');
    expect(seed).toContain('createBillingFromDelivery(');
    expect(seed).toContain('postCustomerCreditMemo(');
    expect(seed).toContain('postOutgoingPayment(');
    expect(seed).toContain('postIncomingPayment(');
    expect(seed).toContain('clearCustomerItems(');
    expect(seed).toContain('postTransfer(');
    expect(seed).toContain('reverseTransfer(');
    expect(seed).toContain('reconcileStock(');
    expect(seed).toContain('calculateSubledgerTie(');
    expect(seed).toContain('inventoryTieRows');
    expect(seed).toContain('GR/IR 210000 is zero');
    expect(seed.lastIndexOf('confirmDeliveryPicks({')).toBeLessThan(seed.lastIndexOf('postDeliveryGoodsIssue({'));
  });

  it('supports same-date replay through production setup and billing without duplicate writes', () => {
    expect(seed).toContain('listOrderTypeParameters(tenant)');
    expect(seed).toContain('saveOrderTypeParameter({');
    expect(seed).toContain("productionVersionSelection !== '0'");
    expect(seed).toContain('billing.invoice ?? (billing.billing.customerInvoiceNumber');
    expect(seed).toContain('getCustomerInvoice(tenant, billing.billing.customerInvoiceNumber)');
    expect(seed).toContain("finishedReceipt.movementCode !== '101'");
    expect(seed).toContain("moneyEqual(routing.baseQuantity, 1, 0.0005)");
    expect(seed).toContain("const TRANSFER_STORAGE = '0004'");
    expect(seed).toContain("headerText: 'Walkthrough prod issue'");
    expect(seed).toContain("headerText: 'Walkthrough output GR'");
    expect(seed).toContain('material_number in (${sql.join(MATERIALS.map');
    expect(seed).not.toContain('material_number = any(${MATERIALS})');
  });

  it('uses configuration codes accepted by the production BOM maintenance service', () => {
    expect(seed).toContain("productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.'");
    expect(seed).not.toContain("productionRelevance: 'X'");
    expect(seed).not.toContain("engineeringRelevance: ' '");
  });

  it('preflights active CCA 0001 and the company mapping before the first setup write', () => {
    const gate = seed.indexOf('await preflightCreditConfiguration(tenant, summary)');
    const firstSetupWrite = seed.indexOf('await ensureStandardPackage(tx, tenant, true)');
    expect(gate).toBeGreaterThan(-1);
    expect(firstSetupWrite).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstSetupWrite);
    expect(seed).toContain('applyStandardStructureInTransaction(tx,');
    expect(seed).toContain('assertStandardWalkthroughStructure(tx, tenant)');
    expect(seed).toContain('writeWalkthroughCheckpoint(tx,');
    expect(seed).toContain('walkthroughCreditPrerequisiteError({');
    expect(seed).toContain('eq(creditControlArea.creditControlArea, \'0001\')');
    expect(seed).toContain('summary.checks.creditControlArea');

    const existingCompany = { isActive: true, currency: 'AED', creditControlArea: '0001' };
    const activeArea = { isActive: true, currency: 'AED' };
    expect(walkthroughCreditPrerequisiteError({ company: existingCompany, area: activeArea, companyCode: '1000', areaCode: '0001', expectedCurrency: 'AED' })).toBeNull();
    expect(walkthroughCreditPrerequisiteError({ company: existingCompany, area: null, companyCode: '1000', areaCode: '0001', expectedCurrency: 'AED' })).toMatch(/missing/i);
    expect(walkthroughCreditPrerequisiteError({ company: { ...existingCompany, creditControlArea: null }, area: activeArea, companyCode: '1000', areaCode: '0001', expectedCurrency: 'AED' })).toMatch(/mapped to no credit control area/i);
    expect(walkthroughCreditPrerequisiteError({ company: existingCompany, area: { ...activeArea, isActive: false }, companyCode: '1000', areaCode: '0001', expectedCurrency: 'AED' })).toMatch(/inactive/i);
    expect(walkthroughCreditPrerequisiteError({ company: null, area: null, companyCode: '1000', areaCode: '0001', expectedCurrency: 'AED' })).toBeNull();
  });

  it('ships the seed only in the one-shot operations image and does not invoke it on startup', () => {
    expect(operations).toContain('COPY walkthrough-seed.ts /app/walkthrough-seed.ts');
    expect(operations).not.toContain('npm run walkthrough:seed');
    expect(seed).toContain("if (process.argv[1]?.endsWith('walkthrough-seed.ts')) void main();");
  });
});
