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
import { formatDate, formatMoney } from '@/lib/utils';
import { QuotationActions } from './quotation-actions';

interface QuotationLine {
  id: string;
  lineNumber: number;
  sku: string;
  description: string;
  hsnSacCode: string | null;
  uomCode: string | null;
  quantity: string;
  unitListPrice: string;
  unitPrice: string;
  discountAmount: string;
  discountPercent: string;
  taxableValue: string;
  gstRate: string;
  cgst: string;
  sgst: string;
  igst: string;
  totalTax: string;
  lineTotal: string;
  overrideReason: string | null;
}

interface QuotationDetail {
  id: string;
  number: string | null;
  status: string;
  revision: number;
  quotationDate: string;
  validUntil: string | null;
  isExpired: boolean;
  distributorId: string | null;
  distributorName: string | null;
  customerId: string | null;
  customerName: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  subtotal: string;
  totalDiscount: string;
  taxableValue: string;
  totalCgst: string;
  totalSgst: string;
  totalIgst: string;
  totalTax: string;
  roundOff: string;
  grandTotal: string;
  lineCount: number;
  lines: QuotationLine[];
  revisions?: Array<{ id: string; revision: number; status: string; number: string | null }>;
}

/**
 * A quotation, and what can be done to it.
 *
 * The lines show what the document was priced at — the SNAPSHOT, not a live
 * re-price. Every input to a price is mutable by design, so a document
 * re-priced against today's data is not what was agreed (ADR-0011). Re-pricing
 * happens only on conversion, and visibly.
 */
export default function QuotationDetailPage() {
  const params = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['quotations', params.id],
    queryFn: () => api.get<QuotationDetail>(`/quotations/${params.id}`),
  });

  if (isLoading) return <TableSkeleton />;

  if (error || !data) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Quotation not found"
        description={
          error instanceof ApiError
            ? error.problem.detail
            : 'It may have been removed, or lie outside your territory.'
        }
      />
    );
  }

  const party = data.distributorName ?? data.customerName ?? 'Unaddressed';
  const isInterState = Number(data.totalIgst) > 0;

  return (
    <>
      <Link
        href="/quotations"
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Quotations
      </Link>

      <PageHeader
        title={data.number ?? 'Draft quotation'}
        description={`${party} · ${formatDate(data.quotationDate)}${data.revision > 1 ? ` · revision ${data.revision}` : ''}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={data.status} />
            {data.isExpired && data.status !== 'ACCEPTED' ? (
              <StatusBadge status="EXPIRED" tone="warning" label="Lapsed" />
            ) : null}
            <QuotationActions quotationId={data.id} status={data.status} />
          </div>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Valid until</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {data.validUntil ? formatDate(data.validUntil) : 'not set'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Sent</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {data.sentAt ? formatDate(data.sentAt) : 'not yet'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Lines</CardTitle>
          </CardHeader>
          <CardContent className="text-sm tabular-nums">{data.lineCount}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Grand total</CardTitle>
          </CardHeader>
          <CardContent className="text-sm font-semibold tabular-nums">
            {formatMoney(data.grandTotal)}
          </CardContent>
        </Card>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[56rem] text-sm">
          <caption className="sr-only">Quotation lines, as priced when the document was raised</caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">#</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">Product</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Qty</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Unit</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Taxable</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Tax</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line) => (
              <tr key={line.id} className="border-t border-border">
                <td className="px-3 py-2 text-muted-foreground tabular-nums">{line.lineNumber}</td>
                <td className="px-3 py-2">
                  <div className="font-medium">{line.description}</div>
                  <div className="text-[11px] text-muted-foreground">
                    <code className="font-mono">{line.sku}</code>
                    {line.hsnSacCode ? ` · HSN/SAC ${line.hsnSacCode}` : null}
                  </div>
                  {line.overrideReason ? (
                    <div className="mt-0.5 text-[11px] text-warning">
                      Override: {line.overrideReason}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {Number(line.quantity)} {line.uomCode ?? ''}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <div>{formatMoney(line.unitPrice)}</div>
                  {Number(line.discountAmount) > 0 ? (
                    <div className="text-[11px] text-muted-foreground">
                      −{line.discountPercent}% off {formatMoney(line.unitListPrice)}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(line.taxableValue)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <div>{formatMoney(line.totalTax)}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {Number(line.igst) > 0 ? `IGST ${line.gstRate}%` : `C+S ${line.gstRate}%`}
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {formatMoney(line.lineTotal)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-border bg-muted/30">
            <tr>
              <td colSpan={4} className="px-3 py-2 text-right text-xs text-muted-foreground">
                Taxable value
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatMoney(data.taxableValue)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatMoney(data.totalTax)}</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">
                {formatMoney(data.grandTotal)}
              </td>
            </tr>
            <tr>
              <td colSpan={7} className="px-3 pb-2 text-right text-[11px] text-muted-foreground">
                {isInterState
                  ? `IGST ${formatMoney(data.totalIgst)} — inter-state supply`
                  : `CGST ${formatMoney(data.totalCgst)} + SGST ${formatMoney(data.totalSgst)} — intra-state supply`}
                {Number(data.roundOff) !== 0 ? ` · round-off ${formatMoney(data.roundOff)}` : null}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {data.revisions && data.revisions.length > 1 ? (
        <div className="mt-4">
          <h2 className="mb-2 text-sm font-semibold">Revisions</h2>
          <ul className="flex flex-wrap gap-2">
            {data.revisions.map((revision) => (
              <li key={revision.id}>
                <Link
                  href={`/quotations/${revision.id}`}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
                    revision.id === data.id
                      ? 'border-primary bg-accent'
                      : 'border-border hover:bg-accent'
                  }`}
                >
                  r{revision.revision} · {revision.number ?? 'draft'}
                  <StatusBadge status={revision.status} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
