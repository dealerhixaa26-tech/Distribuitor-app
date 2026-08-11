'use client';

import { PERMISSIONS } from '@hixaa/contracts';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/lib/use-permission';
import { ProductForm, emptyProduct } from '../product-form';

export default function NewProductPage() {
  const { can, isLoading } = usePermission();

  if (isLoading) return <TableSkeleton />;

  if (!can(PERMISSIONS.PRODUCT_CREATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot create products"
        description="Ask an administrator for the product:create permission."
      />
    );
  }

  return (
    <>
      <Link
        href="/products"
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Products
      </Link>

      <PageHeader
        title="New product"
        description="Created as a DRAFT. Pricing is set separately on a price list — a product carries no price of its own (ADR-0007)."
      />

      <ProductForm mode="create" defaultValues={emptyProduct} />
    </>
  );
}
