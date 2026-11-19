import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');

describe('employee and assignment screens carry the live session, never a capability list', () => {
  it('the employee actions and page use scoped services only', () => {
    const actions = read('src/app/people/employees/actions.ts');
    expect(actions).not.toMatch(/session\.user\.capabilities/);
    expect(actions).toMatch(/liveAccess\(session\)/);
    const page = read('src/app/people/employees/page.tsx');
    expect(page).toMatch(/searchEmployees\(client, query, access\)/);
    expect(page).toMatch(/viewEmployee\(client, personnelNumber, access\)/);
    expect(page).not.toMatch(/\blistEmployees\(|\bgetEmployee\(/); // the unscoped reads are for trusted in-process callers
  });

  it('the assignment actions and page use scoped services only', () => {
    const actions = read('src/app/people/assignments/actions.ts');
    expect(actions).not.toMatch(/session\.user\.capabilities/);
    expect(actions).toMatch(/authorization: \{ userId: session\.user\.userId/);
    const page = read('src/app/people/assignments/page.tsx');
    expect(page).toMatch(/listAssignments\(\{[^}]*\}, access\)/);
    expect(page).toMatch(/assignmentsOf\(client, employee, access\)/);
    expect(page).toMatch(/openAssignmentOf\(client, employee, access\)/);
  });

  it('hire decisions and user links go through the live session', () => {
    const actions = read('src/app/people/employees/actions.ts');
    expect(actions).toMatch(/decideHire\([\s\S]*?liveAccess\(session\)/);
    expect(actions).toMatch(/linkEmployeeUser\([\s\S]*?liveAccess\(session\)/);
  });

  it('a position tier is only written under the live session', () => {
    const actions = read('src/app/people/organization/actions.ts');
    expect(actions).toMatch(/tierOf\(formData\) === undefined \? access\.capabilities : \{ authorization/);
  });
});
