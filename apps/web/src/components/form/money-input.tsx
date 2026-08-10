'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Money and quantity entry.
 *
 * `type="text"`, never `type="number"`. A number input hands back a JavaScript
 * number, and money here is `DECIMAL(18,4)` that crosses the wire as a string
 * precisely so it never touches a float (ADR-0004, HANDOFF §4.5). One
 * `valueAsNumber` is all it takes to turn ₹1,234.56 into 1234.5600000000001 in
 * a tax computation that then fails to reconcile by a paisa.
 *
 * `inputMode="decimal"` still raises the numeric keypad on a phone, so nothing
 * is lost by refusing the number type.
 */
export const MoneyInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & { prefix?: string }
>(({ className, prefix = '₹', ...props }, ref) => (
  <div className="relative">
    <span
      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
      aria-hidden="true"
    >
      {prefix}
    </span>
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={cn(
        'flex min-h-9 w-full rounded-md border border-input bg-background py-1 pr-3 text-sm tabular-nums',
        prefix ? 'pl-7' : 'px-3',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30',
        className,
      )}
      {...props}
    />
  </div>
));
MoneyInput.displayName = 'MoneyInput';

/** The same rules without a currency mark — quantities, not amounts. */
export const QuantityInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>
>(({ className, ...props }, ref) => (
  <MoneyInput ref={ref} prefix="" className={cn('text-right', className)} {...props} />
));
QuantityInput.displayName = 'QuantityInput';

/**
 * A calendar date.
 *
 * Native `type="date"` because its value is exactly `YYYY-MM-DD` — the same
 * string `dateOnlySchema` validates. Any picker that formats for display would
 * need converting back, and a conversion that runs through a `Date` reintroduces
 * the timezone offset that migration 0003 spent sixty columns removing
 * (HANDOFF §4.8).
 */
export const DateInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    type="date"
    className={cn(
      'flex min-h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
      'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30',
      className,
    )}
    {...props}
  />
));
DateInput.displayName = 'DateInput';
