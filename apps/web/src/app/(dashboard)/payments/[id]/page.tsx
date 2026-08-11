'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { formatDate, formatDateTime, formatMoney, humanizeEnum } from '@/lib/utils';
import { PaymentActions } from './payment-actions';

interface PaymentDetail {
  id: string;
  number: string | null;
  status: string;
  method: string;
  amount: string;
  tdsAmount: string | null;
  totalValue: string;
  unallocatedAmount: string;
  paymentDate: string;
  referenceNumber: string | null;
  bankName: string | null;
  chequeNumber: string | null;
  chequeDate: string | null;
  notes: string | null;
  distributorId: string | null;
  distributorName: string | null;
  customerId: string | null;
  customerName: string | null;
  recordedById: string | null;
  recordedByName: string | null;
  verifiedById: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  bouncedAt: string | null;
  bouncedReason: string | null;
  allocationCount: number;
  allocations: Array<{
    id: string;
    invoiceId: string;
    invoiceNumber: string | null;
    invoiceDate: string;
    invoiceGrandTotal: string;
    amount: string;
  }>;
}

/**
 * A receipt, and its position in the segregation of duties.
 *
 * The screen leads with WHO did what: recording and verifying are different
 * acts by different people, and the whole control is that the two names differ
 * (ADR-0018). Burying that in an audit log would make it invisible exactly
 * where it matters.
 */
export default function PaymentDetailPage() {
  const params = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['payments', params.id],
    queryFn: () => api.get<PaymentDetail>(`/payments/${params.id}`),
  });

  if (isLoading) return <TableSkeleton />;

  if (error || !data) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Receipt not found"
        description={
          error instanceof ApiError
            ? error.problem.detail
            : 'It may have been removed, or lie outside your territory.'
        }
      />
    );
  }

  const party = data.distributorName ?? data.customerName ?? 'Unknown party';

  return (
    <>
      <Link
        href="/payments"
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Payments
      </Link>

      <PageHeader
        title={data.number ?? 'Receipt'}
        description={`${party} · ${humanizeEnum(data.method)} · ${formatDate(data.paymentDate)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={data.status} />
            <PaymentActions
              paymentId={data.id}
              status={data.status}
              distributorId={data.distributorId}
              customerId={data.customerId}
              unallocatedAmount={data.unallocatedAmount}
              recordedById={data.recordedById}
            />
          </div>
        }
      />

      {data.status === 'RECORDED' ? (
        <div
          role="status"
          className="mb-4 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm"
        >
          <strong>No financial effect yet.</strong> A recorded receipt is a memo — it writes no
          ledger entry and settles no invoice. Verification is what posts it.
        </div>
      ) : null}

      {data.bouncedAt ? (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <div className="font-medium text-destructive">
            Bounced {formatDate(data.bouncedAt)}
          </div>
          <div className="text-muted-foreground">{data.bouncedReason}</div>
        </div>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Amount received</CardTitle>
          </CardHeader>
          <CardContent className="text-sm font-semibold tabular-nums">
            {formatMoney(data.amount)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>TDS withheld</CardTitle>
          </CardHeader>
          <CardContent className="text-sm tabular-nums">
            {data.tdsAmount && Number(data.tdsAmount) > 0 ? formatMoney(data.tdsAmount) : '—'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Total value</CardTitle>
          </CardHeader>
          <CardContent className="text-sm tabular-nums">{formatMoney(data.totalValue)}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Still unapplied</CardTitle>
          </CardHeader>
          <CardContent className="text-sm tabular-nums">
            {formatMoney(data.unallocatedAmount)}
          </CardContent>
        </Card>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Segregation of duties</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div>
              <span className="text-muted-foreground">Recorded by </span>
              {data.recordedByName ?? '—'}
            </div>
            <div>
              <span className="text-muted-foreground">Verified by </span>
              {data.verifiedByName ?? <span className="text-muted-foreground">not yet</span>}
              {data.verifiedAt ? (
                <span className="ml-1 text-xs text-muted-foreground">
                  {formatDateTime(data.verifiedAt)}
                </span>
              ) : null}
            </div>
            <p className="pt-1 text-xs text-muted-foreground">
              The two must be different people. The API refuses self-verification.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Instrument</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div>
              <span className="text-muted-foreground">Reference </span>
              <code className="font-mono text-xs">{data.referenceNumber ?? '—'}</code>
            </div>
            <div>
              <span className="text-muted-foreground">Bank </span>
              {data.bankName ?? '—'}
            </div>
            {data.chequeNumber ? (
              <div>
                <span className="text-muted-foreground">Instrument no. </span>
                <code className="font-mono text-xs">{data.chequeNumber}</code>
                {data.chequeDate ? ` · ${formatDate(data.chequeDate)}` : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <h2 className="mb-2 text-sm font-semibold">
        Applied to {data.allocationCount} invoice{data.allocationCount === 1 ? '' : 's'}
      </h2>

      {data.allocations.length === 0 ? (
        <EmptyState
          title="Not applied to anything yet"
          description={
            data.status === 'VERIFIED'
              ? 'The money is verified and sitting unallocated. Apply it to the invoices it settles.'
              : 'Allocation requires a verified receipt.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="sr-only">Invoices this receipt was applied to</caption>
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">Invoice</th>
                <th scope="col" className="px-3 py-2 text-left font-medium">Date</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Invoice total</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Applied</th>
              </tr>
            </thead>
            <tbody>
              {data.allocations.map((allocation) => (
                <tr key={allocation.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link
                      href={`/invoices/${allocation.invoiceId}`}
                      className="rounded font-medium text-primary hover:underline"
                    >
                      {allocation.invoiceNumber ?? 'Draft'}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{formatDate(allocation.invoiceDate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMoney(allocation.invoiceGrandTotal)}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {formatMoney(allocation.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.notes ? (
        <div className="mt-4">
          <h2 className="mb-1 text-sm font-semibold">Notes</h2>
          <p className="text-sm text-muted-foreground">{data.notes}</p>
        </div>
      ) : null}
    </>
  );
}
