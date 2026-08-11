'use client';

import { PERMISSIONS, canTransitionPriceList } from '@hixaa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/form/form-dialog';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';
import { formatDate } from '@/lib/utils';
import { PriceListItems } from './price-list-items';

interface PriceListDetail {
  id: string;
  code: string;
  name: string;
  status: string;
  currency: string;
  priceBasis: string;
  validFrom: string;
  validTo: string | null;
  isDefault: boolean;
  version: number;
  itemCount: number;
  distributorCount: number;
  publishedAt: string | null;
  createdAt: string;
}

/**
 * A price list, with its slabs.
 *
 * The status actions are driven by the contract's own `canTransitionPriceList`
 * rather than a status list written here — the same rule the service enforces
 * (HANDOFF §4.27). Publishing is what makes a list resolvable by the pricing
 * engine; archiving takes it out of circulation without deleting the prices
 * past documents were quoted against.
 */
export default function PriceListDetailPage() {
  const params = useParams<{ id: string }>();
  const { can } = usePermission();
  const queryClient = useQueryClient();
  const [pending, setPending] = React.useState<'publish' | 'archive' | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['price-lists', params.id],
    queryFn: () => api.get<PriceListDetail>(`/price-lists/${params.id}`),
  });

  const act = useMutation({
    mutationFn: (action: 'publish' | 'archive') =>
      api.post(`/price-lists/${params.id}/${action}`, {}),
    onSuccess: async (_result, action) => {
      await queryClient.invalidateQueries({ queryKey: ['price-lists'] });
      toast.success(action === 'publish' ? 'Price list published' : 'Price list archived');
      setPending(null);
      setFailure(null);
    },
    onError: (mutationError) => {
      setFailure(
        mutationError instanceof ApiError
          ? mutationError.problem.detail
          : 'Could not reach the server.',
      );
    },
  });

  if (isLoading) return <TableSkeleton />;

  if (error || !data) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Price list not found"
        description={error instanceof ApiError ? error.problem.detail : 'It may have been removed.'}
      />
    );
  }

  const canPublish =
    can(PERMISSIONS.PRICELIST_PUBLISH) && canTransitionPriceList(data.status as never, 'ACTIVE');
  const canArchive =
    can(PERMISSIONS.PRICELIST_PUBLISH) && canTransitionPriceList(data.status as never, 'ARCHIVED');

  return (
    <>
      <Link
        href="/price-lists"
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Price lists
      </Link>

      <PageHeader
        title={data.name}
        description={`${data.code} · ${data.currency} · GST-exclusive`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={data.status} />
            {data.isDefault ? <StatusBadge status="DEFAULT" tone="info" label="Default" /> : null}
            {can(PERMISSIONS.PRICELIST_UPDATE) && data.status !== 'ARCHIVED' ? (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/price-lists/${data.id}/edit`}>
                  <Pencil aria-hidden="true" />
                  Edit
                </Link>
              </Button>
            ) : null}
            {canPublish ? (
              <Button size="sm" onClick={() => setPending('publish')}>
                Publish
              </Button>
            ) : null}
            {canArchive ? (
              <Button variant="destructive" size="sm" onClick={() => setPending('archive')}>
                Archive
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Valid</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {formatDate(data.validFrom)} → {data.validTo ? formatDate(data.validTo) : 'open-ended'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Slabs</CardTitle>
          </CardHeader>
          <CardContent className="text-sm tabular-nums">{data.itemCount}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Distributors using it</CardTitle>
          </CardHeader>
          <CardContent className="text-sm tabular-nums">{data.distributorCount}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Version</CardTitle>
          </CardHeader>
          <CardContent className="text-sm tabular-nums">
            v{data.version}
            {data.publishedAt ? (
              <span className="ml-2 text-xs text-muted-foreground">
                published {formatDate(data.publishedAt)}
              </span>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <h2 className="mb-3 text-sm font-semibold">Prices</h2>
      <PriceListItems priceListId={data.id} status={data.status} />

      {pending ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setPending(null);
              setFailure(null);
            }
          }}
          title={pending === 'publish' ? 'Publish this price list' : 'Archive this price list'}
          consequence={
            pending === 'publish'
              ? 'Makes these prices resolvable by the pricing engine, which is the only place a price is decided. Quotations and orders raised from now on will use them.'
              : 'Takes the list out of circulation. Prices already snapshotted onto quotations, orders and invoices are unaffected — every document keeps what it was agreed at (ADR-0011).'
          }
          confirmLabel={pending === 'publish' ? 'Publish' : 'Archive'}
          destructive={pending === 'archive'}
          loading={act.isPending}
          error={failure}
          onConfirm={() => act.mutate(pending)}
        />
      ) : null}
    </>
  );
}
