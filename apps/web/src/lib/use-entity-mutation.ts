'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import type { FieldValues, Resolver, UseFormSetError } from 'react-hook-form';
import { toast } from 'sonner';
import type { ZodType } from 'zod';
import { applyServerErrors } from './form-errors';

/**
 * One place where a form's submit meets the API.
 *
 * It does five things a form should not each reinvent: run the request, make a
 * retry safe, put the server's refusals on the fields that caused them,
 * invalidate exactly the queries that are now stale, and tell the user it
 * worked.
 *
 * ## The idempotency key
 *
 * Generated once per form and held in a ref, NOT per submit. That is the whole
 * point: if the first attempt times out at the BFF's thirty seconds and the
 * user presses the button again, the second request must carry the SAME key so
 * the server recognises it as the same act and replays the original result
 * rather than creating a second payment. A key minted per click would make
 * every retry a new request, which is exactly the hazard.
 *
 * A fresh key is minted after a success, so the next thing the user creates on
 * a form they did not navigate away from is genuinely a new act.
 *
 * The server requires it on the money-moving routes (`docs/03 §5`,
 * `IdempotencyInterceptor`) and ignores it elsewhere, so sending it on every
 * mutation costs nothing and means no form has to know which is which.
 */

/**
 * `zodResolver`, but validating what will actually be SENT.
 *
 * The DOM has one way to say "nothing": the empty string. Zod has another:
 * absent. Validating the raw form values checks a payload the server will never
 * see, and refuses it for fields the user was never required to fill in.
 *
 * So the same `pruneEmpty` that shapes the request also shapes what is
 * validated. One function, so the two cannot drift.
 */
export function contractResolver<TValues extends FieldValues>(
  // The contract schemas carry `.refine()`/`.superRefine()`, so their input and
  // output types differ; the resolver only needs to parse.
  schema: ZodType<unknown, never, never>,
): Resolver<TValues> {
  const inner = zodResolver(schema as never) as Resolver<TValues>;
  return (values, context, options) =>
    inner(pruneEmpty(values as Record<string, unknown>) as TValues, context, options);
}

export interface EntityMutationOptions<TValues extends FieldValues, TResult> {
  /**
   * The request. `idempotencyKey` is stable across retries of the same attempt
   * — pass it straight through to `api.post`/`api.patch`.
   */
  mutationFn: (values: TValues, idempotencyKey: string) => Promise<TResult>;

  /** Errors are applied to these fields; anything else surfaces in the summary. */
  knownFields: readonly string[];
  setError: UseFormSetError<TValues>;

  /** Query keys made stale by this write. Never invalidate everything. */
  invalidate?: readonly unknown[][];

  successMessage: string | ((result: TResult) => string);
  /** Where to go afterwards. Omit to stay put. */
  redirectTo?: string | ((result: TResult) => string);
  onSuccess?: (result: TResult) => void;
}

export function useEntityMutation<TValues extends FieldValues, TResult>({
  mutationFn,
  knownFields,
  setError,
  invalidate = [],
  successMessage,
  redirectTo,
  onSuccess,
}: EntityMutationOptions<TValues, TResult>) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [summary, setSummary] = React.useState<string | null>(null);
  const [unattributed, setUnattributed] = React.useState<string[]>([]);

  // One key per attempt, surviving re-renders. State rather than a ref: the key
  // IS part of this hook's state, the lazy initialiser means a form that is
  // never submitted costs nothing, and `mutationFn` closes over the value from
  // the render that called `mutate` — which is precisely the stability a retry
  // depends on.
  const [idempotencyKey, setIdempotencyKey] = React.useState(() => crypto.randomUUID());

  const mutation = useMutation({
    mutationFn: (values: TValues) => mutationFn(values, idempotencyKey),
    onSuccess: async (result) => {
      setSummary(null);
      setUnattributed([]);
      // The act is finished. Anything created next on this form is a new one.
      setIdempotencyKey(crypto.randomUUID());

      await Promise.all(
        invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );

      toast.success(
        typeof successMessage === 'function' ? successMessage(result) : successMessage,
      );
      onSuccess?.(result);

      if (redirectTo) {
        router.push(typeof redirectTo === 'function' ? redirectTo(result) : redirectTo);
      }
    },
    onError: (error) => {
      const applied = applyServerErrors(error, setError, knownFields);
      setSummary(applied.summary);
      setUnattributed(applied.unattributed);
    },
  });

  return {
    submit: mutation.mutate,
    isPending: mutation.isPending,
    summary,
    unattributed,
    /** Clears the summary when the user starts fixing things. */
    reset: React.useCallback(() => {
      setSummary(null);
      setUnattributed([]);
    }, []),
  };
}

/**
 * Strips empty inputs from form values.
 *
 * An untouched optional text input yields `''`, and `''` fails `gstinSchema`,
 * `ifscSchema`, `indianPhoneSchema` and every other refined string — so an
 * unpruned form refuses a perfectly valid record because nobody filled in
 * fields that were never required. `undefined` is what "not provided" means to
 * Zod's `.optional()`.
 *
 * This was found by submitting the distributor form, not by reading it: a form
 * that typechecks, renders correctly and cannot create anything is exactly the
 * failure this project keeps meeting. Twelve optional fields refused at once —
 * territory, TAN, CIN, Udyam, all four bank fields, both contact phones.
 *
 * `NaN` counts as empty: `register(..., { valueAsNumber: true })` yields NaN
 * for a cleared number input, and NaN survives every check except this one.
 *
 * Nested objects are cleaned too, and an object left entirely empty is dropped
 * whole: a blank shipping address must not post as `{}`, which would fail the
 * address schema's required fields.
 *
 * Used in TWO places — `contractResolver` before validation, and the mutation
 * before the request — so what the browser validates and what the server
 * receives cannot disagree.
 */
export function pruneEmpty<T extends Record<string, unknown>>(values: T): Partial<T> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    if (value === '' || value === undefined || value === null) continue;
    if (typeof value === 'number' && Number.isNaN(value)) continue;

    if (Array.isArray(value)) {
      output[key] = value;
      continue;
    }

    if (typeof value === 'object') {
      const nested = pruneEmpty(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) output[key] = nested;
      continue;
    }

    output[key] = value;
  }

  return output as Partial<T>;
}
