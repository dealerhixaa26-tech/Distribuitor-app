'use client';

import type { WarehouseSummary } from '@hixaa/contracts';
import { PERMISSIONS } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Star, Warehouse as WarehouseIcon } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';
import { humanizeEnum } from '@/lib/utils';

interface WarehousesResponse {
  data: WarehouseSummary[];
  meta: { cursor: { next: string | null; hasMore: boolean }; totalCount?: number };
}

const TYPES = ['', 'COMPANY', 'DISTRIBUTOR', 'TRANSIT', 'SCRAP'] as const;

const columns: ColumnDef<WarehouseSummary, unknown>[] = [
  {
    id: 'warehouse',
    header: 'Warehouse',
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{row.original.name}</span>
          {row.original.isDefault ? (
            <span
              title="The default warehouse"
              className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary"
            >
              <Star className="size-2.5" aria-hidden="true" />
              default
            </span>
          ) : null}
        </div>
        <code className="font-mono text-xs text-muted-foreground">{row.original.code}</code>
      </div>
    ),
  },
  {
    id: 'type',
    header: 'Type',
    cell: ({ row }) => (
      <div>
        <span className="text-sm">{humanizeEnum(row.original.type)}</span>
        {/* A DISTRIBUTOR warehouse holds a partner's stock, not Hixaa's —
            worth seeing without opening the record. */}
        {row.original.distributorName ? (
          <div className="text-[11px] text-muted-foreground">{row.original.distributorName}</div>
        ) : null}
      </div>
    ),
  },
  {
    id: 'territory',
    header: 'Territory',
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.territoryName ?? <span className="text-muted-foreground">—</span>}
      </span>
    ),
  },
  {
    id: 'stocked',
    header: 'Products stocked',
    cell: ({ row }) => (
      <div className="text-right tabular text-sm">{row.original.stockedProductCount}</div>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.isActive ? 'ACTIVE' : 'DISABLED'} />,
  },
];

export default function WarehousesPage() {
  const { can, scopeType } = usePermission();
  const [type, setType] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['warehouses', { type }],
    queryFn: () =>
      api.get<WarehousesResponse>('/warehouses', {
        query: { type: type || undefined, limit: 50, includeTotal: true },
      }),
  });

  return (
    <>
      <PageHeader
        title="Warehouses"
        description="Stock locations. A territory-scoped user only ever sees their own — enforced in the database."
        actions={
          can(PERMISSIONS.WAREHOUSE_CREATE) ? (
            <Button>
              <Plus aria-hidden="true" />
              New warehouse
            </Button>
          ) : null
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {TYPES.map((value) => (
            <button
              key={value || 'all'}
              type="button"
              onClick={() => setType(value)}
              aria-pressed={type === value}
              className={
                type === value
                  ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
                  : 'rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
              }
            >
              {value ? humanizeEnum(value) : 'All'}
            </button>
          ))}
        </div>
        {scopeType !== 'GLOBAL' ? (
          <StatusBadge
            status="INFO"
            tone="info"
            label="Scoped to your territories"
            className="ml-auto"
          />
        ) : null}
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
        getRowId={(row) => row.id}
        caption="Warehouses"
        emptyState={
          <EmptyState
            icon={WarehouseIcon}
            title="No warehouses"
            description="Create a warehouse before receiving stock."
          />
        }
      />
    </>
  );
}
