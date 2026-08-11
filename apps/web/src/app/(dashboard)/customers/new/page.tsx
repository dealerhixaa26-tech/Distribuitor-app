'use client';

import { PERMISSIONS } from '@hixaa/contracts';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/lib/use-permission';
import { CustomerForm, emptyCustomer } from '../customer-form';

export default function NewCustomerPage() {
  const { can, isLoading } = usePermission();

  if (isLoading) return <TableSkeleton />;

  if (!can(PERMISSIONS.CUSTOMER_CREATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot create customers"
        description="Ask an administrator for the customer:create permission."
      />
    );
  }

  return (
    <>
      <Link
        href="/customers"
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Customers
      </Link>

      <PageHeader
        title="New customer"
        description="An END customer — a plant, a mine, a government body. A SECONDARY order (sell-out) cannot be raised without one."
      />

      <CustomerForm mode="create" defaultValues={emptyCustomer} />
    </>
  );
}
