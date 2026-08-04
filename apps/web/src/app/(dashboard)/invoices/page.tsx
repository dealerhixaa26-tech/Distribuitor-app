'use client';

import type { InvoiceSummary } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, FileText } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { formatCompactAmount, formatDate, humanizeEnum } from '@/lib/utils';

interface InvoicesResponse {
  data: InvoiceSummary[];
  meta: { cursor: { next: string | null; hasMore: boolean }; totalCount?: number };
}

const STATUSES = ['', 'DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED'] as const;

const columns: ColumnDef<InvoiceSummary, unknown>[] = [
  {
    id: 'invoice',
    header: 'Invoice',
    cell: ({ row }) => (
      <div className="min-w-0">
        {/* A draft has no number: none is allocated until issue, which is what
            makes a draft free to delete. Saying "Draft" is more honest than an
            em-dash where a number belongs. */}
        <div className="truncate text-sm font-medium">
          {row.original.number ?? <span className="text-muted-foreground">Draft</span>}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{formatDate(row.original.invoiceDate)}</span>
          <span aria-hidden="true">·</span>
          <span>{row.original.isInterState ? 'IGST' : 'CGST + SGST'}</span>
        </div>
      </div>
    ),
  },
  {
    id: 'counterparty',
    header: 'Bill to',
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate text-sm">{row.original.counterpartyName}</div>
        <div className="text-[11px] text-muted-foreground">
          {row.original.counterpartyGstin ?? 'Unregistered'}
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
        {/* Overdue is computed at read time, never stored — so this badge can
            never be stale in the way a nightly-job status would be. */}
        {row.original.isOverdue ? (
          <span className="flex items-center gap-1 text-[11px] text-destructive">
            <AlertTriangle className="size-3" aria-hidden="true" />
            {row.original.daysPastDue}d overdue
          </span>
        ) : null}
      </div>
    ),
  },
  {
    id: 'due',
    header: 'Due',
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.dueDate ? (
          formatDate(row.original.dueDate)
        ) : (
          <span className="text-muted-foreground">On receipt</span>
        )}
      </span>
    ),
  },
  {
    id: 'value',
    header: 'Value',
    cell: ({ row }) => (
      <div className="text-right">
        <div className="text-sm tabular">₹{formatCompactAmount(row.original.grandTotal)}</div>
        {/* Outstanding is shown only when it differs from the total: repeating
            the same figure twice tells the reader nothing. */}
        {row.original.amountOutstanding !== row.original.grandTotal ? (
          <div className="text-[11px] text-muted-foreground">
            ₹{formatCompactAmount(row.original.amountOutstanding)} due
          </div>
        ) : null}
      </div>
    ),
  },
];

export default function InvoicesPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['invoices', { search, status, overdueOnly }],
    queryFn: () =>
      api.get<InvoicesResponse>('/invoices', {
        query: {
          q: search || undefined,
          status: status || undefined,
          overdueOnly: overdueOnly || undefined,
          limit: 50,
          includeTotal: true,
        },
      }),
  });

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Tax invoices under GST. Once issued, an invoice is immutable — corrections go through a credit or debit note."
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search number or counterparty…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
          aria-label="Search invoices"
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
          <button
            type="button"
            onClick={() => setOverdueOnly((previous) => !previous)}
            aria-pressed={overdueOnly}
            className={
              overdueOnly
                ? 'rounded-md bg-destructive px-2.5 py-1 text-xs font-medium text-destructive-foreground'
                : 'rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
            }
          >
            Overdue
          </button>
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
        onRowClick={(row) => router.push(`/invoices/${row.id}`)}
        getRowId={(row) => row.id}
        caption="Invoices"
        emptyState={
          <EmptyState
            icon={FileText}
            title={status || overdueOnly ? 'No matching invoices' : 'No invoices yet'}
            description={
              status || overdueOnly
                ? 'Try a different filter.'
                : 'Invoice a dispatched order to start.'
            }
          />
        }
      />
    </>
  );
}
