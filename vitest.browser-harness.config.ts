/** Pure CLI/fixture/credential tests: intentionally no database setup or cleanup. */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: { alias: { '@': resolve(process.cwd(), './src') } },
  test: {
    environment: 'node',
    include: ['tests/browser-targets.test.ts', 'tests/customer-company-codes.test.ts', 'tests/db-credentials.test.ts', 'tests/tenant-provisioning.test.ts', 'tests/onboarding-admission.test.ts', 'tests/company-code-capability-contract.test.ts', 'tests/company-code-coa-assignment-contract.test.ts', 'tests/company-code-coa-assignment-ui-contract.test.ts', 'tests/company-code-assignments.test.ts', 'tests/company-code-assignments-schema-contract.test.ts', 'tests/company-code-definition-contract.test.ts', 'tests/company-code-definition-ui-contract.test.ts', 'tests/supplier-company-payment-method-schema.test.ts', 'tests/supplier-company-payment-methods.test.ts', 'tests/supplier-company-payment-method-action-contract.test.ts', 'tests/supplier-company-payment-method-ui-contract.test.ts', 'tests/supplier-company-payment-method-browser-contract.test.ts', 'tests/plant-company-code-nullable-schema-contract.test.ts', 'tests/plant-logistics-fields-schema-contract.test.ts', 'tests/plant-maintenance-contract.test.ts', 'tests/plant-maintenance-action-contract.test.ts', 'tests/plant-definition-ui-contract.test.ts', 'tests/plant-company-code-assignment-contract.test.ts', 'tests/plant-company-code-assignment-ui-contract.test.ts', 'tests/storage-location-capability-contract.test.ts', 'tests/storage-location-schema-contract.test.ts', 'tests/purchasing-org-company-code-nullable-schema-contract.test.ts', 'tests/purchasing-org-maintenance-contract.test.ts', 'tests/storage-location-maintenance-contract.test.ts', 'tests/storage-location-ui-contract.test.ts'],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 5_000,
  },
});
