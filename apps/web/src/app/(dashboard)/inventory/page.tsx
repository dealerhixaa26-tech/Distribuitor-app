'use client';

import type { StockBalanceSummary, WarehouseSummary } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Boxes, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ApiError, api } from '@/lib/api-client';
import { formatMoney } from '@/lib/utils';

interface BalancesResponse {
  data: StockBalanceSummary[];
  meta: { cursor: { next: string | null; hasMore: boolean }; totalCount?: number };
}

interface WarehousesResponse {
  data: WarehouseSummary[];
}

/** Quantities are decimal strings on the wire, like money — never Number(). */
const qty = (value: string): string => {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

const columns: ColumnDef<StockBalanceSummary, unknown>[] = [
  {
    id: 'product',
    header: 'Product',
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{row.original.productName}</div>
        <code className="font-mono text-xs text-muted-foreground">{row.original.sku}</code>
      </div>
    ),
  },
  {
    id: 'warehouse',
    header: 'Warehouse',
    cell: ({ row }) => <span className="text-sm">{row.original.warehouseCode}</span>,
  },
  {
    id: 'onHand',
    header: 'On hand',
    cell: ({ row }) => <div className="text-right tabular">{qty(row.original.quantityOnHand)}</div>,
  },
  {
    id: 'reserved',
    header: 'Reserved',
    cell: ({ row }) => (
      <div className="text-right tabular text-muted-foreground">
        {qty(row.original.quantityReserved)}
      </div>
    ),
  },
  {
    id: 'available',
    header: 'Available',
    cell: ({ row }) => (
      <div className="flex items-center justify-end gap-1.5">
        {/* Available, not on-hand, is what can actually be sold — reserved
            stock is physically present but already promised. */}
        <span className="text-right text-sm font-medium tabular">
          {qty(row.original.quantityAvailable)}
        </span>
        {row.original.isBelowReorderLevel ? (
          <TriangleAlert
            className="size-3.5 shrink-0 text-warning"
            aria-label={`At or below reorder level of ${qty(row.original.reorderLevel ?? '0')}`}
          />
        ) : null}
      </div>
    ),
  },
  {
    id: 'value',
    header: 'Value',
    cell: ({ row }) => (
      <div className="text-right">
        <div className="text-sm tabular">{formatMoney(row.original.stockValue)}</div>
        <div className="text-[11px] text-muted-foreground">
          @ {formatMoney(row.original.averageCost)}
        </div>
      </div>
    ),
  },
];

export default function InventoryPage() {
  const [warehouseId, setWarehouseId] = useState('');
  const [search, setSearch] = useState('');
  const [belowReorder, setBelowReorder] = useState(false);

  const { data: warehouses } = useQuery({
    queryKey: ['warehouses', 'picker'],
    queryFn: () => api.get<WarehousesResponse>('/warehouses', { query: { limit: 100 } }),
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['inventory-balances', { warehouseId, belowReorder }],
    queryFn: () =>
      api.get<BalancesResponse>('/inventory/balances', {
        query: {
          warehouseId: warehouseId || undefined,
          belowReorderLevel: belowReorder || undefined,
          limit: 100,
        },
      }),
  });

  // Filtering client-side: the balance list is bounded by the catalog size, so
  // a round trip per keystroke would cost more than it saves.
  const rows = (data?.data ?? []).filter((row) =>
    search
      ? `${row.sku} ${row.productName}`.toLowerCase().includes(search.toLowerCase())
      : true,
  );

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Balances derived from an append-only ledger — never a mutable counter. Reserved stock is on hand but already promised."
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Filter by SKU or name…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
          aria-label="Filter stock"
        />
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setWarehouseId('')}
            aria-pressed={warehouseId === ''}
            className={
              warehouseId === ''
                ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
                : 'rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
            }
          >
            All warehouses
          </button>
          {(warehouses?.data ?? []).map((warehouse) => (
            <button
              key={warehouse.id}
              type="button"
              onClick={() => setWarehouseId(warehouse.id)}
              aria-pressed={warehouseId === warehouse.id}
              className={
                warehouseId === warehouse.id
                  ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
                  : 'rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
              }
            >
              {warehouse.code}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setBelowReorder((previous) => !previous)}
          aria-pressed={belowReorder}
          className={
            belowReorder
              ? 'ml-auto flex items-center gap-1 rounded-md bg-warning/15 px-2.5 py-1 text-xs font-medium text-warning'
              : 'ml-auto flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
          }
        >
          <TriangleAlert className="size-3" aria-hidden="true" />
          Below reorder level
        </button>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        loading={isLoading}
        error={
          error
            ? {
                message: error instanceof ApiError ? error.problem.detail : 'Something went wrong.',
                onRetry: () => void refetch(),
              }
            : null
        }
        getRowId={(row) => row.id}
        caption="Stock balances"
        emptyState={
          <EmptyState
            icon={Boxes}
            title={belowReorder ? 'Nothing below its reorder level' : 'No stock yet'}
            description={
              belowReorder
                ? 'Every stocked product is at or above its reorder level.'
                : 'The ledger starts empty by design. Stock appears here after the first goods receipt.'
            }
          />
        }
      />
    </>
  );
}
