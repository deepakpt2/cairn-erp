export type IntegrationDatabaseMode = 'persistent' | 'disposable';

export interface IntegrationDatabaseEnvironment {
  [key: string]: string | undefined;
  CAIRN_ENV?: string;
  CAIRN_INTEGRATION_MODE?: string;
  CAIRN_TEST_DB_NAME?: string;
  CAIRN_INTEGRATION_DATA_DIRECTORY?: string;
  CAIRN_INTEGRATION_SYSTEM_IDENTIFIER?: string;
  DATABASE_URL?: string;
  MIGRATION_DATABASE_URL?: string;
  CAIRN_DB_HOST?: string;
  CAIRN_DB_PORT?: string;
  CAIRN_DB_USER?: string;
  CAIRN_DB_PASSWORD?: string;
}

export interface ValidatedIntegrationDatabaseConfig {
  mode: IntegrationDatabaseMode;
  database: string;
  host: '127.0.0.1';
  port: 55435;
  runtimeRole: 'cairn_app';
  migrationRole: 'cairn_integration_migrator';
  dataDirectory: '/home/cairn/.local/share/postgresql/cairn_integration/data';
  systemIdentifier: '7703407688127814566';
  runtimeUrl: string;
  migrationUrl: string;
}

const PERSISTENT_DATABASE = 'cairn_integration';
const DISPOSABLE_DATABASE = /^cairn_migration_test_\d{8}_[a-z0-9]{4,12}$/;
const EXPECTED_DATA_DIRECTORY = '/home/cairn/.local/share/postgresql/cairn_integration/data';
const EXPECTED_SYSTEM_IDENTIFIER = '7703407688127814566';

export function redactConnectionUrls(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, '[connection URL withheld]');
}

function refuse(message: string): never {
  // Deliberately never include URL values or parsed passwords in guard errors.
  throw new Error(`Integration database target refused: ${message}`);
}

function parseUrl(raw: string | undefined, variable: string): URL {
  if (!raw) refuse(`${variable} must be set explicitly.`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    refuse(`${variable} is not a valid connection URL; value withheld.`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    refuse(`${variable} must use PostgreSQL.`);
  }
  if (parsed.search || parsed.hash) {
    refuse(`${variable} must not contain unreviewed query or fragment parameters.`);
  }
  return parsed;
}

/** Validate integration test configuration before any database connection. */
export function validateIntegrationDatabaseConfig(
  env: IntegrationDatabaseEnvironment = process.env,
): ValidatedIntegrationDatabaseConfig {
  const mode = env.CAIRN_INTEGRATION_MODE;
  if (mode !== 'persistent' && mode !== 'disposable') {
    refuse('CAIRN_INTEGRATION_MODE must be persistent or disposable.');
  }
  if ((env.CAIRN_ENV ?? 'development') !== 'development') {
    refuse('CAIRN_ENV must be development.');
  }

  const database = env.CAIRN_TEST_DB_NAME;
  if (!database) refuse('CAIRN_TEST_DB_NAME must be explicit.');
  if (mode === 'persistent' && database !== PERSISTENT_DATABASE) {
    refuse('persistent integration runs may target cairn_integration only.');
  }
  if (mode === 'disposable' && !DISPOSABLE_DATABASE.test(database)) {
    refuse('disposable migration runs require a unique cairn_migration_test_YYYYMMDD_<run-id> name.');
  }
  if (database === 'cairn_b210') refuse('the protected browser-acceptance database is forbidden.');

  const runtimeUrl = parseUrl(env.DATABASE_URL, 'DATABASE_URL');
  const migrationUrl = parseUrl(env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL');
  for (const [name, url] of [['DATABASE_URL', runtimeUrl], ['MIGRATION_DATABASE_URL', migrationUrl]] as const) {
    if (url.pathname !== `/${database}`) refuse(`${name} must explicitly target ${database}.`);
    if (url.hostname !== '127.0.0.1' || url.port !== '55435') {
      refuse(`${name} must use the approved loopback PostgreSQL endpoint.`);
    }
    if (!decodeURIComponent(url.username) || !decodeURIComponent(url.password)) {
      refuse(`${name} must use its dedicated role and non-empty credential.`);
    }
  }

  if (decodeURIComponent(runtimeUrl.username) !== 'cairn_app') {
    refuse('DATABASE_URL must use the restricted cairn_app runtime role.');
  }
  if (decodeURIComponent(migrationUrl.username) !== 'cairn_integration_migrator') {
    refuse('MIGRATION_DATABASE_URL must use cairn_integration_migrator.');
  }
  if (runtimeUrl.password === migrationUrl.password) {
    refuse('runtime and migration credentials must be distinct.');
  }
  if (runtimeUrl.hostname !== migrationUrl.hostname || runtimeUrl.port !== migrationUrl.port
      || runtimeUrl.pathname !== migrationUrl.pathname) {
    refuse('runtime and migration URLs must target the same approved endpoint and database.');
  }
  if (env.CAIRN_DB_HOST !== '127.0.0.1' || env.CAIRN_DB_PORT !== '55435'
      || env.CAIRN_DB_USER !== 'cairn_app'
      || env.CAIRN_DB_PASSWORD !== decodeURIComponent(runtimeUrl.password)) {
    refuse('CAIRN_DB_* identity-verification settings must match the runtime URL.');
  }
  if (env.CAIRN_INTEGRATION_DATA_DIRECTORY !== EXPECTED_DATA_DIRECTORY) {
    refuse('the expected PostgreSQL data-directory identity must be explicit.');
  }
  if (env.CAIRN_INTEGRATION_SYSTEM_IDENTIFIER !== EXPECTED_SYSTEM_IDENTIFIER) {
    refuse('the expected PostgreSQL system identifier must be explicit.');
  }

  return {
    mode,
    database,
    host: '127.0.0.1',
    port: 55435,
    runtimeRole: 'cairn_app',
    migrationRole: 'cairn_integration_migrator',
    dataDirectory: EXPECTED_DATA_DIRECTORY,
    systemIdentifier: EXPECTED_SYSTEM_IDENTIFIER,
    runtimeUrl: env.DATABASE_URL as string,
    migrationUrl: env.MIGRATION_DATABASE_URL as string,
  };
}
