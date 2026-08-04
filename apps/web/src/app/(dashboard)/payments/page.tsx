'use client';

import type { PaymentSummary } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Clock, Receipt } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { formatCompactAmount, formatDate, humanizeEnum } from '@/lib/utils';

interface PaymentsResponse {
  data: PaymentSummary[];
  meta: { cursor: { next: string | null; hasMore: boolean }; totalCount?: number };
}

const STATUSES = ['', 'RECORDED', 'VERIFIED', 'BOUNCED', 'CANCELLED'] as const;

const columns: ColumnDef<PaymentSummary, unknown>[] = [
  {
    id: 'receipt',
    header: 'Receipt',
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{row.original.number}</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{formatDate(row.original.paymentDate)}</span>
          <span aria-hidden="true">·</span>
          <span>{humanizeEnum(row.original.method)}</span>
        </div>
      </div>
    ),
  },
  {
    id: 'party',
    header: 'From',
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
        {/* The distinction ADR-0018 exists to make: a RECORDED receipt is a
            claim, and has changed no balance anywhere. Saying so on the list is
            what stops someone reading it as money in the bank. */}
        {row.original.awaitingVerification ? (
          <span
            title="Recorded but not confirmed — no ledger effect, and it cannot be allocated"
            className="flex items-center gap-1 text-[11px] text-warning"
          >
            <Clock className="size-3" aria-hidden="true" />
            awaiting verification
          </span>
        ) : null}
      </div>
    ),
  },
  {
    id: 'unallocated',
    header: 'Unapplied',
    cell: ({ row }) =>
      row.original.unallocatedAmount === '0.0000' ? (
        <span className="text-xs text-muted-foreground">Fully applied</span>
      ) : (
        <span className="text-sm tabular">
          ₹{formatCompactAmount(row.original.unallocatedAmount)}
        </span>
      ),
  },
  {
    id: 'value',
    header: 'Amount',
    cell: ({ row }) => (
      <div className="text-right">
        <div className="text-sm tabular">₹{formatCompactAmount(row.original.amount)}</div>
        {row.original.tdsAmount !== '0.0000' ? (
          <div className="text-[11px] text-muted-foreground">
            + ₹{formatCompactAmount(row.original.tdsAmount)} TDS
          </div>
        ) : null}
      </div>
    ),
  },
];

export default function PaymentsPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['payments', { search, status }],
    queryFn: () =>
      api.get<PaymentsResponse>('/payments', {
        query: {
          q: search || undefined,
          status: status || undefined,
          limit: 50,
          includeTotal: true,
        },
      }),
  });

  return (
    <>
      <PageHeader
        title="Payments"
        description="Recording a receipt is a memo with no financial effect. Verification — by someone other than the recorder — is what credits the ledger."
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search receipt or reference…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
          aria-label="Search payments"
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
        getRowId={(row) => row.id}
        caption="Payments"
        emptyState={
          <EmptyState
            icon={Receipt}
            title={status ? 'No matching receipts' : 'No payments yet'}
            description={
              status ? 'Try a different status filter.' : 'Record a receipt against an invoice.'
            }
          />
        }
      />
    </>
  );
}
