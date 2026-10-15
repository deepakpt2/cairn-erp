import { GlAccountModeScreen } from '../GlAccountModeScreen';

export const dynamic = 'force-dynamic';

/** FSP0 — Change mode. The account number and the Chart of Accounts are both immutable here. */
export default async function EditGlAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ chart?: string; account?: string }>;
}) {
  return <GlAccountModeScreen mode="CHANGE" searchParams={searchParams} />;
}
