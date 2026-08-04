'use client';

import type { RoleSummary } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import { Lock, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api-client';

const SCOPE_HINT: Record<string, string> = {
  GLOBAL: 'Sees everything',
  TERRITORY: 'Bounded to assigned territories',
  DISTRIBUTOR: 'Bounded to one distributor (portal)',
};

export default function RolesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<RoleSummary[]>('/roles'),
  });

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        description="A role answers what someone may do; its scope answers which records. Both are enforced server-side."
      />

      {isLoading ? (
        <Card>
          <TableSkeleton rows={6} columns={4} />
        </Card>
      ) : !data?.length ? (
        <Card>
          <EmptyState icon={ShieldCheck} title="No roles" />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.map((role) => (
            <Card key={role.id} className="p-4">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-semibold">{role.name}</h2>
                    {role.isSystem ? (
                      <span
                        title="Defined in code and reconciled on every deploy"
                        className="flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      >
                        <Lock className="size-2.5" aria-hidden="true" />
                        System
                      </span>
                    ) : null}
                  </div>
                  <code className="text-[11px] text-muted-foreground">{role.key}</code>
                </div>
                <StatusBadge
                  status={role.scopeType}
                  tone={role.scopeType === 'GLOBAL' ? 'primary' : 'neutral'}
                  label={role.scopeType}
                />
              </div>

              {role.description ? (
                <p className="mb-3 text-sm text-muted-foreground">{role.description}</p>
              ) : null}

              <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">Permissions</dt>
                  <dd className="mt-0.5 font-medium tabular">{role.permissions.length}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Users</dt>
                  <dd className="mt-0.5 font-medium tabular">{role.userCount}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Discount cap</dt>
                  <dd className="mt-0.5 font-medium tabular">
                    {role.maxDiscountPercent ? `${Number(role.maxDiscountPercent)}%` : '—'}
                  </dd>
                </div>
              </dl>

              <p className="mt-2 text-[11px] text-muted-foreground">
                {SCOPE_HINT[role.scopeType] ?? ''}
              </p>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
