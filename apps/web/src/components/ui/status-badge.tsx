import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn, humanizeEnum } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted text-muted-foreground',
        success: 'border-success/30 bg-success/10 text-success',
        warning: 'border-warning/30 bg-warning/10 text-warning',
        danger: 'border-destructive/30 bg-destructive/10 text-destructive',
        info: 'border-info/30 bg-info/10 text-info',
        primary: 'border-primary/30 bg-primary/10 text-primary',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type Tone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

/**
 * Maps every domain status to a tone, in one place.
 *
 * Centralised so "APPROVED" is the same colour on the order list, the order
 * detail, and the dashboard. Per-screen colour choices are how an interface
 * starts contradicting itself.
 */
const STATUS_TONES: Record<string, Tone> = {
  // Lifecycle
  DRAFT: 'neutral',
  LEAD: 'neutral',
  INVITED: 'info',
  PENDING: 'warning',
  PENDING_APPROVAL: 'warning',
  PROCESSING: 'info',
  ACTIVE: 'success',
  APPROVED: 'success',
  COMPLETED: 'success',
  DELIVERED: 'success',
  CLEARED: 'success',
  PAID: 'success',
  ISSUED: 'info',
  SENT: 'info',
  DISPATCHED: 'info',
  IN_TRANSIT: 'info',
  PARTIALLY_DISPATCHED: 'warning',
  PARTIALLY_PAID: 'warning',
  SUSPENDED: 'warning',
  OVERDUE: 'danger',
  CANCELLED: 'danger',
  REJECTED: 'danger',
  TERMINATED: 'danger',
  DISABLED: 'danger',
  BOUNCED: 'danger',
  FAILED: 'danger',
  DEAD: 'danger',
  EXPIRED: 'neutral',
  ARCHIVED: 'neutral',
  DISCONTINUED: 'neutral',
  // Files
  CLEAN: 'success',
  INFECTED: 'danger',
  SKIPPED: 'neutral',
};

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: string;
  tone?: Tone;
  label?: string;
}

export function StatusBadge({ status, tone, label, className, ...props }: StatusBadgeProps) {
  const resolved = tone ?? STATUS_TONES[status] ?? 'neutral';
  return (
    <span className={cn(badgeVariants({ tone: resolved }), className)} {...props}>
      {/*
        A dot plus the text label: colour is never the sole carrier of meaning,
        which WCAG 2.2 §1.4.1 requires and colour-blind users depend on.
      */}
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {label ?? humanizeEnum(status)}
    </span>
  );
}

export { badgeVariants };
