'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Clock, ShieldAlert, ShoppingCart, Truck, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { formatDate, formatDateTime, formatMoney, humanizeEnum } from '@/lib/utils';
import { OrderActions } from './order-actions';

/**
 * Order detail.
 *
 * The fulfilment columns are the point of this screen. An approved order is NOT
 * a guarantee of stock (ADR-0012) — reserved, backordered, and dispatched are
 * shown per line so nobody has to infer why something has not shipped.
 */
interface OrderDetail {
  id: string;
  number: string;
  type: string;
  status: string;
  distributorName: string | null;
  customerName: string | null;
  orderDate: string;
  expectedDate: string | null;
  customerPoNumber: string | null;
  creditOverridden: boolean;
  creditOverrideReason: string | null;
  subtotal: string;
  totalDiscount: string;
  taxableValue: string;
  totalCgst: string;
  totalSgst: string;
  totalIgst: string;
  totalTax: string;
  roundOff: string;
  grandTotal: string;
  approvedAt: string | null;
  lines: Array<{
    id: string;
    lineNumber: number;
    sku: string;
    description: string;
    quantity: string;
    quantityReserved: string;
    quantityBackordered: string;
    quantityDispatched: string;
    quantityOutstanding: string;
    expectedAvailableDate: string | null;
    isBackordered: boolean;
    unitPrice: string;
    discountPercent: string;
    overrideReason: string | null;
    gstRate: string;
    lineTotal: string;
  }>;
  approvals: Array<{
    id: string;
    kind: string;
    requestedValue: string;
    approverCeiling: string | null;
    reason: string | null;
    createdAt: string;
  }>;
  shipments: Array<{
    id: string;
    number: string;
    status: string;
    lrNumber: string | null;
    dispatchedAt: string | null;
    deliveredAt: string | null;
  }>;
  timeline: Array<{
    id: string;
    event: string;
    description: string;
    createdAt: string;
  }>;
}

const qty = (value: string): string => {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['orders', params.id],
    // Plural, matching the list and every invalidation. It was ['order', id]
    // — a singular key nothing invalidated, so an action succeeded, the toast
    // fired, and the screen kept showing the state before it.
    // `apiFetch` already unwraps the single-resource envelope — HANDOFF §4.10.
    queryFn: () => api.get<OrderDetail>(`/orders/${params.id}`),
    enabled: Boolean(params.id),
  });

  if (isLoading) return <TableSkeleton />;

  if (error || !data) {
    return (
      <EmptyState
        icon={ShoppingCart}
        title="Order not found"
        description={
          error instanceof ApiError ? error.problem.detail : 'This order could not be loaded.'
        }
      />
    );
  }

  const isInterState = Number(data.totalIgst) > 0;

  return (
    <>
      <Link
        href="/orders"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        All orders
      </Link>

      <PageHeader
        title={data.number}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={data.status} />
            <span className="text-xs text-muted-foreground">
              {data.type === 'PRIMARY' ? 'Sell-in' : 'Sell-out'} ·{' '}
              {data.distributorName ?? data.customerName} · {formatDate(data.orderDate)}
            </span>
          </span>
        }
        actions={<OrderActions orderId={data.id} status={data.status} type={data.type} />}
      />

      {/* A credit override is an exception the company knowingly took. It
          belongs at the top of the record, not buried in an audit search. */}
      {data.creditOverridden ? (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <div className="text-sm">
            <div className="font-medium text-destructive">Credit limit overridden</div>
            <div className="text-muted-foreground">{data.creditOverrideReason}</div>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Lines</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Order lines with fulfilment state</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" className="pb-1.5 font-medium">Item</th>
                    <th scope="col" className="pb-1.5 text-right font-medium">Qty</th>
                    <th scope="col" className="pb-1.5 text-right font-medium">Reserved</th>
                    <th scope="col" className="pb-1.5 text-right font-medium">Dispatched</th>
                    <th scope="col" className="pb-1.5 text-right font-medium">Rate</th>
                    <th scope="col" className="pb-1.5 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((line) => (
                    <tr key={line.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2">
                        <div>{line.description}</div>
                        <div className="text-[11px] text-muted-foreground">
                          <code className="font-mono">{line.sku}</code>
                          {Number(line.discountPercent) > 0
                            ? ` · ${Number(line.discountPercent).toFixed(1)}% off`
                            : ''}
                        </div>
                        {line.isBackordered ? (
                          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-warning">
                            <TriangleAlert className="size-3" aria-hidden="true" />
                            {qty(line.quantityBackordered)} backordered
                            {line.expectedAvailableDate
                              ? ` · expected ${formatDate(line.expectedAvailableDate)}`
                              : ''}
                          </div>
                        ) : null}
                        {line.overrideReason ? (
                          <div className="mt-0.5 text-[11px] text-primary">
                            Price overridden: {line.overrideReason}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2 text-right tabular">{qty(line.quantity)}</td>
                      <td className="py-2 text-right tabular text-muted-foreground">
                        {qty(line.quantityReserved)}
                      </td>
                      <td className="py-2 text-right tabular">{qty(line.quantityDispatched)}</td>
                      <td className="py-2 text-right tabular">{formatMoney(line.unitPrice)}</td>
                      <td className="py-2 text-right tabular">{formatMoney(line.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <dl className="mt-4 ml-auto max-w-xs space-y-1 text-sm">
              <Row label="Taxable value" value={formatMoney(data.taxableValue)} />
              {isInterState ? (
                <Row label="IGST" value={formatMoney(data.totalIgst)} />
              ) : (
                <>
                  <Row label="CGST" value={formatMoney(data.totalCgst)} />
                  <Row label="SGST" value={formatMoney(data.totalSgst)} />
                </>
              )}
              {Number(data.roundOff) !== 0 ? (
                <Row label="Round off" value={formatMoney(data.roundOff)} />
              ) : null}
              <div className="flex justify-between border-t border-border pt-1 font-semibold">
                <dt>Total</dt>
                <dd className="tabular">{formatMoney(data.grandTotal)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Customer PO" value={data.customerPoNumber ?? '—'} />
              <Row label="Expected" value={data.expectedDate ? formatDate(data.expectedDate) : '—'} />
              <Row
                label="Approved"
                value={data.approvedAt ? formatDateTime(data.approvedAt) : 'Not yet'}
              />
            </CardContent>
          </Card>

          {data.shipments.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Shipments</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.shipments.map((shipment) => (
                  <div key={shipment.id} className="flex items-start gap-2 text-sm">
                    <Truck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs">{shipment.number}</span>
                        <StatusBadge status={shipment.status} />
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {shipment.lrNumber ? `LR ${shipment.lrNumber}` : 'No LR'}
                        {shipment.dispatchedAt
                          ? ` · ${formatDate(shipment.dispatchedAt)}`
                          : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {data.approvals.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Approvals</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {data.approvals.map((approval) => (
                  <div key={approval.id}>
                    <div className="text-xs font-medium">{humanizeEnum(approval.kind)}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {formatMoney(approval.requestedValue)}
                      {approval.approverCeiling
                        ? ` against a ceiling of ${formatMoney(approval.approverCeiling)}`
                        : ' (no ceiling)'}
                    </div>
                    {approval.reason ? (
                      <div className="text-[11px] text-muted-foreground">{approval.reason}</div>
                    ) : null}
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2">
              {data.timeline.map((entry) => (
                <li key={entry.id} className="flex items-start gap-2 text-sm">
                  <Clock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div>
                    <span>{entry.description}</span>
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      {formatDateTime(entry.createdAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
