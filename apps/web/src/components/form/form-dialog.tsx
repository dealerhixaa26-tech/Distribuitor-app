'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A modal for an action taken ON a record you are already looking at —
 * approving, suspending, verifying, issuing (ADR-0025).
 *
 * Radix rather than a hand-rolled overlay: the focus trap, the return of focus
 * to the trigger on close, `aria-modal`, the inert background, and Escape are
 * all things that are easy to write and easy to write *almost* right, and 11.3
 * would find each one separately.
 */

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2',
            '-translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-xl',
            className,
          )}
        >
          <div className="mb-4 pr-8">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            {description ? (
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                {description}
              </Dialog.Description>
            ) : null}
          </div>

          <Dialog.Close asChild>
            <button
              type="button"
              className="absolute right-4 top-4 rounded p-1 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" aria-hidden="true" />
              <span className="sr-only">Close</span>
            </button>
          </Dialog.Close>

          {children}

          {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A confirmation whose consequence is worth stating before it happens.
 *
 * `consequence` is not decoration. Issuing an invoice burns a number from a
 * gapless statutory series that cannot be renumbered (HANDOFF §4.19); verifying
 * a payment posts to the ledger (ADR-0018). A dialog that says only "Are you
 * sure?" tells the user nothing they did not already know.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequence,
  confirmLabel,
  destructive,
  loading,
  error,
  confirmDisabled,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  consequence: string;
  confirmLabel: string;
  destructive?: boolean;
  loading?: boolean;
  error?: string | null;
  /** Held back while a required input is incomplete. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  /** Any inputs the action requires — a reason, a note. */
  children?: React.ReactNode;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={consequence}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            loading={loading}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
      {children}
    </FormDialog>
  );
}
