'use client';

import { PERMISSIONS } from '@hixaa/contracts';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/lib/use-permission';
import { PriceListForm, emptyPriceList } from '../price-list-form';

export default function NewPriceListPage() {
  const { can, isLoading } = usePermission();

  if (isLoading) return <TableSkeleton />;

  if (!can(PERMISSIONS.PRICELIST_CREATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot create price lists"
        description="Ask an administrator for the pricelist:create permission."
      />
    );
  }

  return (
    <>
      <Link
        href="/price-lists"
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Price lists
      </Link>

      <PageHeader
        title="New price list"
        description="Created as a DRAFT. Add the slabs, then publish — only a published list is resolvable by the pricing engine."
      />

      <PriceListForm mode="create" defaultValues={emptyPriceList()} />
    </>
  );
}
