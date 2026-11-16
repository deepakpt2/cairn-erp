'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { t } from '@/platform/i18n';
import { resolveMenuPath } from './menu-path';
import type { NavModuleNode } from './nav-tree';

/**
 * The sidebar: modules, expandable categories, the open screen marked.
 *
 * The module name opens that module's page; the +/- beside it opens or closes its categories. A category opens to
 * its screens. The module and category holding the page being read open themselves and stay marked. On a narrow
 * screen the menu sits behind a Menu button; the full drawer behaviour is a later stage.
 */
export function SidebarMenu({ tree }: { tree: NavModuleNode[] }) {
  const pathname = usePathname() || '/';
  const search = useSearchParams();
  const path = resolveMenuPath(pathname, new URLSearchParams(search.toString()));
  const activeScreen = path?.screen ?? null;
  const onModulePage = pathname.replace(/\/$/, '') === '/menu';
  const activeModule = onModulePage ? search.get('module') : activeScreen?.nav?.module ?? null;
  const activeCategory = activeScreen?.nav?.category ?? null;

  const [openModules, setOpenModules] = useState<Set<string>>(new Set());
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());
  const [mobileOpen, setMobileOpen] = useState(false);

  // Follow the page: whatever holds it is open, and what the reader opened stays open.
  useEffect(() => {
    if (activeModule) setOpenModules((prev) => new Set(prev).add(activeModule));
    if (activeModule && activeCategory) setOpenCategories((prev) => new Set(prev).add(`${activeModule}|${activeCategory}`));
    setMobileOpen(false);
  }, [activeModule, activeCategory, pathname]);

  const flip = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  };

  return (
    <aside className="border-line bg-sunken md:w-64 md:shrink-0 md:border-e" data-testid="sidebar">
      <button
        type="button"
        className="btn btn-default m-2 min-h-11 md:hidden"
        aria-expanded={mobileOpen}
        aria-controls="sidebar-menu"
        onClick={() => setMobileOpen((open) => !open)}
      >
        {t('nav.sidebarToggle')}
      </button>
      <nav
        id="sidebar-menu"
        aria-label={t('nav.sidebar')}
        className={`${mobileOpen ? 'block' : 'hidden'} px-1 pb-3 md:sticky md:top-12 md:block md:max-h-[calc(100vh-6rem)] md:overflow-y-auto`}
      >
        <ul className="text-sm">
          {tree.map((module) => {
            const moduleOpen = openModules.has(module.id);
            const moduleActive = module.id === activeModule;
            return (
              <li key={module.id} className="border-b border-line/60 last:border-b-0">
                <div className="flex items-stretch">
                  <Link
                    href={module.href}
                    aria-current={onModulePage && moduleActive || (module.id === 'dashboard' && pathname === '/') ? 'page' : undefined}
                    className={`flex min-h-10 min-w-0 flex-1 items-center px-2 hover:bg-paper ${moduleActive ? 'font-semibold text-ink' : 'text-ink-soft'}`}
                  >
                    <span className="truncate">{module.label}</span>
                  </Link>
                  {module.categories.length > 0 && (
                    <button
                      type="button"
                      className="flex min-h-10 w-10 items-center justify-center text-ink-soft hover:bg-paper"
                      aria-expanded={moduleOpen}
                      aria-label={t('nav.sidebarExpand', { name: module.label })}
                      onClick={() => setOpenModules((prev) => flip(prev, module.id))}
                    >
                      <span aria-hidden>{moduleOpen ? '−' : '+'}</span>
                    </button>
                  )}
                </div>
                {moduleOpen && (
                  <ul className="pb-1">
                    {module.categories.map((category) => {
                      const key = `${module.id}|${category.name}`;
                      const categoryOpen = openCategories.has(key);
                      return (
                        <li key={key}>
                          <button
                            type="button"
                            className={`flex min-h-9 w-full items-center justify-between gap-2 ps-5 pe-2 text-start hover:bg-paper ${moduleActive && category.name === activeCategory ? 'font-medium text-ink' : 'text-ink-soft'}`}
                            aria-expanded={categoryOpen}
                            onClick={() => setOpenCategories((prev) => flip(prev, key))}
                          >
                            <span className="truncate">{category.name}</span>
                            <span className="tabular text-2xs text-ink-faint">{category.count}</span>
                          </button>
                          {categoryOpen && (
                            <ul className="pb-1">
                              {category.activities.flatMap((activity) => activity.items).map((leaf) => (
                                <li key={`${key}|${leaf.id}`}>
                                  <Link
                                    href={leaf.href}
                                    aria-current={activeScreen?.id === leaf.id ? 'page' : undefined}
                                    className={`block min-h-8 truncate py-1.5 ps-9 pe-2 hover:bg-paper ${activeScreen?.id === leaf.id ? 'border-s-2 border-accent bg-accent-soft/40 font-medium text-ink' : 'text-ink-soft'}`}
                                  >
                                    {leaf.title}
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
