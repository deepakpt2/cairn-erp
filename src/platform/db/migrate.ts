/**
 * Migration runner — CAIRN.md §22.5
 *
 * Applies every .sql file in /drizzle in lexical order, once each, tracked in
 * cairn_migration. Runs as the migration role (owner of the schema), never as the
 * application role — the application has no data-definition rights (§22.8).
 *
 * Lexical ordering is why the row-level security file is numbered 9000+: generated
 * table migrations are 0000, 0001, … and policies must land after the tables they
 * attach to.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { directSql } from './client';

const MIGRATION_DIR = join(process.cwd(), 'drizzle');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(): Promise<MigrationResult> {
  // Migrations must use the owning role, not the restricted application role.
  const connectionString =
    process.env.MIGRATION_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://cairn:cairn_dev@127.0.0.1:5432/cairn';

  const client = directSqlWith(connectionString);
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    const [role] = await client.unsafe<Array<{ elevated: boolean }>>(
      `select (rolsuper or rolbypassrls) as elevated from pg_roles where rolname = current_user`,
    );
    if (!role?.elevated) throw new Error('The migration role must have BYPASSRLS so forced-RLS data migrations and narrow administration functions cannot silently return no rows. The application role must NEVER have BYPASSRLS.');
    await client.unsafe(`
      create table if not exists cairn_migration (
        filename    text primary key,
        applied_at  timestamptz not null default now(),
        checksum    text not null
      )
    `);

    const files = readdirSync(MIGRATION_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    const existing = await client.unsafe<Array<{ filename: string; checksum: string }>>(
      `select filename, checksum from cairn_migration`,
    );
    const alreadyApplied = new Map(existing.map((row) => [row.filename, row.checksum]));

    for (const file of files) {
      const sqlText = readFileSync(join(MIGRATION_DIR, file), 'utf8');
      const checksum = simpleChecksum(sqlText);
      const previous = alreadyApplied.get(file);

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} has changed since it was applied. ` +
              `Migrations are immutable once applied — add a new migration instead.`,
          );
        }
        skipped.push(file);
        continue;
      }

      // Each file runs inside its own transaction: a failing migration leaves no
      // partial schema behind.
      await client.unsafe('begin');
      try {
        await client.unsafe(sqlText);
        await client.unsafe(
          `insert into cairn_migration (filename, checksum) values ($1, $2)`,
          [file, checksum],
        );
        await client.unsafe('commit');
        applied.push(file);
      } catch (error) {
        await client.unsafe('rollback');
        throw new Error(
          `Migration ${file} failed: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }

    return { applied, skipped };
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** Deterministic, dependency-free checksum. Detects edited migrations, nothing more. */
function simpleChecksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// Imported lazily so this module does not pull the pool into every consumer.
import postgres from 'postgres';
function directSqlWith(connectionString: string) {
  return postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });
}

/** CLI entry point: `npm run db:migrate` */
if (process.argv[1] && process.argv[1].includes('migrate')) {
  runMigrations()
    .then((result) => {
      if (result.applied.length > 0) {
        console.log(`Applied ${result.applied.length} migration(s):`);
        for (const file of result.applied) console.log(`  + ${file}`);
      }
      if (result.skipped.length > 0) {
        console.log(`${result.skipped.length} migration(s) already applied.`);
      }
      if (result.applied.length === 0 && result.skipped.length === 0) {
        console.log('No migrations found.');
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error.message);
      process.exit(1);
    });
}
