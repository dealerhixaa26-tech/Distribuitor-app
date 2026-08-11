'use client';

import { CUSTOMER_TYPES, createCustomerSchema, updateCustomerSchema } from '@hixaa/contracts';
import { useRouter } from 'next/navigation';
import { Controller, useForm } from 'react-hook-form';
import {
  AddressFields,
  type AddressValues,
  addressFieldPaths,
  emptyAddress,
} from '@/components/form/address-fields';
import { EntityPicker } from '@/components/form/entity-picker';
import { Field, FieldRow, FieldSet } from '@/components/form/field';
import { EnumOptions, Select } from '@/components/form/select';
import { FormError, SubmitBar, useUnsavedChangesWarning } from '@/components/form/submit-bar';
import { Input, Textarea } from '@/components/ui/input';
import { api } from '@/lib/api-client';
import { contractResolver, pruneEmpty, useEntityMutation } from '@/lib/use-entity-mutation';

/**
 * Create and edit an END customer — a plant, a mine, a government body.
 *
 * Built before quotations and orders because a SECONDARY order is refused
 * without a `customerId` (`createOrderSchema.superRefine`): a sell-out is the
 * distributor's own sale to someone, and there was no way to enter that
 * someone. Small, and blocking.
 *
 * Structurally the distributor form's smaller sibling, and deliberately shares
 * its parts — `AddressFields`, `EntityPicker`, `contractResolver` — rather than
 * restating a nine-field address whose `stateId` decides the tax split.
 */

const KNOWN_FIELDS: readonly string[] = [
  'code',
  'name',
  'type',
  'distributorId',
  'territoryId',
  'industryId',
  'gstin',
  'pan',
  'siteName',
  'website',
  'notes',
  ...addressFieldPaths('billingAddress'),
  ...addressFieldPaths('shippingAddress'),
];

export interface CustomerFormValues {
  code: string;
  name: string;
  type: string;
  distributorId: string;
  territoryId: string;
  industryId: string;
  gstin: string;
  pan: string;
  siteName: string;
  website: string;
  notes: string;
  billingAddress: AddressValues;
  shippingAddress: AddressValues;
}

export const emptyCustomer: CustomerFormValues = {
  code: '',
  name: '',
  type: 'INDUSTRIAL',
  distributorId: '',
  territoryId: '',
  industryId: '',
  gstin: '',
  pan: '',
  siteName: '',
  website: '',
  notes: '',
  billingAddress: { ...emptyAddress },
  shippingAddress: { ...emptyAddress },
};

interface CustomerFormProps {
  mode: 'create' | 'edit';
  defaultValues: CustomerFormValues;
  initialLabels?: { distributor?: string; territory?: string; industry?: string };
  customerId?: string;
  /** Where to go on success. A dialog opened mid-order wants to stay put. */
  onCreated?: (result: { id: string; code: string; name: string }) => void;
}

export function CustomerForm({
  mode,
  defaultValues,
  initialLabels,
  customerId,
  onCreated,
}: CustomerFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';

  const {
    register,
    control,
    handleSubmit,
    setError,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<CustomerFormValues>({
    resolver: contractResolver<CustomerFormValues>(
      (isEdit ? updateCustomerSchema : createCustomerSchema) as never,
    ),
    defaultValues,
    mode: 'onBlur',
  });

  useUnsavedChangesWarning(isDirty);

  const { submit, isPending, summary, unattributed, reset } = useEntityMutation<
    CustomerFormValues,
    { id: string; code: string; name: string }
  >({
    mutationFn: (values, idempotencyKey) => {
      const body = pruneEmpty(values as unknown as Record<string, unknown>);
      return isEdit
        ? api.patch(`/customers/${customerId}`, body, { idempotencyKey })
        : api.post('/customers', body, { idempotencyKey });
    },
    knownFields: KNOWN_FIELDS,
    setError,
    invalidate: [['customers']],
    successMessage: (result) =>
      isEdit ? `${result.name} updated` : `${result.code} — ${result.name} created`,
    // A form opened as a dialog hands the new customer back to whatever needed
    // it, instead of navigating away from a half-written order.
    redirectTo: onCreated ? undefined : '/customers',
    onSuccess: onCreated,
  });

  const onSubmit = handleSubmit((values) => {
    reset();
    submit(values);
  });

  return (
    <form onSubmit={onSubmit} className="max-w-3xl space-y-8 pb-4" noValidate>
      <FormError summary={summary} unattributed={unattributed} />

      <FieldSet legend="Identity">
        <FieldRow>
          <Field name="name" label="Customer name" error={errors.name?.message} required>
            {(field) => <Input {...field} autoFocus={!isEdit} {...register('name')} />}
          </Field>
          <Field name="type" label="Type" error={errors.type?.message} required>
            {(field) => (
              <Select {...field} {...register('type')}>
                <EnumOptions values={CUSTOMER_TYPES} />
              </Select>
            )}
          </Field>
        </FieldRow>

        {!isEdit ? (
          <Field
            name="code"
            label="Code"
            error={errors.code?.message}
            description="Leave blank and one is generated. It cannot be changed afterwards."
          >
            {(field) => <Input {...field} className="font-mono uppercase" {...register('code')} />}
          </Field>
        ) : null}

        <FieldRow>
          <Field
            name="siteName"
            label="Site or plant"
            error={errors.siteName?.message}
            description="Where the work happens, if that differs from the billing entity."
          >
            {(field) => <Input {...field} {...register('siteName')} />}
          </Field>
          <Field name="website" label="Website" error={errors.website?.message}>
            {(field) => <Input {...field} type="url" {...register('website')} />}
          </Field>
        </FieldRow>
      </FieldSet>

      <FieldSet
        legend="Relationships"
        description="A customer served THROUGH a partner carries that distributor, which is what makes a SECONDARY order a sell-out rather than a direct sale."
      >
        <FieldRow>
          <Field
            name="distributorId"
            label="Served by distributor"
            error={errors.distributorId?.message}
          >
            {(field) => (
              <Controller
                control={control}
                name="distributorId"
                render={({ field: controlled }) => (
                  <EntityPicker
                    control={field}
                    value={controlled.value}
                    onChange={controlled.onChange}
                    onBlur={controlled.onBlur}
                    path="/distributors"
                    initialLabel={initialLabels?.distributor}
                    placeholder="Search distributors…"
                    toOption={(row: { id: string; legalName: string; code: string; status: string }) => ({
                      id: row.id,
                      label: row.legalName,
                      hint: `${row.code} · ${row.status}`,
                    })}
                  />
                )}
              />
            )}
          </Field>

          <Field name="territoryId" label="Territory" error={errors.territoryId?.message}>
            {(field) => (
              <Controller
                control={control}
                name="territoryId"
                render={({ field: controlled }) => (
                  <EntityPicker
                    control={field}
                    value={controlled.value}
                    onChange={controlled.onChange}
                    onBlur={controlled.onBlur}
                    path="/territories"
                    initialLabel={initialLabels?.territory}
                    placeholder="Search territories…"
                    toOption={(row: { id: string; name: string; code: string; type: string }) => ({
                      id: row.id,
                      label: row.name,
                      hint: `${row.code} · ${row.type}`,
                    })}
                  />
                )}
              />
            )}
          </Field>
        </FieldRow>

        <Field
          name="industryId"
          label="Industry"
          error={errors.industryId?.message}
          description="Thermal power, coal, mining, cement, rail simulation — the sectors Hixaa sells into."
        >
          {(field) => (
            <Controller
              control={control}
              name="industryId"
              render={({ field: controlled }) => (
                <EntityPicker
                  control={field}
                  value={controlled.value}
                  onChange={controlled.onChange}
                  onBlur={controlled.onBlur}
                  path="/geography/industries"
                  initialLabel={initialLabels?.industry}
                  placeholder="Search industries…"
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
      </FieldSet>

      <FieldSet
        legend="Statutory"
        description="Held to exactly the standard the company's own numbers are — the same validators, so a customer's GSTIN cannot be looser than a distributor's."
      >
        <FieldRow>
          <Field name="gstin" label="GSTIN" error={errors.gstin?.message}>
            {(field) => (
              <Input
                {...field}
                maxLength={15}
                className="font-mono uppercase"
                autoCapitalize="characters"
                {...register('gstin')}
              />
            )}
          </Field>
          <Field name="pan" label="PAN" error={errors.pan?.message}>
            {(field) => (
              <Input
                {...field}
                maxLength={10}
                className="font-mono uppercase"
                autoCapitalize="characters"
                {...register('pan')}
              />
            )}
          </Field>
        </FieldRow>
      </FieldSet>

      <FieldSet legend="Billing address">
        <AddressFields prefix="billingAddress" control={control} register={register} errors={errors} />
      </FieldSet>

      <FieldSet legend="Shipping address">
        <button
          type="button"
          onClick={() =>
            setValue('shippingAddress', { ...watch('billingAddress') }, {
              shouldDirty: true,
              shouldValidate: true,
            })
          }
          className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Same as billing
        </button>
        <AddressFields prefix="shippingAddress" control={control} register={register} errors={errors} />
      </FieldSet>

      <FieldSet legend="Notes">
        <Field name="notes" label="Internal notes" error={errors.notes?.message}>
          {(field) => <Textarea {...field} rows={3} {...register('notes')} />}
        </Field>
      </FieldSet>

      <SubmitBar
        submitLabel={isEdit ? 'Save changes' : 'Create customer'}
        submitting={isPending}
        onCancel={() => router.back()}
      />
    </form>
  );
}
