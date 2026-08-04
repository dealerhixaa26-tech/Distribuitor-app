import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api-client';

/**
 * TanStack Query owns all server state — there is no global store of business
 * entities, because server data kept in a client store is stale data, and stale
 * data in an ERP shows a user an order status that changed ten minutes ago.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Long enough to make navigation feel instant, short enough that a
        // colleague's change surfaces quickly.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          // Retrying a 403 or a 422 just repeats the same failure and delays
          // the error the user needs to see.
          if (error instanceof ApiError && !error.isRetryable) return false;
          return failureCount < 2;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
      mutations: {
        // Mutations are never retried automatically. A retried POST could
        // create a second order; that safety belongs to explicit idempotency
        // keys, not to a blanket retry policy.
        retry: false,
      },
    },
  });
}

/**
 * Structured query keys.
 *
 * Declared centrally so invalidation can be precise. `invalidateQueries()` with
 * no key refetches the entire application and is never the right answer.
 */
export const queryKeys = {
  auth: {
    me: () => ['auth', 'me'] as const,
    sessions: () => ['auth', 'sessions'] as const,
  },
  health: () => ['health'] as const,
  settings: (category: string) => ['settings', category] as const,
} as const;
