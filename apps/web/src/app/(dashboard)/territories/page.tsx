'use client';

import type { TerritoryNode } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Map as MapIcon, UserCircle2 } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { usePermission } from '@/lib/use-permission';
import { cn } from '@/lib/utils';

const TYPE_TONE = {
  ZONE: 'primary',
  REGION: 'info',
  STATE: 'neutral',
  DISTRICT: 'neutral',
} as const;

function TreeRow({ node, depth = 0 }: { node: TerritoryNode; depth?: number }) {
  // Zones open by default: a collapsed root shows the user nothing on arrival.
  const [open, setOpen] = useState(depth === 0);
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <div
        className={cn(
          'flex items-center gap-2 border-b border-border px-3 py-2 transition-colors hover:bg-accent/50',
        )}
        // Indent by nesting depth rather than by CSS nesting, so the row stays
        // a flat flex line and the hover target spans the full width.
        style={{ paddingLeft: `${12 + depth * 20}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {open ? (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="size-4" aria-hidden="true" />
        )}

        <span className="min-w-0 flex-1 truncate text-sm font-medium">{node.name}</span>

        <code className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:block">
          {node.code}
        </code>

        {node.gstStateCode ? (
          <span
            title="GST state code — drives the CGST/SGST vs IGST split"
            className="hidden shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:block"
          >
            GST {node.gstStateCode}
          </span>
        ) : null}

        {node.managerName ? (
          <span className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground lg:flex">
            <UserCircle2 className="size-3" aria-hidden="true" />
            {node.managerName}
          </span>
        ) : null}

        <StatusBadge
          status={node.type}
          tone={TYPE_TONE[node.type as keyof typeof TYPE_TONE] ?? 'neutral'}
          label={node.type}
          className="shrink-0"
        />
      </div>

      {hasChildren && open ? (
        <ul>
          {node.children.map((child) => (
            <TreeRow key={child.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function TerritoriesPage() {
  const { scopeType, territoryIds } = usePermission();

  const { data, isLoading, error } = useQuery({
    queryKey: ['territories', 'tree'],
    queryFn: () => api.get<TerritoryNode[]>('/territories/tree'),
  });

  const total = countNodes(data ?? []);

  return (
    <>
      <PageHeader
        title="Territories"
        description="Sales geography as a tree. A user scoped to a zone sees that zone and everything beneath it — enforced in the database, not here."
        actions={
          scopeType !== 'GLOBAL' ? (
            <StatusBadge
              status="INFO"
              tone="info"
              label={`Scoped to ${territoryIds.length} territor${territoryIds.length === 1 ? 'y' : 'ies'}`}
            />
          ) : null
        }
      />

      <Card>
        {isLoading ? (
          <TableSkeleton rows={8} columns={3} />
        ) : error ? (
          <EmptyState
            icon={MapIcon}
            title="Could not load territories"
            description={error instanceof ApiError ? error.problem.detail : 'Something went wrong.'}
          />
        ) : !data?.length ? (
          <EmptyState
            icon={MapIcon}
            title="No territories"
            description="Territories define sales geography and bound what each user can see."
          />
        ) : (
          <>
            <ul role="tree" aria-label="Territory hierarchy">
              {data.map((node) => (
                <TreeRow key={node.id} node={node} />
              ))}
            </ul>
            <p className="px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
              {total} territor{total === 1 ? 'y' : 'ies'} visible to you
            </p>
          </>
        )}
      </Card>
    </>
  );
}

function countNodes(nodes: TerritoryNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}
