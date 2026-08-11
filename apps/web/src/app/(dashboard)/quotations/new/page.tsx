'use client';

import { PERMISSIONS } from '@hixaa/contracts';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/lib/use-permission';
import { QuotationForm, emptyQuotation } from '../quotation-form';

export default function NewQuotationPage() {
  const { can, isLoading } = usePermission();

  if (isLoading) return <TableSkeleton />;

  if (!can(PERMISSIONS.QUOTATION_CREATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot create quotations"
        description="Ask an administrator for the quotation:create permission."
      />
    );
  }

  return (
    <>
      <Link
        href="/quotations"
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Quotations
      </Link>

      <PageHeader
        title="New quotation"
        description="Hixaa sells RFQ-first, so this is usually the first document in a deal. Prices are resolved by the engine — the lines carry quantity, not money."
      />

      <QuotationForm mode="create" defaultValues={emptyQuotation()} />
    </>
  );
}
