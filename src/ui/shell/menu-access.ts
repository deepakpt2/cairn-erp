import { hasCapability } from '@/platform/auth/session';
import { EXPLICIT_GRANT_ONLY_CAPABILITIES } from '@/platform/auth/capability-policy';
import { SCREENS } from './screen-catalog';
import { visibleScreenIds } from './screen-access';

/**
 * The screens the menu lists for a reader: what the related strip would offer, less the screens that insist on an
 * exact grant the reader does not hold.
 *
 * `visibleScreenIds` offers every reading screen to everyone, because opening a screen asks only for a session. That
 * is fair for a strip beside the page you are on. For a menu it would list the cost and value reports to readers who
 * will certainly be refused, so the menu is stricter. Stricter is always safe here: it can only show less. The page
 * still enforces its own authority either way, and nothing in this file grants anything.
 */
export function menuScreenIds(capabilities: readonly string[]): ReadonlySet<string> {
  const offered = visibleScreenIds(capabilities);
  const held = [...capabilities];
  const out = new Set<string>();
  for (const screen of SCREENS) {
    if (!offered.has(screen.id)) continue;
    if (screen.code !== '' && EXPLICIT_GRANT_ONLY_CAPABILITIES.has(screen.code) && !hasCapability(held, screen.code)) continue;
    out.add(screen.id);
  }
  return out;
}
