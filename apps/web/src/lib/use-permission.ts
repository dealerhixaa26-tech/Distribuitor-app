'use client';

import { useQuery } from '@tanstack/react-query';
import type { CurrentUser, Permission } from '@hixaa/contracts';
import { api } from './api-client';
import { queryKeys } from './query-client';

// The shape comes from @hixaa/contracts — the same schema the API validates
// its response against. Redeclaring it here would let the two drift, which is
// precisely what ADR-0001 exists to prevent.

/**
 * Permission-aware rendering.
 *
 * This is PRESENTATION, not security. Every check here is independently
 * enforced server-side by a route guard and by the repository-level scope
 * filter. The rule we hold to: if the button were visible, clicking it would
 * still be rejected by the API. See docs/04-rbac-and-permissions.md §5.
 */
export function usePermission() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.auth.me(),
    queryFn: () => api.get<CurrentUser>('/auth/me'),
    // Effective permissions change rarely; refetching them on every navigation
    // would be a request per page view for data that is nearly static.
    staleTime: 5 * 60_000,
    retry: false,
  });

  const granted = new Set(data?.access?.permissions ?? []);

  return {
    user: data,
    isLoading,

    can: (permission: Permission): boolean => granted.has(permission),
    canAny: (permissions: readonly Permission[]): boolean =>
      permissions.some((permission) => granted.has(permission)),
    canAll: (permissions: readonly Permission[]): boolean =>
      permissions.every((permission) => granted.has(permission)),

    scopeType: data?.access?.scopeType ?? 'GLOBAL',
    territoryIds: data?.access?.territoryIds ?? [],
    distributorIds: data?.access?.distributorIds ?? [],
  };
}
