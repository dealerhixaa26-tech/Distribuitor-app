'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Download, FileText, Receipt } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { formatDate, formatMoney, humanizeEnum } from '@/lib/utils';

/**
 * Invoice detail.
 *
 * Three things this screen must make obvious, because they are what people
 * actually come here to find out:
 *
 *   • **What is still owed**, and how old it is. Overdue is computed from the
 *     due date at read time, so it cannot be stale.
 *   • **How it was settled** — which receipts, and how much of each was TDS
 *     rather than cash. They reconcile against different statements.
 *   • **What corrected it.** An issued invoice is immutable, so any change to
 *     the amount owed is a credit or debit note, and it should be visible here
 *     rather than requiring a search.
 */
interface InvoiceDetail {
  id: string;
  number: string | null;
  status: string;
  supplyType: string;
  isReverseCharge: boolean;
  counterpartyName: string;
  counterpartyGstin: string | null;
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  isInterState: boolean;
  orderId: string | null;
  orderNumber: string | null;
  invoiceDate: string;
  dueDate: string | null;
  paymentTermsCode: string | null;
  taxableValue: string;
  totalCgst: string;
  totalSgst: string;
  totalIgst: string;
  totalCess: string;
  totalTax: string;
  roundOff: string;
  grandTotal: string;
  amountPaid: string;
  amountCredited: string;
  amountOutstanding: string;
  isOverdue: boolean;
  daysPastDue: number;
  cancelledReason: string | null;
  lines: Array<{
    id: string;
    lineNumber: number;
    sku: string;
    description: string;
    quantity: string;
    uomCode: string | null;
    unitPrice: string;
    discountPercent: string;
    hsnSacCode: string | null;
    gstRate: string;
    cgst: string;
    sgst: string;
    igst: string;
    lineTotal: string;
    taxRateId: string | null;
  }>;
  settlements: Array<{
    paymentId: string;
    paymentNumber: string;
    paymentDate: string;
    method: string;
    amount: string;
    tdsPortion: string;
    referenceNumber: string | null;
  }>;
  taxNotes: Array<{
    id: string;
    type: string;
    number: string | null;
    status: string;
    reason: string;
    noteDate: string;
    grandTotal: string;
  }>;
}

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data, isLoading, error } = useQuery({
    // `apiFetch` already unwraps the `{ data }` envelope for a SINGLE resource —
    // it returns the envelope whole only when `meta` is present. Adding
    // `.then(r => r.data)` here yields undefined against a 200 (HANDOFF §4.10).
    queryKey: ['invoice', id],
    queryFn: () => api.get<InvoiceDetail>(`/invoices/${id}`),
  });

  if (isLoading) return <TableSkeleton />;

  if (error || !data) {
    return (
      <EmptyState
        icon={FileText}
        title="Invoice not found"
        description={
          error instanceof ApiError
            ? error.problem.detail
            : 'It may have been removed, or lie outside your territory.'
        }
      />
    );
  }

  const isDraft = data.status === 'DRAFT';

  return (
    <>
      <Link
        href="/invoices"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Invoices
      </Link>

      <PageHeader
        title={data.number ?? 'Draft invoice'}
        description={`${data.counterpartyName} · ${data.counterpartyGstin ?? 'Unregistered'}`}
        actions={
          <a
            href={`/api/v1/invoices/${data.id}/pdf`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            <Download className="size-4" aria-hidden="true" />
            PDF
          </a>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge status={data.status} />
        <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {data.supplyType}
        </span>
        <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {data.isInterState ? 'Inter-state · IGST' : 'Intra-state · CGST + SGST'}
        </span>
        {data.isReverseCharge ? (
          <span className="rounded-md border border-warning px-2 py-0.5 text-xs text-warning">
            Reverse charge
          </span>
        ) : null}
        {data.isOverdue ? (
          <span className="flex items-center gap-1 rounded-md bg-destructive px-2 py-0.5 text-xs text-destructive-foreground">
            <AlertTriangle className="size-3" aria-hidden="true" />
            {data.daysPastDue} days overdue
          </span>
        ) : null}
      </div>

      {isDraft ? (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          This invoice has <strong>not been issued</strong>. No statutory number has been allocated,
          and it can still be edited or deleted. Issuing is irreversible.
        </div>
      ) : null}

      {data.cancelledReason ? (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <strong>Cancelled:</strong> {data.cancelledReason}. The number is retained and still
          reported as cancelled — it has not been reissued.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Invoice date" value={formatDate(data.invoiceDate)} />
            <Row
              label="Due date"
              value={data.dueDate ? formatDate(data.dueDate) : 'On receipt'}
            />
            <Row label="Terms" value={data.paymentTermsCode ?? '—'} />
            <Row label="Place of supply" value={data.placeOfSupplyStateCode} />
            <Row
              label="Order"
              value={
                data.orderId && data.orderNumber ? (
                  <Link href={`/orders/${data.orderId}`} className="text-primary hover:underline">
                    {data.orderNumber}
                  </Link>
                ) : (
                  'Direct invoice'
                )
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Amounts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Taxable value" value={`₹${formatMoney(data.taxableValue)}`} />
            {data.isInterState ? (
              <Row label="IGST" value={`₹${formatMoney(data.totalIgst)}`} />
            ) : (
              <>
                <Row label="CGST" value={`₹${formatMoney(data.totalCgst)}`} />
                <Row label="SGST" value={`₹${formatMoney(data.totalSgst)}`} />
              </>
            )}
            {data.roundOff !== '0.0000' ? (
              <Row label="Round off" value={`₹${formatMoney(data.roundOff)}`} />
            ) : null}
            <Row label="Total" value={`₹${formatMoney(data.grandTotal)}`} strong />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Settlement</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Paid" value={`₹${formatMoney(data.amountPaid)}`} />
            <Row label="Credited" value={`₹${formatMoney(data.amountCredited)}`} />
            <Row
              label="Outstanding"
              value={`₹${formatMoney(data.amountOutstanding)}`}
              strong
            />
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Invoice lines</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3">#</th>
                  <th scope="col" className="py-2 pr-3">Description</th>
                  <th scope="col" className="py-2 pr-3">HSN/SAC</th>
                  <th scope="col" className="py-2 pr-3 text-right">Qty</th>
                  <th scope="col" className="py-2 pr-3 text-right">Rate</th>
                  <th scope="col" className="py-2 pr-3 text-right">GST %</th>
                  <th scope="col" className="py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((line) => (
                  <tr key={line.id} className="border-b border-border/50">
                    <td className="py-2 pr-3 text-muted-foreground">{line.lineNumber}</td>
                    <td className="py-2 pr-3">
                      <div>{line.description}</div>
                      <div className="text-[11px] text-muted-foreground">{line.sku}</div>
                    </td>
                    <td className="py-2 pr-3">
                      {line.hsnSacCode ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-2 pr-3 text-right tabular">
                      {formatMoney(line.quantity)} {line.uomCode ?? ''}
                    </td>
                    <td className="py-2 pr-3 text-right tabular">
                      ₹{formatMoney(line.unitPrice)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular">{line.gstRate}</td>
                    <td className="py-2 text-right tabular">₹{formatMoney(line.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>How it was settled</CardTitle>
          </CardHeader>
          <CardContent>
            {data.settlements.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing applied yet. Only a verified receipt can be allocated.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.settlements.map((settlement) => (
                  <li
                    key={settlement.paymentId}
                    className="flex items-start justify-between gap-3 border-b border-border/50 pb-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Receipt className="size-3.5 text-muted-foreground" aria-hidden="true" />
                        <span className="font-medium">{settlement.paymentNumber}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {formatDate(settlement.paymentDate)} · {humanizeEnum(settlement.method)}
                        {settlement.referenceNumber ? ` · ${settlement.referenceNumber}` : ''}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="tabular">₹{formatMoney(settlement.amount)}</div>
                      {/* TDS is called out because it is recoverable from the
                          government rather than cash in the bank. */}
                      {settlement.tdsPortion !== '0.0000' ? (
                        <div className="text-[11px] text-muted-foreground">
                          incl. ₹{formatMoney(settlement.tdsPortion)} TDS
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Corrections</CardTitle>
          </CardHeader>
          <CardContent>
            {data.taxNotes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                None. An issued invoice cannot be edited — a correction is a credit or debit note
                under CGST s.34.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.taxNotes.map((note) => (
                  <li
                    key={note.id}
                    className="flex items-start justify-between gap-3 border-b border-border/50 pb-2"
                  >
                    <div className="min-w-0">
                      <div className="font-medium">
                        {note.number ?? 'Draft'}{' '}
                        <span className="text-xs text-muted-foreground">
                          {note.type === 'CREDIT' ? 'credit note' : 'debit note'}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {formatDate(note.noteDate)} · {humanizeEnum(note.reason)}
                      </div>
                    </div>
                    <div className="text-right tabular">
                      {note.type === 'CREDIT' ? '−' : '+'}₹{formatMoney(note.grandTotal)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? 'font-semibold tabular' : 'tabular'}>{value}</span>
    </div>
  );
}
