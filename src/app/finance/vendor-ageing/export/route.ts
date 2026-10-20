import { can, requireSession } from '@/platform/auth/current';
import {
  VENDOR_AGEING_CAPABILITY, VendorAgeingError, getVendorAgeing, vendorAgeingCsv,
} from '@/modules/finance/vendor-ageing';

const ROUTE = '/finance/vendor-ageing';

/**
 * CSV export of the standing vendor ageing selection (SCR-120):
 * read-only, the same derivation the screen shows, per company code.
 */
export async function GET(request: Request) {
  const session = await requireSession(ROUTE);
  if (!can(session, VENDOR_AGEING_CAPABILITY)) {
    return new Response('You do not hold the vendor ageing capability.', { status: 403 });
  }
  const params = new URL(request.url).searchParams;
  const companyCode = (params.get('companyCode') ?? params.get('companyFrom') ?? '').toUpperCase();
  if (!companyCode) return new Response('Company code is required.', { status: 400 });
  const keyDate = params.get('keyDate') || new Date().toISOString().slice(0, 10);
  try {
    const view = await getVendorAgeing(session.user.client, {
      companyCode,
      keyDate,
      supplierFrom: params.get('supplierFrom')?.toUpperCase() || undefined,
      supplierTo: params.get('supplierTo')?.toUpperCase() || undefined,
      thresholds: [
        Number(params.get('bucket1') ?? 30),
        Number(params.get('bucket2') ?? 60),
        Number(params.get('bucket3') ?? 90),
      ],
      includeSpecialGl: params.get('includeSpecialGl') === 'on',
    });
    return new Response(vendorAgeingCsv(view), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="vendor-ageing-${companyCode}-${keyDate}.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof VendorAgeingError) {
      return new Response(error.remedy ? `${error.message} ${error.remedy}` : error.message, { status: 400 });
    }
    throw error;
  }
}
