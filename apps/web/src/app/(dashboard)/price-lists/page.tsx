'use client';

import type { PriceListSummary } from '@hixaa/contracts';
import { PERMISSIONS } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Star, Tags } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';
import { formatDate, humanizeEnum } from '@/lib/utils';

interface PriceListsResponse {
  data: PriceListSummary[];
  meta: { cursor: { next: string | null; hasMore: boolean }; totalCount?: number };
}

const STATUSES = ['', 'DRAFT', 'ACTIVE', 'ARCHIVED'] as const;

const columns: ColumnDef<PriceListSummary, unknown>[] = [
  {
    id: 'list',
    header: 'Price list',
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{row.original.name}</span>
          {row.original.isDefault ? (
            <span
              title="The default list — used when a distributor has none assigned"
              className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary"
            >
              <Star className="size-2.5" aria-hidden="true" />
              default
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <code className="font-mono">{row.original.code}</code>
          <span aria-hidden="true">·</span>
          <span>v{row.original.version}</span>
        </div>
      </div>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    id: 'validity',
    header: 'Effective',
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {formatDate(row.original.validFrom)}
        {row.original.validTo ? ` → ${formatDate(row.original.validTo)}` : ' → open'}
      </span>
    ),
  },
  {
    id: 'basis',
    header: 'Basis',
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.priceBasis === 'EXCLUSIVE' ? 'Excl. GST' : 'Incl. GST'}
      </span>
    ),
  },
  {
    id: 'items',
    header: 'Prices',
    cell: ({ row }) => (
      <div className="text-right">
        <div className="text-sm tabular">{row.original.itemCount}</div>
        <div className="text-[11px] text-muted-foreground">
          {row.original.distributorCount} partner
          {row.original.distributorCount === 1 ? '' : 's'}
        </div>
      </div>
    ),
  },
];

export default function PriceListsPage() {
  const router = useRouter();
  const { can } = usePermission();
  const [status, setStatus] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<string[]>([]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['price-lists', { status, cursor }],
    queryFn: () =>
      api.get<PriceListsResponse>('/price-lists', {
        query: { status: status || undefined, cursor, limit: 25, includeTotal: true },
      }),
  });

  return (
    <>
      <PageHeader
        title="Price lists"
        description="Versioned, date-effective, GST-exclusive. A price revision is a clone-and-publish, never an edit to a live list."
        actions={
          can(PERMISSIONS.PRICELIST_CREATE) ? (
            <Button asChild>
              <Link href="/price-lists/new">
                <Plus aria-hidden="true" />
                New price list
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="mb-3 flex flex-wrap gap-1.5">
        {STATUSES.map((value) => (
          <button
            key={value || 'all'}
            type="button"
            onClick={() => {
              setStatus(value);
              setCursor(undefined);
              setHistory([]);
            }}
            aria-pressed={status === value}
            className={
              status === value
                ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
                : 'rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
            }
          >
            {value ? humanizeEnum(value) : 'All'}
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
                message: error instanceof ApiError ? error.problem.detail : 'Something went wrong.',
                onRetry: () => void refetch(),
              }
            : null
        }
        cursor={data?.meta.cursor}
        totalCount={data?.meta.totalCount}
        canGoBack={history.length > 0}
        onRowClick={(row) => router.push(`/price-lists/${row.id}`)}
        getRowId={(row) => row.id}
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
        caption="Price lists"
        emptyState={
          <EmptyState
            icon={Tags}
            title="No price lists"
            description="Create a price list and publish it before quoting."
          />
        }
      />
    </>
  );
}
