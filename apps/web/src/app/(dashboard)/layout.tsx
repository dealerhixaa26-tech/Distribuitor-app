'use client';

import * as React from 'react';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { cn } from '@/lib/utils';

/**
 * Authenticated application shell.
 *
 * Responsive behaviour follows docs/08-frontend-and-ux.md §3: the sidebar is
 * a persistent rail at lg and above, and an overlay sheet below it. Tablet is a
 * first-class target — a warehouse supervisor doing dispatch on an iPad is a
 * real user, not a hypothetical one.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // Escape closes the overlay — expected of any modal surface.
  React.useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <Topbar onToggleSidebar={() => setMobileOpen((open) => !open)} />

      <div className="flex min-h-0 flex-1">
        <div className="hidden lg:block">
          <Sidebar />
        </div>

        {mobileOpen ? (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/50 lg:hidden"
              onClick={() => setMobileOpen(false)}
              aria-hidden="true"
            />
            <div
              className={cn('fixed inset-y-0 left-0 z-50 pt-14 lg:hidden')}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
            >
              <Sidebar />
            </div>
          </>
        ) : null}

        <main
          id="main-content"
          className="scrollbar-thin min-w-0 flex-1 overflow-y-auto bg-background p-4 sm:p-6"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
