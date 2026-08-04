'use client';

import type { QuotationSummary } from '@hixaa/contracts';
import { PERMISSIONS } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { CalendarX, Download, FileText, Plus } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';
import { formatCompactAmount, formatDate, humanizeEnum } from '@/lib/utils';

interface QuotationsResponse {
  data: QuotationSummary[];
  meta: { cursor: { next: string | null; hasMore: boolean }; totalCount?: number };
}

const STATUSES = ['', 'DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED'] as const;

const columns: ColumnDef<QuotationSummary, unknown>[] = [
  {
    id: 'quotation',
    header: 'Quotation',
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">
          {row.original.number}
          {row.original.revision > 1 ? (
            <span className="ml-1.5 text-xs text-muted-foreground">rev {row.original.revision}</span>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground">{formatDate(row.original.quotationDate)}</div>
      </div>
    ),
  },
  {
    id: 'for',
    header: 'For',
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
        {/* Expiry is computed server-side, so it cannot go stale the way a
            stored flag would. */}
        {row.original.isExpired && row.original.status === 'SENT' ? (
          <span className="flex items-center gap-1 text-[11px] text-warning">
            <CalendarX className="size-3" aria-hidden="true" />
            lapsed
          </span>
        ) : null}
      </div>
    ),
  },
  {
    id: 'validity',
    header: 'Valid until',
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.validUntil ? formatDate(row.original.validUntil) : '—'}
      </span>
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
  {
    id: 'pdf',
    header: '',
    cell: ({ row }) => (
      <a
        href={`/api/bff/quotations/${row.original.id}/pdf`}
        onClick={(event) => event.stopPropagation()}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
        title="Download the quotation PDF"
      >
        <Download className="size-3" aria-hidden="true" />
        PDF
      </a>
    ),
  },
];

export default function QuotationsPage() {
  const { can } = usePermission();
  const [status, setStatus] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['quotations', { status }],
    queryFn: () =>
      api.get<QuotationsResponse>('/quotations', {
        query: { status: status || undefined, limit: 50, includeTotal: true },
      }),
  });

  return (
    <>
      <PageHeader
        title="Quotations"
        description="Hixaa's sales motion starts here — RFQ first, not reorder. Prices are resolved by the pricing engine and frozen onto each line."
        actions={
          can(PERMISSIONS.QUOTATION_CREATE) ? (
            <Button>
              <Plus aria-hidden="true" />
              New quotation
            </Button>
          ) : null
        }
      />

      <div className="mb-3 flex flex-wrap gap-1.5">
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
        caption="Quotations"
        emptyState={
          <EmptyState
            icon={FileText}
            title="No quotations"
            description="Create a quotation to begin an RFQ."
          />
        }
      />
    </>
  );
}
