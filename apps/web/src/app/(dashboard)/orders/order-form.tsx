'use client';

import { ORDER_TYPES, createOrderSchema, updateOrderSchema } from '@hixaa/contracts';
import { useRouter } from 'next/navigation';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { EntityPicker } from '@/components/form/entity-picker';
import { Field, FieldRow, FieldSet } from '@/components/form/field';
import { DateInput } from '@/components/form/money-input';
import {
  SALES_LINE_FIELDS,
  SalesLines,
  type SalesLineValues,
  emptySalesLine,
  toSalesLinePayload,
} from '@/components/form/sales-lines';
import { EnumOptions, Select } from '@/components/form/select';
import { FormError, SubmitBar, useUnsavedChangesWarning } from '@/components/form/submit-bar';
import { Input, Textarea } from '@/components/ui/input';
import { api } from '@/lib/api-client';
import { lineFields } from '@/lib/form-errors';
import { contractResolver, pruneEmpty, useEntityMutation } from '@/lib/use-entity-mutation';

/**
 * Raise or amend an order.
 *
 * The type is load-bearing and mirrors a CHECK constraint in migration 0008:
 * a PRIMARY order is sell-in, Hixaa → distributor; a SECONDARY order is
 * sell-out, distributor → customer, issuing from that partner's own channel
 * warehouse (ADR-0014). Mixing them up puts sell-out revenue in the sell-in
 * ledger, so the form shows only the party the chosen type requires.
 *
 * Only a DRAFT is editable. An approved order is frozen (ADR-0011) — changing
 * one is cancel-and-reraise until there is a documented amendment policy.
 */

const KNOWN_FIELDS_BASE: readonly string[] = [
  'type',
  'distributorId',
  'customerId',
  'warehouseId',
  'orderDate',
  'expectedDate',
  'customerPoNumber',
  'customerPoDate',
  'paymentTermsCode',
  'placeOfSupplyStateCode',
  'priceListId',
  'notes',
  'lines',
];

export interface OrderFormValues {
  type: string;
  distributorId: string;
  customerId: string;
  warehouseId: string;
  orderDate: string;
  expectedDate: string;
  customerPoNumber: string;
  customerPoDate: string;
  paymentTermsCode: string;
  placeOfSupplyStateCode: string;
  priceListId: string;
  notes: string;
  lines: SalesLineValues[];
}

export const emptyOrder = (): OrderFormValues => ({
  type: 'PRIMARY',
  distributorId: '',
  customerId: '',
  warehouseId: '',
  orderDate: '',
  expectedDate: '',
  customerPoNumber: '',
  customerPoDate: '',
  paymentTermsCode: '',
  placeOfSupplyStateCode: '',
  priceListId: '',
  notes: '',
  lines: [{ ...emptySalesLine }],
});

interface OrderFormProps {
  mode: 'create' | 'edit';
  defaultValues: OrderFormValues;
  initialLabels?: { distributor?: string; customer?: string; warehouse?: string };
  orderId?: string;
}

export function OrderForm({ mode, defaultValues, initialLabels, orderId }: OrderFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';

  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<OrderFormValues>({
    resolver: contractResolver<OrderFormValues>(
      (isEdit ? updateOrderSchema : createOrderSchema) as never,
    ),
    defaultValues,
    mode: 'onBlur',
  });

  useUnsavedChangesWarning(isDirty);

  const [type, distributorId, priceListId, placeOfSupply, lines] = useWatch({
    control,
    name: ['type', 'distributorId', 'priceListId', 'placeOfSupplyStateCode', 'lines'],
  });
  const isSecondary = type === 'SECONDARY';

  const { submit, isPending, summary, unattributed, reset } = useEntityMutation<
    OrderFormValues,
    { id: string; number: string | null }
  >({
    mutationFn: (values, idempotencyKey) => {
      const scalars = pruneEmpty({
        type: values.type,
        // Only the party the type requires is sent. Posting both would be
        // refused by the CHECK constraint the schema mirrors.
        distributorId: isSecondary ? '' : values.distributorId,
        customerId: isSecondary ? values.customerId : '',
        warehouseId: values.warehouseId,
        orderDate: values.orderDate,
        expectedDate: values.expectedDate,
        customerPoNumber: values.customerPoNumber,
        customerPoDate: values.customerPoDate,
        paymentTermsCode: values.paymentTermsCode,
        placeOfSupplyStateCode: values.placeOfSupplyStateCode,
        priceListId: values.priceListId,
        notes: values.notes,
      });
      const body = isEdit
        ? { ...scalars, lines: toSalesLinePayload(values.lines) }
        : { ...scalars, type: values.type, lines: toSalesLinePayload(values.lines) };
      return isEdit
        ? api.patch(`/orders/${orderId}`, body, { idempotencyKey })
        : api.post('/orders', body, { idempotencyKey });
    },
    knownFields: [
      ...KNOWN_FIELDS_BASE,
      ...lineFields('lines', lines?.length ?? 0, SALES_LINE_FIELDS),
    ],
    setError,
    invalidate: [['orders']],
    successMessage: (result) => `Order ${result.number ?? 'draft'} saved`,
    redirectTo: (result) => `/orders/${result.id}`,
  });

  const onSubmit = handleSubmit((values) => {
    reset();
    submit(values);
  });

  return (
    <form onSubmit={onSubmit} className="space-y-8 pb-4" noValidate>
      <FormError summary={summary} unattributed={unattributed} />

      <FieldSet
        legend="Type and party"
        description="PRIMARY is sell-in: Hixaa to a distributor. SECONDARY is sell-out: a distributor to an end customer, issued from that partner's own channel warehouse."
      >
        <FieldRow>
          <Field name="type" label="Order type" error={errors.type?.message} required>
            {(field) => (
              <Select {...field} disabled={isEdit} {...register('type')}>
                <EnumOptions values={ORDER_TYPES} />
              </Select>
            )}
          </Field>

          {isSecondary ? (
            <Field
              name="customerId"
              label="End customer"
              error={errors.customerId?.message}
              required
              description="A SECONDARY order is refused without one."
            >
              {(field) => (
                <Controller
                  control={control}
                  name="customerId"
                  render={({ field: controlled }) => (
                    <EntityPicker
                      control={field}
                      value={controlled.value}
                      onChange={controlled.onChange}
                      onBlur={controlled.onBlur}
                      path="/customers"
                      initialLabel={initialLabels?.customer}
                      placeholder="Search customers…"
                      disabled={isEdit}
                      toOption={(row: { id: string; name: string; code: string }) => ({
                        id: row.id,
                        label: row.name,
                        hint: row.code,
                      })}
                    />
                  )}
                />
              )}
            </Field>
          ) : (
            <Field
              name="distributorId"
              label="Distributor"
              error={errors.distributorId?.message}
              required
              description="Only an ACTIVE partner may transact."
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
                      query={{ status: 'ACTIVE' }}
                      initialLabel={initialLabels?.distributor}
                      placeholder="Search distributors…"
                      disabled={isEdit}
                      toOption={(row: { id: string; legalName: string; code: string }) => ({
                        id: row.id,
                        label: row.legalName,
                        hint: row.code,
                      })}
                    />
                  )}
                />
              )}
            </Field>
          )}
        </FieldRow>

        <FieldRow>
          <Field
            name="warehouseId"
            label="Fulfilling warehouse"
            error={errors.warehouseId?.message}
            description="Blank uses the default warehouse."
          >
            {(field) => (
              <Controller
                control={control}
                name="warehouseId"
                render={({ field: controlled }) => (
                  <EntityPicker
                    control={field}
                    value={controlled.value}
                    onChange={controlled.onChange}
                    onBlur={controlled.onBlur}
                    path="/warehouses"
                    initialLabel={initialLabels?.warehouse}
                    placeholder="Search warehouses…"
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

          <Field
            name="placeOfSupplyStateCode"
            label="Place of supply"
            error={errors.placeOfSupplyStateCode?.message}
            description="Two-digit GST state code. Blank derives it from the party's GSTIN."
          >
            {(field) => (
              <Input
                {...field}
                inputMode="numeric"
                maxLength={2}
                className="font-mono"
                {...register('placeOfSupplyStateCode')}
              />
            )}
          </Field>
        </FieldRow>
      </FieldSet>

      <FieldSet legend="Dates and reference">
        <FieldRow>
          {!isEdit ? (
            <Field
              name="orderDate"
              label="Order date"
              error={errors.orderDate?.message}
              description="Defaults to today."
            >
              {(field) => <DateInput {...field} {...register('orderDate')} />}
            </Field>
          ) : null}
          <Field
            name="expectedDate"
            label="Expected delivery"
            error={errors.expectedDate?.message}
          >
            {(field) => <DateInput {...field} {...register('expectedDate')} />}
          </Field>
        </FieldRow>

        <FieldRow>
          <Field
            name="customerPoNumber"
            label="Customer PO number"
            error={errors.customerPoNumber?.message}
            description="Their reference, quoted back on the invoice."
          >
            {(field) => <Input {...field} {...register('customerPoNumber')} />}
          </Field>
          <Field name="customerPoDate" label="Customer PO date" error={errors.customerPoDate?.message}>
            {(field) => <DateInput {...field} {...register('customerPoDate')} />}
          </Field>
        </FieldRow>

        <FieldRow>
          <Field
            name="paymentTermsCode"
            label="Payment terms"
            error={errors.paymentTermsCode?.message}
            description="Blank uses the party's default."
          >
            {(field) => (
              <Input {...field} className="uppercase" {...register('paymentTermsCode')} />
            )}
          </Field>
          <Field
            name="priceListId"
            label="Price list"
            error={errors.priceListId?.message}
            description="Blank uses the one resolved for this party."
          >
            {(field) => (
              <Controller
                control={control}
                name="priceListId"
                render={({ field: controlled }) => (
                  <EntityPicker
                    control={field}
                    value={controlled.value}
                    onChange={controlled.onChange}
                    onBlur={controlled.onBlur}
                    path="/price-lists"
                    query={{ status: 'ACTIVE' }}
                    placeholder="Search price lists…"
                    toOption={(row: { id: string; code: string; name: string }) => ({
                      id: row.id,
                      label: row.name,
                      hint: row.code,
                    })}
                  />
                )}
              />
            )}
          </Field>
        </FieldRow>
      </FieldSet>

      <FieldSet
        legend="Lines"
        description="Approval reserves what exists and backorders the rest (ADR-0012), so a line that cannot be filled in full still becomes an order."
      >
        <SalesLines
          control={control}
          register={register}
          errors={errors}
          distributorId={distributorId}
          priceListId={priceListId}
          placeOfSupplyStateCode={placeOfSupply}
        />
      </FieldSet>

      <FieldSet legend="Notes">
        <Field name="notes" label="Internal notes" error={errors.notes?.message}>
          {(field) => <Textarea {...field} rows={3} {...register('notes')} />}
        </Field>
      </FieldSet>

      <SubmitBar
        submitLabel={isEdit ? 'Save changes' : 'Create order'}
        submitting={isPending}
        onCancel={() => router.back()}
      />
    </form>
  );
}
