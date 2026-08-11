'use client';

import { PRODUCT_TYPES, createProductSchema, updateProductSchema } from '@hixaa/contracts';
import { useRouter } from 'next/navigation';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { EntityPicker } from '@/components/form/entity-picker';
import { Field, FieldRow, FieldSet } from '@/components/form/field';
import { QuantityInput } from '@/components/form/money-input';
import { EnumOptions, Select } from '@/components/form/select';
import { FormError, SubmitBar, useUnsavedChangesWarning } from '@/components/form/submit-bar';
import { Input, Textarea } from '@/components/ui/input';
import { api } from '@/lib/api-client';
import { contractResolver, pruneEmpty, useEntityMutation } from '@/lib/use-entity-mutation';

/**
 * Create and edit a product.
 *
 * The catalogue is not a flat SKU list — Hixaa sells one flagship IoT product
 * alongside custom ATE, test benches, machine vision and LabVIEW integration,
 * so `GOODS | SERVICE | KIT | CONFIGURABLE` and SAC codes beside HSN are the
 * domain, not over-engineering (`docs/00`).
 *
 * The HSN/SAC rule comes from the contract's `superRefine` and is rendered, not
 * restated: a SERVICE is classified by SAC, everything else by HSN, and never
 * both. Which field is shown follows the selected type so the form cannot ask
 * for something the schema will refuse.
 */

const KNOWN_FIELDS: readonly string[] = [
  'sku',
  'name',
  'slug',
  'type',
  'categoryId',
  'brandId',
  'uomId',
  'shortDescription',
  'description',
  'hsnCode',
  'sacCode',
  'gstRate',
  'isSerialized',
  'isBatchTracked',
  'isReturnable',
  'isPurchasable',
  'isSellable',
  'warrantyMonths',
  'leadTimeDays',
  'minOrderQty',
  'weightGrams',
];

export interface ProductFormValues {
  sku: string;
  name: string;
  slug: string;
  type: string;
  categoryId: string;
  uomId: string;
  shortDescription: string;
  description: string;
  hsnCode: string;
  sacCode: string;
  gstRate: number;
  isSerialized: boolean;
  isBatchTracked: boolean;
  isReturnable: boolean;
  isPurchasable: boolean;
  isSellable: boolean;
  warrantyMonths: number | '';
  leadTimeDays: number | '';
  minOrderQty: string;
  weightGrams: string;
}

export const emptyProduct: ProductFormValues = {
  sku: '',
  name: '',
  slug: '',
  type: 'GOODS',
  categoryId: '',
  uomId: '',
  shortDescription: '',
  description: '',
  hsnCode: '',
  sacCode: '',
  gstRate: 18,
  isSerialized: false,
  isBatchTracked: false,
  isReturnable: true,
  isPurchasable: true,
  isSellable: true,
  warrantyMonths: '',
  leadTimeDays: '',
  minOrderQty: '1',
  weightGrams: '',
};

/** The rates GST actually uses. A free number field invites 18.5. */
const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28] as const;

interface ProductFormProps {
  mode: 'create' | 'edit';
  defaultValues: ProductFormValues;
  initialLabels?: { category?: string; uom?: string };
  productId?: string;
}

export function ProductForm({ mode, defaultValues, initialLabels, productId }: ProductFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';

  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<ProductFormValues>({
    resolver: contractResolver<ProductFormValues>(
      (isEdit ? updateProductSchema : createProductSchema) as never,
    ),
    defaultValues,
    mode: 'onBlur',
  });

  useUnsavedChangesWarning(isDirty);

  // Drives which tax-classification field is shown. `useWatch` rather than
  // `watch` so only this subtree re-renders on a type change.
  const type = useWatch({ control, name: 'type' });
  const isService = type === 'SERVICE';

  const { submit, isPending, summary, unattributed, reset } = useEntityMutation<
    ProductFormValues,
    { id: string; sku: string; name: string }
  >({
    mutationFn: (values, idempotencyKey) => {
      const body = pruneEmpty(values as unknown as Record<string, unknown>);
      // Whichever code the type does not use is dropped rather than sent empty:
      // switching GOODS → SERVICE after typing an HSN would otherwise submit
      // both and be refused by a rule the user cannot see.
      delete body[isService ? 'hsnCode' : 'sacCode'];
      return isEdit
        ? api.patch(`/products/${productId}`, body, { idempotencyKey })
        : api.post('/products', body, { idempotencyKey });
    },
    knownFields: KNOWN_FIELDS,
    setError,
    invalidate: [['products']],
    successMessage: (result) =>
      isEdit ? `${result.name} updated` : `${result.sku} — ${result.name} created`,
    redirectTo: (result) => `/products/${result.id}`,
  });

  const onSubmit = handleSubmit((values) => {
    reset();
    submit(values);
  });

  const toggle = (
    name: keyof ProductFormValues,
    label: string,
    description: string,
  ) => (
    <label className="flex items-start gap-2.5 rounded-md border border-border p-3">
      <input
        type="checkbox"
        className="mt-0.5 size-4 rounded border-input accent-[hsl(var(--primary))]"
        {...register(name)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );

  return (
    <form onSubmit={onSubmit} className="max-w-3xl space-y-8 pb-4" noValidate>
      <FormError summary={summary} unattributed={unattributed} />

      <FieldSet legend="Identity">
        <FieldRow>
          <Field
            name="sku"
            label="SKU"
            error={errors.sku?.message}
            required={!isEdit}
            description={
              isEdit
                ? 'Fixed once created — it is what people quote on the phone.'
                : 'Letters, digits, hyphens and slashes. e.g. HTPL-RAKSHA-GW'
            }
          >
            {(field) => (
              <Input
                {...field}
                className="font-mono uppercase"
                disabled={isEdit}
                {...register('sku')}
              />
            )}
          </Field>
          <Field name="type" label="Type" error={errors.type?.message} required>
            {(field) => (
              <Select {...field} {...register('type')}>
                <EnumOptions values={PRODUCT_TYPES} />
              </Select>
            )}
          </Field>
        </FieldRow>

        <Field name="name" label="Name" error={errors.name?.message} required>
          {(field) => <Input {...field} autoFocus={!isEdit} {...register('name')} />}
        </Field>

        <Field
          name="shortDescription"
          label="Short description"
          error={errors.shortDescription?.message}
          description="One line. Appears on quotations and invoices."
        >
          {(field) => <Input {...field} {...register('shortDescription')} />}
        </Field>

        <Field name="description" label="Description" error={errors.description?.message}>
          {(field) => <Textarea {...field} rows={4} {...register('description')} />}
        </Field>

        <FieldRow>
          <Field name="categoryId" label="Category" error={errors.categoryId?.message}>
            {(field) => (
              <Controller
                control={control}
                name="categoryId"
                render={({ field: controlled }) => (
                  <EntityPicker
                    control={field}
                    value={controlled.value}
                    onChange={controlled.onChange}
                    onBlur={controlled.onBlur}
                    path="/categories"
                    initialLabel={initialLabels?.category}
                    placeholder="Search categories…"
                    toOption={(row: { id: string; name: string; slug: string }) => ({
                      id: row.id,
                      label: row.name,
                      hint: row.slug,
                    })}
                  />
                )}
              />
            )}
          </Field>

          <Field
            name="uomId"
            label="Unit of measure"
            error={errors.uomId?.message}
            description="Each, metre, hour, lot."
          >
            {(field) => (
              <Controller
                control={control}
                name="uomId"
                render={({ field: controlled }) => (
                  <EntityPicker
                    control={field}
                    value={controlled.value}
                    onChange={controlled.onChange}
                    onBlur={controlled.onBlur}
                    path="/geography/uoms"
                    initialLabel={initialLabels?.uom}
                    placeholder="Search units…"
                    toOption={(row: { id: string; name: string; code: string; uqc: string }) => ({
                      id: row.id,
                      label: row.name,
                      hint: `${row.code} · GST UQC ${row.uqc}`,
                    })}
                  />
                )}
              />
            )}
          </Field>
        </FieldRow>
      </FieldSet>

      <FieldSet
        legend="Tax classification"
        description={
          isService
            ? 'A SERVICE is classified by SAC. The HSN field is hidden because the schema refuses both.'
            : 'Goods are classified by HSN. A SERVICE would use SAC instead — change the type to switch.'
        }
      >
        <FieldRow>
          {isService ? (
            <Field
              name="sacCode"
              label="SAC code"
              error={errors.sacCode?.message}
              description="Six digits, e.g. 998719."
            >
              {(field) => (
                <Input {...field} inputMode="numeric" maxLength={6} className="font-mono" {...register('sacCode')} />
              )}
            </Field>
          ) : (
            <Field
              name="hsnCode"
              label="HSN code"
              error={errors.hsnCode?.message}
              description="Four, six, or eight digits."
            >
              {(field) => (
                <Input {...field} inputMode="numeric" maxLength={8} className="font-mono" {...register('hsnCode')} />
              )}
            </Field>
          )}

          <Field
            name="gstRate"
            label="GST rate"
            error={errors.gstRate?.message}
            required
            description="A display snapshot. The authoritative, date-effective rate lives in TaxRate (ADR-0008)."
          >
            {(field) => (
              <Select {...field} {...register('gstRate', { valueAsNumber: true })}>
                {GST_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}%
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </FieldRow>
      </FieldSet>

      <FieldSet legend="Handling">
        <div className="grid gap-3 sm:grid-cols-2">
          {toggle(
            'isSerialized',
            'Serial tracked',
            'Identity is captured at DISPATCH, not receipt (ADR-0009).',
          )}
          {toggle('isBatchTracked', 'Batch tracked', 'Received and issued in lots.')}
          {toggle('isSellable', 'Sellable', 'Can appear on a quotation or order.')}
          {toggle('isPurchasable', 'Purchasable', 'Can be bought in.')}
          {toggle('isReturnable', 'Returnable', 'Eligible for a credit note on return.')}
        </div>
      </FieldSet>

      <FieldSet legend="Commercial">
        <FieldRow>
          <Field
            name="minOrderQty"
            label="Minimum order quantity"
            error={errors.minOrderQty?.message}
          >
            {(field) => <QuantityInput {...field} {...register('minOrderQty')} />}
          </Field>
          <Field
            name="weightGrams"
            label="Weight (grams)"
            error={errors.weightGrams?.message}
            description="Used for shipping paperwork."
          >
            {(field) => <QuantityInput {...field} {...register('weightGrams')} />}
          </Field>
        </FieldRow>

        <FieldRow>
          <Field
            name="warrantyMonths"
            label="Warranty (months)"
            error={errors.warrantyMonths?.message}
            description="Runs from dispatch, when the serial is captured."
          >
            {(field) => (
              <Input
                {...field}
                type="number"
                min={0}
                max={600}
                {...register('warrantyMonths', { valueAsNumber: true })}
              />
            )}
          </Field>
          <Field name="leadTimeDays" label="Lead time (days)" error={errors.leadTimeDays?.message}>
            {(field) => (
              <Input
                {...field}
                type="number"
                min={0}
                max={3650}
                {...register('leadTimeDays', { valueAsNumber: true })}
              />
            )}
          </Field>
        </FieldRow>
      </FieldSet>

      <SubmitBar
        submitLabel={isEdit ? 'Save changes' : 'Create product'}
        submitting={isPending}
        onCancel={() => router.back()}
      />
    </form>
  );
}
