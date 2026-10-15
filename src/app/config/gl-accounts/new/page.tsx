import { GlAccountModeScreen } from '../GlAccountModeScreen';

export const dynamic = 'force-dynamic';

/** FS00 — Create mode. The chart and a proposed account number arrive from the initial screen. */
export default async function NewGlAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ chart?: string; account?: string }>;
}) {
  return <GlAccountModeScreen mode="CREATE" searchParams={searchParams} />;
}
