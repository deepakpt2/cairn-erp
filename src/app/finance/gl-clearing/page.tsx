
import { can, requireSession } from '@/platform/auth/current';
import {
  GL_CLEARING_CAPABILITY, GlClearingError, getGlClearing, type GlClearingView,
} from '@/modules/finance/gl-clearing';
import GlClearing from './GlClearing';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/gl-clearing';

/**
 * Clear G/L account (SCR-114 / F-03 as a search alias only).
 */
export default async function GlClearingPage({ searchParams }: {
  searchParams: Promise<{ companyCode?: string; glAccount?: string; documentNumber?: string; assignment?: string; reference?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  let view: GlClearingView | null = null;
  let loadError: string | null = null;
  if (params.companyCode && params.glAccount) {
    try {
      view = await getGlClearing({
        client, companyCode: params.companyCode, glAccount: params.glAccount.toUpperCase(),
        filters: {
          documentNumber: params.documentNumber || undefined,
          assignment: params.assignment || undefined,
          reference: params.reference || undefined,
        },
      });
    } catch (error) {
      if (error instanceof GlClearingError) loadError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
      else throw error;
    }
  }
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title="Clear G/L Account" code="FIN.GL.CLEAR · F-03"
      description="Clear open items of an open-item-managed G/L account against each other — in full, partially (the item stays open for its balance), or residually (the item closes and its remainder re-stands as a new open item). The difference must stand at zero, or within the tolerance of the default group, before posting; cross-currency clearing translates at the clearing date and posts the realized exchange difference."
    >

      <GlClearing
        view={view}
        loadError={loadError}
        canClear={can(session, GL_CLEARING_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
