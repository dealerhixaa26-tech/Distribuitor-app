'use client';

import type { SettingEntry } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Lock, Settings as SettingsIcon } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api-client';
import { cn, formatDateTime, humanizeEnum } from '@/lib/utils';

interface Category {
  category: string;
  count: number;
}

const CATEGORY_BLURB: Record<string, string> = {
  company: 'Legal identity, statutory numbers, and registered address — used on every invoice.',
  branding: 'Colours and logos. Applied at runtime, so no deploy is needed to change them.',
  portfolio: 'Service lines, industries, and the flagship product. Seeded from the company profile.',
  finance: 'Currency, financial-year start, numbering prefixes, and payment terms.',
  approvals: 'Escalation behaviour and the self-approval prohibition.',
};

export default function SettingsPage() {
  const [active, setActive] = useState('company');

  const { data: categories, isLoading: loadingCategories } = useQuery({
    queryKey: ['settings', 'categories'],
    queryFn: () => api.get<Category[]>('/settings'),
  });

  const { data: entries, isLoading } = useQuery({
    queryKey: ['settings', active],
    queryFn: () => api.get<SettingEntry[]>(`/settings/${active}`),
    enabled: Boolean(active),
  });

  const statutory = entries?.find((entry) => entry.key === 'statutory');
  const unverified =
    statutory && typeof statutory.value === 'object' && statutory.value !== null
      ? (statutory.value as { verified?: boolean }).verified === false
      : false;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Everything about the company lives here as data — nothing is hardcoded, so this is editable without a deploy."
      />

      {unverified ? (
        // Surfaced prominently: invoicing refuses to issue while this is false,
        // and an operator should learn that here rather than at the moment they
        // try to bill a customer.
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <div>
            <p className="font-medium text-warning">Statutory details are not verified</p>
            <p className="mt-0.5 text-muted-foreground">
              The GSTIN and PAN below are placeholders. Invoicing will refuse to issue documents
              until someone confirms the real values and sets <code>verified</code> to true.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[200px_1fr]">
        <nav aria-label="Setting categories">
          <ul className="space-y-0.5">
            {loadingCategories
              ? null
              : categories?.map((category) => (
                  <li key={category.category}>
                    <button
                      type="button"
                      onClick={() => setActive(category.category)}
                      aria-current={active === category.category ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors',
                        active === category.category
                          ? 'bg-primary/10 font-medium text-primary'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      {humanizeEnum(category.category)}
                      <span className="text-[10px] tabular">{category.count}</span>
                    </button>
                  </li>
                ))}
          </ul>
        </nav>

        <Card>
          {isLoading ? (
            <TableSkeleton rows={4} columns={2} />
          ) : !entries?.length ? (
            <EmptyState icon={SettingsIcon} title="No settings in this category" />
          ) : (
            <>
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold">{humanizeEnum(active)}</h2>
                {CATEGORY_BLURB[active] ? (
                  <p className="mt-0.5 text-sm text-muted-foreground">{CATEGORY_BLURB[active]}</p>
                ) : null}
              </div>

              <ul className="divide-y divide-border">
                {entries.map((entry) => (
                  <li key={entry.key} className="p-4">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <code className="text-sm font-medium">{entry.key}</code>
                      {!entry.writable ? (
                        <span
                          title="Managed in code and reconciled on every deploy"
                          className="flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          <Lock className="size-2.5" aria-hidden="true" />
                          Read-only
                        </span>
                      ) : null}
                      {entry.isSecret ? <StatusBadge status="SECRET" tone="warning" /> : null}
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {formatDateTime(entry.updatedAt)}
                      </span>
                    </div>

                    {entry.description ? (
                      <p className="mb-2 text-sm text-muted-foreground">{entry.description}</p>
                    ) : null}

                    <pre className="scrollbar-thin overflow-x-auto rounded-md bg-muted p-3 text-xs">
                      {JSON.stringify(entry.value, null, 2)}
                    </pre>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
