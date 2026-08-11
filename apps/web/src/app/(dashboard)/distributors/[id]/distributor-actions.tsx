'use client';

import { PERMISSIONS, canTransitionDistributor } from '@hixaa/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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

/**
 * The state transitions, as dialogs on the record they act on (ADR-0025).
 *
 * Which actions appear is decided by `canTransitionDistributor` — the
 * contract's own transition table, the same one the service enforces. A second
 * hand-written list of "what you can do from SUSPENDED" is how a UI comes to
 * offer a button the API refuses (HANDOFF §4.27).
 *
 * Note the asymmetry, which is deliberate and comes from §4.21: this table
 * governs STATUS MOVES. An action with side effects beyond the status — issuing
 * a document, burning a number — is guarded on its own precondition, never on
 * "is this transition legal".
 */

type ActionKey = 'submit' | 'approve' | 'suspend' | 'reactivate' | 'terminate' | 'credit';

interface ActionSpec {
  key: ActionKey;
  label: string;
  /** The status this moves the record to. Absent for credit-limit. */
  to?: 'PENDING_APPROVAL' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  /**
   * Statuses this action means something from, when that is narrower than the
   * transition table. Two actions can share a destination and mean different
   * things — the table cannot tell them apart, so it must not be asked to.
   */
  from?: readonly string[];
  permission: string;
  path: (id: string) => string;
  title: string;
  consequence: string;
  destructive?: boolean;
  /** A reason the API requires, and its minimum length. */
  reason?: { label: string; min: number; help?: string };
  amount?: boolean;
}

const ACTIONS: ActionSpec[] = [
  {
    key: 'submit',
    label: 'Submit for approval',
    to: 'PENDING_APPROVAL',
    permission: PERMISSIONS.DISTRIBUTOR_UPDATE,
    path: (id) => `/distributors/${id}/submit`,
    title: 'Submit for approval',
    consequence:
      'Sends this partner for review. They still cannot transact until someone approves them.',
  },
  {
    key: 'approve',
    label: 'Approve',
    to: 'ACTIVE',
    permission: PERMISSIONS.DISTRIBUTOR_APPROVE,
    path: (id) => `/distributors/${id}/approve`,
    title: 'Approve this distributor',
    consequence:
      'Makes the partner ACTIVE, which is the only status that may transact. Refused while KYC is outstanding — a GST certificate, a PAN, and a signed agreement are the minimum for a compliant invoice.',
  },
  {
    key: 'suspend',
    label: 'Suspend',
    to: 'SUSPENDED',
    permission: PERMISSIONS.DISTRIBUTOR_APPROVE,
    path: (id) => `/distributors/${id}/suspend`,
    title: 'Suspend this distributor',
    consequence:
      'Stops new orders immediately. Existing orders and invoices are untouched — this is not a cancellation.',
    destructive: true,
    reason: { label: 'Reason', min: 3, help: 'Recorded against the partner and visible in the audit trail.' },
  },
  {
    key: 'reactivate',
    label: 'Reactivate',
    to: 'ACTIVE',
    // Narrower than the transition table allows. PENDING_APPROVAL → ACTIVE is
    // also legal, but reaching ACTIVE from there is an APPROVAL — it has to
    // check KYC. Offering both buttons here is what exposed the matching hole
    // in the service (§4.21).
    from: ['SUSPENDED'],
    permission: PERMISSIONS.DISTRIBUTOR_APPROVE,
    path: (id) => `/distributors/${id}/reactivate`,
    title: 'Reactivate this distributor',
    consequence: 'Lifts the suspension and allows new orders again.',
  },
  {
    key: 'terminate',
    label: 'Terminate',
    to: 'TERMINATED',
    permission: PERMISSIONS.DISTRIBUTOR_APPROVE,
    path: (id) => `/distributors/${id}/terminate`,
    title: 'Terminate this distributor',
    consequence:
      'Ends the relationship. TERMINATED is a terminal status — there is no transition out of it, and anything still owed remains owed.',
    destructive: true,
    reason: { label: 'Reason', min: 3 },
  },
  {
    key: 'credit',
    label: 'Change credit limit',
    permission: PERMISSIONS.DISTRIBUTOR_CREDIT_UPDATE,
    path: (id) => `/distributors/${id}/credit-limit`,
    title: 'Change the credit limit',
    consequence:
      'The limit is what stands between the company and unrecoverable exposure, so this is a separate audited action rather than part of the edit form.',
    reason: { label: 'Reason', min: 3, help: 'Required. Recorded with who changed it and when.' },
    amount: true,
  },
];

export function DistributorActions({
  distributorId,
  status,
  creditLimit,
}: {
  distributorId: string;
  status: string;
  creditLimit: string;
}) {
  const { can } = usePermission();
  const queryClient = useQueryClient();
  const [active, setActive] = React.useState<ActionSpec | null>(null);
  const [reason, setReason] = React.useState('');
  const [amount, setAmount] = React.useState(creditLimit);
  const [failure, setFailure] = React.useState<string | null>(null);

  const close = () => {
    setActive(null);
    setReason('');
    setFailure(null);
  };

  // One key per opened dialog, so pressing the button again after a timeout is
  // the same act rather than a second approval. Reset when a dialog opens.
  const idempotencyKey = React.useRef<string>('');

  const run = useMutation({
    mutationFn: (spec: ActionSpec) => {
      const body: Record<string, string> = {};
      if (spec.reason) body.reason = reason;
      if (spec.amount) body.creditLimit = amount;
      // `/approve` requires one (docs/03 §5); the others ignore it, so there is
      // no per-action list here to fall out of step with the server's.
      return api.post(spec.path(distributorId), body, {
        idempotencyKey: idempotencyKey.current,
      });
    },
    onSuccess: async (_result, spec) => {
      // Prefix match — reaches both the list and ['distributors', id].
      await queryClient.invalidateQueries({ queryKey: ['distributors'] });
      toast.success(`${spec.label} — done`);
      close();
    },
    onError: (error) => {
      // Kept in the dialog rather than a toast: the refusal usually names
      // something the user must now do (attach KYC, give a longer reason), and
      // a toast that vanishes takes the instruction with it.
      setFailure(
        error instanceof ApiError ? error.problem.detail : 'Could not reach the server.',
      );
    },
  });

  const available = ACTIONS.filter((spec) => {
    if (!can(spec.permission as never)) return false;
    if (spec.from && !spec.from.includes(status)) return false;
    // The contract's table decides the rest, not a hand-written status list.
    if (spec.to) return canTransitionDistributor(status as never, spec.to);
    // Credit limit is not a transition; it is meaningless once terminated.
    return status !== 'TERMINATED';
  });

  const reasonTooShort = Boolean(active?.reason) && reason.trim().length < (active?.reason?.min ?? 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {can(PERMISSIONS.DISTRIBUTOR_UPDATE) ? (
        <Button variant="outline" size="sm" asChild>
          <Link href={`/distributors/${distributorId}/edit`}>
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
            setAmount(creditLimit);
            setFailure(null);
            idempotencyKey.current = crypto.randomUUID();
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
          // Held back rather than left to fail: the API refuses a short reason
          // with a 422, and letting the user discover that after a round trip
          // teaches them nothing the field could not have said first.
          confirmDisabled={reasonTooShort}
          onConfirm={() => run.mutate(active)}
        >
          {active.amount ? (
            <div className="mb-4 space-y-1.5">
              <label htmlFor="credit-limit" className="block text-sm font-medium">
                New credit limit
              </label>
              <MoneyInput
                id="credit-limit"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">Currently {creditLimit}.</p>
            </div>
          ) : null}

          {active.reason ? (
            <div className="space-y-1.5">
              <label htmlFor="action-reason" className="block text-sm font-medium">
                {active.reason.label}
                <span className="ml-0.5 text-destructive" aria-hidden="true">
                  *
                </span>
                <span className="sr-only"> (required)</span>
              </label>
              <Textarea
                id="action-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                aria-invalid={reasonTooShort && reason.length > 0}
                aria-describedby="action-reason-help"
                rows={3}
              />
              <p id="action-reason-help" className="text-xs text-muted-foreground">
                {active.reason.help ?? `At least ${active.reason.min} characters.`}
              </p>
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
