'use client';

import type { AuditLogEntry } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ScrollText } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { formatDateTime, formatRelative } from '@/lib/utils';

interface AuditResponse {
  data: AuditLogEntry[];
  meta: { cursor: { next: string | null; hasMore: boolean }; totalCount?: number };
}

const CATEGORY_TONE: Record<string, Tone> = {
  AUTH: 'info',
  DATA: 'neutral',
  SECURITY: 'danger',
  INTEGRATION: 'primary',
};

const columns: ColumnDef<AuditLogEntry, unknown>[] = [
  {
    id: 'when',
    header: 'When',
    cell: ({ row }) => (
      <div className="whitespace-nowrap">
        <div className="text-xs">{formatRelative(row.original.createdAt)}</div>
        <div className="text-[11px] text-muted-foreground">
          {formatDateTime(row.original.createdAt)}
        </div>
      </div>
    ),
  },
  {
    id: 'category',
    header: 'Category',
    cell: ({ row }) => (
      <StatusBadge
        status={row.original.category}
        tone={CATEGORY_TONE[row.original.category] ?? 'neutral'}
        label={row.original.category}
      />
    ),
  },
  {
    id: 'action',
    header: 'Action',
    cell: ({ row }) => (
      <code className="font-mono text-xs">{row.original.action}</code>
    ),
  },
  {
    id: 'actor',
    header: 'Actor',
    cell: ({ row }) => (
      <div className="text-xs">
        {row.original.actorName ?? (
          <span className="text-muted-foreground">{row.original.actorType}</span>
        )}
      </div>
    ),
  },
  {
    id: 'entity',
    header: 'Entity',
    cell: ({ row }) =>
      row.original.entityType ? (
        <div className="text-xs">
          <div>{row.original.entityType}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            {row.original.entityId?.slice(0, 8)}
          </div>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
  },
  {
    id: 'origin',
    header: 'Origin',
    cell: ({ row }) => (
      <span className="font-mono text-[11px] text-muted-foreground">
        {row.original.ipAddress ?? '—'}
      </span>
    ),
  },
];

export default function AuditPage() {
  const [category, setCategory] = useState<string>('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<string[]>([]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['audit-logs', { category, cursor }],
    queryFn: () =>
      api.get<AuditResponse>('/audit-logs', {
        query: { category: category || undefined, cursor, limit: 25, includeTotal: true },
      }),
  });

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every mutation, with actor, origin, and before/after state. Append-only — the database itself rejects edits and deletes."
      />

      <div className="mb-3 flex flex-wrap gap-1.5">
        {['', 'AUTH', 'DATA', 'SECURITY', 'INTEGRATION'].map((value) => (
          <button
            key={value || 'all'}
            type="button"
            onClick={() => {
              setCategory(value);
              setCursor(undefined);
              setHistory([]);
            }}
            aria-pressed={category === value}
            className={
              category === value
                ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
                : 'rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
            }
          >
            {value || 'All'}
          </button>
        ))}
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
        caption="Audit log entries"
        emptyState={
          <EmptyState
            icon={ScrollText}
            title="No audit entries"
            description="Actions will appear here as people use the system."
          />
        }
      />
    </>
  );
}
