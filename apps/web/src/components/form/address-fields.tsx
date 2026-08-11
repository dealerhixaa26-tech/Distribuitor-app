'use client';

import { useQuery } from '@tanstack/react-query';
import { Controller, type Control, type FieldErrors, type FieldValues, type Path, type UseFormRegister } from 'react-hook-form';
import { api } from '@/lib/api-client';
import { Input } from '@/components/ui/input';
import { Field, FieldRow } from './field';
import { Select } from './select';

/**
 * The address block from `addressSchema`, rendered once.
 *
 * Distributor and Customer both embed the same contract, and a nine-field
 * address written twice is nine chances for the two to diverge — most
 * dangerously on `stateId`, which decides place of supply and therefore whether
 * an invoice carries CGST+SGST or IGST (ADR-0008).
 */

export interface AddressValues {
  line1: string;
  line2: string;
  landmark: string;
  cityName: string;
  stateId: string;
  postalCode: string;
  contactName: string;
  contactPhone: string;
}

export const emptyAddress: AddressValues = {
  line1: '',
  line2: '',
  landmark: '',
  cityName: '',
  stateId: '',
  postalCode: '',
  contactName: '',
  contactPhone: '',
};

/** The leaf names, so a form can build its `knownFields` without listing them. */
export const ADDRESS_FIELD_NAMES = [
  'line1',
  'line2',
  'landmark',
  'cityName',
  'stateId',
  'postalCode',
  'contactName',
  'contactPhone',
] as const;

export const addressFieldPaths = (prefix: string): string[] =>
  ADDRESS_FIELD_NAMES.map((field) => `${prefix}.${field}`);

/** `null` → `''`, so a controlled input never flips to uncontrolled. */
export const toAddressValues = (
  address: Partial<Record<keyof AddressValues, string | null>> | null | undefined,
): AddressValues =>
  address
    ? (Object.fromEntries(
        ADDRESS_FIELD_NAMES.map((field) => [field, address[field] ?? '']),
      ) as unknown as AddressValues)
    : { ...emptyAddress };

interface StateRow {
  id: string;
  name: string;
  gstStateCode: string;
}

/** Shared so thirteen pickers on one page are still one request. */
export function useStates() {
  return useQuery({
    queryKey: ['geography', 'states'],
    queryFn: () => api.get<StateRow[]>('/geography/states'),
    // These change roughly never; refetching them per form would be a request
    // for a list of Indian states that has not moved since 2020.
    staleTime: 60 * 60_000,
  });
}

export function AddressFields<TValues extends FieldValues>({
  prefix,
  control,
  register,
  errors,
}: {
  prefix: Path<TValues>;
  control: Control<TValues>;
  register: UseFormRegister<TValues>;
  errors: FieldErrors<TValues>;
}) {
  const states = useStates();
  const path = (field: string) => `${prefix}.${field}` as Path<TValues>;
  // Errors are nested under the prefix; RHF types them loosely for a dynamic
  // path, so read them through one narrow cast rather than eight.
  const fieldErrors = (errors[prefix as keyof typeof errors] ?? {}) as Record<
    string,
    { message?: string } | undefined
  >;

  return (
    <div className="space-y-4">
      <Field
        name={path('line1')}
        label="Address line 1"
        error={fieldErrors.line1?.message}
        required
      >
        {(field) => <Input {...field} {...register(path('line1'))} />}
      </Field>

      <FieldRow>
        <Field name={path('line2')} label="Address line 2" error={fieldErrors.line2?.message}>
          {(field) => <Input {...field} {...register(path('line2'))} />}
        </Field>
        <Field name={path('landmark')} label="Landmark" error={fieldErrors.landmark?.message}>
          {(field) => <Input {...field} {...register(path('landmark'))} />}
        </Field>
      </FieldRow>

      <FieldRow>
        <Field
          name={path('cityName')}
          label="City"
          error={fieldErrors.cityName?.message}
          required
          description="Free text — not every Indian town is in the reference list."
        >
          {(field) => <Input {...field} {...register(path('cityName'))} />}
        </Field>
        <Field
          name={path('postalCode')}
          label="PIN code"
          error={fieldErrors.postalCode?.message}
          required
        >
          {(field) => (
            <Input {...field} inputMode="numeric" maxLength={6} {...register(path('postalCode'))} />
          )}
        </Field>
      </FieldRow>

      <Field
        name={path('stateId')}
        label="State"
        error={fieldErrors.stateId?.message}
        required
        description="Decides the place of supply, and therefore CGST+SGST versus IGST."
      >
        {/* Controlled, not `register`d. The options arrive from the API AFTER the
            first render, so an uncontrolled select mounts with no matching
            <option>, silently falls back to '', and never picks the default up
            again — an edit form would show a blank state and save the address
            without one. See HANDOFF §4.33. */}
        {(field) => (
          <Controller
            control={control}
            name={path('stateId')}
            render={({ field: controlled }) => (
              <Select
                {...field}
                placeholder="Select a state…"
                value={controlled.value ?? ''}
                onChange={controlled.onChange}
                onBlur={controlled.onBlur}
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
          name={path('contactName')}
          label="Contact at this address"
          error={fieldErrors.contactName?.message}
        >
          {(field) => <Input {...field} {...register(path('contactName'))} />}
        </Field>
        <Field
          name={path('contactPhone')}
          label="Contact phone"
          error={fieldErrors.contactPhone?.message}
        >
          {(field) => (
            <Input {...field} type="tel" inputMode="tel" {...register(path('contactPhone'))} />
          )}
        </Field>
      </FieldRow>
    </div>
  );
}
