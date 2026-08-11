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
import { QuotationForm, type QuotationFormValues } from '../../quotation-form';

interface QuotationForEdit {
  id: string;
  number: string | null;
  status: string;
  quotationDate: string;
  validUntil: string | null;
  distributorId: string | null;
  distributorName: string | null;
  customerId: string | null;
  customerName: string | null;
  lines: Array<{
    productId: string;
    sku: string;
    description: string;
    quantity: string;
    unitPrice: string;
    overrideReason: string | null;
  }>;
}

export default function EditQuotationPage() {
  const params = useParams<{ id: string }>();
  const { can, isLoading: permissionsLoading } = usePermission();

  const { data, isLoading, error } = useQuery({
    queryKey: ['quotations', params.id],
    queryFn: () => api.get<QuotationForEdit>(`/quotations/${params.id}`),
  });

  if (isLoading || permissionsLoading) return <TableSkeleton />;

  if (!can(PERMISSIONS.QUOTATION_UPDATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot edit quotations"
        description="Ask an administrator for the quotation:update permission."
      />
    );
  }

  if (error || !data) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Quotation not found"
        description={error instanceof ApiError ? error.problem.detail : 'It may have been removed.'}
      />
    );
  }

  // Only a DRAFT is editable. A SENT quotation is an offer somebody has seen;
  // changing it silently would make the copy they hold wrong. Revise instead.
  if (data.status !== 'DRAFT') {
    return (
      <EmptyState
        icon={ShieldAlert}
        title={`This quotation is ${data.status}`}
        description="Only a DRAFT can be edited. Raise a revision instead — the partner already has the version that was sent."
      />
    );
  }

  const defaultValues: QuotationFormValues = {
    distributorId: data.distributorId ?? '',
    customerId: data.customerId ?? '',
    quotationDate: data.quotationDate,
    validUntil: data.validUntil ?? '',
    placeOfSupplyStateCode: '',
    priceListId: '',
    termsAndConditions: '',
    notes: '',
    lines: data.lines.map((line) => ({
      productId: line.productId,
      quantity: String(Number(line.quantity)),
      // An existing override's price is NOT carried into the form: re-submitting
      // it silently would re-apply a concession nobody re-authorised. The reason
      // is shown so the person editing knows one was granted.
      overrideUnitPrice: '',
      overrideReason: line.overrideReason ?? '',
      notes: '',
      label: `${line.sku} — ${line.description}`,
    })),
  };

  return (
    <>
      <Link
        href={`/quotations/${params.id}`}
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {data.number ?? 'Draft quotation'}
      </Link>

      <PageHeader title="Edit quotation" description={`${data.number ?? 'Draft'} · ${data.status}`} />

      <QuotationForm
        mode="edit"
        quotationId={params.id}
        defaultValues={defaultValues}
        initialLabels={{
          distributor: data.distributorName ?? undefined,
          customer: data.customerName ?? undefined,
        }}
      />
    </>
  );
}
