'use client';

import { PERMISSIONS } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';
import { ProductForm, type ProductFormValues } from '../../product-form';

interface ProductForEdit {
  id: string;
  sku: string;
  name: string;
  slug: string | null;
  type: string;
  status: string;
  categoryId: string | null;
  categoryName: string | null;
  uomCode: string | null;
  hsnCode: string | null;
  sacCode: string | null;
  gstRate: string | number;
  isSerialized: boolean;
  isBatchTracked: boolean;
  warrantyMonths: number | null;
  leadTimeDays: number | null;
  minOrderQty: string;
  editable: {
    uomId: string | null;
    shortDescription: string | null;
    description: string | null;
    isReturnable: boolean;
    isPurchasable: boolean;
    isSellable: boolean;
    weightGrams: string | null;
  };
}

const text = (value: string | null | undefined): string => value ?? '';

export default function EditProductPage() {
  const params = useParams<{ id: string }>();
  const { can, isLoading: permissionsLoading } = usePermission();

  const { data, isLoading, error } = useQuery({
    queryKey: ['products', params.id],
    queryFn: () => api.get<ProductForEdit>(`/products/${params.id}`),
  });

  if (isLoading || permissionsLoading) return <TableSkeleton />;

  if (!can(PERMISSIONS.PRODUCT_UPDATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot edit products"
        description="Ask an administrator for the product:update permission."
      />
    );
  }

  if (error || !data) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Product not found"
        description={
          error instanceof ApiError ? error.problem.detail : 'It may have been removed.'
        }
      />
    );
  }

  const defaultValues: ProductFormValues = {
    sku: data.sku,
    name: data.name,
    slug: text(data.slug),
    type: data.type,
    categoryId: text(data.categoryId),
    uomId: text(data.editable.uomId),
    shortDescription: text(data.editable.shortDescription),
    description: text(data.editable.description),
    hsnCode: text(data.hsnCode),
    sacCode: text(data.sacCode),
    gstRate: Number(data.gstRate),
    isSerialized: data.isSerialized,
    isBatchTracked: data.isBatchTracked,
    isReturnable: data.editable.isReturnable,
    isPurchasable: data.editable.isPurchasable,
    isSellable: data.editable.isSellable,
    warrantyMonths: data.warrantyMonths ?? '',
    leadTimeDays: data.leadTimeDays ?? '',
    minOrderQty: data.minOrderQty,
    weightGrams: text(data.editable.weightGrams),
  };

  return (
    <>
      <Link
        href={`/products/${params.id}`}
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {data.name}
      </Link>

      <PageHeader title="Edit product" description={`${data.sku} · ${data.status}`} />

      <ProductForm
        mode="edit"
        productId={params.id}
        defaultValues={defaultValues}
        initialLabels={{
          category: data.categoryName ?? undefined,
          uom: data.uomCode ?? undefined,
        }}
      />
    </>
  );
}
