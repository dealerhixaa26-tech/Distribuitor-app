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
import {
  DistributorForm,
  type DistributorFormValues,
  emptyDistributor,
} from '../../distributor-form';

interface EditableAddress {
  line1: string;
  line2: string | null;
  landmark: string | null;
  cityName: string;
  stateId: string;
  postalCode: string;
  contactName: string | null;
  contactPhone: string | null;
}

interface DistributorForEdit {
  id: string;
  code: string;
  legalName: string;
  tradeName: string | null;
  type: string;
  status: string;
  gstin: string | null;
  pan: string | null;
  territoryId: string | null;
  territoryName: string | null;
  accountManagerId: string | null;
  accountManagerName: string | null;
  creditLimit: string;
  creditDays: number;
  bankAccountMasked: string | null;
  editable: {
    tan: string | null;
    cin: string | null;
    msmeNumber: string | null;
    paymentTermsCode: string | null;
    website: string | null;
    bankAccountName: string | null;
    bankIfsc: string | null;
    bankName: string | null;
    billingAddress: EditableAddress | null;
    shippingAddress: EditableAddress | null;
  };
}

/** null → '' so a controlled input never flips between controlled and not. */
const text = (value: string | null | undefined): string => value ?? '';

const toAddressValues = (address: EditableAddress | null) =>
  address
    ? {
        line1: text(address.line1),
        line2: text(address.line2),
        landmark: text(address.landmark),
        cityName: text(address.cityName),
        stateId: text(address.stateId),
        postalCode: text(address.postalCode),
        contactName: text(address.contactName),
        contactPhone: text(address.contactPhone),
      }
    : { ...emptyDistributor.billingAddress };

export default function EditDistributorPage() {
  const params = useParams<{ id: string }>();
  const { can, isLoading: permissionsLoading } = usePermission();

  const { data, isLoading, error } = useQuery({
    // The same key the detail page uses, so the two share one cache entry
    // rather than each fetching the record separately.
    queryKey: ['distributors', params.id],
    // §4.10: apiFetch already unwraps `{ data }` for a single resource. Adding
    // `.then(r => r.data)` here would yield undefined against a 200 OK.
    queryFn: () => api.get<DistributorForEdit>(`/distributors/${params.id}`),
  });

  if (isLoading || permissionsLoading) return <TableSkeleton />;

  if (!can(PERMISSIONS.DISTRIBUTOR_UPDATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot edit distributors"
        description="Ask an administrator for the distributor:update permission."
      />
    );
  }

  if (error || !data) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Distributor not found"
        description={
          error instanceof ApiError
            ? error.problem.detail
            : 'It may have been removed, or lie outside your territory.'
        }
      />
    );
  }

  const defaultValues: DistributorFormValues = {
    legalName: data.legalName,
    tradeName: text(data.tradeName),
    type: data.type,
    territoryId: text(data.territoryId),
    accountManagerId: text(data.accountManagerId),
    gstin: text(data.gstin),
    pan: text(data.pan),
    tan: text(data.editable.tan),
    cin: text(data.editable.cin),
    msmeNumber: text(data.editable.msmeNumber),
    // Not editable here — its own endpoint, its own permission, its own reason.
    creditLimit: data.creditLimit,
    creditDays: data.creditDays,
    openingBalance: '0',
    paymentTermsCode: text(data.editable.paymentTermsCode),
    website: text(data.editable.website),
    bankAccountName: text(data.editable.bankAccountName),
    // Always blank: the stored number is encrypted at rest and never sent to a
    // browser. Blank means "leave it alone", which `update()` honours because
    // it treats `undefined` as not-supplied.
    bankAccountNumber: '',
    bankIfsc: text(data.editable.bankIfsc),
    bankName: text(data.editable.bankName),
    billingAddress: toAddressValues(data.editable.billingAddress),
    shippingAddress: toAddressValues(data.editable.shippingAddress),
  };

  return (
    <>
      <Link
        href={`/distributors/${params.id}`}
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {data.legalName}
      </Link>

      <PageHeader title="Edit distributor" description={`${data.code} · ${data.status}`} />

      <DistributorForm
        mode="edit"
        distributorId={params.id}
        defaultValues={defaultValues}
        bankAccountMasked={data.bankAccountMasked}
        initialLabels={{
          territory: data.territoryName ?? undefined,
          accountManager: data.accountManagerName ?? undefined,
        }}
      />
    </>
  );
}
