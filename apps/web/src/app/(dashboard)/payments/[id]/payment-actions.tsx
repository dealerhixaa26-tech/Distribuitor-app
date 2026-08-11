'use client';

import { PERMISSIONS } from '@hixaa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/form/form-dialog';
import { MoneyInput } from '@/components/form/money-input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';
import { formatDate, formatMoney } from '@/lib/utils';

/**
 * Verify, allocate, bounce.
 *
 * ADR-0018: verifying is the financial event. Recording is a memo; verification
 * writes the ledger entries and is what allows allocation. The API refuses
 * self-verification outright, so the button is offered and the refusal is the
 * control — this screen does not try to predict it, because a UI that guesses
 * at a server rule is a second copy of that rule.
 *
 * Allocation is offered on the same dialog as verification because the two
 * happen in one transaction when both are supplied. That is a convenience, not
 * a shortcut past the control: nothing is allocated while the receipt is
 * RECORDED.
 */

interface OpenInvoice {
  id: string;
  number: string | null;
  invoiceDate: string;
  grandTotal: string;
  amountOutstanding: string;
}

export function PaymentActions({
  paymentId,
  status,
  distributorId,
  customerId,
  unallocatedAmount,
  recordedById,
}: {
  paymentId: string;
  status: string;
  distributorId: string | null;
  customerId: string | null;
  unallocatedAmount: string;
  recordedById: string | null;
}) {
  const { can, user } = usePermission();
  const queryClient = useQueryClient();
  const [active, setActive] = React.useState<'verify' | 'allocate' | 'bounce' | null>(null);
  const [note, setNote] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = React.useState('');

  // The open invoices this receipt could settle. Fetched only when a dialog
  // that needs them is open.
  const openInvoices = useQuery({
    queryKey: ['invoices', 'open', distributorId, customerId],
    queryFn: () =>
      api.get<{ data: OpenInvoice[] }>('/invoices', {
        query: {
          distributorId: distributorId ?? undefined,
          customerId: customerId ?? undefined,
          // `outstandingOnly` — the collections worklist — not a list of
          // statuses. `status` takes a single enum or an array, and `apiFetch`
          // serialises arrays as CSV, which this endpoint refuses with a 422.
          // Enumerating statuses would also drift from whatever "not settled"
          // means; the server already has a name for it.
          outstandingOnly: true,
          limit: 50,
        },
      }),
    enabled: active === 'verify' || active === 'allocate',
  });

  const invoices = openInvoices.data?.data ?? [];

  const close = () => {
    setActive(null);
    setNote('');
    setReason('');
    setAmounts({});
    setFailure(null);
  };

  const allocations = Object.entries(amounts)
    .filter(([, amount]) => amount && Number(amount) > 0)
    .map(([invoiceId, amount]) => ({ invoiceId, amount }));

  const allocatedTotal = allocations.reduce((sum, a) => sum + Number(a.amount), 0);
  const overAllocated = allocatedTotal > Number(unallocatedAmount) + 0.0001;

  const run = useMutation({
    mutationFn: (action: 'verify' | 'allocate' | 'bounce') => {
      const body: Record<string, unknown> = {};
      if (action === 'verify') {
        if (note.trim()) body.verificationNote = note.trim();
        if (allocations.length) body.allocations = allocations;
      }
      if (action === 'allocate') body.allocations = allocations;
      if (action === 'bounce') body.reason = reason.trim();
      return api.post(`/payments/${paymentId}/${action}`, body, { idempotencyKey });
    },
    onSuccess: async (_result, action) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['payments'] }),
        queryClient.invalidateQueries({ queryKey: ['invoices'] }),
        queryClient.invalidateQueries({ queryKey: ['outstanding'] }),
      ]);
      toast.success(
        action === 'verify'
          ? 'Receipt verified — the ledger has been posted'
          : action === 'allocate'
            ? 'Receipt applied'
            : 'Receipt marked bounced',
      );
      close();
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? error.problem.detail : 'Could not reach the server.');
    },
  });

  const open = (action: 'verify' | 'allocate' | 'bounce') => {
    setActive(action);
    setNote('');
    setReason('');
    setAmounts({});
    setFailure(null);
    setIdempotencyKey(crypto.randomUUID());
  };

  const isRecorder = Boolean(recordedById && user?.id && recordedById === user.id);
  const canVerify = can(PERMISSIONS.PAYMENT_VERIFY) && status === 'RECORDED';
  const canAllocate =
    can(PERMISSIONS.PAYMENT_ALLOCATE) && status === 'VERIFIED' && Number(unallocatedAmount) > 0;
  const canBounce =
    can(PERMISSIONS.PAYMENT_VERIFY) && (status === 'RECORDED' || status === 'VERIFIED');

  const allocationGrid = (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        Apply to invoices
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {formatMoney(unallocatedAmount)} available
        </span>
      </p>

      {openInvoices.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading open invoices…</p>
      ) : openInvoices.isError ? (
        // Distinct from "none found". Rendering the empty state for a FAILED
        // query said "this party has no open invoices" when the request had
        // actually been refused — a wrong answer stated confidently.
        <p role="alert" className="text-xs text-destructive">
          Could not load open invoices
          {openInvoices.error instanceof ApiError ? `: ${openInvoices.error.problem.detail}` : '.'}{' '}
          Verify without allocating, then apply the receipt once this is working.
        </p>
      ) : invoices.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This party has no open invoices. The receipt can still be verified — the money sits
          unallocated until there is something to settle.
        </p>
      ) : (
        <ul className="max-h-56 space-y-1.5 overflow-y-auto">
          {invoices.map((invoice) => (
            <li key={invoice.id} className="flex items-center gap-2 rounded-md border border-border p-2">
              <div className="min-w-0 flex-1">
                <label htmlFor={`alloc-${invoice.id}`} className="block truncate text-xs font-medium">
                  {invoice.number ?? 'Draft'}
                </label>
                <span className="text-[11px] text-muted-foreground">
                  {formatDate(invoice.invoiceDate)} · {formatMoney(invoice.amountOutstanding)} due
                </span>
              </div>
              <MoneyInput
                id={`alloc-${invoice.id}`}
                className="w-28"
                value={amounts[invoice.id] ?? ''}
                onChange={(event) =>
                  setAmounts((previous) => ({ ...previous, [invoice.id]: event.target.value }))
                }
              />
              <button
                type="button"
                onClick={() =>
                  setAmounts((previous) => ({
                    ...previous,
                    [invoice.id]: String(
                      Math.min(Number(invoice.amountOutstanding), Number(unallocatedAmount)),
                    ),
                  }))
                }
                className="rounded border border-border px-1.5 py-1 text-[11px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Fill
              </button>
            </li>
          ))}
        </ul>
      )}

      {overAllocated ? (
        <p role="alert" className="text-xs text-destructive">
          {formatMoney(String(allocatedTotal))} allocated exceeds the {formatMoney(unallocatedAmount)}{' '}
          available.
        </p>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {can(PERMISSIONS.PAYMENT_UPDATE) && status === 'RECORDED' ? (
        <Button variant="outline" size="sm" asChild>
          <Link href={`/payments/${paymentId}/edit`}>
            <Pencil aria-hidden="true" />
            Edit
          </Link>
        </Button>
      ) : null}

      {canVerify ? (
        <Button size="sm" onClick={() => open('verify')}>
          Verify
        </Button>
      ) : null}

      {canAllocate ? (
        <Button variant="outline" size="sm" onClick={() => open('allocate')}>
          Apply to invoices
        </Button>
      ) : null}

      {canBounce ? (
        <Button variant="destructive" size="sm" onClick={() => open('bounce')}>
          Mark bounced
        </Button>
      ) : null}

      {active === 'verify' ? (
        <ConfirmDialog
          open
          onOpenChange={(isOpen) => !isOpen && close()}
          title="Verify this receipt"
          consequence="This is the financial event: it writes the ledger entries and settles whatever you apply it to, in one transaction. The verifier is taken from your session and may not be the person who recorded it."
          confirmLabel="Verify"
          loading={run.isPending}
          error={failure}
          confirmDisabled={overAllocated}
          onConfirm={() => run.mutate('verify')}
        >
          {/* Said plainly, but NOT enforced here — the API refuses it, and that
              refusal is the control. A disabled button would merely hide it. */}
          {isRecorder ? (
            <p
              role="status"
              className="mb-3 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs"
            >
              You recorded this receipt. Verification by the recorder is refused — someone else has
              to confirm it against the bank.
            </p>
          ) : null}

          <div className="mb-4 space-y-1.5">
            <label htmlFor="verify-note" className="block text-sm font-medium">
              What did you match it against?
              <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id="verify-note"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="statement line, UTR, deposit slip…"
            />
          </div>

          {allocationGrid}
        </ConfirmDialog>
      ) : null}

      {active === 'allocate' ? (
        <ConfirmDialog
          open
          onOpenChange={(isOpen) => !isOpen && close()}
          title="Apply this receipt"
          consequence="Settles the invoices you choose against the verified money. Per-invoice outstanding is materialised, so the aging report moves with it."
          confirmLabel="Apply"
          loading={run.isPending}
          error={failure}
          confirmDisabled={overAllocated || allocations.length === 0}
          onConfirm={() => run.mutate('allocate')}
        >
          {allocationGrid}
        </ConfirmDialog>
      ) : null}

      {active === 'bounce' ? (
        <ConfirmDialog
          open
          onOpenChange={(isOpen) => !isOpen && close()}
          title="Mark this receipt bounced"
          consequence="Reverses any ledger effect and puts the amount back on the party's account as owed. The reason appears on their statement."
          confirmLabel="Mark bounced"
          destructive
          loading={run.isPending}
          error={failure}
          confirmDisabled={reason.trim().length < 5}
          onConfirm={() => run.mutate('bounce')}
        >
          <div className="space-y-1.5">
            <label htmlFor="bounce-reason" className="block text-sm font-medium">
              Why did it bounce?
              <span className="ml-0.5 text-destructive" aria-hidden="true">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </label>
            <Textarea
              id="bounce-reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={reason.length > 0 && reason.trim().length < 5}
              aria-describedby="bounce-reason-help"
            />
            <p id="bounce-reason-help" className="text-xs text-muted-foreground">
              At least five characters — the partner&rsquo;s ledger will show this.
            </p>
          </div>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
