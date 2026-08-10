'use client';

import { AlertCircle } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';

/**
 * The form-level failure summary and the submit controls.
 *
 * The summary carries `unattributed` — errors naming fields this form does not
 * render. Those are the ones that would otherwise leave a user pressing a
 * button that appears to do nothing (see `form-errors.ts`), so they are shown
 * verbatim rather than swallowed.
 *
 * `role="alert"` with `aria-live="assertive"`: a submit failure that only
 * changes colour is invisible to a screen-reader user, who is usually still
 * focused on the button they just pressed.
 */
export function FormError({
  summary,
  unattributed = [],
}: {
  summary: string | null;
  unattributed?: string[];
}) {
  if (!summary) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p>{summary}</p>
        {unattributed.length > 0 ? (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
            {unattributed.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function SubmitBar({
  submitLabel = 'Save',
  submitting,
  onCancel,
  disabled,
  children,
}: {
  submitLabel?: string;
  submitting: boolean;
  onCancel: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background/95 px-1 py-3 backdrop-blur">
      {children}
      <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
        Cancel
      </Button>
      <Button type="submit" loading={submitting} disabled={disabled}>
        {submitLabel}
      </Button>
    </div>
  );
}

/**
 * Warns before a navigation would discard unsaved edits.
 *
 * Only `beforeunload` — a reload or a closed tab. In-app navigation is left
 * alone deliberately: intercepting the App Router needs either a route guard
 * that fights the framework or a global click handler that traps clicks it does
 * not understand. A half-working guard that misses the common case is worse
 * than an honest one that covers the case the browser gives us for free.
 */
export function useUnsavedChangesWarning(isDirty: boolean): void {
  React.useEffect(() => {
    if (!isDirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);
}
