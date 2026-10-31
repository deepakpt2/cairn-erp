import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const actionsPath = 'src/app/platform/roles/actions.ts';
const managerPath = 'src/app/platform/roles/RoleManager.tsx';
const actionsText = readFileSync(actionsPath, 'utf8');
const managerText = readFileSync(managerPath, 'utf8');
const actions = ts.createSourceFile(actionsPath, actionsText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function isErasedTypeExport(statement: ts.Statement): boolean {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true;
  if (!ts.isExportDeclaration(statement)) return false;
  if (statement.isTypeOnly) return true;
  const clause = statement.exportClause;
  return clause !== undefined
    && ts.isNamedExports(clause)
    && clause.elements.length > 0
    && clause.elements.every((element) => element.isTypeOnly);
}

describe('role server-action export contract', () => {
  it('keeps runtime exports of a use-server module limited to async functions', () => {
    expect(actions.statements.some((statement) =>
      ts.isExpressionStatement(statement)
      && ts.isStringLiteral(statement.expression)
      && statement.expression.text === 'use server',
    )).toBe(true);

    const invalidRuntimeExports = actions.statements.filter((statement) => {
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return false;
      if (isErasedTypeExport(statement)) return false;
      return !(ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.AsyncKeyword));
    });

    expect(invalidRuntimeExports.map((statement) => statement.getText(actions))).toEqual([]);
    expect(actionsText).not.toContain('EMPTY_ROLE_ADMIN_STATE');
  });

  it('keeps the role UI initial action state local to the client component', () => {
    expect(managerText).toContain("'use client'");
    expect(managerText).toContain('const EMPTY: RoleAdminActionState = { ok: false }');
    expect(managerText).not.toContain('EMPTY_ROLE_ADMIN_STATE');
  });
});
