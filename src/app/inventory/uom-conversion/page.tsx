import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  UOM_CAPABILITY,
  listUnitsOfMeasure,
  listUomConversions,
  type UomConversionRow,
} from '@/modules/inventory/unit-conversion';
import UomShell from './UomShell';
import { Page } from '@/ui/kit';

const UOM_ROUTE = '/inventory/uom-conversion';

export const dynamic = 'force-dynamic';

/**
 * SCR-144 / INV.STOCK.UOM — alternative units per material.
 *
 * A material posts in its base unit. Every other unit it accepts is a row here stating the
 * exact ratio, so a quantity entered as boxes becomes pieces at twelve to one rather than
 * being taken at face value. Without a row here, a posting in that unit is refused by name —
 * which is the point: silence would be a wrong stock figure nobody can see.
 */
export default async function UomConversionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(UOM_ROUTE);
  const params = await searchParams;
  const material = (typeof params.material === 'string' ? params.material : '').trim().toUpperCase();

  let rows: UomConversionRow[] = [];
  let listError: string | null = null;
  let units: Array<{ code: string; name: string }> = [];
  try {
    [rows, units] = await Promise.all([
      listUomConversions(session.user.client, material ? { materialNumber: material } : {}),
      listUnitsOfMeasure(session.user.client),
    ]);
  } catch {
    listError = 'The conversion table could not be read.';
  }

  return (
    <Page
      title={t('uom.title')} code="INV.STOCK.UOM · CUNI" width="100rem" back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('uom.subtitle')}</p>
        </>
      }
    >

      {listError && (
        <p role="alert" className="border border-signal-error/40 bg-signal-error-soft p-3 text-sm text-signal-error">{listError}</p>
      )}

      <UomShell canMaintain={can(session, UOM_CAPABILITY)} rows={rows} units={units} />
    </Page>
  );
}
