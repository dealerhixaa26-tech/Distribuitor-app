'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A labelled form control with its description and error, wired together.
 *
 * The accessibility pattern is the one the login page established: the invalid
 * state is announced through `aria-invalid` rather than inferred from a red
 * border, and the message is bound with `aria-describedby` so a screen-reader
 * user hears *why* the field was refused rather than only that it was.
 *
 * It is a component and not a convention because a convention repeated across
 * thirteen forms is right in most of them. 11.3 audits this once.
 */

interface FieldProps {
  /** Also the control's `id` and its `name` in the form. */
  name: string;
  label: string;
  /** Rendered under the control, and referenced by `aria-describedby`. */
  description?: string;
  error?: string;
  required?: boolean;
  className?: string;
  /** Receives the ids and state the control must carry. */
  children: (control: FieldControlProps) => React.ReactNode;
}

export interface FieldControlProps {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
  'aria-required': true | undefined;
}

export function Field({
  name,
  label,
  description,
  error,
  required,
  className,
  children,
}: FieldProps) {
  const errorId = `${name}-error`;
  const descriptionId = `${name}-description`;

  // Both are announced when both exist — a field can be described AND refused,
  // and dropping the description on error loses the format hint exactly when
  // the user has just got the format wrong.
  const describedBy =
    [description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={name} className="block text-sm font-medium">
        {label}
        {required ? (
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
        ) : null}
        {/* Optionality is conveyed in text, not by a glyph a screen reader
            reads as "asterisk" or skips entirely. */}
        {required ? <span className="sr-only"> (required)</span> : null}
      </label>

      {children({
        id: name,
        'aria-invalid': Boolean(error),
        'aria-describedby': describedBy,
        'aria-required': required || undefined,
      })}

      {description ? (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Groups related fields under a heading, e.g. "Billing address". */
export function FieldSet({
  legend,
  description,
  children,
  className,
}: {
  legend: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn('space-y-4', className)}>
      <legend className="text-sm font-semibold">{legend}</legend>
      {description ? <p className="-mt-2 text-xs text-muted-foreground">{description}</p> : null}
      {children}
    </fieldset>
  );
}

/** Two-column on desktop, stacked on mobile. */
export function FieldRow({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}
