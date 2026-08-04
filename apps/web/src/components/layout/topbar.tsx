'use client';

import { Bell, Menu, Moon, Search, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import { UserMenu } from './user-menu';

export function Topbar({ onToggleSidebar }: { onToggleSidebar?: () => void }) {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleSidebar}
        aria-label="Toggle navigation"
        className="lg:hidden"
      >
        <Menu />
      </Button>

      <div className="flex items-center gap-2">
        <span className="text-base font-bold tracking-tight text-primary">HIXAA</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">DMS</span>
      </div>

      {/* Command palette trigger — the primary navigation for power users.
          Wired up in Phase 9 alongside global search. */}
      <button
        type="button"
        disabled
        className="ml-4 hidden min-h-8 flex-1 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-muted-foreground md:flex md:max-w-sm disabled:opacity-60"
        aria-label="Search (available in Phase 9)"
      >
        <Search className="size-3.5" aria-hidden="true" />
        <span>Search…</span>
        <kbd className="ml-auto rounded border border-border bg-muted px-1.5 font-mono text-[10px]">
          ⌘K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="icon" aria-label="Notifications" disabled>
          <Bell />
        </Button>

        {/*
          Both icons render; CSS picks one from the `dark` class that next-themes
          puts on <html> BEFORE hydration.

          The usual next-themes pattern — a `mounted` flag set in an effect — is
          a hydration workaround that React 19 rightly flags as setState-in-
          effect. Doing it in CSS needs no state, no effect, and cannot flash the
          wrong icon, because the class is already correct on first paint.
        */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle colour theme"
        >
          <Sun className="hidden dark:block" aria-hidden="true" />
          <Moon className="block dark:hidden" aria-hidden="true" />
        </Button>

        <div className="ml-1 border-l border-border pl-1">
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
