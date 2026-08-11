'use client';

import { PERMISSIONS } from '@hixaa/contracts';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/lib/use-permission';
import { OrderForm, emptyOrder } from '../order-form';

export default function NewOrderPage() {
  const { can, isLoading } = usePermission();

  if (isLoading) return <TableSkeleton />;

  if (!can(PERMISSIONS.ORDER_CREATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot create orders"
        description="Ask an administrator for the order:create permission."
      />
    );
  }

  return (
    <>
      <Link
        href="/orders"
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Orders
      </Link>

      <PageHeader
        title="New order"
        description="Created as a DRAFT. Submitting sends it for approval; approval is what checks credit and reserves stock."
      />

      <OrderForm mode="create" defaultValues={emptyOrder()} />
    </>
  );
}
