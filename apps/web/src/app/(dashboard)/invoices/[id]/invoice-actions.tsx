'use client';

import { PERMISSIONS } from '@hixaa/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/form/form-dialog';
import { DateInput } from '@/components/form/money-input';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';

/**
 * Issuing, sending and cancelling an invoice.
 *
 * ⚠️ **Issuing is the one irreversible button in this application.** It
 * allocates the next number from a gapless statutory series and posts to the
 * ledger. A GST series cannot be renumbered, so a number consumed by mistake
 * is a number that must be accounted for — there is no undo, only a credit
 * note. The dialog says so in those words rather than asking "Are you sure?".
 *
 * `issue` is guarded on `status === 'DRAFT'`, never on the transition table:
 * `PAID → ISSUED` is a legitimate MOVE (a credit note can leave a paid invoice
 * unsettled again), and guarding the ACTION with it once let a PAID invoice
 * burn a second number before the database trigger rejected it — a 500 with a
 * gap in the series (HANDOFF §4.21).
 */

export function InvoiceActions({
  invoiceId,
  status,
  number,
}: {
  invoiceId: string;
  status: string;
  number: string | null;
}) {
  const { can } = usePermission();
  const queryClient = useQueryClient();
  const [active, setActive] = React.useState<'issue' | 'send' | 'cancel' | null>(null);
  const [reason, setReason] = React.useState('');
  const [recipients, setRecipients] = React.useState('');
  const [invoiceDate, setInvoiceDate] = React.useState('');
  const [failure, setFailure] = React.useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = React.useState('');

  const close = () => {
    setActive(null);
    setReason('');
    setRecipients('');
    setInvoiceDate('');
    setFailure(null);
  };

  const run = useMutation({
    mutationFn: (action: 'issue' | 'send' | 'cancel') => {
      const body: Record<string, unknown> = {};
      if (action === 'issue' && invoiceDate) body.invoiceDate = invoiceDate;
      if (action === 'cancel') body.reason = reason;
      if (action === 'send' && recipients.trim()) {
        body.to = recipients.split(',').map((a) => a.trim()).filter(Boolean);
      }
      return api.post(`/invoices/${invoiceId}/${action}`, body, { idempotencyKey });
    },
    onSuccess: async (_result, action) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['invoices'] }),
        queryClient.invalidateQueries({ queryKey: ['outstanding'] }),
      ]);
      toast.success(
        action === 'issue'
          ? 'Invoice issued — a statutory number has been allocated'
          : action === 'send'
            ? 'Invoice queued for sending'
            : 'Invoice cancelled',
      );
      close();
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? error.problem.detail : 'Could not reach the server.');
    },
  });

  const open = (action: 'issue' | 'send' | 'cancel') => {
    setActive(action);
    setReason('');
    setRecipients('');
    setInvoiceDate('');
    setFailure(null);
    setIdempotencyKey(crypto.randomUUID());
  };

  const cancelReasonTooShort = active === 'cancel' && reason.trim().length < 5;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" asChild>
        <a href={`/api/bff/invoices/${invoiceId}/pdf`} target="_blank" rel="noreferrer">
          <Download aria-hidden="true" />
          PDF
        </a>
      </Button>

      {can(PERMISSIONS.INVOICE_ISSUE) && status === 'DRAFT' ? (
        <Button size="sm" onClick={() => open('issue')}>
          Issue
        </Button>
      ) : null}

      {can(PERMISSIONS.INVOICE_SEND) && status !== 'DRAFT' && status !== 'CANCELLED' ? (
        <Button variant="outline" size="sm" onClick={() => open('send')}>
          Send
        </Button>
      ) : null}

      {can(PERMISSIONS.INVOICE_CANCEL) && status !== 'CANCELLED' && status !== 'PAID' ? (
        <Button variant="destructive" size="sm" onClick={() => open('cancel')}>
          Cancel
        </Button>
      ) : null}

      {active === 'issue' ? (
        <ConfirmDialog
          open
          onOpenChange={(isOpen) => !isOpen && close()}
          title="Issue this invoice"
          consequence="This allocates the next number from the gapless GST series and posts the claim to the ledger. A statutory series cannot be renumbered, so the number is consumed whether or not the invoice was correct — the only way back is a credit note. The claim itself becomes immutable, enforced by a database trigger."
          confirmLabel="Issue invoice"
          loading={run.isPending}
          error={failure}
          onConfirm={() => run.mutate('issue')}
        >
          <div className="space-y-1.5">
            <label htmlFor="invoice-date" className="block text-sm font-medium">
              Invoice date
              <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>
            </label>
            <DateInput
              id="invoice-date"
              value={invoiceDate}
              onChange={(event) => setInvoiceDate(event.target.value)}
              aria-describedby="invoice-date-help"
            />
            <p id="invoice-date-help" className="text-xs text-muted-foreground">
              Blank uses today. The date decides which GST return period the invoice falls in, so
              backdating across a filing boundary is not something to do casually.
            </p>
          </div>
        </ConfirmDialog>
      ) : null}

      {active === 'send' ? (
        <ConfirmDialog
          open
          onOpenChange={(isOpen) => !isOpen && close()}
          title={`Send ${number ?? 'this invoice'}`}
          consequence="Emails the PDF to the party's contacts. It goes through the outbox, so it is queued rather than sent on this request — no third-party call ever sits on a request path (ADR-0005)."
          confirmLabel="Send"
          loading={run.isPending}
          error={failure}
          onConfirm={() => run.mutate('send')}
        >
          <div className="space-y-1.5">
            <label htmlFor="invoice-recipients" className="block text-sm font-medium">
              Recipients
            </label>
            <Input
              id="invoice-recipients"
              value={recipients}
              onChange={(event) => setRecipients(event.target.value)}
              placeholder="leave blank for the primary contact"
              aria-describedby="invoice-recipients-help"
            />
            <p id="invoice-recipients-help" className="text-xs text-muted-foreground">
              Comma-separated. Blank resolves through the party&rsquo;s contact records.
            </p>
          </div>
        </ConfirmDialog>
      ) : null}

      {active === 'cancel' ? (
        <ConfirmDialog
          open
          onOpenChange={(isOpen) => !isOpen && close()}
          title={`Cancel ${number ?? 'this invoice'}`}
          consequence="Reverses the ledger claim. The NUMBER is not released — a gapless series keeps its cancelled entries, and the return must still account for it."
          confirmLabel="Cancel invoice"
          destructive
          loading={run.isPending}
          error={failure}
          confirmDisabled={cancelReasonTooShort}
          onConfirm={() => run.mutate('cancel')}
        >
          <div className="space-y-1.5">
            <label htmlFor="invoice-cancel-reason" className="block text-sm font-medium">
              Why is it cancelled?
              <span className="ml-0.5 text-destructive" aria-hidden="true">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </label>
            <Textarea
              id="invoice-cancel-reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={cancelReasonTooShort && reason.length > 0}
              aria-describedby="invoice-cancel-help"
            />
            <p id="invoice-cancel-help" className="text-xs text-muted-foreground">
              At least five characters. This is what the auditor reads.
            </p>
          </div>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
