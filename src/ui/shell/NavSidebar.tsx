import { getSession } from '@/platform/auth/current';
import { SidebarMenu } from './SidebarMenu';
import { buildNavTree } from './nav-tree';
import { menuScreenIds } from './menu-access';
import { storageKey } from './nav-personal';

/**
 * The collapsible sidebar (navigation Stage 3).
 *
 * Decided on the server: the reader's capabilities never leave it. The browser receives only the labels and
 * addresses of the screens this reader may be offered, from the related strip's filter, narrowed by `menuScreenIds` for screens that insist on an exact grant. A screen
 * missing here is not forbidden and a screen shown here is not allowed — each page still enforces its own authority.
 */
export async function NavSidebar() {
  const session = await getSession();
  if (!session) return null;
  const tree = buildNavTree(menuScreenIds(session.user.capabilities));
  return <SidebarMenu tree={tree} storageKey={storageKey(session.user.client, session.user.userId)} />;
}
