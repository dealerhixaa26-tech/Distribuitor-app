'use client';

import { useQueryClient } from '@tanstack/react-query';
import { LogOut, ShieldCheck, User as UserIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';
import { Button } from '@/components/ui/button';
import { cn, initials } from '@/lib/utils';

export function UserMenu() {
  const { user, isLoading, scopeType } = usePermission();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  if (isLoading) {
    return <div className="size-8 animate-pulse rounded-full bg-muted" aria-hidden="true" />;
  }
  if (!user) return null;

  const name = `${user.firstName} ${user.lastName}`.trim();

  const signOut = async () => {
    setSigningOut(true);
    try {
      await api.post('/auth/logout');
    } catch {
      // The BFF clears cookies regardless; navigating away is still correct.
    }
    // Purge every cached query — leaving one user's data in the cache for the
    // next person to sign in on this browser would be a real leak.
    queryClient.clear();
    router.replace('/login');
    router.refresh();
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md p-1 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {initials(name || user.email)}
        </span>
        <span className="hidden text-left sm:block">
          <span className="block text-xs font-medium leading-tight">{name}</span>
          <span className="block text-[10px] leading-tight text-muted-foreground">
            {user.roles[0]?.name ?? 'No role'}
          </span>
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-60 rounded-md border border-border bg-popover p-1 shadow-lg"
        >
          <div className="border-b border-border px-3 py-2">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            <p className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <ShieldCheck className="size-3" aria-hidden="true" />
              {user.roles.map((role) => role.name).join(', ') || 'No role'} · {scopeType}
            </p>
          </div>

          <a
            href="/settings/profile"
            role="menuitem"
            className="flex items-center gap-2 rounded px-3 py-1.5 text-sm hover:bg-accent"
          >
            <UserIcon className="size-4" aria-hidden="true" />
            Your profile
          </a>

          <Button
            variant="ghost"
            role="menuitem"
            onClick={signOut}
            loading={signingOut}
            className={cn('w-full justify-start gap-2 px-3 text-sm font-normal text-destructive')}
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </Button>
        </div>
      ) : null}
    </div>
  );
}
