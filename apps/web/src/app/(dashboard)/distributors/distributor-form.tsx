'use client';

import {
  DISTRIBUTOR_TYPES,
  createDistributorSchema,
  updateDistributorSchema,
} from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Controller, useForm } from 'react-hook-form';
import { EntityPicker } from '@/components/form/entity-picker';
import { Field, FieldRow, FieldSet } from '@/components/form/field';
import { MoneyInput } from '@/components/form/money-input';
import { EnumOptions, Select } from '@/components/form/select';
import { FormError, SubmitBar, useUnsavedChangesWarning } from '@/components/form/submit-bar';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api-client';
import { contractResolver, pruneEmpty, useEntityMutation } from '@/lib/use-entity-mutation';

/**
 * Create and edit a distributor.
 *
 * One component for both, because the two schemas differ only in optionality
 * and a second near-identical form is how the create path and the edit path
 * come to validate slightly different things.
 *
 * The schema is `@hixaa/contracts`' own — the same object the API validates
 * against (ADR-0001). That includes the cross-field rule tying PAN to the PAN
 * embedded in the GSTIN, which therefore fires here without being restated.
 */

// ── The fields this form renders ────────────────────────────────────────────
// Declared once and handed to `applyServerErrors`, which places a refusal only
// on a field that exists here and surfaces everything else in the summary. A
// field removed from the markup but left in this list would silently swallow
// its own errors, so the two are kept adjacent deliberately.
const ADDRESS_FIELDS = [
  'line1',
  'line2',
  'landmark',
  'cityName',
  'stateId',
  'postalCode',
  'contactName',
  'contactPhone',
] as const;

const KNOWN_FIELDS: readonly string[] = [
  'legalName',
  'tradeName',
  'type',
  'territoryId',
  'accountManagerId',
  'gstin',
  'pan',
  'tan',
  'cin',
  'msmeNumber',
  'creditLimit',
  'creditDays',
  'openingBalance',
  'paymentTermsCode',
  'website',
  'bankAccountName',
  'bankAccountNumber',
  'bankIfsc',
  'bankName',
  ...ADDRESS_FIELDS.map((field) => `billingAddress.${field}`),
  ...ADDRESS_FIELDS.map((field) => `shippingAddress.${field}`),
];

interface StateRow {
  id: string;
  name: string;
  code: string;
  gstStateCode: string;
}

export interface DistributorFormValues {
  legalName: string;
  tradeName: string;
  type: string;
  territoryId: string;
  accountManagerId: string;
  gstin: string;
  pan: string;
  tan: string;
  cin: string;
  msmeNumber: string;
  creditLimit: string;
  creditDays: number;
  openingBalance: string;
  paymentTermsCode: string;
  website: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankIfsc: string;
  bankName: string;
  billingAddress: AddressValues;
  shippingAddress: AddressValues;
}

interface AddressValues {
  line1: string;
  line2: string;
  landmark: string;
  cityName: string;
  stateId: string;
  postalCode: string;
  contactName: string;
  contactPhone: string;
}

const emptyAddress: AddressValues = {
  line1: '',
  line2: '',
  landmark: '',
  cityName: '',
  stateId: '',
  postalCode: '',
  contactName: '',
  contactPhone: '',
};

export const emptyDistributor: DistributorFormValues = {
  legalName: '',
  tradeName: '',
  type: 'DISTRIBUTOR',
  territoryId: '',
  accountManagerId: '',
  gstin: '',
  pan: '',
  tan: '',
  cin: '',
  msmeNumber: '',
  creditLimit: '0',
  creditDays: 30,
  openingBalance: '0',
  paymentTermsCode: '',
  website: '',
  bankAccountName: '',
  bankAccountNumber: '',
  bankIfsc: '',
  bankName: '',
  billingAddress: { ...emptyAddress },
  shippingAddress: { ...emptyAddress },
};

interface DistributorFormProps {
  mode: 'create' | 'edit';
  defaultValues: DistributorFormValues;
  /** Edit only — pre-fills the picker labels so they do not show a bare UUID. */
  initialLabels?: { territory?: string; accountManager?: string };
  /** Edit only — shown beside the blank account-number field. */
  bankAccountMasked?: string | null;
  distributorId?: string;
}

export function DistributorForm({
  mode,
  defaultValues,
  initialLabels,
  bankAccountMasked,
  distributorId,
}: DistributorFormProps) {
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
  } = useForm<DistributorFormValues>({
    // The contract's OWN schema, not a copy — including the rule tying PAN to
    // the PAN embedded in the GSTIN. `contractResolver` prunes empty inputs
    // first, so what the browser validates is what the server will receive.
    resolver: contractResolver<DistributorFormValues>(
      (isEdit ? updateDistributorSchema : createDistributorSchema) as never,
    ),
    defaultValues,
    mode: 'onBlur',
  });

  useUnsavedChangesWarning(isDirty);

  const states = useQuery({
    queryKey: ['geography', 'states'],
    queryFn: () => api.get<StateRow[]>('/geography/states'),
    staleTime: 60 * 60_000,
  });

  const { submit, isPending, summary, unattributed, reset } = useEntityMutation<
    DistributorFormValues,
    { id: string; code: string; legalName: string }
  >({
    mutationFn: (values) => {
      // Empty strings are pruned rather than sent: '' fails gstinSchema,
      // urlSchema and every other refined string, so an untouched optional
      // input would refuse a perfectly valid record. On edit this also means a
      // blank bank account number leaves the stored one untouched, which is why
      // the plaintext never needs to leave the server.
      const body = pruneEmpty(values as unknown as Record<string, unknown>);
      return isEdit
        ? api.patch(`/distributors/${distributorId}`, body)
        : api.post('/distributors', body);
    },
    knownFields: KNOWN_FIELDS,
    setError,
    // Prefix match: this covers the list AND ['distributors', id]. Invalidating
    // with no key at all would refetch the whole application.
    invalidate: [['distributors']],
    successMessage: (result) =>
      isEdit ? `${result.legalName} updated` : `${result.code} — ${result.legalName} created`,
    redirectTo: (result) => `/distributors/${result.id}`,
  });

  const onSubmit = handleSubmit((values) => {
    reset();
    submit(values);
  });

  const copyBillingToShipping = () => {
    const billing = watch('billingAddress');
    setValue('shippingAddress', { ...billing }, { shouldDirty: true, shouldValidate: true });
  };

  const addressFields = (prefix: 'billingAddress' | 'shippingAddress') => (
    <div className="space-y-4">
      <Field
        name={`${prefix}.line1`}
        label="Address line 1"
        error={errors[prefix]?.line1?.message}
        required
      >
        {(control) => <Input {...control} {...register(`${prefix}.line1`)} />}
      </Field>

      <FieldRow>
        <Field name={`${prefix}.line2`} label="Address line 2" error={errors[prefix]?.line2?.message}>
          {(control) => <Input {...control} {...register(`${prefix}.line2`)} />}
        </Field>
        <Field
          name={`${prefix}.landmark`}
          label="Landmark"
          error={errors[prefix]?.landmark?.message}
        >
          {(control) => <Input {...control} {...register(`${prefix}.landmark`)} />}
        </Field>
      </FieldRow>

      <FieldRow>
        <Field
          name={`${prefix}.cityName`}
          label="City"
          error={errors[prefix]?.cityName?.message}
          required
          description="Free text — not every Indian town is in the reference list."
        >
          {(control) => <Input {...control} {...register(`${prefix}.cityName`)} />}
        </Field>
        <Field
          name={`${prefix}.postalCode`}
          label="PIN code"
          error={errors[prefix]?.postalCode?.message}
          required
        >
          {(control) => (
            <Input {...control} inputMode="numeric" maxLength={6} {...register(`${prefix}.postalCode`)} />
          )}
        </Field>
      </FieldRow>

      <Field
        name={`${prefix}.stateId`}
        label="State"
        error={errors[prefix]?.stateId?.message}
        required
        description="Decides the place of supply, and therefore CGST+SGST versus IGST."
      >
        {/* Controlled, not `register`d. The options arrive from the API AFTER
            the first render, so an uncontrolled select is mounted with no
            matching <option>, silently falls back to '', and never picks the
            default up again — an edit form would show a blank state and save
            the address without one. Found by loading an edit page, not by
            reading this file. */}
        {(fieldControl) => (
          <Controller
            control={control}
            name={`${prefix}.stateId`}
            render={({ field }) => (
              <Select
                {...fieldControl}
                placeholder="Select a state…"
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                disabled={states.isLoading}
              >
                {(states.data ?? []).map((state) => (
                  <option key={state.id} value={state.id}>
                    {state.name} ({state.gstStateCode})
                  </option>
                ))}
              </Select>
            )}
          />
        )}
      </Field>

      <FieldRow>
        <Field
          name={`${prefix}.contactName`}
          label="Contact at this address"
          error={errors[prefix]?.contactName?.message}
        >
          {(control) => <Input {...control} {...register(`${prefix}.contactName`)} />}
        </Field>
        <Field
          name={`${prefix}.contactPhone`}
          label="Contact phone"
          error={errors[prefix]?.contactPhone?.message}
        >
          {(control) => (
            <Input {...control} type="tel" inputMode="tel" {...register(`${prefix}.contactPhone`)} />
          )}
        </Field>
      </FieldRow>
    </div>
  );

  return (
    <form onSubmit={onSubmit} className="max-w-3xl space-y-8 pb-4" noValidate>
      <FormError summary={summary} unattributed={unattributed} />

      <FieldSet legend="Identity">
        <Field name="legalName" label="Legal name" error={errors.legalName?.message} required>
          {(control) => <Input {...control} autoFocus={!isEdit} {...register('legalName')} />}
        </Field>

        <FieldRow>
          <Field
            name="tradeName"
            label="Trade name"
            error={errors.tradeName?.message}
            description="The name people actually use, if it differs."
          >
            {(control) => <Input {...control} {...register('tradeName')} />}
          </Field>
          <Field name="type" label="Type" error={errors.type?.message} required>
            {(control) => (
              <Select {...control} {...register('type')}>
                <EnumOptions values={DISTRIBUTOR_TYPES} />
              </Select>
            )}
          </Field>
        </FieldRow>

        <FieldRow>
          <Field
            name="territoryId"
            label="Territory"
            error={errors.territoryId?.message}
            description="Determines who can see this partner at all."
          >
            {(fieldControl) => (
              <Controller
                control={control}
                name="territoryId"
                render={({ field }) => (
                  <EntityPicker
                    control={fieldControl}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
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

          <Field
            name="accountManagerId"
            label="Account manager"
            error={errors.accountManagerId?.message}
          >
            {(fieldControl) => (
              <Controller
                control={control}
                name="accountManagerId"
                render={({ field }) => (
                  <EntityPicker
                    control={fieldControl}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    path="/users"
                    initialLabel={initialLabels?.accountManager}
                    placeholder="Search users…"
                    toOption={(row: {
                      id: string;
                      firstName: string;
                      lastName: string;
                      email: string;
                    }) => ({
                      id: row.id,
                      label: `${row.firstName} ${row.lastName}`,
                      hint: row.email,
                    })}
                  />
                )}
              />
            )}
          </Field>
        </FieldRow>

        <Field
          name="website"
          label="Website"
          error={errors.website?.message}
          description="Include https://"
        >
          {(control) => <Input {...control} type="url" {...register('website')} />}
        </Field>
      </FieldSet>

      <FieldSet
        legend="Statutory"
        description="The GSTIN embeds its holder's PAN. Give both and they must agree — if they do not, one is a typo and the invoice that results would be wrong."
      >
        <FieldRow>
          <Field name="gstin" label="GSTIN" error={errors.gstin?.message}>
            {(control) => (
              <Input
                {...control}
                maxLength={15}
                className="font-mono uppercase"
                autoCapitalize="characters"
                {...register('gstin')}
              />
            )}
          </Field>
          <Field name="pan" label="PAN" error={errors.pan?.message}>
            {(control) => (
              <Input
                {...control}
                maxLength={10}
                className="font-mono uppercase"
                autoCapitalize="characters"
                {...register('pan')}
              />
            )}
          </Field>
        </FieldRow>

        <FieldRow>
          <Field name="tan" label="TAN" error={errors.tan?.message}>
            {(control) => (
              <Input {...control} maxLength={10} className="font-mono uppercase" {...register('tan')} />
            )}
          </Field>
          <Field name="cin" label="CIN" error={errors.cin?.message}>
            {(control) => (
              <Input {...control} maxLength={21} className="font-mono uppercase" {...register('cin')} />
            )}
          </Field>
        </FieldRow>

        <Field
          name="msmeNumber"
          label="Udyam registration"
          error={errors.msmeNumber?.message}
          description="MSME status affects the payment terms the law allows."
        >
          {(control) => <Input {...control} className="font-mono uppercase" {...register('msmeNumber')} />}
        </Field>
      </FieldSet>

      <FieldSet legend="Commercial terms">
        <FieldRow>
          {/* Only on create. Changing a limit later is its own endpoint with its
              own permission and a mandatory reason — burying that in a form
              that also edits a phone number is exactly what the contract's
              comment refuses. */}
          {!isEdit ? (
            <Field
              name="creditLimit"
              label="Credit limit"
              error={errors.creditLimit?.message}
              description="Changed later through its own audited action."
            >
              {(control) => <MoneyInput {...control} {...register('creditLimit')} />}
            </Field>
          ) : null}

          <Field
            name="creditDays"
            label="Credit days"
            error={errors.creditDays?.message}
            description="0–365."
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                min={0}
                max={365}
                {...register('creditDays', { valueAsNumber: true })}
              />
            )}
          </Field>
        </FieldRow>

        <FieldRow>
          {!isEdit ? (
            <Field
              name="openingBalance"
              label="Opening balance"
              error={errors.openingBalance?.message}
              description="What this partner already owed when they were entered."
            >
              {(control) => <MoneyInput {...control} {...register('openingBalance')} />}
            </Field>
          ) : null}

          <Field
            name="paymentTermsCode"
            label="Payment terms code"
            error={errors.paymentTermsCode?.message}
          >
            {(control) => (
              <Input {...control} className="uppercase" maxLength={20} {...register('paymentTermsCode')} />
            )}
          </Field>
        </FieldRow>
      </FieldSet>

      <FieldSet
        legend="Banking"
        description={
          isEdit
            ? `Account number on file: ${bankAccountMasked ?? 'none'}. Leave blank to keep it — it is encrypted at rest and never sent to the browser.`
            : 'Stored encrypted. Needed to pay a distributor, and to match their remittances.'
        }
      >
        <FieldRow>
          <Field name="bankName" label="Bank" error={errors.bankName?.message}>
            {(control) => <Input {...control} {...register('bankName')} />}
          </Field>
          <Field
            name="bankAccountName"
            label="Account holder"
            error={errors.bankAccountName?.message}
          >
            {(control) => <Input {...control} {...register('bankAccountName')} />}
          </Field>
        </FieldRow>

        <FieldRow>
          <Field
            name="bankAccountNumber"
            label="Account number"
            error={errors.bankAccountNumber?.message}
          >
            {(control) => (
              <Input
                {...control}
                autoComplete="off"
                className="font-mono"
                {...register('bankAccountNumber')}
              />
            )}
          </Field>
          <Field name="bankIfsc" label="IFSC" error={errors.bankIfsc?.message}>
            {(control) => (
              <Input
                {...control}
                maxLength={11}
                className="font-mono uppercase"
                {...register('bankIfsc')}
              />
            )}
          </Field>
        </FieldRow>
      </FieldSet>

      <FieldSet legend="Billing address">{addressFields('billingAddress')}</FieldSet>

      <FieldSet legend="Shipping address">
        <button
          type="button"
          onClick={copyBillingToShipping}
          className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Same as billing
        </button>
        {addressFields('shippingAddress')}
      </FieldSet>

      <SubmitBar
        submitLabel={isEdit ? 'Save changes' : 'Create distributor'}
        submitting={isPending}
        onCancel={() => router.back()}
      />
    </form>
  );
}
