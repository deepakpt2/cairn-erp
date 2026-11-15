/**
 * Run a command with the test environment loaded (`.env.test`, guarded to erp_test).
 *
 *   tsx scripts/with-test-env.ts <command> [args...]
 *
 * Used by the `test:db:*` npm scripts so migrations and seeds for the test database go
 * through the same erp_dev refusal as the vitest suites.
 */
import { spawnSync } from 'node:child_process';
import '../tests/test-env';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: tsx scripts/with-test-env.ts <command> [args...]');
  process.exit(2);
}
console.log(`with-test-env: database ${process.env.TEST_DATABASE_NAME}; credentials withheld.`);
const result = spawnSync(command, args, { stdio: 'inherit', env: process.env, shell: false });
process.exit(result.status ?? 1);
