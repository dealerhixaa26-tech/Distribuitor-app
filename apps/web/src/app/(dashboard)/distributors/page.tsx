'use client';

import type { DistributorSummary } from '@hixaa/contracts';
import { PERMISSIONS } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Building2, Plus, ShieldAlert } from 'lucide-react';
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
import { formatCompactAmount, humanizeEnum } from '@/lib/utils';

interface DistributorsResponse {
  data: DistributorSummary[];
  meta: { cursor: { next: string | null; hasMore: boolean }; totalCount?: number };
}

const STATUSES = ['', 'LEAD', 'PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'TERMINATED'] as const;

const columns: ColumnDef<DistributorSummary, unknown>[] = [
  {
    id: 'distributor',
    header: 'Distributor',
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{row.original.legalName}</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <code className="font-mono">{row.original.code}</code>
          <span aria-hidden="true">·</span>
          <span>{humanizeEnum(row.original.type)}</span>
        </div>
      </div>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <div className="flex flex-col items-start gap-1">
        <StatusBadge status={row.original.status} />
        {/* KYC gaps block approval, so surface them in the list rather than
            making someone open the record to find out why they are stuck. */}
        {row.original.kycMissing.length > 0 && row.original.status !== 'TERMINATED' ? (
          <span
            title={`Unverified: ${row.original.kycMissing.join(', ')}`}
            className="flex items-center gap-1 text-[11px] text-warning"
          >
            <ShieldAlert className="size-3" aria-hidden="true" />
            {row.original.kycMissing.length} KYC pending
          </span>
        ) : null}
      </div>
    ),
  },
  {
    id: 'territory',
    header: 'Territory',
    cell: ({ row }) => (
      <span className="text-sm">{row.original.territoryName ?? <span className="text-muted-foreground">—</span>}</span>
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
    id: 'credit',
    header: 'Credit',
    cell: ({ row }) => (
      <div className="text-right tabular">
        <div className="text-sm">₹{formatCompactAmount(row.original.creditLimit)}</div>
        <div className="text-[11px] text-muted-foreground">{row.original.creditDays} days</div>
      </div>
    ),
  },
  {
    id: 'manager',
    header: 'Account manager',
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.accountManagerName ?? 'Unassigned'}
      </span>
    ),
  },
];

export default function DistributorsPage() {
  const router = useRouter();
  const { can, scopeType } = usePermission();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<string[]>([]);

  const resetPaging = () => {
    setCursor(undefined);
    setHistory([]);
  };

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['distributors', { search, status, cursor }],
    queryFn: () =>
      api.get<DistributorsResponse>('/distributors', {
        query: {
          q: search || undefined,
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
        title="Distributors"
        description="Hixaa's channel partners. A territory-scoped user only ever sees their own — enforced in the database."
        actions={
          can(PERMISSIONS.DISTRIBUTOR_CREATE) ? (
            <Button asChild>
              <Link href="/distributors/new">
                <Plus aria-hidden="true" />
                New distributor
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search name, code, or GSTIN…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            resetPaging();
          }}
          className="max-w-xs"
          aria-label="Search distributors"
        />
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((value) => (
            <button
              key={value || 'all'}
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
              {value ? humanizeEnum(value) : 'All'}
            </button>
          ))}
        </div>
        {scopeType !== 'GLOBAL' ? (
          <StatusBadge status="INFO" tone="info" label="Scoped to your territories" className="ml-auto" />
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
        cursor={data?.meta.cursor}
        totalCount={data?.meta.totalCount}
        canGoBack={history.length > 0}
        onRowClick={(row) => router.push(`/distributors/${row.id}`)}
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
        caption="Distributors"
        emptyState={
          <EmptyState
            icon={Building2}
            title={search || status ? 'No matching distributors' : 'No distributors yet'}
            description={
              search || status
                ? 'Try a different search or status filter.'
                : 'Onboard your first channel partner to get started.'
            }
          />
        }
      />
    </>
  );
}
