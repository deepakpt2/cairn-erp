import { GlAccountModeScreen } from '../GlAccountModeScreen';

export const dynamic = 'force-dynamic';

/** FSS0 — Display mode. Read-only for anyone holding the display authority. */
export default async function ViewGlAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ chart?: string; account?: string }>;
}) {
  return <GlAccountModeScreen mode="DISPLAY" searchParams={searchParams} />;
}
