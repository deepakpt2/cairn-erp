#!/usr/bin/env python3
"""Read-only Compose DB diagnostic. Never prints env values, passwords or raw inspect output."""
import json
import subprocess
import sys
from urllib.parse import unquote, urlsplit


def command(args, timeout=20):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError('Diagnostic command failed: ' + ' '.join(args[:3]) + '. No raw output shown.')
    return p.stdout


def env_map(container):
    return dict(item.split('=', 1) for item in container.get('Config', {}).get('Env', []) if '=' in item)


def connection_summary(app_env, migration_env, db_env):
    a = app_env.get('DATABASE_URL', '')
    m = migration_env.get('DATABASE_URL', '')
    if not a or not m:
        return {'application_url_present': bool(a), 'migration_url_present': bool(m)}
    try:
        app, migration = urlsplit(a), urlsplit(m)
        app_password, migration_password = unquote(app.password or ''), unquote(migration.password or '')
        return {
            'exact_application_migration_url_match': a == m,
            'decoded_application_migration_password_match': app_password == migration_password,
            'app_password_matches_db_container_setting': app_password == db_env.get('CAIRN_APP_DB_PASSWORD'),
            'application_user': unquote(app.username or ''),
            'application_host': app.hostname,
            'application_port': app.port or 5432,
            'application_database': app.path.lstrip('/'),
        }
    except (ValueError, TypeError):
        return {'connection_url_parse_failed': True}


PROBE = r'''
(async () => {
  const out = {};
  let url;
  try { url = new URL(process.env.DATABASE_URL); }
  catch { console.log(JSON.stringify({runtime_url_valid:false})); return; }
  const dns = require('node:dns').promises;
  try { out.resolved_addresses = (await dns.lookup(url.hostname, {all:true})).map(x=>x.address); }
  catch (e) { out.dns_error_code = e.code || 'UNKNOWN'; }
  let sql;
  try {
    let postgres;
    try { postgres = require('postgres'); }
    catch { out.direct_login_probe = 'driver_not_separately_packaged'; console.log(JSON.stringify(out)); return; }
    sql = postgres(process.env.DATABASE_URL, {max:1, prepare:false, connect_timeout:5, onnotice:()=>{}});
    const [row] = await sql`select inet_server_addr()::text as server_address, current_database() as database, current_user as username`;
    out.direct_login_probe = 'ok'; out.database_identity = row;
  } catch (e) { out.direct_login_probe = 'failed'; out.sqlstate = e.code || 'UNKNOWN'; }
  finally { if (sql) await sql.end({timeout:2}); }
  console.log(JSON.stringify(out));
})().catch(()=>{console.log(JSON.stringify({probe_failed:true}));process.exitCode=1;});
'''


def main():
    containers = {}
    for service in ('app', 'migrate', 'db'):
        ids = command(['docker', 'compose', 'ps', '-a', '-q', service]).split()
        if len(ids) != 1:
            raise RuntimeError('Expected one container for ' + service + '; no private details shown.')
        containers[service] = json.loads(command(['docker', 'inspect', ids[0]]))[0]
    report = connection_summary(env_map(containers['app']), env_map(containers['migrate']), env_map(containers['db']))
    report['application_started_at'] = containers['app']['State']['StartedAt']
    report['migration_exit_code'] = containers['migrate']['State']['ExitCode']
    report['application_networks'] = list(containers['app']['NetworkSettings']['Networks'])
    report['expected_db_addresses'] = [v['IPAddress'] for v in containers['db']['NetworkSettings']['Networks'].values() if v.get('IPAddress')]
    # Only fixed read-only JavaScript is supplied; the URL stays inside the app container.
    text = command(['docker', 'exec', containers['app']['Id'], 'node', '-e', PROBE], timeout=15)
    probe = json.loads(text.strip().splitlines()[-1])
    report['application_probe'] = probe
    addresses = probe.get('resolved_addresses', [])
    report['dns_resolves_only_expected_database'] = bool(addresses) and set(addresses) <= set(report['expected_db_addresses'])
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Read-only diagnostic could not complete. Check Docker permissions and service names app/migrate/db. No private values shown.', file=sys.stderr)
        sys.exit(1)
