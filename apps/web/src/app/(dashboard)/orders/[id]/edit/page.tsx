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
import { OrderForm, type OrderFormValues } from '../../order-form';

interface OrderForEdit {
  id: string;
  number: string;
  status: string;
  type: string;
  distributorId: string | null;
  distributorName: string | null;
  customerId: string | null;
  customerName: string | null;
  warehouseId: string | null;
  orderDate: string;
  expectedDate: string | null;
  customerPoNumber: string | null;
  lines: Array<{
    productId: string;
    sku: string;
    description: string;
    quantity: string;
    overrideReason: string | null;
  }>;
}

export default function EditOrderPage() {
  const params = useParams<{ id: string }>();
  const { can, isLoading: permissionsLoading } = usePermission();

  const { data, isLoading, error } = useQuery({
    queryKey: ['orders', params.id],
    queryFn: () => api.get<OrderForEdit>(`/orders/${params.id}`),
  });

  if (isLoading || permissionsLoading) return <TableSkeleton />;

  if (!can(PERMISSIONS.ORDER_UPDATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot edit orders"
        description="Ask an administrator for the order:update permission."
      />
    );
  }

  if (error || !data) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Order not found"
        description={
          error instanceof ApiError
            ? error.problem.detail
            : 'It may have been removed, or lie outside your territory.'
        }
      />
    );
  }

  // An approved order is FROZEN (ADR-0011). Its lines snapshot what was agreed
  // and stock is already reserved against them; editing would silently change
  // both. Cancel and re-raise until there is a documented amendment policy.
  if (data.status !== 'DRAFT') {
    return (
      <EmptyState
        icon={ShieldAlert}
        title={`This order is ${data.status}`}
        description="Only a DRAFT can be edited. An approved order has reserved stock against its lines and snapshotted its pricing — cancel and re-raise instead."
      />
    );
  }

  const defaultValues: OrderFormValues = {
    type: data.type,
    distributorId: data.distributorId ?? '',
    customerId: data.customerId ?? '',
    warehouseId: data.warehouseId ?? '',
    orderDate: data.orderDate,
    expectedDate: data.expectedDate ?? '',
    customerPoNumber: data.customerPoNumber ?? '',
    customerPoDate: '',
    paymentTermsCode: '',
    placeOfSupplyStateCode: '',
    priceListId: '',
    notes: '',
    lines: data.lines.map((line) => ({
      productId: line.productId,
      quantity: String(Number(line.quantity)),
      // Not carried forward — re-submitting an override silently would re-apply
      // a concession nobody re-authorised.
      overrideUnitPrice: '',
      overrideReason: line.overrideReason ?? '',
      notes: '',
      label: `${line.sku} — ${line.description}`,
    })),
  };

  return (
    <>
      <Link
        href={`/orders/${params.id}`}
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {data.number}
      </Link>

      <PageHeader title="Edit order" description={`${data.number} · ${data.status}`} />

      <OrderForm
        mode="edit"
        orderId={params.id}
        defaultValues={defaultValues}
        initialLabels={{
          distributor: data.distributorName ?? undefined,
          customer: data.customerName ?? undefined,
        }}
      />
    </>
  );
}
