'use client';

import { PERMISSIONS } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toAddressValues } from '@/components/form/address-fields';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';
import { CustomerForm, type CustomerFormValues } from '../../customer-form';

interface CustomerForEdit {
  id: string;
  code: string;
  name: string;
  type: string;
  distributorId: string | null;
  distributorName: string | null;
  territoryId: string | null;
  territoryName: string | null;
  industryId: string | null;
  industryName: string | null;
  gstin: string | null;
  siteName: string | null;
  editable: {
    pan: string | null;
    website: string | null;
    notes: string | null;
    billingAddress: Record<string, string | null> | null;
    shippingAddress: Record<string, string | null> | null;
  };
}

const text = (value: string | null | undefined): string => value ?? '';

export default function EditCustomerPage() {
  const params = useParams<{ id: string }>();
  const { can, isLoading: permissionsLoading } = usePermission();

  const { data, isLoading, error } = useQuery({
    // The same key the list and detail use, so one cache entry serves all.
    queryKey: ['customers', params.id],
    queryFn: () => api.get<CustomerForEdit>(`/customers/${params.id}`),
  });

  if (isLoading || permissionsLoading) return <TableSkeleton />;

  if (!can(PERMISSIONS.CUSTOMER_UPDATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot edit customers"
        description="Ask an administrator for the customer:update permission."
      />
    );
  }

  if (error || !data) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Customer not found"
        description={
          error instanceof ApiError
            ? error.problem.detail
            : 'It may have been removed, or lie outside your territory.'
        }
      />
    );
  }

  const defaultValues: CustomerFormValues = {
    code: data.code,
    name: data.name,
    type: data.type,
    distributorId: text(data.distributorId),
    territoryId: text(data.territoryId),
    industryId: text(data.industryId),
    gstin: text(data.gstin),
    pan: text(data.editable.pan),
    siteName: text(data.siteName),
    website: text(data.editable.website),
    notes: text(data.editable.notes),
    billingAddress: toAddressValues(data.editable.billingAddress),
    shippingAddress: toAddressValues(data.editable.shippingAddress),
  };

  return (
    <>
      <Link
        href="/customers"
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Customers
      </Link>

      <PageHeader title="Edit customer" description={`${data.code} · ${data.name}`} />

      <CustomerForm
        mode="edit"
        customerId={params.id}
        defaultValues={defaultValues}
        initialLabels={{
          distributor: data.distributorName ?? undefined,
          territory: data.territoryName ?? undefined,
          industry: data.industryName ?? undefined,
        }}
      />
    </>
  );
}
