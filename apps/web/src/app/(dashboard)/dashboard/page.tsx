'use client';

import type { KpiSummary } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  IndianRupee,
  Minus,
  Package,
  Receipt,
  ShoppingCart,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TableSkeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api-client';
import { formatCompactAmount, formatDate } from '@/lib/utils';

/**
 * The dashboard.
 *
 * ── Every figure is live ───────────────────────────────────────────────────
 * There are no materialised views behind this (ADR-0019). Each panel reads
 * live tables through a 5-minute server-side cache, which is why a card and
 * the list it links to can never disagree — the specific failure the ADR traded
 * ~100 ms away to prevent.
 *
 * ── Each panel loads independently ─────────────────────────────────────────
 * Separate queries, so a slow panel never blocks the page (docs/08 §10).
 *
 * ── A money field that is ABSENT is not zero ───────────────────────────────
 * Without `analytics:read:financial` the API omits money entirely rather than
 * sending zeros. The cards below render "—" for an absent value, because
 * showing ₹0 would be a claim about the business rather than about permissions.
 */

const PERIODS = [
  { key: 'MTD', label: 'This month' },
  { key: 'QTD', label: 'This quarter' },
  { key: 'FYTD', label: 'This FY' },
] as const;

interface RankingResponse {
  total?: string;
  entries: Array<{
    id: string;
    label: string;
    sublabel: string | null;
    orderCount: number;
    revenue?: string;
    sharePercent?: string;
  }>;
}

interface ActivityEntry {
  id: string;
  kind: string;
  reference: string;
  description: string;
  amount?: string;
  occurredAt: string;
  href: string;
}

export default function DashboardPage() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['key']>('MTD');

  const kpis = useQuery({
    queryKey: ['analytics', 'kpis', period],
    queryFn: () => api.get<KpiSummary>('/analytics/kpis', { query: { period } }),
  });

  const topDistributors = useQuery({
    queryKey: ['analytics', 'top-distributors'],
    queryFn: () => api.get<RankingResponse>('/analytics/top-distributors', { query: { limit: 5 } }),
  });

  const topProducts = useQuery({
    queryKey: ['analytics', 'top-products'],
    queryFn: () => api.get<RankingResponse>('/analytics/top-products', { query: { limit: 5 } }),
  });

  const activity = useQuery({
    queryKey: ['analytics', 'activity'],
    queryFn: () => api.get<ActivityEntry[]>('/analytics/activity', { query: { limit: 8 } }),
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Live figures, computed on request. Every card links through to the list that produced it."
        actions={
          <div className="flex gap-1.5">
            {PERIODS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setPeriod(option.key)}
                aria-pressed={period === option.key}
                className={
                  period === option.key
                    ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
                    : 'rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        }
      />

      <section aria-labelledby="kpi-heading" className="mb-6">
        <h2 id="kpi-heading" className="sr-only">
          Key figures
        </h2>
        {kpis.isLoading ? (
          <TableSkeleton />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Revenue invoiced"
              kpi={kpis.data?.revenue}
              icon={IndianRupee}
              money
              href="/invoices"
            />
            <KpiCard
              label="Outstanding"
              kpi={kpis.data?.outstanding}
              icon={Receipt}
              money
              href="/outstanding"
            />
            <KpiCard label="Orders" kpi={kpis.data?.orderCount} icon={ShoppingCart} href="/orders" />
            <KpiCard
              label="Low stock"
              kpi={kpis.data?.lowStockCount}
              icon={Package}
              href="/inventory"
            />
          </div>
        )}
        {kpis.data ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {kpis.data.from} to {kpis.data.to}, compared with {kpis.data.comparedFrom} to{' '}
            {kpis.data.comparedTo} — the same number of days, so a fresh month does not read as a
            collapse.
          </p>
        ) : null}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <RankingCard
          title="Top distributors"
          href="/distributors"
          query={topDistributors}
          emptyText="No orders in the last 12 months."
        />
        <RankingCard
          title="Top products"
          href="/products"
          query={topProducts}
          emptyText="No orders in the last 12 months."
        />
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          {activity.isLoading ? (
            <TableSkeleton />
          ) : !activity.data?.length ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {activity.data.map((entry) => (
                <li
                  key={`${entry.kind}:${entry.id}`}
                  className="flex items-start justify-between gap-3 border-b border-border/50 pb-2"
                >
                  <div className="min-w-0">
                    <Link href={entry.href} className="font-medium hover:underline">
                      {entry.reference}
                    </Link>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {entry.description}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    {entry.amount ? (
                      <div className="tabular">₹{formatCompactAmount(entry.amount)}</div>
                    ) : null}
                    <div className="text-[11px] text-muted-foreground">
                      {formatDate(entry.occurredAt)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function KpiCard({
  label,
  kpi,
  icon: Icon,
  money,
  href,
}: {
  label: string;
  kpi?: { value?: string; deltaPercent: string | null; direction: string; inverse?: boolean };
  icon: typeof IndianRupee;
  money?: boolean;
  href: string;
}) {
  // Absent, not zero — the caller lacks analytics:read:financial.
  const value = kpi?.value;
  const display =
    value === undefined ? '—' : money ? `₹${formatCompactAmount(value)}` : value;

  // `inverse` marks a metric where a rise is bad: outstanding going up is not
  // good news, and colouring it green would say the opposite of the truth.
  const rising = kpi?.direction === 'UP';
  const good = kpi?.inverse ? !rising : rising;
  const DeltaIcon = kpi?.direction === 'FLAT' ? Minus : rising ? ArrowUpRight : ArrowDownRight;

  return (
    <Link href={href} className="block">
      <Card className="transition-colors hover:border-primary/40">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
          <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        </CardHeader>
        <CardContent>
          <div className="text-xl font-semibold tabular">{display}</div>
          {value === undefined ? (
            <div className="text-[11px] text-muted-foreground">Not visible to your role</div>
          ) : kpi?.deltaPercent === null ? (
            // Null delta means the baseline was zero. "+100%" would be a lie
            // people act on — going from ₹0 to ₹5,000 is a start, not a doubling.
            <div className="text-[11px] text-muted-foreground">No prior period to compare</div>
          ) : (
            <div
              className={`flex items-center gap-1 text-[11px] ${
                kpi?.direction === 'FLAT'
                  ? 'text-muted-foreground'
                  : good
                    ? 'text-success'
                    : 'text-destructive'
              }`}
            >
              <DeltaIcon className="size-3" aria-hidden="true" />
              {kpi?.deltaPercent}% vs previous
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function RankingCard({
  title,
  href,
  query,
  emptyText,
}: {
  title: string;
  href: string;
  query: { data?: RankingResponse; isLoading: boolean };
  emptyText: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>{title}</CardTitle>
        <Link
          href={href}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          All <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <TableSkeleton />
        ) : !query.data?.entries.length ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <AlertTriangle className="size-3.5" aria-hidden="true" />
            {emptyText}
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {query.data.entries.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate">{entry.label}</div>
                  {entry.sublabel ? (
                    <div className="text-[11px] text-muted-foreground">{entry.sublabel}</div>
                  ) : null}
                </div>
                <div className="shrink-0 text-right">
                  {entry.revenue ? (
                    <div className="tabular">₹{formatCompactAmount(entry.revenue)}</div>
                  ) : (
                    <div className="text-muted-foreground">—</div>
                  )}
                  <div className="text-[11px] text-muted-foreground">
                    {entry.orderCount} orders
                    {entry.sharePercent ? ` · ${entry.sharePercent}%` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
