'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { humanizeEnum } from '@/lib/utils';

/**
 * A native `<select>`.
 *
 * Deliberately not the Radix listbox that sits unused in package.json. For a
 * fixed set of enum values a native select is keyboard-complete, announced
 * correctly by every screen reader, opens as the platform picker on a phone,
 * and needs no JavaScript to be correct — none of which a rebuilt listbox gets
 * for free, and all of which 11.3 would have to audit. The searchable
 * ENTITY lookup is a different problem with a different answer: `EntityPicker`.
 *
 * `register()` works on it unchanged, so a select is one line in a form.
 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & { placeholder?: string }
>(({ className, children, placeholder, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'flex min-h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
      'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30',
      className,
    )}
    {...props}
  >
    {placeholder ? <option value="">{placeholder}</option> : null}
    {children}
  </select>
));
Select.displayName = 'Select';

/**
 * Options from a contracts enum.
 *
 * Sourced from the Zod enum's own `.options`, so a value added to the contract
 * appears here without anyone remembering to add it — the same reason
 * `event-plumbing.spec.ts` exists (HANDOFF §4.27). A hand-written list is a
 * second table that drifts.
 */
export function EnumOptions({
  values,
  label = humanizeEnum,
}: {
  values: readonly string[];
  label?: (value: string) => string;
}) {
  return (
    <>
      {values.map((value) => (
        <option key={value} value={value}>
          {label(value)}
        </option>
      ))}
    </>
  );
}
