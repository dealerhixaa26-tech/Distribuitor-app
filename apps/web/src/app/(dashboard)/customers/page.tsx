'use client';

import type { CustomerSummary } from '@hixaa/contracts';
import { PERMISSIONS } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Users } from 'lucide-react';
import Link from 'next/link';
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
import { humanizeEnum } from '@/lib/utils';

interface CustomersResponse {
  data: CustomerSummary[];
  meta: { cursor: { next: string | null; hasMore: boolean }; totalCount?: number };
}

const columns: ColumnDef<CustomerSummary, unknown>[] = [
  {
    id: 'customer',
    header: 'Customer',
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{row.original.name}</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <code className="font-mono">{row.original.code}</code>
          <span aria-hidden="true">·</span>
          <span>{humanizeEnum(row.original.type)}</span>
          {row.original.siteName ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{row.original.siteName}</span>
            </>
          ) : null}
        </div>
      </div>
    ),
  },
  {
    id: 'industry',
    header: 'Industry',
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.industryName ?? <span className="text-muted-foreground">—</span>}
      </span>
    ),
  },
  {
    id: 'distributor',
    header: 'Serviced by',
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.distributorName ?? 'Direct'}
      </span>
    ),
  },
  {
    id: 'gstin',
    header: 'GSTIN',
    cell: ({ row }) => (
      <code className="font-mono text-xs">
        {row.original.gstin ?? <span className="text-muted-foreground">—</span>}
      </code>
    ),
  },
  {
    id: 'orders',
    header: 'Orders',
    cell: ({ row }) => <div className="text-right tabular text-sm">{row.original.orderCount}</div>,
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.isActive ? 'ACTIVE' : 'DISABLED'} />,
  },
];

export default function CustomersPage() {
  const router = useRouter();
  const { can, scopeType } = usePermission();
  const [search, setSearch] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['customers', { search }],
    queryFn: () =>
      api.get<CustomersResponse>('/customers', {
        query: { q: search || undefined, limit: 50, includeTotal: true },
      }),
  });

  return (
    <>
      <PageHeader
        title="Customers"
        description="End customers — plants, mines, government bodies. Distinct from distributors, which are channel partners."
        actions={
          can(PERMISSIONS.CUSTOMER_CREATE) ? (
            <Button asChild>
              <Link href="/customers/new">
                <Plus aria-hidden="true" />
                New customer
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search name, code, site, or GSTIN…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
          aria-label="Search customers"
        />
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
        onRowClick={(row) => router.push(`/customers/${row.id}/edit`)}
        getRowId={(row) => row.id}
        caption="Customers"
        emptyState={
          <EmptyState
            icon={Users}
            title="No customers"
            description="Add the end customers your distributors sell to."
          />
        }
      />
    </>
  );
}
