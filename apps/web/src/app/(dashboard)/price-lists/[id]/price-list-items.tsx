'use client';

import { PERMISSIONS, upsertPriceListItemsSchema } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { EntityPicker } from '@/components/form/entity-picker';
import { Field } from '@/components/form/field';
import { MoneyInput, QuantityInput } from '@/components/form/money-input';
import { FormError } from '@/components/form/submit-bar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api-client';
import { lineFields } from '@/lib/form-errors';
import { usePermission } from '@/lib/use-permission';
import { contractResolver, pruneEmpty, useEntityMutation } from '@/lib/use-entity-mutation';
import { formatMoney } from '@/lib/utils';

/**
 * The slab rows of a price list.
 *
 * A row is one volume slab: `minQty` is its inclusive lower bound, so 1 / 10 /
 * 50 for one product is three rows. This is the first repeating-row editor in
 * the app and the pattern the quotation and order line editors will follow —
 * `useFieldArray`, one `EntityPicker` per row, and `lineFields()` so a server
 * error on row 7 attaches to row 7 rather than vanishing.
 *
 * `replaceAll` is deliberately surfaced rather than assumed. Sending the whole
 * grid with `replaceAll: false` merges by product+slab and leaves untouched
 * rows alone; `true` deletes everything absent from the submission. Guessing
 * either way silently discards prices someone else added.
 */

interface PriceListItemRow {
  id: string;
  productId: string;
  sku: string;
  name: string;
  minQty: string;
  price: string;
  minPrice: string | null;
}

interface ItemFormValues {
  items: Array<{
    productId: string;
    minQty: string;
    price: string;
    minPrice: string;
    /** Display only — never sent. Keeps the picker labelled after a reload. */
    label: string;
  }>;
  replaceAll: boolean;
}

export function PriceListItems({
  priceListId,
  status,
}: {
  priceListId: string;
  status: string;
}) {
  const { can } = usePermission();

  const { data, isLoading } = useQuery({
    queryKey: ['price-lists', priceListId, 'items'],
    queryFn: () => api.get<PriceListItemRow[]>(`/price-lists/${priceListId}/items`),
  });

  if (isLoading) return <TableSkeleton />;

  return (
    <ItemsEditor
      priceListId={priceListId}
      status={status}
      rows={data ?? []}
      canEdit={can(PERMISSIONS.PRICELIST_UPDATE)}
    />
  );
}

function ItemsEditor({
  priceListId,
  status,
  rows,
  canEdit,
}: {
  priceListId: string;
  status: string;
  rows: PriceListItemRow[];
  canEdit: boolean;
}) {
  const {
    register,
    control,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isDirty },
  } = useForm<ItemFormValues>({
    resolver: contractResolver<ItemFormValues>(upsertPriceListItemsSchema as never),
    defaultValues: {
      items: rows.map((row) => ({
        productId: row.productId,
        minQty: row.minQty,
        price: row.price,
        minPrice: row.minPrice ?? '',
        label: `${row.sku} — ${row.name}`,
      })),
      replaceAll: false,
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });
  const replaceAll = watch('replaceAll');

  const { submit, isPending, summary, unattributed, reset } = useEntityMutation<
    ItemFormValues,
    { updated?: number; created?: number }
  >({
    mutationFn: (values, idempotencyKey) =>
      api.put(
        `/price-lists/${priceListId}/items`,
        {
          // `label` is presentation and would be rejected by the schema — Zod
          // strips unknown keys, but sending it invites the next person to
          // wonder whether it means something.
          items: values.items.map(({ label: _label, ...item }) =>
            pruneEmpty(item as unknown as Record<string, unknown>),
          ),
          replaceAll: values.replaceAll,
        },
        { idempotencyKey },
      ),
    // Row errors come back as items[3].price; `lineFields` expands the paths so
    // they land on the row rather than in the summary.
    knownFields: ['items', 'replaceAll', ...lineFields('items', fields.length, [
      'productId',
      'minQty',
      'price',
      'minPrice',
    ])],
    setError,
    invalidate: [['price-lists', priceListId], ['products']],
    successMessage: 'Prices saved',
  });

  const onSubmit = handleSubmit((values) => {
    reset();
    submit(values);
  });

  // ARCHIVED lists are history. Editing one would rewrite what a past quotation
  // was priced against, and every document snapshots its own pricing anyway
  // (ADR-0011), so there is nothing to gain and a record to corrupt.
  const locked = status === 'ARCHIVED' || !canEdit;

  if (locked && fields.length === 0) {
    return (
      <EmptyState
        title="No prices on this list"
        description={
          status === 'ARCHIVED'
            ? 'An archived list is history and cannot be changed.'
            : 'You do not have permission to edit prices.'
        }
      />
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormError summary={summary} unattributed={unattributed} />

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[52rem] text-sm">
          <caption className="sr-only">Price list slabs</caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">Product</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">From qty</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Unit price</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Floor price</th>
              <th scope="col" className="w-10 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {fields.map((field, index) => (
              <tr key={field.id} className="border-t border-border align-top">
                <td className="px-3 py-2">
                  <Field
                    name={`items.${index}.productId`}
                    label={`Product, row ${index + 1}`}
                    error={errors.items?.[index]?.productId?.message}
                  >
                    {(fieldControl) => (
                      <Controller
                        control={control}
                        name={`items.${index}.productId`}
                        render={({ field: controlled }) => (
                          <EntityPicker
                            control={fieldControl}
                            value={controlled.value}
                            onChange={controlled.onChange}
                            onBlur={controlled.onBlur}
                            path="/products"
                            initialLabel={watch(`items.${index}.label`)}
                            placeholder="Search products…"
                            disabled={locked}
                            toOption={(row: { id: string; sku: string; name: string }) => ({
                              id: row.id,
                              label: `${row.sku} — ${row.name}`,
                              hint: row.sku,
                            })}
                          />
                        )}
                      />
                    )}
                  </Field>
                </td>
                <td className="px-3 py-2">
                  <Field
                    name={`items.${index}.minQty`}
                    label={`From quantity, row ${index + 1}`}
                    error={errors.items?.[index]?.minQty?.message}
                  >
                    {(fieldControl) => (
                      <QuantityInput
                        {...fieldControl}
                        disabled={locked}
                        className="w-24"
                        {...register(`items.${index}.minQty`)}
                      />
                    )}
                  </Field>
                </td>
                <td className="px-3 py-2">
                  <Field
                    name={`items.${index}.price`}
                    label={`Unit price, row ${index + 1}`}
                    error={errors.items?.[index]?.price?.message}
                  >
                    {(fieldControl) => (
                      <MoneyInput
                        {...fieldControl}
                        disabled={locked}
                        className="w-32"
                        {...register(`items.${index}.price`)}
                      />
                    )}
                  </Field>
                </td>
                <td className="px-3 py-2">
                  <Field
                    name={`items.${index}.minPrice`}
                    label={`Floor price, row ${index + 1}`}
                    error={errors.items?.[index]?.minPrice?.message}
                  >
                    {(fieldControl) => (
                      <MoneyInput
                        {...fieldControl}
                        disabled={locked}
                        className="w-32"
                        {...register(`items.${index}.minPrice`)}
                      />
                    )}
                  </Field>
                </td>
                <td className="px-3 py-2">
                  {!locked ? (
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                      <span className="sr-only">Remove row {index + 1}</span>
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}

            {fields.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No prices yet. Add a row to set one.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        The floor price is what an override is measured against: below it, a discount is flagged for
        approval regardless of who granted it. Prices are GST-exclusive (ADR-0008).
      </p>

      {!locked ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              append({ productId: '', minQty: '1', price: '', minPrice: '', label: '' })
            }
          >
            <Plus aria-hidden="true" />
            Add row
          </Button>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="size-4 rounded border-input accent-[hsl(var(--primary))]"
                {...register('replaceAll')}
              />
              Replace the whole list
            </label>
            <Button type="submit" loading={isPending} disabled={!isDirty}>
              Save prices
            </Button>
          </div>
        </div>
      ) : null}

      {replaceAll ? (
        <p role="status" className="text-xs text-warning">
          Every price not listed above will be deleted, including any added by someone else since
          this page loaded.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {rows.length} slab{rows.length === 1 ? '' : 's'} currently stored · highest{' '}
          {formatMoney(
            rows.reduce((max, row) => (Number(row.price) > Number(max) ? row.price : max), '0'),
          )}
        </p>
      ) : null}
    </form>
  );
}
