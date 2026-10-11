import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';

const auth = vi.hoisted(() => ({
  requireSession: vi.fn(),
  can: vi.fn(),
}));
const bankReads = vi.hoisted(() => ({ listPartnerBankMetadata: vi.fn() }));
const partnerReads = vi.hoisted(() => ({ getBusinessPartner: vi.fn(), listBusinessPartners: vi.fn() }));
const db = vi.hoisted(() => ({ withTenant: vi.fn() }));

vi.mock('@/platform/auth/current', () => ({
  requireSession: auth.requireSession,
  can: auth.can,
}));
vi.mock('../src/modules/foundation/partner-bank-reads', () => ({
  listPartnerBankMetadata: bankReads.listPartnerBankMetadata,
}));
vi.mock('@/modules/foundation/business-partners', () => ({
  getBusinessPartner: partnerReads.getBusinessPartner,
  listBusinessPartners: partnerReads.listBusinessPartners,
}));
vi.mock('@/platform/db/client', () => ({ withTenant: db.withTenant }));

import PartnersPage from '../src/app/foundation/partners/page';
import { PartnerBankMetadataPanel } from '../src/app/foundation/partners/PartnerBankMetadataPanel';

function containsElementType(node: unknown, type: unknown): boolean {
  if (Array.isArray(node)) return node.some((child) => containsElementType(child, type));
  if (!isValidElement(node)) return false;
  if (node.type === type) return true;
  return containsElementType(
    (node as ReactElement<{ children?: unknown }>).props.children,
    type,
  );
}

function setupAuthorizedPartnerPage() {
  const session = {
    user: {
      client: 'T123',
      userId: '00000000-0000-4000-8000-000000000123',
      username: 'synthetic.reader',
      fullName: 'Synthetic Reader',
      email: null,
      mustChangePassword: false,
      capabilities: ['FND.PARTNER.DISPLAY'],
    },
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    renewed: false,
  };
  auth.requireSession.mockResolvedValue(session);
  auth.can.mockImplementation((_session: unknown, authority: string) => authority === 'FND.PARTNER.DISPLAY');
  partnerReads.getBusinessPartner.mockResolvedValue({
    general: {
      client: 'T123',
      partnerNumber: 'BP.100',
      category: 'ORGANIZATION',
      name: 'Synthetic Partner',
      name2: null,
      searchTerm: null,
      country: 'KW',
      region: null,
      street: null,
      city: 'Synthetic City',
      postalCode: null,
      taxNumber: null,
      email: null,
      phone: null,
      generalStatus: 'CREATED',
      isBlocked: false,
      version: 1,
    },
    roles: [],
  });
  db.withTenant.mockImplementation(async (_client: string, callback: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: () => ({
        from: () => ({ orderBy: () => Promise.resolve([]) }),
      }),
    };
    return callback(tx);
  });
  bankReads.listPartnerBankMetadata.mockResolvedValue([]);
  return session;
}

describe('partner display route authorization and bank panel integration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies missing FND.PARTNER.DISPLAY before reading search parameters or partner data', async () => {
    const session = { user: { client: '0100' } };
    auth.requireSession.mockResolvedValue(session);
    auth.can.mockReturnValue(false);

    const then = vi.fn(() => {
      throw new Error('Route proceeded to partner query parameters before authorization.');
    });
    const searchParams = { then } as unknown as Promise<Record<string, string>>;

    const page = await PartnersPage({ searchParams });

    expect(auth.requireSession).toHaveBeenCalledWith('/foundation/partners');
    expect(auth.can).toHaveBeenCalledWith(session, 'FND.PARTNER.DISPLAY');
    expect(bankReads.listPartnerBankMetadata).not.toHaveBeenCalled();
    expect(then).not.toHaveBeenCalled();
    expect(page).toMatchObject({ type: 'div' });
    expect(page.props.children.props.children).toContain('FND.PARTNER.DISPLAY');
  });

  it('loads the bank metadata panel only for the explicit bank view, with the session and matched partner', async () => {
    const session = setupAuthorizedPartnerPage();

    const bankPage = await PartnersPage({
      searchParams: Promise.resolve({ partner: 'BP.100', view: 'BANKS' }),
    });

    expect(bankReads.listPartnerBankMetadata).toHaveBeenCalledTimes(1);
    expect(bankReads.listPartnerBankMetadata).toHaveBeenCalledWith(session, 'BP.100');
    expect(containsElementType(bankPage, PartnerBankMetadataPanel)).toBe(true);

    vi.clearAllMocks();
    setupAuthorizedPartnerPage();
    const generalPage = await PartnersPage({
      searchParams: Promise.resolve({ partner: 'BP.100' }),
    });

    expect(bankReads.listPartnerBankMetadata).not.toHaveBeenCalled();
    expect(containsElementType(generalPage, PartnerBankMetadataPanel)).toBe(false);
  });
});
