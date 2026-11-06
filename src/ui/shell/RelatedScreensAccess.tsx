import { getSession } from '@/platform/auth/current';
import { visibleScreenIds } from './screen-access';
import { RelatedScreens } from './RelatedScreens';

/**
 * The related-screens strip for the reader who is signed in.
 *
 * The strip is worked out from the path, which only the browser knows, so the
 * filtering happens there; what the server decides is *which screens exist for
 * this reader at all*. The authority list never leaves the server.
 */
export async function RelatedScreensAccess() {
  const session = await getSession();
  const visible = visibleScreenIds(session?.user.capabilities ?? []);
  return <RelatedScreens visibleScreenIds={[...visible]} />;
}
