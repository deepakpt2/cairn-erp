# Cairn ERP — Agent Operating Instructions

**Mandatory entry point for every coding-agent session.** Read this file in full before any implementation, GitHub operation, test-server connection, or database operation.

## Session-Start Preflight

Before making any changes, complete this preflight report:

| Check | Required Result |
|-------|-----------------|
| Root AGENTS.md read | YES |
| docs/DEVELOPMENT-OPERATIONS.md read | YES |
| ".env.local" inspected safely | YES / NO / NOT PRESENT |
| Git branch and working tree checked | YES / NO |
| GitHub authentication procedure identified | YES / NO |
| Test-server procedure identified | YES / NO |
| Database restrictions understood | YES / NO |
| Intended database target identified | YES / NO / NOT APPLICABLE |

If any mandatory check fails, stop before making changes and report the blocker.

## Core Rules

### 1. Branch Discipline

- **`main`** is the stable, tested release branch. Never push directly to `main`.
- **`development`** is the active integration and testing branch. Implement on `development`.
- Never force-push. Never rewrite existing branch history.
- Never automatically merge into `main`. Merge only after explicit owner authorization.
- Use `development` for implementation and testing. Commit logically scoped changes.
- Push completed commits to `origin/development`.

### 2. GitHub Authentication

- Reuse the existing working authentication mechanism.
- Credentials are stored in `.env.local` as `GITHUB_REMOTE_URL` and `GITHUB_PAT`.
- Do not print or expose the PAT. Do not embed credentials in remote URLs.
- Do not write credentials into repository files or Git history.
- To verify authentication: `git -c 'http.extraheader=Authorization: Basic <base64(x-access-token:PAT)>' ls-remote origin`

### 3. Test Server

- Host: `107.173.201.115`, SSH port: `2222`, User: `cairn`
- Project directory: `/home/cairn/cairn-erp/`
- Use the established Pexpect-based interactive SSH procedure.
- Direct SSH and SSH_ASKPASS attempts previously failed — do not retry those methods.
- The test-server checkout tracks `origin/development`.

### 4. Database Safety (PERMANENT)

**Permanently prohibited databases — never access under any circumstances:**
- `cairn_b210`
- `cairn_hr_accept`
- `cairn_demo`

**Authorized acceptance database:**
- `cairn_acceptance` — persistent, must never be dropped, reset, reseeded, or recreated during routine testing.
- Use incremental migrations only.
- Verify the effective database target before every database-writing operation.
- Never assume the first `DATABASE_URL` or `MIGRATION_DATABASE_URL` is the correct database.
- If the target cannot be positively identified, stop.

### 5. Environment-File Protection

- `.env.local` is an important existing project configuration source.
- Check whether it exists before creating or modifying environment configuration.
- Inspect variable names and structure without printing values.
- Reuse existing configured credentials and connection methods.
- Never overwrite an existing environment file.
- Never generate a competing environment file.
- Never replace existing database URLs with guessed values.
- Never expose secrets in logs, reports, documentation, or commits.

### 6. Repository Hygiene

- Preserve owner modifications, untracked files, and stashes.
- Never run destructive Git cleanup without explicit authorization.
- Do not commit `.env.local`, secret-bearing environment files, private keys, credentials, or generated secret-bearing logs.
- Before committing, review all staged files and confirm no secrets have been introduced.
- Do not include unrelated owner changes in commits.

### 7. No Unrelated Feature Work

- Do not begin unrelated feature implementation.
- Work incrementally and keep changes scoped.
- Follow the mandatory three-attempt stop rule: if the same error persists through three consecutive attempts, stop immediately and report.

### 8. Evidence Standard

- Do not claim success without actual command exit codes and evidence.
- Record actual exit codes and results for all commands.
- Associate test results with a Git commit hash.

## Documentation Hierarchy

1. **`AGENTS.md`** — mandatory agent rules and session startup (this file).
2. **`docs/DEVELOPMENT-OPERATIONS.md`** — verified operational procedures.
3. Existing module-specific documentation — business and implementation rules.
4. Actual source code, schemas, migrations, and tests — implementation evidence.

If documentation conflicts with actual configuration or code, do not guess. Report the discrepancy and resolve it safely.

## Platform Notes

This repository relies on `AGENTS.md` and `docs/DEVELOPMENT-OPERATIONS.md` for persistent agent instruction. The coding-agent platform may or may not support repository-level instructions, session-start hooks, or preflight scripts. Agents must read both files at the start of every session regardless of platform support.
