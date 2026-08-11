'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import {
  Controller,
  type Control,
  type FieldErrors,
  type FieldValues,
  type Path,
  type UseFormRegister,
  useFieldArray,
  useWatch,
} from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/utils';
import { EntityPicker } from './entity-picker';
import { Field } from './field';
import { MoneyInput, QuantityInput } from './money-input';

/**
 * The line editor for quotations and orders.
 *
 * ## A line carries no price
 *
 * Product, quantity, and an optional override with a mandatory reason — never a
 * price (ADR-0011, HANDOFF §4.16). If a client could post one, `PricingService`
 * would be advisory and every discount ceiling trivially bypassable.
 *
 * So the totals shown here are not computed in the browser. They come from
 * `POST /pricing/quote`, which is the same engine the server will use when the
 * document is saved — including the CGST/SGST/IGST split, the matched volume
 * slab, and whether the line needs approval. The screen displays a price; it
 * never holds one.
 *
 * An override IS an input, and an audited one: it goes in the payload as
 * `{ unitPrice, reason }` and the engine decides what it means. That is the
 * difference between an override and a bypass.
 */

export interface SalesLineValues {
  productId: string;
  quantity: string;
  overrideUnitPrice: string;
  overrideReason: string;
  notes: string;
  /** Display only — keeps the picker labelled when editing an existing document. */
  label: string;
}

export const emptySalesLine: SalesLineValues = {
  productId: '',
  quantity: '1',
  overrideUnitPrice: '',
  overrideReason: '',
  notes: '',
  label: '',
};

export const SALES_LINE_FIELDS = [
  'productId',
  'quantity',
  'override',
  'override.unitPrice',
  'override.reason',
  'notes',
] as const;

/**
 * Form shape → wire shape.
 *
 * The override is two flat inputs on screen and a nested object on the wire,
 * and it is omitted entirely unless a price was actually entered — sending
 * `{ unitPrice: '', reason: '' }` would fail the schema on a line nobody
 * overrode.
 */
export function toSalesLinePayload(lines: SalesLineValues[]): unknown[] {
  return lines.map((line) => ({
    productId: line.productId,
    quantity: line.quantity,
    ...(line.overrideUnitPrice
      ? { override: { unitPrice: line.overrideUnitPrice, reason: line.overrideReason } }
      : {}),
    ...(line.notes ? { notes: line.notes } : {}),
  }));
}

interface QuoteLine {
  productId: string;
  sku: string;
  name: string;
  quantity: string;
  listUnitPrice: string;
  unitPrice: string;
  discountAmount: string;
  discountPercent: string;
  taxableValue: string;
  gstRate: string;
  cgst: string;
  sgst: string;
  igst: string;
  totalTax: string;
  lineTotal: string;
  isOverridden: boolean;
  requiresApproval: boolean;
  approvalReasons: string[];
  trace?: { priceListCode: string; matchedSlabMinQty: string };
}

interface QuoteResponse {
  isInterState: boolean;
  placeOfSupplyStateCode: string;
  lines: QuoteLine[];
}

export function SalesLines<TValues extends FieldValues>({
  control,
  register,
  errors,
  /** Drives price-list selection and the default place of supply. */
  distributorId,
  priceListId,
  placeOfSupplyStateCode,
  disabled,
}: {
  control: Control<TValues>;
  register: UseFormRegister<TValues>;
  errors: FieldErrors<TValues>;
  distributorId?: string;
  priceListId?: string;
  placeOfSupplyStateCode?: string;
  disabled?: boolean;
}) {
  const name = 'lines' as Path<TValues>;
  const { fields, append, remove } = useFieldArray({
    control,
    name: name as never,
  });

  // Watching the whole array rather than each field: the preview is a function
  // of every line together, since slabs and discounts depend on quantity.
  const lines = (useWatch({ control, name: name as never }) ?? []) as SalesLineValues[];
  const [debouncedLines, setDebouncedLines] = React.useState<SalesLineValues[]>([]);
  const serialised = JSON.stringify(
    lines.map((line) => [line.productId, line.quantity, line.overrideUnitPrice]),
  );

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedLines(lines), 400);
    return () => clearTimeout(timer);
    // `serialised` is the real dependency — the identity of `lines` changes on
    // every keystroke, including ones that cannot affect the price.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialised]);

  const priceable = debouncedLines.filter((line) => line.productId && line.quantity);

  const quote = useQuery({
    queryKey: [
      'pricing-preview',
      distributorId,
      priceListId,
      placeOfSupplyStateCode,
      priceable.map((l) => [l.productId, l.quantity, l.overrideUnitPrice]),
    ],
    queryFn: () =>
      api.post<QuoteResponse>('/pricing/quote', {
        distributorId: distributorId || undefined,
        priceListId: priceListId || undefined,
        placeOfSupplyStateCode: placeOfSupplyStateCode || undefined,
        lines: priceable.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          ...(line.overrideUnitPrice
            ? {
                override: {
                  unitPrice: line.overrideUnitPrice,
                  // The preview only needs a well-formed reason; the real one
                  // is whatever the user typed and is what gets submitted.
                  reason: line.overrideReason || 'Pricing preview',
                },
              }
            : {}),
        })),
      }),
    enabled: priceable.length > 0,
    // A failed quote is informative (no price on the list, product inactive),
    // not something to hammer.
    retry: false,
    staleTime: 15_000,
  });

  const priced = quote.data?.lines ?? [];
  const byProduct = new Map(priced.map((line) => [line.productId, line]));

  const totals = priced.reduce(
    (accumulator, line) => ({
      taxable: accumulator.taxable + Number(line.taxableValue),
      tax: accumulator.tax + Number(line.totalTax),
      total: accumulator.total + Number(line.lineTotal),
    }),
    { taxable: 0, tax: 0, total: 0 },
  );

  const needsApproval = priced.filter((line) => line.requiresApproval);

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[60rem] text-sm">
          <caption className="sr-only">Document lines with live pricing</caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">Product</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Qty</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Unit price</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Tax</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Line total</th>
              <th scope="col" className="w-10 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {fields.map((field, index) => {
              const productId = lines[index]?.productId;
              const line = productId ? byProduct.get(productId) : undefined;
              const lineErrors = (errors as Record<string, unknown>)['lines'] as
                | Array<Record<string, { message?: string }>>
                | undefined;
              const rowError = lineErrors?.[index];

              return (
                <tr key={field.id} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <Field
                      name={`lines.${index}.productId`}
                      label={`Product, line ${index + 1}`}
                      error={rowError?.productId?.message}
                    >
                      {(fieldControl) => (
                        <Controller
                          control={control}
                          name={`lines.${index}.productId` as Path<TValues>}
                          render={({ field: controlled }) => (
                            <EntityPicker
                              control={fieldControl}
                              value={(controlled.value as string) ?? ''}
                              onChange={controlled.onChange}
                              onBlur={controlled.onBlur}
                              path="/products"
                              query={{ status: 'ACTIVE' }}
                              initialLabel={lines[index]?.label}
                              placeholder="Search products…"
                              disabled={disabled}
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

                    <details className="mt-1">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground">
                        Override price or add a note
                      </summary>
                      <div className="mt-2 space-y-2 rounded-md border border-border p-2">
                        <Field
                          name={`lines.${index}.overrideUnitPrice`}
                          label="Override unit price"
                          error={rowError?.override?.message}
                          description="Leave blank to use the engine's price."
                        >
                          {(fieldControl) => (
                            <MoneyInput
                              {...fieldControl}
                              disabled={disabled}
                              {...register(`lines.${index}.overrideUnitPrice` as Path<TValues>)}
                            />
                          )}
                        </Field>
                        <Field
                          name={`lines.${index}.overrideReason`}
                          label="Reason for the override"
                          error={rowError?.['override.reason']?.message}
                          description="Required with an override — at least ten characters. An unexplained concession is indistinguishable from a typo six months later."
                        >
                          {(fieldControl) => (
                            <Input
                              {...fieldControl}
                              disabled={disabled}
                              {...register(`lines.${index}.overrideReason` as Path<TValues>)}
                            />
                          )}
                        </Field>
                        <Field
                          name={`lines.${index}.notes`}
                          label="Line note"
                          error={rowError?.notes?.message}
                        >
                          {(fieldControl) => (
                            <Input
                              {...fieldControl}
                              disabled={disabled}
                              {...register(`lines.${index}.notes` as Path<TValues>)}
                            />
                          )}
                        </Field>
                      </div>
                    </details>
                  </td>

                  <td className="px-3 py-2">
                    <Field
                      name={`lines.${index}.quantity`}
                      label={`Quantity, line ${index + 1}`}
                      error={rowError?.quantity?.message}
                    >
                      {(fieldControl) => (
                        <QuantityInput
                          {...fieldControl}
                          disabled={disabled}
                          className="w-20"
                          {...register(`lines.${index}.quantity` as Path<TValues>)}
                        />
                      )}
                    </Field>
                  </td>

                  {/* Read-only, and from the server. A editable total here would
                      make the pricing engine advisory. */}
                  <td className="px-3 py-2 text-right tabular-nums">
                    {line ? (
                      <>
                        <div>{formatMoney(line.unitPrice)}</div>
                        {line.isOverridden ? (
                          <div className="text-[11px] text-warning">overridden</div>
                        ) : Number(line.discountAmount) > 0 ? (
                          <div className="text-[11px] text-muted-foreground">
                            −{line.discountPercent}% off {formatMoney(line.listUnitPrice)}
                          </div>
                        ) : line.trace ? (
                          <div className="text-[11px] text-muted-foreground">
                            {line.trace.priceListCode} · slab ≥{Number(line.trace.matchedSlabMinQty)}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>

                  <td className="px-3 py-2 text-right tabular-nums">
                    {line ? (
                      <>
                        <div>{formatMoney(line.totalTax)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {Number(line.igst) > 0
                            ? `IGST ${line.gstRate}%`
                            : `CGST+SGST ${line.gstRate}%`}
                        </div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>

                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {line ? formatMoney(line.lineTotal) : <span className="text-muted-foreground">—</span>}
                  </td>

                  <td className="px-3 py-2">
                    {!disabled ? (
                      <button
                        type="button"
                        onClick={() => remove(index)}
                        className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                        <span className="sr-only">Remove line {index + 1}</span>
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}

            {fields.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No lines yet. A document needs at least one.
                </td>
              </tr>
            ) : null}
          </tbody>

          {priced.length > 0 ? (
            <tfoot className="border-t-2 border-border bg-muted/30 text-sm">
              {/* Each number sits under the column it belongs to. The label was
                  "Taxable value" over the TAX column at first, which read as a
                  ₹45,360 taxable value on a ₹2,52,000 order. */}
              <tr>
                <td colSpan={3} className="px-3 py-2 text-right text-xs font-medium">
                  Totals
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(String(totals.tax))}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">
                  {formatMoney(String(totals.total))}
                </td>
                <td />
              </tr>
              <tr>
                <td colSpan={6} className="px-3 pb-2 text-right text-xs text-muted-foreground">
                  Taxable value {formatMoney(String(totals.taxable))}
                  {quote.data?.isInterState ? ' · inter-state, so IGST' : ' · intra-state, so CGST+SGST'}
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {quote.isError ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs"
        >
          <Info className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span>
            The live total is unavailable — usually because a product has no price on the resolved
            list, or is not ACTIVE. The document can still be saved; the server prices it with the
            same engine and will refuse for the same reason.
          </span>
        </p>
      ) : null}

      {needsApproval.length > 0 ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span>
            {needsApproval.length} line{needsApproval.length === 1 ? '' : 's'} will need approval:{' '}
            {[...new Set(needsApproval.flatMap((line) => line.approvalReasons))].join('; ')}
          </span>
        </p>
      ) : null}

      {!disabled ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => append(emptySalesLine as never)}
        >
          <Plus aria-hidden="true" />
          Add line
        </Button>
      ) : null}
    </div>
  );
}
