'use client';

import { PERMISSIONS } from '@hixaa/contracts';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/lib/use-permission';
import { DistributorForm, emptyDistributor } from '../distributor-form';

/**
 * A route rather than a modal (ADR-0025): onboarding a partner is a task
 * someone starts, is interrupted during, and comes back to, and it must survive
 * a refusal without losing thirty fields of typing.
 */
export default function NewDistributorPage() {
  const { can, isLoading } = usePermission();

  if (isLoading) return <TableSkeleton />;

  // Presentation only. `POST /distributors` enforces this permission itself,
  // and a caller who forged their way past this screen would still be refused
  // (docs/04 §5).
  if (!can(PERMISSIONS.DISTRIBUTOR_CREATE)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You cannot create distributors"
        description="Ask an administrator for the distributor:create permission."
      />
    );
  }

  return (
    <>
      <Link
        href="/distributors"
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Distributors
      </Link>

      <PageHeader
        title="New distributor"
        description="Created as a LEAD. KYC and approval come after — a partner cannot transact until they are ACTIVE."
      />

      <DistributorForm mode="create" defaultValues={emptyDistributor} />
    </>
  );
}
