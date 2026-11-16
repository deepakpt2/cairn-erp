/**
 * Navigation Stage 3 is behind a flag so the existing shell is untouched until it is switched on.
 *
 * Set `CAIRN_NAVIGATION=sidebar` in the app's environment to turn on the sidebar, the module pages under
 * `/menu` and the linked menu path. Anything else — including unset — leaves the shell exactly as it was.
 */
export function sidebarNavigationEnabled(): boolean {
  return process.env.CAIRN_NAVIGATION === 'sidebar';
}
