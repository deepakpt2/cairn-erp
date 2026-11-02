import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { validateIntegrationDatabaseConfig } from './integration-db-config';

function main() {
  try {
    const config = validateIntegrationDatabaseConfig(process.env);
    const args = process.argv.slice(2);
    if (args.some((arg) => arg === '--config' || arg.startsWith('--config='))) {
      throw new Error('Integration test runner does not permit an alternate Vitest config.');
    }
    console.log(
      `Integration test preflight: ${config.mode} database ${config.database}, runtime ${config.runtimeRole}, migration ${config.migrationRole}; connection secrets withheld.`,
    );
    const vitest = resolve(process.cwd(), 'node_modules/.bin/vitest');
    const result = spawnSync(vitest, ['run', ...args], {
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) {
      console.error('Integration test runner could not start Vitest; environment values withheld.');
      process.exitCode = 1;
      return;
    }
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Integration test configuration refused; values withheld.');
    process.exitCode = 1;
  }
}

main();
