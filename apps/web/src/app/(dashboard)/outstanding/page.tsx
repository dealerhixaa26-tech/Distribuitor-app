'use client';

import type { OutstandingReport } from '@hixaa/contracts';
import { useQuery } from '@tanstack/react-query';
import { IndianRupee } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { ApiError, api } from '@/lib/api-client';
import { formatCompactAmount, formatMoney } from '@/lib/utils';

/**
 * The aging report — the collections screen.
 *
 * Aged from the DUE date, not the invoice date: an invoice on Net 45 terms is
 * not overdue on day 31. Sorted worst-first, because this exists to decide who
 * to call.
 */
const BUCKETS = [
  { key: 'current', label: 'Not yet due', tone: 'text-muted-foreground' },
  { key: 'd0_30', label: '0–30 days', tone: 'text-foreground' },
  { key: 'd31_60', label: '31–60 days', tone: 'text-warning' },
  { key: 'd61_90', label: '61–90 days', tone: 'text-warning' },
  { key: 'd90Plus', label: '90+ days', tone: 'text-destructive' },
] as const;

export default function OutstandingPage() {
  const [overdueOnly, setOverdueOnly] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['outstanding', { overdueOnly }],
    queryFn: () =>
      api.get<OutstandingReport>('/outstanding', {
        query: { overdueOnly: overdueOnly || undefined },
      }),
  });

  if (isLoading) return <TableSkeleton />;

  if (error || !data) {
    return (
      <EmptyState
        icon={IndianRupee}
        title="Could not load outstanding"
        description={
          error instanceof ApiError ? error.problem.detail : 'Something went wrong.'
        }
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Outstanding"
        description={`Receivables aged from the due date, as of ${data.asOf}. An invoice on Net 45 terms is not overdue on day 31.`}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {BUCKETS.map((bucket) => (
          <Card key={bucket.key}>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                {bucket.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-lg font-semibold tabular ${bucket.tone}`}>
                ₹{formatCompactAmount(data.totals[bucket.key])}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mb-3">
        <button
          type="button"
          onClick={() => setOverdueOnly((previous) => !previous)}
          aria-pressed={overdueOnly}
          className={
            overdueOnly
              ? 'rounded-md bg-destructive px-2.5 py-1 text-xs font-medium text-destructive-foreground'
              : 'rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
          }
        >
          Overdue only
        </button>
      </div>

      {data.parties.length === 0 ? (
        <EmptyState
          icon={IndianRupee}
          title={overdueOnly ? 'Nothing overdue' : 'Nothing outstanding'}
          description={
            overdueOnly
              ? 'Every unpaid invoice is still within its terms.'
              : 'All issued invoices have been settled.'
          }
        />
      ) : (
        <Card>
          <CardContent className="pt-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Outstanding receivables by party and age</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-2 pr-3">Party</th>
                    <th scope="col" className="py-2 pr-3 text-right">Not due</th>
                    <th scope="col" className="py-2 pr-3 text-right">0–30</th>
                    <th scope="col" className="py-2 pr-3 text-right">31–60</th>
                    <th scope="col" className="py-2 pr-3 text-right">61–90</th>
                    <th scope="col" className="py-2 pr-3 text-right">90+</th>
                    <th scope="col" className="py-2 pr-3 text-right">Total</th>
                    <th scope="col" className="py-2 text-right">Credit used</th>
                  </tr>
                </thead>
                <tbody>
                  {data.parties.map((party) => (
                    <tr key={`${party.partyType}:${party.partyId}`} className="border-b border-border/50">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{party.partyName}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {party.partyCode ?? party.partyType}
                          {party.oldestDaysPastDue > 0
                            ? ` · oldest ${party.oldestDaysPastDue}d past due`
                            : ''}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right tabular text-muted-foreground">
                        {formatMoney(party.current)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular">{formatMoney(party.d0_30)}</td>
                      <td className="py-2 pr-3 text-right tabular text-warning">
                        {formatMoney(party.d31_60)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular text-warning">
                        {formatMoney(party.d61_90)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular text-destructive">
                        {formatMoney(party.d90Plus)}
                      </td>
                      <td className="py-2 pr-3 text-right font-semibold tabular">
                        {formatMoney(party.total)}
                      </td>
                      <td className="py-2 text-right tabular text-muted-foreground">
                        {party.creditUtilisationPercent
                          ? `${party.creditUtilisationPercent}%`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
