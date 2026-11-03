import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionContext } from '../src/platform/auth/session';
import { createSession, resolveSession } from '../src/platform/auth/session';
import { appUser, role, roleCapability, userRole } from '../src/platform/tables/security';
import { listCharacteristics } from '../src/modules/quality/inspection-results';
import { createTenant, destroyTenant, withTenant, closeDb, type TestTenant } from './helpers';

const authState = vi.hoisted(() => ({ session: null as SessionContext | null }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/platform/auth/current', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/auth/current')>();
  return {
    ...actual,
    requireSession: vi.fn(async () => {
      if (!authState.session) throw new Error('No quality-action session fixture was selected.');
      return authState.session;
    }),
  };
});

import {
  decideAction,
  recordResultAction,
  saveCharacteristicAction,
} from '@/app/quality/inspection/actions';

const INSPECTION_CAPABILITY = 'QM.INSPECTION.RECORD';
const DECISION_CAPABILITY = 'QM.USAGE.DECIDE';

let tenant: TestTenant;
let noAuthority: SessionContext;
let inspectionOnly: SessionContext;
let decisionOnly: SessionContext;

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeAll(async () => {
  tenant = await createTenant('quality-action-security');
  await withTenant(tenant.client, async (tx) => {
    const users = [
      { id: randomUUID(), username: 'qm.noauthority', fullName: 'QM No Authority' },
      { id: randomUUID(), username: 'qm.inspector', fullName: 'QM Inspector' },
      { id: randomUUID(), username: 'qm.decision', fullName: 'QM Decision User' },
    ];
    await tx.insert(appUser).values(users.map((user) => ({
      id: user.id,
      client: tenant.client,
      username: user.username,
      fullName: user.fullName,
      passwordHash: 'test-only-hash',
      isActive: true,
      isLocked: false,
      createdBy: 'QUALITY_ACTION_TEST',
    })));

    await tx.insert(role).values([
      {
        client: tenant.client,
        code: 'TEST_QM_INSPECTOR',
        name: 'Quality inspector test role',
        description: 'Disposable role for the inspection action authorization test',
        isSystemRole: false,
        isReadOnly: false,
        createdBy: 'QUALITY_ACTION_TEST',
      },
      {
        client: tenant.client,
        code: 'TEST_QM_DECIDER',
        name: 'Quality decision test role',
        description: 'Disposable role for the usage-decision action authorization test',
        isSystemRole: false,
        isReadOnly: false,
        createdBy: 'QUALITY_ACTION_TEST',
      },
    ]);
    await tx.insert(roleCapability).values([
      {
        client: tenant.client,
        roleCode: 'TEST_QM_INSPECTOR',
        capabilityCode: INSPECTION_CAPABILITY,
        createdBy: 'QUALITY_ACTION_TEST',
      },
      {
        client: tenant.client,
        roleCode: 'TEST_QM_DECIDER',
        capabilityCode: DECISION_CAPABILITY,
        createdBy: 'QUALITY_ACTION_TEST',
      },
    ]);
    await tx.insert(userRole).values([
      { client: tenant.client, userId: users[1]!.id, roleCode: 'TEST_QM_INSPECTOR', createdBy: 'QUALITY_ACTION_TEST' },
      { client: tenant.client, userId: users[2]!.id, roleCode: 'TEST_QM_DECIDER', createdBy: 'QUALITY_ACTION_TEST' },
    ]);

    const sessions = await Promise.all(users.map((user) => createSession(tx, {
      client: tenant.client,
      userId: user.id,
    })));
    const resolved = await Promise.all(sessions.map((session) => resolveSession(tx, {
      client: tenant.client,
      token: session.token,
    })));
    if (resolved.some((session) => session === null)) {
      throw new Error('A quality-action session fixture did not resolve from its persisted row.');
    }
    noAuthority = resolved[0]!;
    inspectionOnly = resolved[1]!;
    decisionOnly = resolved[2]!;
  });
});

afterAll(async () => {
  if (tenant?.client) await destroyTenant(tenant.client);
  await closeDb();
});

describe('quality inspection actions enforce database-resolved capabilities at runtime', () => {
  it('refuses result entry, characteristic maintenance, and usage decisions for a persisted user with no role', async () => {
    authState.session = noAuthority;
    const result = await recordResultAction({ ok: false }, form({
      lotNumber: 'QL-NOAUTH', characteristicCode: 'DIM-NOAUTH', resultValue: '10', resultStatus: 'RECORDED',
    }));
    const characteristic = await saveCharacteristicAction({ ok: false }, form({
      characteristicCode: 'NOAUTH', description: 'Must not be stored', characteristicType: 'QUALITATIVE',
    }));
    const decision = await decideAction({ ok: false }, form({ lotNumber: 'QL-NOAUTH', decisionCode: 'ACCEPT' }));

    expect(result).toMatchObject({ ok: false, remedy: expect.stringContaining(INSPECTION_CAPABILITY) });
    expect(characteristic).toMatchObject({ ok: false, remedy: expect.stringContaining(INSPECTION_CAPABILITY) });
    expect(decision).toMatchObject({ ok: false, remedy: expect.stringContaining(DECISION_CAPABILITY) });
    expect(await listCharacteristics(tenant.client)).not.toContainEqual(
      expect.objectContaining({ characteristicCode: 'NOAUTH' }),
    );
    const decisions = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as count from usage_decision where client = ${tenant.client}
    `)) as unknown as Array<{ count: number }>;
    expect(decisions[0]?.count).toBe(0);
  });

  it('allows only the capability held by the resolved inspector role', async () => {
    expect(inspectionOnly.user.capabilities).toContain(INSPECTION_CAPABILITY);
    expect(inspectionOnly.user.capabilities).not.toContain(DECISION_CAPABILITY);
    authState.session = inspectionOnly;

    const saved = await saveCharacteristicAction({ ok: false }, form({
      characteristicCode: 'AUTH01',
      description: 'Persisted authorized characteristic',
      characteristicType: 'QUALITATIVE',
    }));
    expect(saved).toMatchObject({ ok: true });
    expect(await listCharacteristics(tenant.client)).toContainEqual(
      expect.objectContaining({ characteristicCode: 'AUTH01' }),
    );

    const deniedDecision = await decideAction({ ok: false }, form({ lotNumber: 'QL-MISSING', decisionCode: 'ACCEPT' }));
    expect(deniedDecision).toMatchObject({ ok: false, remedy: expect.stringContaining(DECISION_CAPABILITY) });
  });

  it('allows the decision capability to reach the service, while refusing inspection-result maintenance', async () => {
    expect(decisionOnly.user.capabilities).toContain(DECISION_CAPABILITY);
    expect(decisionOnly.user.capabilities).not.toContain(INSPECTION_CAPABILITY);
    authState.session = decisionOnly;

    const deniedResult = await recordResultAction({ ok: false }, form({
      lotNumber: 'QL-MISSING', characteristicCode: 'AUTH01', resultValue: 'PASS', resultStatus: 'RECORDED',
    }));
    const allowedToService = await decideAction({ ok: false }, form({ lotNumber: 'QL-MISSING', decisionCode: 'ACCEPT' }));

    expect(deniedResult).toMatchObject({ ok: false, remedy: expect.stringContaining(INSPECTION_CAPABILITY) });
    expect(allowedToService).toMatchObject({ ok: false, message: expect.stringContaining('does not exist') });
    const decisions = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as count from usage_decision where client = ${tenant.client}
    `)) as unknown as Array<{ count: number }>;
    expect(decisions[0]?.count).toBe(0);
  });
});
