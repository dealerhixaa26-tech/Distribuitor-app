'use client';

import { PERMISSIONS } from '@hixaa/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/form/form-dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';

/**
 * The order's verbs.
 *
 * `approve` is the one that matters: three gates in ONE transaction — the
 * credit limit, the discount ceiling, and stock reservation. A breach is
 * refused outright unless a Finance Manager supplies `creditOverrideReason`,
 * and supplying it does not authorise anything by itself; the service still
 * checks the caller's role. So the field is offered, and its absence is what
 * makes a refusal a refusal.
 */

type ActionKey = 'submit' | 'approve' | 'reject' | 'cancel' | 'reserve' | 'invoice';

interface ActionSpec {
  key: ActionKey;
  label: string;
  from: readonly string[];
  permission: string;
  title: string;
  consequence: string;
  destructive?: boolean;
  reason?: { field: string; label: string; min: number; help: string };
  /** Optional free-text that turns a refusal into an accepted exception. */
  override?: { field: string; label: string; min: number; help: string };
  /** POSTs elsewhere and lands on a different record. */
  createsInvoice?: boolean;
  /** Hidden for order types the action does not apply to. */
  notForType?: string;
}

const ACTIONS: ActionSpec[] = [
  {
    key: 'submit',
    label: 'Submit for approval',
    from: ['DRAFT'],
    permission: PERMISSIONS.ORDER_SUBMIT,
    title: 'Submit this order',
    consequence:
      'Sends it for approval. Nothing is reserved yet — stock is committed when it is approved.',
  },
  {
    key: 'approve',
    label: 'Approve',
    from: ['PENDING_APPROVAL'],
    permission: PERMISSIONS.ORDER_APPROVE,
    title: 'Approve this order',
    consequence:
      'Checks the credit limit and the discount ceilings, then reserves what is in stock and BACKORDERS the rest — all in one transaction. Dispatch is then blocked per line until each is filled.',
    override: {
      field: 'creditOverrideReason',
      label: 'Credit override reason',
      min: 10,
      help: 'Only needed if the order breaches the credit limit, and only a Finance Manager or above may supply it. Leave blank otherwise — a breach without this is refused outright.',
    },
  },
  {
    key: 'reject',
    label: 'Reject',
    from: ['PENDING_APPROVAL'],
    permission: PERMISSIONS.ORDER_REJECT,
    title: 'Reject this order',
    consequence: 'Sends it back. Nothing is reserved and nothing is cancelled.',
    destructive: true,
    reason: {
      field: 'reason',
      label: 'Why is it rejected?',
      min: 5,
      help: 'Visible to whoever raised it.',
    },
  },
  {
    key: 'cancel',
    label: 'Cancel',
    from: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_DISPATCHED'],
    permission: PERMISSIONS.ORDER_CANCEL,
    title: 'Cancel this order',
    consequence:
      'Releases any reservation back to available stock. Anything already dispatched stays dispatched — cancelling does not un-ship goods.',
    destructive: true,
    reason: {
      field: 'reason',
      label: 'Why is it cancelled?',
      min: 5,
      help: 'Recorded against the order.',
    },
  },
  {
    key: 'invoice',
    label: 'Create invoice',
    from: ['APPROVED', 'PARTIALLY_DISPATCHED', 'DISPATCHED', 'DELIVERED'],
    permission: PERMISSIONS.INVOICE_CREATE,
    title: 'Draft an invoice from this order',
    consequence:
      'Bills everything not yet invoiced, as a DRAFT — no statutory number is consumed until it is issued. The lines carry the pricing this order snapshotted, not today’s.',
    // A SECONDARY order is the DISTRIBUTOR's own sale to their customer, so
    // Hixaa has nothing to invoice. The API refuses it (409, proven in
    // phase-8-smoke); hiding the button here just avoids offering the refusal.
    notForType: 'SECONDARY',
    createsInvoice: true,
  },
  {
    key: 'reserve',
    label: 'Re-attempt reservation',
    from: ['APPROVED', 'PARTIALLY_DISPATCHED'],
    permission: PERMISSIONS.ORDER_APPROVE,
    title: 'Re-attempt the reservation',
    consequence:
      'Tries again to reserve what is still backordered. Deliberately manual: allocating scarce stock between waiting customers is a commercial judgement, not something a job should decide (ADR-0012 §4).',
  },
];

export function OrderActions({
  orderId,
  status,
  type,
}: {
  orderId: string;
  status: string;
  type: string;
}) {
  const { can } = usePermission();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [active, setActive] = React.useState<ActionSpec | null>(null);
  const [reason, setReason] = React.useState('');
  const [override, setOverride] = React.useState('');
  const [failure, setFailure] = React.useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = React.useState('');

  const close = () => {
    setActive(null);
    setReason('');
    setOverride('');
    setFailure(null);
  };

  const run = useMutation({
    mutationFn: (spec: ActionSpec) => {
      if (spec.createsInvoice) {
        return api.post<{ id: string }>(
          `/invoices/from-order/${orderId}`,
          {},
          { idempotencyKey },
        );
      }
      const body: Record<string, string> = {};
      if (spec.reason && reason.trim()) body[spec.reason.field] = reason.trim();
      if (spec.override && override.trim()) body[spec.override.field] = override.trim();
      return api.post(`/orders/${orderId}/${spec.key}`, body, { idempotencyKey });
    },
    onSuccess: async (result, spec) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        // Approval moves stock into reservation, so the inventory screens are
        // now stale too.
        queryClient.invalidateQueries({ queryKey: ['inventory'] }),
        queryClient.invalidateQueries({ queryKey: ['invoices'] }),
      ]);
      if (spec.createsInvoice) {
        toast.success('Invoice drafted — it consumes no number until issued');
        router.push(`/invoices/${(result as { id: string }).id}`);
      } else {
        toast.success(`${spec.label} — done`);
      }
      close();
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? error.problem.detail : 'Could not reach the server.');
    },
  });

  const available = ACTIONS.filter(
    (spec) =>
      can(spec.permission as never) &&
      spec.from.includes(status) &&
      spec.notForType !== type,
  );

  const reasonTooShort =
    Boolean(active?.reason) && reason.trim().length < (active?.reason?.min ?? 0);
  // An override is optional, but a token one is worse than none.
  const overrideTooShort =
    Boolean(active?.override) &&
    override.trim().length > 0 &&
    override.trim().length < (active?.override?.min ?? 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {can(PERMISSIONS.ORDER_UPDATE) && status === 'DRAFT' ? (
        <Button variant="outline" size="sm" asChild>
          <Link href={`/orders/${orderId}/edit`}>
            <Pencil aria-hidden="true" />
            Edit
          </Link>
        </Button>
      ) : null}

      {available.map((spec) => (
        <Button
          key={spec.key}
          size="sm"
          variant={spec.destructive ? 'destructive' : 'outline'}
          onClick={() => {
            setActive(spec);
            setReason('');
            setOverride('');
            setFailure(null);
            setIdempotencyKey(crypto.randomUUID());
          }}
        >
          {spec.label}
        </Button>
      ))}

      {active ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={active.title}
          consequence={active.consequence}
          confirmLabel={active.label}
          destructive={active.destructive}
          loading={run.isPending}
          error={failure}
          confirmDisabled={reasonTooShort || overrideTooShort}
          onConfirm={() => run.mutate(active)}
        >
          {active.reason ? (
            <div className="space-y-1.5">
              <label htmlFor="order-reason" className="block text-sm font-medium">
                {active.reason.label}
                <span className="ml-0.5 text-destructive" aria-hidden="true">
                  *
                </span>
                <span className="sr-only"> (required)</span>
              </label>
              <Textarea
                id="order-reason"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                aria-invalid={reasonTooShort && reason.length > 0}
                aria-describedby="order-reason-help"
              />
              <p id="order-reason-help" className="text-xs text-muted-foreground">
                {active.reason.help}
              </p>
            </div>
          ) : null}

          {active.override ? (
            <div className="space-y-1.5">
              <label htmlFor="order-override" className="block text-sm font-medium">
                {active.override.label}
                <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>
              </label>
              <Textarea
                id="order-override"
                rows={3}
                value={override}
                onChange={(event) => setOverride(event.target.value)}
                aria-invalid={overrideTooShort}
                aria-describedby="order-override-help"
              />
              <p id="order-override-help" className="text-xs text-muted-foreground">
                {active.override.help}
              </p>
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
