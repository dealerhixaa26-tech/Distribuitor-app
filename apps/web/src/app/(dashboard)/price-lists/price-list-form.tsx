'use client';

import { createPriceListSchema, updatePriceListSchema } from '@hixaa/contracts';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { Field, FieldRow, FieldSet } from '@/components/form/field';
import { DateInput } from '@/components/form/money-input';
import { Select } from '@/components/form/select';
import { FormError, SubmitBar, useUnsavedChangesWarning } from '@/components/form/submit-bar';
import { Input, Textarea } from '@/components/ui/input';
import { api } from '@/lib/api-client';
import { contractResolver, pruneEmpty, useEntityMutation } from '@/lib/use-entity-mutation';
import { todayIso } from '@/lib/utils';

/**
 * Create and edit a price list — the header only. The prices themselves are
 * `PriceListItems`, edited separately (see `price-list-items.tsx`), because a
 * list's validity dates and a thousand slab rows are different jobs done at
 * different times.
 *
 * `priceBasis` is fixed at EXCLUSIVE and shown read-only: ADR-0008 makes price
 * lists GST-exclusive with tax derived forward, never backed out. Offering the
 * choice would imply the engine honours it.
 */

const KNOWN_FIELDS: readonly string[] = [
  'code',
  'name',
  'currency',
  'priceBasis',
  'validFrom',
  'validTo',
  'isDefault',
  'description',
];

export interface PriceListFormValues {
  code: string;
  name: string;
  currency: string;
  priceBasis: string;
  validFrom: string;
  validTo: string;
  isDefault: boolean;
  description: string;
}

export const emptyPriceList = (): PriceListFormValues => ({
  code: '',
  name: '',
  currency: 'INR',
  priceBasis: 'EXCLUSIVE',
  validFrom: todayIso(),
  validTo: '',
  isDefault: false,
  description: '',
});

interface PriceListFormProps {
  mode: 'create' | 'edit';
  defaultValues: PriceListFormValues;
  priceListId?: string;
}

export function PriceListForm({ mode, defaultValues, priceListId }: PriceListFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<PriceListFormValues>({
    resolver: contractResolver<PriceListFormValues>(
      (isEdit ? updatePriceListSchema : createPriceListSchema) as never,
    ),
    defaultValues,
    mode: 'onBlur',
  });

  useUnsavedChangesWarning(isDirty);

  const { submit, isPending, summary, unattributed, reset } = useEntityMutation<
    PriceListFormValues,
    { id: string; code: string; name: string }
  >({
    mutationFn: (values, idempotencyKey) => {
      const body = pruneEmpty(values as unknown as Record<string, unknown>);
      return isEdit
        ? api.patch(`/price-lists/${priceListId}`, body, { idempotencyKey })
        : api.post('/price-lists', body, { idempotencyKey });
    },
    knownFields: KNOWN_FIELDS,
    setError,
    invalidate: [['price-lists']],
    successMessage: (result) =>
      isEdit ? `${result.name} updated` : `${result.code} — ${result.name} created`,
    redirectTo: (result) => `/price-lists/${result.id}`,
  });

  const onSubmit = handleSubmit((values) => {
    reset();
    submit(values);
  });

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-8 pb-4" noValidate>
      <FormError summary={summary} unattributed={unattributed} />

      <FieldSet legend="Identity">
        <FieldRow>
          <Field
            name="code"
            label="Code"
            error={errors.code?.message}
            required={!isEdit}
            description={isEdit ? 'Fixed once created.' : 'e.g. STD-2026, DIST-NORTH-2026'}
          >
            {(field) => (
              <Input
                {...field}
                className="font-mono uppercase"
                disabled={isEdit}
                {...register('code')}
              />
            )}
          </Field>
          <Field name="name" label="Name" error={errors.name?.message} required>
            {(field) => <Input {...field} autoFocus={!isEdit} {...register('name')} />}
          </Field>
        </FieldRow>

        <Field name="description" label="Description" error={errors.description?.message}>
          {(field) => <Textarea {...field} rows={2} {...register('description')} />}
        </Field>
      </FieldSet>

      <FieldSet
        legend="Validity"
        description="A list applies on a date. Overlapping lists are resolved by the pricing engine, which is the only place a price is decided (ADR-0007)."
      >
        <FieldRow>
          <Field name="validFrom" label="Valid from" error={errors.validFrom?.message} required>
            {(field) => <DateInput {...field} {...register('validFrom')} />}
          </Field>
          <Field
            name="validTo"
            label="Valid to"
            error={errors.validTo?.message}
            description="Leave blank for open-ended."
          >
            {(field) => <DateInput {...field} {...register('validTo')} />}
          </Field>
        </FieldRow>

        <label className="flex items-start gap-2.5 rounded-md border border-border p-3">
          <input
            type="checkbox"
            className="mt-0.5 size-4 rounded border-input accent-[hsl(var(--primary))]"
            {...register('isDefault')}
          />
          <span>
            <span className="block text-sm font-medium">Default list</span>
            <span className="block text-xs text-muted-foreground">
              Used when a distributor has no list of their own. Exactly one list is the default;
              setting this moves it.
            </span>
          </span>
        </label>
      </FieldSet>

      <FieldSet legend="Basis">
        <FieldRow>
          <Field
            name="currency"
            label="Currency"
            error={errors.currency?.message}
            description="INR. Multi-currency is not implemented."
          >
            {(field) => (
              <Select {...field} {...register('currency')}>
                <option value="INR">INR — Indian Rupee</option>
              </Select>
            )}
          </Field>
          <Field
            name="priceBasis"
            label="Price basis"
            error={errors.priceBasis?.message}
            description="GST-EXCLUSIVE, always. Tax is derived forward and never backed out (ADR-0008)."
          >
            {(field) => (
              <Select {...field} disabled {...register('priceBasis')}>
                <option value="EXCLUSIVE">Exclusive of GST</option>
              </Select>
            )}
          </Field>
        </FieldRow>
      </FieldSet>

      <SubmitBar
        submitLabel={isEdit ? 'Save changes' : 'Create price list'}
        submitting={isPending}
        onCancel={() => router.back()}
      />
    </form>
  );
}
