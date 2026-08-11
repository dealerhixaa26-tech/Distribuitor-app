'use client';

import { PERMISSIONS } from '@hixaa/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/form/form-dialog';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';

/**
 * What can be done to a quotation, from the record itself (ADR-0025).
 *
 * Availability is keyed on STATUS, listed per action, because a quotation's
 * verbs are not a single transition table: revising an accepted quotation
 * creates a new revision rather than moving a status, and converting to an
 * order is a different resource entirely.
 */

type ActionKey = 'send' | 'accept' | 'reject' | 'revise' | 'convert';

interface ActionSpec {
  key: ActionKey;
  label: string;
  from: readonly string[];
  permission: string;
  title: string;
  consequence: string;
  destructive?: boolean;
  reason?: { label: string; min: number; help?: string };
  recipients?: boolean;
  /** POSTs elsewhere and lands on a different record. */
  convert?: boolean;
}

const ACTIONS: ActionSpec[] = [
  {
    key: 'send',
    label: 'Send',
    from: ['DRAFT', 'SENT'],
    permission: PERMISSIONS.QUOTATION_SEND,
    title: 'Send this quotation',
    consequence:
      'Emails the PDF to the party’s contacts and marks it SENT. The mail goes through the outbox, so it is queued rather than sent on this request (ADR-0005).',
    recipients: true,
  },
  {
    key: 'accept',
    label: 'Mark accepted',
    from: ['SENT'],
    permission: PERMISSIONS.QUOTATION_UPDATE,
    title: 'Mark this quotation accepted',
    consequence:
      'Records that the partner agreed. It does not create an order — converting is a separate step that re-prices, so the order reflects today’s data rather than a stale number.',
  },
  {
    key: 'reject',
    label: 'Mark rejected',
    from: ['SENT'],
    permission: PERMISSIONS.QUOTATION_UPDATE,
    title: 'Mark this quotation rejected',
    consequence: 'Closes the quotation. A revision can still be raised from it.',
    destructive: true,
    reason: { label: 'Why was it rejected?', min: 5, help: 'Shown on the follow-up list.' },
  },
  {
    key: 'revise',
    label: 'Revise',
    from: ['SENT', 'REJECTED', 'EXPIRED'],
    permission: PERMISSIONS.QUOTATION_UPDATE,
    title: 'Raise a revision',
    consequence:
      'Creates the next revision of this quotation, carrying its lines forward. The original is kept — what was offered before is part of the negotiation record.',
  },
  {
    key: 'convert',
    label: 'Convert to order',
    from: ['ACCEPTED'],
    permission: PERMISSIONS.QUOTATION_CONVERT,
    title: 'Convert to an order',
    consequence:
      'Creates a DRAFT order from these lines, RE-PRICED as it converts rather than carrying a possibly stale number forward. Every input to a price is mutable by design (ADR-0011).',
    convert: true,
  },
];

export function QuotationActions({
  quotationId,
  status,
}: {
  quotationId: string;
  status: string;
}) {
  const { can } = usePermission();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [active, setActive] = React.useState<ActionSpec | null>(null);
  const [reason, setReason] = React.useState('');
  const [recipients, setRecipients] = React.useState('');
  const [failure, setFailure] = React.useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = React.useState('');

  const close = () => {
    setActive(null);
    setReason('');
    setRecipients('');
    setFailure(null);
  };

  const run = useMutation({
    mutationFn: (spec: ActionSpec) => {
      if (spec.convert) {
        return api.post<{ id: string }>(
          `/orders/from-quotation/${quotationId}`,
          {},
          { idempotencyKey },
        );
      }
      const body: Record<string, unknown> = {};
      if (spec.reason) body.reason = reason;
      if (spec.recipients && recipients.trim()) {
        body.to = recipients
          .split(',')
          .map((address) => address.trim())
          .filter(Boolean);
      }
      return api.post<{ id: string }>(`/quotations/${quotationId}/${spec.key}`, body, {
        idempotencyKey,
      });
    },
    onSuccess: async (result, spec) => {
      await queryClient.invalidateQueries({ queryKey: ['quotations'] });
      if (spec.convert) {
        await queryClient.invalidateQueries({ queryKey: ['orders'] });
        toast.success('Order drafted from this quotation');
        router.push(`/orders/${result.id}`);
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
    (spec) => can(spec.permission as never) && spec.from.includes(status),
  );

  const reasonTooShort = Boolean(active?.reason) && reason.trim().length < (active?.reason?.min ?? 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {can(PERMISSIONS.QUOTATION_UPDATE) && status === 'DRAFT' ? (
        <Button variant="outline" size="sm" asChild>
          <Link href={`/quotations/${quotationId}/edit`}>
            <Pencil aria-hidden="true" />
            Edit
          </Link>
        </Button>
      ) : null}

      <Button variant="outline" size="sm" asChild>
        <a href={`/api/bff/quotations/${quotationId}/pdf`} target="_blank" rel="noreferrer">
          <Download aria-hidden="true" />
          PDF
        </a>
      </Button>

      {available.map((spec) => (
        <Button
          key={spec.key}
          size="sm"
          variant={spec.destructive ? 'destructive' : 'outline'}
          onClick={() => {
            setActive(spec);
            setReason('');
            setRecipients('');
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
          confirmDisabled={reasonTooShort}
          onConfirm={() => run.mutate(active)}
        >
          {active.recipients ? (
            <div className="space-y-1.5">
              <label htmlFor="quotation-recipients" className="block text-sm font-medium">
                Recipients
              </label>
              <Input
                id="quotation-recipients"
                value={recipients}
                onChange={(event) => setRecipients(event.target.value)}
                placeholder="leave blank for the primary contact"
                aria-describedby="quotation-recipients-help"
              />
              <p id="quotation-recipients-help" className="text-xs text-muted-foreground">
                Comma-separated. Blank uses the party’s primary contact — neither distributor nor
                customer carries a top-level email, so recipients resolve through the contact tables.
              </p>
            </div>
          ) : null}

          {active.reason ? (
            <div className="space-y-1.5">
              <label htmlFor="quotation-reason" className="block text-sm font-medium">
                {active.reason.label}
                <span className="ml-0.5 text-destructive" aria-hidden="true">
                  *
                </span>
                <span className="sr-only"> (required)</span>
              </label>
              <Textarea
                id="quotation-reason"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                aria-invalid={reasonTooShort && reason.length > 0}
                aria-describedby="quotation-reason-help"
              />
              <p id="quotation-reason-help" className="text-xs text-muted-foreground">
                {active.reason.help ?? `At least ${active.reason.min} characters.`}
              </p>
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
