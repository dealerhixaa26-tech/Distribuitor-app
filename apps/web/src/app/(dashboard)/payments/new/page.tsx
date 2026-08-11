'use client';

import { PERMISSIONS } from '@hixaa/contracts';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/lib/use-permission';
import { PaymentForm, emptyPayment } from '../payment-form';

export default function NewPaymentPage() {
  const { can, isLoading } = usePermission();

  if (isLoading) return <TableSkeleton />;

  if (!can(PERMISSIONS.PAYMENT_CREATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot record receipts"
        description="Ask an administrator for the payment:create permission."
      />
    );
  }

  return (
    <>
      <Link
        href="/payments"
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Payments
      </Link>

      <PageHeader
        title="Record a receipt"
        description="A memo, with no financial effect until someone else verifies it against the bank."
      />

      <PaymentForm mode="create" defaultValues={emptyPayment()} />
    </>
  );
}
