'use client';

import { PAYMENT_METHODS, createPaymentSchema, updatePaymentSchema } from '@hixaa/contracts';
import { useRouter } from 'next/navigation';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { EntityPicker } from '@/components/form/entity-picker';
import { Field, FieldRow, FieldSet } from '@/components/form/field';
import { DateInput, MoneyInput } from '@/components/form/money-input';
import { EnumOptions, Select } from '@/components/form/select';
import { FormError, SubmitBar, useUnsavedChangesWarning } from '@/components/form/submit-bar';
import { Input, Textarea } from '@/components/ui/input';
import { api } from '@/lib/api-client';
import { contractResolver, pruneEmpty, useEntityMutation } from '@/lib/use-entity-mutation';

/**
 * Record a receipt.
 *
 * **Recording is a memo with no financial effect.** It writes no ledger entry
 * and settles no invoice. VERIFYING is the financial event, it is a separate
 * action, and the verifier may not be the recorder (ADR-0018) — which is why
 * this form has no "verify" checkbox and no allocation grid. Offering either
 * here would make the segregation a matter of remembering rather than of shape.
 *
 * TDS is held apart from the amount because the two reconcile against different
 * statements: the bank, and Form 26AS.
 */

const KNOWN_FIELDS: readonly string[] = [
  'distributorId',
  'customerId',
  'method',
  'amount',
  'tdsAmount',
  'paymentDate',
  'referenceNumber',
  'bankName',
  'ifsc',
  'chequeNumber',
  'chequeDate',
  'notes',
];

export interface PaymentFormValues {
  distributorId: string;
  customerId: string;
  method: string;
  amount: string;
  tdsAmount: string;
  paymentDate: string;
  referenceNumber: string;
  bankName: string;
  ifsc: string;
  chequeNumber: string;
  chequeDate: string;
  notes: string;
}

export const emptyPayment = (): PaymentFormValues => ({
  distributorId: '',
  customerId: '',
  method: 'NEFT',
  amount: '',
  tdsAmount: '',
  paymentDate: '',
  referenceNumber: '',
  bankName: '',
  ifsc: '',
  chequeNumber: '',
  chequeDate: '',
  notes: '',
});

interface PaymentFormProps {
  mode: 'create' | 'edit';
  defaultValues: PaymentFormValues;
  initialLabels?: { distributor?: string; customer?: string };
  paymentId?: string;
}

export function PaymentForm({ mode, defaultValues, initialLabels, paymentId }: PaymentFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';

  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<PaymentFormValues>({
    resolver: contractResolver<PaymentFormValues>(
      (isEdit ? updatePaymentSchema : createPaymentSchema) as never,
    ),
    defaultValues,
    mode: 'onBlur',
  });

  useUnsavedChangesWarning(isDirty);

  const [method, distributorId, customerId] = useWatch({
    control,
    name: ['method', 'distributorId', 'customerId'],
  });
  // A cheque with no number cannot be traced to a bank statement, which is the
  // whole basis on which it will later be verified.
  const needsCheque = method === 'CHEQUE' || method === 'DEMAND_DRAFT';

  const { submit, isPending, summary, unattributed, reset } = useEntityMutation<
    PaymentFormValues,
    { id: string; number: string | null }
  >({
    mutationFn: (values, idempotencyKey) => {
      const body = pruneEmpty(values as unknown as Record<string, unknown>);
      return isEdit
        ? api.patch(`/payments/${paymentId}`, body, { idempotencyKey })
        : api.post('/payments', body, { idempotencyKey });
    },
    knownFields: KNOWN_FIELDS,
    setError,
    invalidate: [['payments'], ['outstanding']],
    successMessage: (result) =>
      isEdit ? 'Receipt updated' : `Receipt ${result.number ?? ''} recorded — not yet verified`,
    redirectTo: (result) => `/payments/${result.id}`,
  });

  const onSubmit = handleSubmit((values) => {
    reset();
    submit(values);
  });

  return (
    <form onSubmit={onSubmit} className="max-w-3xl space-y-8 pb-4" noValidate>
      <FormError summary={summary} unattributed={unattributed} />

      <div
        role="note"
        className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
      >
        Recording a receipt has <strong>no financial effect</strong>. No ledger entry is written and
        no invoice is settled until someone else verifies it against the bank.
      </div>

      <FieldSet
        legend="Who paid"
        description="Exactly one party — a distributor or a customer, never both."
      >
        <FieldRow>
          <Field name="distributorId" label="Distributor" error={errors.distributorId?.message}>
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

          <Field name="customerId" label="Customer" error={errors.customerId?.message}>
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

      <FieldSet legend="What was received">
        <FieldRow>
          <Field name="method" label="Method" error={errors.method?.message} required>
            {(field) => (
              <Select {...field} {...register('method')}>
                <EnumOptions values={PAYMENT_METHODS} />
              </Select>
            )}
          </Field>
          <Field
            name="paymentDate"
            label="Payment date"
            error={errors.paymentDate?.message}
            description="Defaults to today."
          >
            {(field) => <DateInput {...field} {...register('paymentDate')} />}
          </Field>
        </FieldRow>

        <FieldRow>
          <Field
            name="amount"
            label="Amount received"
            error={errors.amount?.message}
            required
            description="Cash actually received, excluding any TDS the payer withheld."
          >
            {(field) => <MoneyInput {...field} {...register('amount')} />}
          </Field>
          <Field
            name="tdsAmount"
            label="TDS withheld"
            error={errors.tdsAmount?.message}
            description="Held separately — the bank statement and Form 26AS are different reconciliations."
          >
            {(field) => <MoneyInput {...field} {...register('tdsAmount')} />}
          </Field>
        </FieldRow>

        <Field
          name="referenceNumber"
          label="Reference"
          error={errors.referenceNumber?.message}
          description="UTR, transaction id, or slip number — what verification will match against."
        >
          {(field) => <Input {...field} className="font-mono" {...register('referenceNumber')} />}
        </Field>
      </FieldSet>

      <FieldSet legend="Bank details">
        <FieldRow>
          <Field name="bankName" label="Bank" error={errors.bankName?.message}>
            {(field) => <Input {...field} {...register('bankName')} />}
          </Field>
          <Field name="ifsc" label="IFSC" error={errors.ifsc?.message}>
            {(field) => (
              <Input {...field} maxLength={11} className="font-mono uppercase" {...register('ifsc')} />
            )}
          </Field>
        </FieldRow>

        {needsCheque ? (
          <FieldRow>
            <Field
              name="chequeNumber"
              label={method === 'CHEQUE' ? 'Cheque number' : 'Demand draft number'}
              error={errors.chequeNumber?.message}
              required
              description="Required — it is what verification matches against on the statement."
            >
              {(field) => <Input {...field} className="font-mono" {...register('chequeNumber')} />}
            </Field>
            <Field name="chequeDate" label="Instrument date" error={errors.chequeDate?.message}>
              {(field) => <DateInput {...field} {...register('chequeDate')} />}
            </Field>
          </FieldRow>
        ) : null}
      </FieldSet>

      <FieldSet legend="Notes">
        <Field name="notes" label="Internal notes" error={errors.notes?.message}>
          {(field) => <Textarea {...field} rows={3} {...register('notes')} />}
        </Field>
      </FieldSet>

      <SubmitBar
        submitLabel={isEdit ? 'Save changes' : 'Record receipt'}
        submitting={isPending}
        onCancel={() => router.back()}
      />
    </form>
  );
}
