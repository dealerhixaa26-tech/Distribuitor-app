'use client';

import type { OrderSummary } from '@hixaa/contracts';
import { PERMISSIONS } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, ShieldAlert, ShoppingCart, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';
import { formatCompactAmount, formatDate, humanizeEnum } from '@/lib/utils';

interface OrdersResponse {
  data: OrderSummary[];
  meta: { cursor: { next: string | null; hasMore: boolean }; totalCount?: number };
}

const STATUSES = [
  '',
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PARTIALLY_DISPATCHED',
  'DISPATCHED',
  'DELIVERED',
  'CANCELLED',
] as const;

const columns: ColumnDef<OrderSummary, unknown>[] = [
  {
    id: 'order',
    header: 'Order',
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{row.original.number}</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{formatDate(row.original.orderDate)}</span>
          {/* PRIMARY is sell-in, SECONDARY is the partner's own sale. Worth
              distinguishing at a glance — they are different ledgers. */}
          <span aria-hidden="true">·</span>
          <span>{row.original.type === 'PRIMARY' ? 'Sell-in' : 'Sell-out'}</span>
        </div>
      </div>
    ),
  },
  {
    id: 'counterparty',
    header: 'Counterparty',
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.distributorName ?? row.original.customerName ?? (
          <span className="text-muted-foreground">—</span>
        )}
      </span>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <div className="flex flex-col items-start gap-1">
        <StatusBadge status={row.original.status} />
        {row.original.hasBackorder ? (
          <span
            title="Some lines could not be reserved and cannot ship yet"
            className="flex items-center gap-1 text-[11px] text-warning"
          >
            <TriangleAlert className="size-3" aria-hidden="true" />
            backordered
          </span>
        ) : null}
      </div>
    ),
  },
  {
    id: 'credit',
    header: 'Credit',
    cell: ({ row }) =>
      row.original.creditOverridden ? (
        <span
          title={row.original.creditOverrideReason ?? undefined}
          className="flex items-center gap-1 text-[11px] text-destructive"
        >
          <ShieldAlert className="size-3" aria-hidden="true" />
          overridden
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
  },
  {
    id: 'value',
    header: 'Value',
    cell: ({ row }) => (
      <div className="text-right">
        <div className="text-sm tabular">₹{formatCompactAmount(row.original.grandTotal)}</div>
        <div className="text-[11px] text-muted-foreground">{row.original.lineCount} lines</div>
      </div>
    ),
  },
];

export default function OrdersPage() {
  const router = useRouter();
  const { can } = usePermission();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['orders', { search, status }],
    queryFn: () =>
      api.get<OrdersResponse>('/orders', {
        query: { q: search || undefined, status: status || undefined, limit: 50, includeTotal: true },
      }),
  });

  return (
    <>
      <PageHeader
        title="Orders"
        description="Sell-in to distributors and sell-out to end customers. Approval reserves stock; anything unreserved is backordered."
        actions={
          can(PERMISSIONS.ORDER_CREATE) ? (
            <Button>
              <Plus aria-hidden="true" />
              New order
            </Button>
          ) : null
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search order number…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
          aria-label="Search orders"
        />
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((value) => (
            <button
              key={value || 'all'}
              type="button"
              onClick={() => setStatus(value)}
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
        totalCount={data?.meta.totalCount}
        onRowClick={(row) => router.push(`/orders/${row.id}`)}
        getRowId={(row) => row.id}
        caption="Orders"
        emptyState={
          <EmptyState
            icon={ShoppingCart}
            title={status ? 'No matching orders' : 'No orders yet'}
            description={
              status ? 'Try a different status filter.' : 'Convert an accepted quotation to start.'
            }
          />
        }
      />
    </>
  );
}
