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
import { PriceListForm, type PriceListFormValues } from '../../price-list-form';

interface PriceListForEdit {
  id: string;
  code: string;
  name: string;
  status: string;
  currency: string;
  priceBasis: string;
  validFrom: string;
  validTo: string | null;
  isDefault: boolean;
  description?: string | null;
}

export default function EditPriceListPage() {
  const params = useParams<{ id: string }>();
  const { can, isLoading: permissionsLoading } = usePermission();

  const { data, isLoading, error } = useQuery({
    queryKey: ['price-lists', params.id],
    queryFn: () => api.get<PriceListForEdit>(`/price-lists/${params.id}`),
  });

  if (isLoading || permissionsLoading) return <TableSkeleton />;

  if (!can(PERMISSIONS.PRICELIST_UPDATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot edit price lists"
        description="Ask an administrator for the pricelist:update permission."
      />
    );
  }

  if (error || !data) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Price list not found"
        description={error instanceof ApiError ? error.problem.detail : 'It may have been removed.'}
      />
    );
  }

  const defaultValues: PriceListFormValues = {
    code: data.code,
    name: data.name,
    currency: data.currency,
    priceBasis: data.priceBasis,
    validFrom: data.validFrom,
    validTo: data.validTo ?? '',
    isDefault: data.isDefault,
    description: data.description ?? '',
  };

  return (
    <>
      <Link
        href={`/price-lists/${params.id}`}
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {data.name}
      </Link>

      <PageHeader title="Edit price list" description={`${data.code} · ${data.status}`} />

      <PriceListForm mode="edit" priceListId={params.id} defaultValues={defaultValues} />
    </>
  );
}
