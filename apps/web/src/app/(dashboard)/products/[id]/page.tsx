'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, FileText, Layers, Package, ScanBarcode, Tag } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { formatDate, formatMoney, humanizeEnum } from '@/lib/utils';

/**
 * Product detail.
 *
 * Specifications are grouped exactly as the datasheet groups them — the reason
 * `ProductSpecification` is a table of rows rather than a JSON blob is that
 * industrial buyers read and filter on them.
 */
interface ProductDetail {
  id: string;
  sku: string;
  name: string;
  type: string;
  status: string;
  categoryName: string | null;
  brandName: string | null;
  uomCode: string | null;
  hsnCode: string | null;
  sacCode: string | null;
  gstRate: string;
  isSerialized: boolean;
  isBatchTracked: boolean;
  warrantyMonths: number | null;
  leadTimeDays: number | null;
  minOrderQty: string;
  tags: string[];
  revision: number;
  createdAt: string;
  specifications: Array<{
    id: string;
    groupName: string | null;
    name: string;
    value: string;
    unit: string | null;
  }>;
  media: Array<{
    id: string;
    type: string;
    title: string | null;
    isPrimary: boolean;
    document: { originalName: string; mimeType: string; sizeBytes: number; scanStatus: string } | null;
  }>;
  bom: Array<{
    id: string;
    quantity: string;
    isOptional: boolean;
    notes: string | null;
    component: { id: string; sku: string; name: string; type: string; status: string };
  }>;
  variants: Array<{ id: string; sku: string; name: string }>;
  prices: Array<{
    id: string;
    priceListCode: string;
    priceListName: string;
    priceListStatus: string;
    minQty: string;
    price: string;
    minPrice: string | null;
  }>;
}

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['product', params.id],
    // `apiFetch` already unwraps the `{ data }` envelope for a single resource
    // (it only keeps the envelope when `meta` is present, i.e. for lists), so
    // this must NOT unwrap again.
    queryFn: () => api.get<ProductDetail>(`/products/${params.id}`),
    enabled: Boolean(params.id),
  });

  if (isLoading) return <TableSkeleton />;

  if (error || !data) {
    return (
      <EmptyState
        icon={Package}
        title="Product not found"
        description={
          error instanceof ApiError ? error.problem.detail : 'This product could not be loaded.'
        }
      />
    );
  }

  // Specifications arrive sorted; grouping preserves that order per group.
  const specGroups = data.specifications.reduce<Record<string, ProductDetail['specifications']>>(
    (groups, spec) => {
      const key = spec.groupName ?? 'General';
      (groups[key] ??= []).push(spec);
      return groups;
    },
    {},
  );

  return (
    <>
      <Link
        href="/products"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        All products
      </Link>

      <PageHeader
        title={data.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-xs">{data.sku}</code>
            <StatusBadge status={data.status} />
            <span className="text-xs text-muted-foreground">
              {humanizeEnum(data.type)} · revision {data.revision}
            </span>
          </span>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── Commercial & tax ─────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Classification</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Field label="Category" value={data.categoryName} />
            <Field label="Brand" value={data.brandName} />
            <Field label="Unit" value={data.uomCode} />
            <Field
              label={data.sacCode ? 'SAC' : 'HSN'}
              value={data.sacCode ?? data.hsnCode}
              mono
            />
            <Field label="GST rate" value={`${data.gstRate}%`} />
            <Field
              label="Warranty"
              value={data.warrantyMonths ? `${data.warrantyMonths} months` : null}
            />
            <Field
              label="Lead time"
              value={data.leadTimeDays ? `${data.leadTimeDays} days` : null}
            />
            <Field label="Min order qty" value={Number(data.minOrderQty).toString()} />
            {data.isSerialized || data.isBatchTracked ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {data.isSerialized ? (
                  <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]">
                    <ScanBarcode className="size-3" aria-hidden="true" />
                    Serial-tracked
                  </span>
                ) : null}
                {data.isBatchTracked ? (
                  <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]">
                    <Layers className="size-3" aria-hidden="true" />
                    Batch-tracked
                  </span>
                ) : null}
              </div>
            ) : null}
            {data.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1 pt-1">
                {data.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    <Tag className="size-2.5" aria-hidden="true" />
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
            <Field label="Created" value={formatDate(data.createdAt)} />
          </CardContent>
        </Card>

        {/* ── Pricing ──────────────────────────────────────────────────── */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Pricing</CardTitle>
          </CardHeader>
          <CardContent>
            {data.prices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No price-list entry. Quoting this product will be refused rather than priced at
                zero.
              </p>
            ) : (
              <table className="w-full text-sm">
                <caption className="sr-only">Price points by price list and volume slab</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" className="pb-1.5 font-medium">Price list</th>
                    <th scope="col" className="pb-1.5 font-medium">From qty</th>
                    <th scope="col" className="pb-1.5 text-right font-medium">Unit price</th>
                    <th scope="col" className="pb-1.5 text-right font-medium">Floor</th>
                  </tr>
                </thead>
                <tbody>
                  {data.prices.map((price) => (
                    <tr key={price.id} className="border-b border-border/50 last:border-0">
                      <td className="py-1.5">
                        <code className="font-mono text-xs">{price.priceListCode}</code>{' '}
                        <StatusBadge status={price.priceListStatus} />
                      </td>
                      <td className="py-1.5 tabular">{Number(price.minQty)}</td>
                      <td className="py-1.5 text-right tabular">{formatMoney(price.price)}</td>
                      <td className="py-1.5 text-right tabular text-xs text-muted-foreground">
                        {price.minPrice ? formatMoney(price.minPrice) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">
              All prices exclude GST. A quantity at or above a slab’s “from qty” takes that slab’s
              price; below the floor, a manual override is flagged for approval.
            </p>
          </CardContent>
        </Card>

        {/* ── Bill of materials ────────────────────────────────────────── */}
        {data.bom.length > 0 ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Bill of materials</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <caption className="sr-only">Components this product explodes into</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" className="pb-1.5 font-medium">Component</th>
                    <th scope="col" className="pb-1.5 font-medium">Type</th>
                    <th scope="col" className="pb-1.5 text-right font-medium">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bom.map((entry) => (
                    <tr key={entry.id} className="border-b border-border/50 last:border-0">
                      <td className="py-1.5">
                        <Link
                          href={`/products/${entry.component.id}`}
                          className="text-primary hover:underline"
                        >
                          {entry.component.name}
                        </Link>
                        <div className="text-[11px] text-muted-foreground">
                          <code className="font-mono">{entry.component.sku}</code>
                          {entry.isOptional ? ' · optional' : null}
                        </div>
                      </td>
                      <td className="py-1.5 text-xs text-muted-foreground">
                        {humanizeEnum(entry.component.type)}
                      </td>
                      <td className="py-1.5 text-right tabular">{Number(entry.quantity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ) : null}

        {/* ── Documents ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Documents</CardTitle>
          </CardHeader>
          <CardContent>
            {data.media.length === 0 ? (
              <p className="text-sm text-muted-foreground">No brochures or datasheets attached.</p>
            ) : (
              <ul className="space-y-1.5">
                {data.media.map((item) => (
                  <li key={item.id} className="flex items-start gap-2 text-sm">
                    <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="truncate">{item.title ?? item.document?.originalName}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {humanizeEnum(item.type)}
                        {item.document ? ` · ${Math.round(item.document.sizeBytes / 1024)} KB` : ''}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ── Specifications ───────────────────────────────────────────── */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Technical specifications</CardTitle>
          </CardHeader>
          <CardContent>
            {data.specifications.length === 0 ? (
              <p className="text-sm text-muted-foreground">No specifications recorded.</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(specGroups).map(([group, specs]) => (
                  <div key={group}>
                    <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {group}
                    </h3>
                    <dl className="space-y-1">
                      {specs.map((spec) => (
                        <div key={spec.id} className="flex justify-between gap-3 text-sm">
                          <dt className="text-muted-foreground">{spec.name}</dt>
                          <dd className="text-right tabular">
                            {spec.value}
                            {spec.unit ? ` ${spec.unit}` : ''}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-xs' : ''}>
        {value ?? <span className="text-muted-foreground">—</span>}
      </span>
    </div>
  );
}
