'use client';

import type { UserSummary } from '@hixaa/contracts';
import { PERMISSIONS } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { UserPlus, Users as UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';
import { formatRelative, initials } from '@/lib/utils';

interface UsersResponse {
  data: UserSummary[];
  meta: { cursor: { next: string | null; hasMore: boolean }; totalCount?: number };
}

const columns: ColumnDef<UserSummary, unknown>[] = [
  {
    id: 'user',
    header: 'User',
    cell: ({ row }) => {
      const user = row.original;
      const name = `${user.firstName} ${user.lastName}`.trim();
      return (
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
            {initials(name || user.email)}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{name || '—'}</div>
            <div className="truncate text-xs text-muted-foreground">{user.email}</div>
          </div>
        </div>
      );
    },
  },
  {
    id: 'roles',
    header: 'Roles',
    cell: ({ row }) => (
      <div className="flex flex-wrap gap-1">
        {row.original.roles.length ? (
          row.original.roles.map((role) => (
            <span
              key={role.id}
              className="rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
              title={`${role.scopeType}${role.scopeId ? `:${role.scopeId}` : ''}`}
            >
              {role.roleName}
            </span>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">None</span>
        )}
      </div>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    id: 'security',
    header: 'Security',
    cell: ({ row }) => (
      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        <span>{row.original.emailVerified ? 'Email verified' : 'Unverified'}</span>
        <span>{row.original.mfaEnabled ? 'MFA on' : 'MFA off'}</span>
      </div>
    ),
  },
  {
    id: 'lastLoginAt',
    header: 'Last seen',
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.lastLoginAt ? formatRelative(row.original.lastLoginAt) : 'Never'}
      </span>
    ),
  },
];

export default function UsersPage() {
  const { can } = usePermission();
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<string[]>([]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['users', { search, cursor }],
    queryFn: () =>
      api.get<UsersResponse>('/users', {
        query: { q: search || undefined, cursor, limit: 25, includeTotal: true },
      }),
  });

  return (
    <>
      <PageHeader
        title="Users"
        description="People with access to the Hixaa DMS, and the roles that define what they can do."
        actions={
          can(PERMISSIONS.USER_CREATE) ? (
            <Button>
              <UserPlus aria-hidden="true" />
              Invite user
            </Button>
          ) : null
        }
      />

      <div className="mb-3 flex gap-2">
        <Input
          placeholder="Search by name or email…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            // Filters must reset pagination — otherwise a cursor from the old
            // result set silently skips rows in the new one.
            setCursor(undefined);
            setHistory([]);
          }}
          className="max-w-xs"
          aria-label="Search users"
        />
      </div>

      <DataTable
        columns={columns}
        data={data?.data ?? []}
        loading={isLoading}
        error={
          error
            ? {
                message:
                  error instanceof ApiError ? error.problem.detail : 'Something went wrong.',
                onRetry: () => void refetch(),
              }
            : null
        }
        cursor={data?.meta.cursor}
        totalCount={data?.meta.totalCount}
        canGoBack={history.length > 0}
        onNextPage={() => {
          if (!data?.meta.cursor.next) return;
          setHistory((previous) => [...previous, cursor ?? '']);
          setCursor(data.meta.cursor.next);
        }}
        onPreviousPage={() => {
          setHistory((previous) => {
            const next = [...previous];
            setCursor(next.pop() || undefined);
            return next;
          });
        }}
        caption="Users"
        emptyState={
          <EmptyState
            icon={UsersIcon}
            title={search ? 'No matching users' : 'No users yet'}
            description={
              search
                ? 'Try a different name or email address.'
                : 'Invite your first colleague to get started.'
            }
          />
        }
      />
    </>
  );
}
