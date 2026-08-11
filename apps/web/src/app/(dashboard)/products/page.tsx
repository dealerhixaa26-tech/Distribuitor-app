'use client';

import type { ProductSummary } from '@hixaa/contracts';
import { PERMISSIONS } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Package, Plus, ScanBarcode } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';
import { humanizeEnum } from '@/lib/utils';

interface ProductsResponse {
  data: ProductSummary[];
  meta: {
    cursor: { next: string | null; hasMore: boolean };
    totalCount?: number;
    /** Set when a full-text search hit the 200-match cap. */
    truncated?: boolean;
  };
}

const TYPES = ['', 'GOODS', 'SERVICE', 'KIT', 'CONFIGURABLE'] as const;
const STATUSES = ['', 'DRAFT', 'ACTIVE', 'DISCONTINUED', 'ARCHIVED'] as const;

const columns: ColumnDef<ProductSummary, unknown>[] = [
  {
    id: 'product',
    header: 'Product',
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{row.original.name}</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <code className="font-mono">{row.original.sku}</code>
          <span aria-hidden="true">·</span>
          <span>{humanizeEnum(row.original.type)}</span>
          {row.original.isSerialized ? (
            <>
              <span aria-hidden="true">·</span>
              {/* Serial tracking drives warranty and liability, so it is worth
                  seeing without opening the record. */}
              <span
                title="Serial-tracked"
                className="flex items-center gap-0.5 text-[11px] text-muted-foreground"
              >
                <ScanBarcode className="size-3" aria-hidden="true" />
                serial
              </span>
            </>
          ) : null}
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
    id: 'category',
    header: 'Category',
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.categoryName ?? <span className="text-muted-foreground">—</span>}
      </span>
    ),
  },
  {
    id: 'tax',
    header: 'HSN / SAC',
    cell: ({ row }) => (
      <div className="text-right">
        <code className="font-mono text-xs">
          {row.original.sacCode ?? row.original.hsnCode ?? (
            <span className="text-muted-foreground">—</span>
          )}
        </code>
        <div className="text-[11px] text-muted-foreground">{row.original.gstRate}% GST</div>
      </div>
    ),
  },
  {
    id: 'lead',
    header: 'Lead time',
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.leadTimeDays ? `${row.original.leadTimeDays} days` : '—'}
      </span>
    ),
  },
  {
    id: 'bom',
    header: 'BOM',
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.bomComponentCount > 0
          ? `${row.original.bomComponentCount} components`
          : '—'}
      </span>
    ),
  },
];

export default function ProductsPage() {
  const router = useRouter();
  const { can } = usePermission();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<string[]>([]);

  const resetPaging = () => {
    setCursor(undefined);
    setHistory([]);
  };

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['products', { search, type, status, cursor }],
    queryFn: () =>
      api.get<ProductsResponse>('/products', {
        query: {
          q: search || undefined,
          type: type || undefined,
          status: status || undefined,
          cursor,
          limit: 25,
          includeTotal: true,
        },
      }),
  });

  return (
    <>
      <PageHeader
        title="Products"
        description="Hixaa's catalog — goods, services, kits, and configurable systems. Prices exclude GST."
        actions={
          can(PERMISSIONS.PRODUCT_CREATE) ? (
            <Button asChild>
              <Link href="/products/new">
                <Plus aria-hidden="true" />
                New product
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search name, SKU, or description…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            resetPaging();
          }}
          className="max-w-xs"
          aria-label="Search products"
        />
        <div className="flex flex-wrap gap-1.5">
          {TYPES.map((value) => (
            <button
              key={value || 'all-types'}
              type="button"
              onClick={() => {
                setType(value);
                resetPaging();
              }}
              aria-pressed={type === value}
              className={
                type === value
                  ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
                  : 'rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
              }
            >
              {value ? humanizeEnum(value) : 'All types'}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((value) => (
            <button
              key={value || 'all-statuses'}
              type="button"
              onClick={() => {
                setStatus(value);
                resetPaging();
              }}
              aria-pressed={status === value}
              className={
                status === value
                  ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
                  : 'rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
              }
            >
              {value ? humanizeEnum(value) : 'All statuses'}
            </button>
          ))}
        </div>
      </div>

      {/* A truncated search must say so. Silently returning the first 200 of
          many reads as "this is everything", which it is not. */}
      {data?.meta.truncated ? (
        <p className="mb-2 text-xs text-warning">
          Showing the 200 best matches. Narrow the search to see more.
        </p>
      ) : null}

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
        onRowClick={(row) => router.push(`/products/${row.id}`)}
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
        caption="Products"
        emptyState={
          <EmptyState
            icon={Package}
            title={search || type || status ? 'No matching products' : 'No products yet'}
            description={
              search || type || status
                ? 'Try a different search or filter.'
                : 'Add your first product to start quoting.'
            }
          />
        }
      />
    </>
  );
}
