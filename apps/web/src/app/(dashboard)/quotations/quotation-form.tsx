'use client';

import { createQuotationSchema, updateQuotationSchema } from '@hixaa/contracts';
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
import { FormError, SubmitBar, useUnsavedChangesWarning } from '@/components/form/submit-bar';
import { Textarea } from '@/components/ui/input';
import { api } from '@/lib/api-client';
import { lineFields } from '@/lib/form-errors';
import { contractResolver, pruneEmpty, useEntityMutation } from '@/lib/use-entity-mutation';

/**
 * Raise or revise a quotation.
 *
 * Hixaa's motion is RFQ-first (`docs/00`), so this is usually the first
 * document in a deal. It is addressed to a distributor OR a customer — the
 * contract refines on at least one being present, and that rule fires here
 * because the resolver is the contract's own.
 *
 * The lines carry no price. `SalesLines` shows what `POST /pricing/quote`
 * returns, which is the same engine that will price the saved document.
 */

const KNOWN_FIELDS_BASE: readonly string[] = [
  'distributorId',
  'customerId',
  'quotationDate',
  'validUntil',
  'placeOfSupplyStateCode',
  'priceListId',
  'termsAndConditions',
  'notes',
  'lines',
];

export interface QuotationFormValues {
  distributorId: string;
  customerId: string;
  quotationDate: string;
  validUntil: string;
  placeOfSupplyStateCode: string;
  priceListId: string;
  termsAndConditions: string;
  notes: string;
  lines: SalesLineValues[];
}

export const emptyQuotation = (): QuotationFormValues => ({
  distributorId: '',
  customerId: '',
  quotationDate: '',
  validUntil: '',
  placeOfSupplyStateCode: '',
  priceListId: '',
  termsAndConditions: '',
  notes: '',
  lines: [{ ...emptySalesLine }],
});

interface QuotationFormProps {
  mode: 'create' | 'edit';
  defaultValues: QuotationFormValues;
  initialLabels?: { distributor?: string; customer?: string; priceList?: string };
  quotationId?: string;
}

export function QuotationForm({
  mode,
  defaultValues,
  initialLabels,
  quotationId,
}: QuotationFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';

  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<QuotationFormValues>({
    resolver: contractResolver<QuotationFormValues>(
      (isEdit ? updateQuotationSchema : createQuotationSchema) as never,
    ),
    defaultValues,
    mode: 'onBlur',
  });

  useUnsavedChangesWarning(isDirty);

  const [distributorId, customerId, priceListId, placeOfSupply, lines] = useWatch({
    control,
    name: ['distributorId', 'customerId', 'priceListId', 'placeOfSupplyStateCode', 'lines'],
  });

  const { submit, isPending, summary, unattributed, reset } = useEntityMutation<
    QuotationFormValues,
    { id: string; number: string | null }
  >({
    mutationFn: (values, idempotencyKey) => {
      const body = {
        ...pruneEmpty({
          distributorId: values.distributorId,
          customerId: values.customerId,
          quotationDate: values.quotationDate,
          validUntil: values.validUntil,
          placeOfSupplyStateCode: values.placeOfSupplyStateCode,
          priceListId: values.priceListId,
          termsAndConditions: values.termsAndConditions,
          notes: values.notes,
        }),
        lines: toSalesLinePayload(values.lines),
      };
      return isEdit
        ? api.patch(`/quotations/${quotationId}`, body, { idempotencyKey })
        : api.post('/quotations', body, { idempotencyKey });
    },
    knownFields: [
      ...KNOWN_FIELDS_BASE,
      ...lineFields('lines', lines?.length ?? 0, SALES_LINE_FIELDS),
    ],
    setError,
    invalidate: [['quotations']],
    successMessage: (result) => `Quotation ${result.number ?? 'draft'} saved`,
    redirectTo: (result) => `/quotations/${result.id}`,
  });

  const onSubmit = handleSubmit((values) => {
    reset();
    submit(values);
  });

  return (
    <form onSubmit={onSubmit} className="space-y-8 pb-4" noValidate>
      <FormError summary={summary} unattributed={unattributed} />

      <FieldSet
        legend="Addressed to"
        description="A quotation goes to a distributor or to an end customer — one of the two is required."
      >
        <FieldRow>
          <Field
            name="distributorId"
            label="Distributor"
            error={errors.distributorId?.message}
            description={customerId ? 'Clear the customer to address a distributor.' : undefined}
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
                    disabled={isEdit || Boolean(customerId)}
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

          <Field
            name="customerId"
            label="Customer"
            error={errors.customerId?.message}
            description={distributorId ? 'Clear the distributor to address a customer.' : undefined}
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
                    disabled={isEdit || Boolean(distributorId)}
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
        </FieldRow>
      </FieldSet>

      <FieldSet legend="Terms">
        <FieldRow>
          {!isEdit ? (
            <Field
              name="quotationDate"
              label="Quotation date"
              error={errors.quotationDate?.message}
              description="Defaults to today."
            >
              {(field) => <DateInput {...field} {...register('quotationDate')} />}
            </Field>
          ) : null}
          <Field
            name="validUntil"
            label="Valid until"
            error={errors.validUntil?.message}
            description="After this the quotation lapses and appears on the follow-up list."
          >
            {(field) => <DateInput {...field} {...register('validUntil')} />}
          </Field>
        </FieldRow>

        <FieldRow>
          <Field
            name="priceListId"
            label="Price list"
            error={errors.priceListId?.message}
            description="Leave blank to use the one resolved for this party."
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
                    initialLabel={initialLabels?.priceList}
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

          <Field
            name="placeOfSupplyStateCode"
            label="Place of supply"
            error={errors.placeOfSupplyStateCode?.message}
            description="Two-digit GST state code. Blank derives it from the party's GSTIN — it decides CGST+SGST versus IGST."
          >
            {(field) => (
              <input
                {...field}
                inputMode="numeric"
                maxLength={2}
                className="flex min-h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-[invalid=true]:border-destructive"
                {...register('placeOfSupplyStateCode')}
              />
            )}
          </Field>
        </FieldRow>
      </FieldSet>

      <FieldSet
        legend="Lines"
        description="Prices come from the engine, never from this screen. An override is an audited input, not a bypass."
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

      <FieldSet legend="Wording">
        <Field
          name="termsAndConditions"
          label="Terms and conditions"
          error={errors.termsAndConditions?.message}
          description="Printed on the PDF sent to the partner."
        >
          {(field) => <Textarea {...field} rows={4} {...register('termsAndConditions')} />}
        </Field>
        <Field
          name="notes"
          label="Internal notes"
          error={errors.notes?.message}
          description="Not printed."
        >
          {(field) => <Textarea {...field} rows={2} {...register('notes')} />}
        </Field>
      </FieldSet>

      <SubmitBar
        submitLabel={isEdit ? 'Save changes' : 'Create quotation'}
        submitting={isPending}
        onCancel={() => router.back()}
      />
    </form>
  );
}
