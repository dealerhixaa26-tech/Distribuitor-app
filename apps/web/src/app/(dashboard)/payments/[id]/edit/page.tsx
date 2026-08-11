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
import { PaymentForm, type PaymentFormValues } from '../../payment-form';

interface PaymentForEdit {
  id: string;
  number: string | null;
  status: string;
  method: string;
  amount: string;
  tdsAmount: string | null;
  paymentDate: string;
  referenceNumber: string | null;
  bankName: string | null;
  chequeNumber: string | null;
  chequeDate: string | null;
  notes: string | null;
  distributorId: string | null;
  distributorName: string | null;
  customerId: string | null;
  customerName: string | null;
}

export default function EditPaymentPage() {
  const params = useParams<{ id: string }>();
  const { can, isLoading: permissionsLoading } = usePermission();

  const { data, isLoading, error } = useQuery({
    queryKey: ['payments', params.id],
    queryFn: () => api.get<PaymentForEdit>(`/payments/${params.id}`),
  });

  if (isLoading || permissionsLoading) return <TableSkeleton />;

  if (!can(PERMISSIONS.PAYMENT_UPDATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot edit receipts"
        description="Ask an administrator for the payment:update permission."
      />
    );
  }

  if (error || !data) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Receipt not found"
        description={error instanceof ApiError ? error.problem.detail : 'It may have been removed.'}
      />
    );
  }

  // Editable only while RECORDED. After verification the ledger is already
  // posted, and a database trigger rejects the write regardless of what this
  // screen allows (ADR-0016, ADR-0018).
  if (data.status !== 'RECORDED') {
    return (
      <EmptyState
        icon={ShieldAlert}
        title={`This receipt is ${data.status}`}
        description="Only a RECORDED receipt can be edited. Once verified the ledger is posted, and the database refuses the change."
      />
    );
  }

  const defaultValues: PaymentFormValues = {
    distributorId: data.distributorId ?? '',
    customerId: data.customerId ?? '',
    method: data.method,
    amount: data.amount,
    tdsAmount: data.tdsAmount ?? '',
    paymentDate: data.paymentDate,
    referenceNumber: data.referenceNumber ?? '',
    bankName: data.bankName ?? '',
    ifsc: '',
    chequeNumber: data.chequeNumber ?? '',
    chequeDate: data.chequeDate ?? '',
    notes: data.notes ?? '',
  };

  return (
    <>
      <Link
        href={`/payments/${params.id}`}
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {data.number ?? 'Receipt'}
      </Link>

      <PageHeader title="Edit receipt" description={`${data.number ?? ''} · ${data.status}`} />

      <PaymentForm
        mode="edit"
        paymentId={params.id}
        defaultValues={defaultValues}
        initialLabels={{
          distributor: data.distributorName ?? undefined,
          customer: data.customerName ?? undefined,
        }}
      />
    </>
  );
}
