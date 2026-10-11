import { describe, expect, it } from 'vitest';
import { changeHistory, recordChange } from '../src/platform/change';
import type { Tx } from '../src/platform/db/client';
import {
  MASKED_HISTORY_VALUE,
  PARTNER_BANK_OBJECT_CLASS,
  PARTNER_CONTACT_OBJECT_CLASS,
} from '../src/platform/change/partner-data-history';

type Write = { table: unknown; values: unknown };

function captureTx() {
  const writes: Write[] = [];
  const tx = {
    insert(table: unknown) {
      return {
        values: async (values: unknown) => {
          writes.push({ table, values });
          return undefined;
        },
      };
    },
  } as unknown as Tx;
  return { tx, writes };
}

function insertedItems(writes: Write[]): Array<Record<string, unknown>> {
  const write = writes.find((entry) => Array.isArray(entry.values));
  return (write?.values as Array<Record<string, unknown>> | undefined) ?? [];
}

describe('partner bank/contact change-history privacy projection', () => {
  it('masks bank account identifiers before generic recordChange and omits unknown fields', async () => {
    const { tx, writes } = captureTx();
    const accountValue = 'TEST-ACCOUNT-SECRET-01';
    const ibanValue = 'TEST-IBAN-SECRET-02';
    const ciphertextValue = 'TEST-CIPHERTEXT-03';

    await recordChange(tx, {
      client: 'T999',
      objectClass: PARTNER_BANK_OBJECT_CLASS,
      objectKey: 'TEST-BANK-ROW',
      changeType: 'CREATE',
      changedBy: 'TEST-USER',
      reason: `Do not log ${accountValue}`,
      fieldLabels: { iban: `Sensitive label ${ibanValue}` },
      after: {
        accountHolder: 'Test Account Holder',
        country: 'GB',
        bankName: 'Synthetic Bank',
        bankCode: 'TEST-CODE',
        iban: ibanValue,
        localAccountNumber: accountValue,
        ibanCiphertext: ciphertextValue,
        privateNote: accountValue,
        validFrom: '2026-01-01',
        isActive: true,
      },
    });

    const document = writes[0].values as Record<string, unknown>;
    const items = insertedItems(writes);
    const byField = Object.fromEntries(items.map((item) => [item.fieldName, item]));
    expect(document.reason).toBeUndefined();
    expect(byField.iban?.newValue).toBe(MASKED_HISTORY_VALUE);
    expect(byField.localAccountNumber?.newValue).toBe(MASKED_HISTORY_VALUE);
    expect(byField.ibanCiphertext?.newValue).toBe(MASKED_HISTORY_VALUE);
    expect(byField.bankName?.newValue).toBe('Synthetic Bank');
    expect(byField.privateNote).toBeUndefined();
    expect(byField.iban?.fieldLabel).toBe('Iban');
    expect(JSON.stringify(writes.map((write) => write.values))).not.toContain(accountValue);
    expect(JSON.stringify(writes.map((write) => write.values))).not.toContain(ibanValue);
    expect(JSON.stringify(writes.map((write) => write.values))).not.toContain(ciphertextValue);
  });

  it('masks old and new personal contact coordinates in changes', async () => {
    const { tx, writes } = captureTx();
    const oldEmail = 'old.private@example.test';
    const newEmail = 'new.private@example.test';
    const oldPhone = 'TEST-PHONE-OLD';
    const newPhone = 'TEST-PHONE-NEW';

    await recordChange(tx, {
      client: 'T999',
      objectClass: PARTNER_CONTACT_OBJECT_CLASS,
      objectKey: 'TEST-CONTACT-ROW',
      changeType: 'CHANGE',
      changedBy: 'TEST-USER',
      reason: `Do not retain ${newEmail}`,
      fieldLabels: { email: `Sensitive contact ${newEmail}` },
      before: { name: 'Old Contact', email: oldEmail, phone: oldPhone, privateNote: oldEmail },
      after: { name: 'New Contact', email: newEmail, phone: newPhone, privateNote: newEmail },
    });

    const document = writes[0].values as Record<string, unknown>;
    const items = insertedItems(writes);
    const byField = Object.fromEntries(items.map((item) => [item.fieldName, item]));
    expect(document.reason).toBeUndefined();
    expect(byField.email?.oldValue).toBe(MASKED_HISTORY_VALUE);
    expect(byField.email?.newValue).toBe(MASKED_HISTORY_VALUE);
    expect(byField.phone?.oldValue).toBe(MASKED_HISTORY_VALUE);
    expect(byField.phone?.newValue).toBe(MASKED_HISTORY_VALUE);
    expect(byField.privateNote).toBeUndefined();
    expect(JSON.stringify(writes.map((write) => write.values))).not.toContain(oldEmail);
    expect(JSON.stringify(writes.map((write) => write.values))).not.toContain(newEmail);
    expect(JSON.stringify(writes.map((write) => write.values))).not.toContain(oldPhone);
    expect(JSON.stringify(writes.map((write) => write.values))).not.toContain(newPhone);
  });

  it('keeps unchanged sensitive values a silent no-op', async () => {
    const { tx, writes } = captureTx();
    const unchangedAccount = 'TEST-ACCOUNT-UNCHANGED';

    const changeId = await recordChange(tx, {
      client: 'T999',
      objectClass: PARTNER_BANK_OBJECT_CLASS,
      objectKey: 'TEST-BANK-ROW',
      changeType: 'CHANGE',
      changedBy: 'TEST-USER',
      before: { iban: unchangedAccount, bankName: 'Synthetic Bank' },
      after: { iban: unchangedAccount, bankName: 'Synthetic Bank' },
    });

    expect(changeId).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it('redacts existing stored sensitive items again when reading history', async () => {
    const emailValue = 'read.private@example.test';
    const accountValue = 'TEST-LEGACY-ACCOUNT';
    const doc = {
      id: 'TEST-CHANGE-DOC',
      client: 'T999',
      objectClass: PARTNER_BANK_OBJECT_CLASS,
      objectKey: 'TEST-BANK-ROW',
      changeType: 'CHANGE',
      reason: `legacy reason ${accountValue}`,
      changedBy: 'TEST-USER',
      changedAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    const storedItems = [
      {
        id: 'TEST-ITEM-1',
        fieldName: 'iban',
        fieldLabel: `Leaked label ${accountValue}`,
        oldValue: accountValue,
        newValue: 'TEST-NEW-ACCOUNT',
      },
      {
        id: 'TEST-ITEM-2',
        fieldName: 'privateNote',
        fieldLabel: 'Private note',
        oldValue: emailValue,
        newValue: emailValue,
      },
    ];
    const tx = {
      query: {
        changeDocument: { findMany: async () => [doc] },
        changeDocumentItem: { findMany: async () => storedItems },
      },
    } as unknown as Tx;

    const history = await changeHistory(tx, 'T999', PARTNER_BANK_OBJECT_CLASS, 'TEST-BANK-ROW');
    const result = history[0] as unknown as { reason?: string; items: Array<Record<string, unknown>> };

    expect(result.reason).toBeUndefined();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].fieldLabel).toBe('Iban');
    expect(result.items[0].oldValue).toBe(MASKED_HISTORY_VALUE);
    expect(result.items[0].newValue).toBe(MASKED_HISTORY_VALUE);
    expect(JSON.stringify(history)).not.toContain(accountValue);
    expect(JSON.stringify(history)).not.toContain(emailValue);
  });

  it('leaves organisation-level business-partner email and phone history unchanged', async () => {
    const { tx, writes } = captureTx();

    await recordChange(tx, {
      client: 'T999',
      objectClass: 'business_partner',
      objectKey: 'TEST-PARTNER',
      changeType: 'CREATE',
      changedBy: 'TEST-USER',
      after: { email: 'office@example.test', phone: 'TEST-OFFICE-PHONE' },
    });

    const byField = Object.fromEntries(insertedItems(writes).map((item) => [item.fieldName, item.newValue]));
    expect(byField.email).toBe('office@example.test');
    expect(byField.phone).toBe('TEST-OFFICE-PHONE');
  });
});
