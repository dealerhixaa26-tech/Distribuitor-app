'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { BarChart3, Download, Play } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { TableSkeleton } from '@/components/ui/skeleton';
import { ApiError, api } from '@/lib/api-client';
import { financialYearStartIso, todayIso } from '@/lib/utils';

/**
 * Reports.
 *
 * A catalogue, not a builder (ADR-0020): you pick a report type, set its
 * declared parameters, and run it. There is no place to type a query, because
 * no user input ever becomes SQL — which is what lets every report inherit the
 * same territory scoping as the rest of the system.
 *
 * Results render inline under the row cap. That is deliberate: making every
 * trivial report a job, a poll and an email is how people stop running reports.
 */
interface CatalogueEntry {
  type: string;
  name: string;
  description: string;
  columns: string[];
  financial: boolean;
}

interface RunResult {
  runId: string;
  type: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

/** Which reports take a date range, from the catalogue's own parameter shapes. */
const PERIOD_REPORTS = new Set([
  'SALES_SUMMARY',
  'DISTRIBUTOR_PERFORMANCE',
  'PRODUCT_PERFORMANCE',
  'GST_SUMMARY',
]);

export default function ReportsPage() {
  const [selected, setSelected] = useState<CatalogueEntry | null>(null);
  // Defaults to the current financial year — the window a CA or an owner
  // almost always wants, and the one the finance module already resets on.
  const [from, setFrom] = useState(financialYearStartIso);
  const [to, setTo] = useState(todayIso);
  const [result, setResult] = useState<RunResult | null>(null);

  const catalogue = useQuery({
    queryKey: ['reports', 'catalogue'],
    queryFn: () => api.get<{ reports: CatalogueEntry[] }>('/reports/catalogue'),
  });

  const run = useMutation({
    mutationFn: (entry: CatalogueEntry) =>
      api.post<RunResult>('/reports/run', {
        type: entry.type,
        parameters: PERIOD_REPORTS.has(entry.type) ? { from, to } : {},
        format: 'CSV',
      }),
    onSuccess: (data) => setResult(data),
  });

  const download = () => {
    if (!result) return;
    // Built client-side from the rows already fetched, so running and
    // downloading cannot produce two different answers.
    const escape = (value: unknown): string => {
      const text = value === null || value === undefined ? '' : String(value);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [
      result.columns.join(','),
      ...result.rows.map((row) => result.columns.map((column) => escape(row[column])).join(',')),
    ].join('\r\n');

    // BOM so Excel on Windows reads UTF-8 rather than mangling every rupee sign.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${result.type.toLowerCase()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title="Reports"
        description="A fixed catalogue with saved parameters. Results are scoped to your territory, like every other screen."
      />

      {catalogue.isLoading ? (
        <TableSkeleton />
      ) : (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {catalogue.data?.reports.map((entry) => (
            <button
              key={entry.type}
              type="button"
              onClick={() => {
                setSelected(entry);
                setResult(null);
              }}
              aria-pressed={selected?.type === entry.type}
              className={`rounded-lg border p-3 text-left transition-colors ${
                selected?.type === entry.type
                  ? 'border-primary bg-accent'
                  : 'border-border hover:bg-accent'
              }`}
            >
              <div className="text-sm font-medium">{entry.name}</div>
              <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
                {entry.description}
              </div>
            </button>
          ))}
        </div>
      )}

      {selected ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>{selected.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              {PERIOD_REPORTS.has(selected.type) ? (
                <>
                  <label className="text-xs text-muted-foreground">
                    From
                    <Input
                      type="date"
                      value={from}
                      onChange={(event) => setFrom(event.target.value)}
                      className="mt-1"
                    />
                  </label>
                  <label className="text-xs text-muted-foreground">
                    To
                    <Input
                      type="date"
                      value={to}
                      onChange={(event) => setTo(event.target.value)}
                      className="mt-1"
                    />
                  </label>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  This report reads the position as of today and takes no date range.
                </p>
              )}

              <button
                type="button"
                onClick={() => run.mutate(selected)}
                disabled={run.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              >
                <Play className="size-4" aria-hidden="true" />
                {run.isPending ? 'Running…' : 'Run'}
              </button>

              {result ? (
                <button
                  type="button"
                  onClick={download}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
                >
                  <Download className="size-4" aria-hidden="true" />
                  CSV
                </button>
              ) : null}
            </div>

            {run.error ? (
              <p className="mt-3 text-sm text-destructive">
                {run.error instanceof ApiError ? run.error.problem.detail : 'Something went wrong.'}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={BarChart3}
          title="Pick a report"
          description="Each one declares its own parameters. There is no query to write."
        />
      )}

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
              {result.truncated ? ' (truncated — narrow the period)' : ''}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{result.type} results</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    {result.columns.map((column) => (
                      <th key={column} scope="col" className="py-2 pr-3 whitespace-nowrap">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr key={index} className="border-b border-border/50">
                      {result.columns.map((column) => (
                        <td key={column} className="py-2 pr-3 whitespace-nowrap tabular">
                          {String(row[column] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
