'use client';

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The table every list screen in this application uses.
 *
 * Almost every screen here is a filtered list of records. Hand-rolling that
 * twelve times is how admin panels become inconsistent and unmaintainable, so
 * pagination, sorting, empty and loading states, keyboard navigation, and ARIA
 * semantics are implemented once and configured per resource.
 * See docs/08-frontend-and-ux.md §4.
 *
 * Sorting and pagination are SERVER-driven: at 1M+ products, sorting a page of
 * 25 rows in the browser would sort the page, not the dataset, which is a
 * subtly wrong answer rather than a slow one.
 */

export interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  loading?: boolean;
  error?: { message: string; onRetry?: () => void } | null;

  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;

  cursor?: { next: string | null; hasMore: boolean };
  onNextPage?: () => void;
  onPreviousPage?: () => void;
  canGoBack?: boolean;
  totalCount?: number;

  onRowClick?: (row: TData) => void;
  getRowId?: (row: TData) => string;

  emptyState?: React.ReactNode;
  caption?: string;
  className?: string;
}

export function DataTable<TData>({
  columns,
  data,
  loading = false,
  error = null,
  sorting = [],
  onSortingChange,
  cursor,
  onNextPage,
  onPreviousPage,
  canGoBack = false,
  totalCount,
  onRowClick,
  getRowId,
  emptyState,
  caption,
  className,
}: DataTableProps<TData>) {
  const [activeRow, setActiveRow] = React.useState(-1);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
    state: { sorting },
    onSortingChange: (updater) => {
      if (!onSortingChange) return;
      onSortingChange(typeof updater === 'function' ? updater(sorting) : updater);
    },
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
  });

  const rows = table.getRowModel().rows;

  // j/k to move, Enter to open — the navigation power users expect from Linear
  // and Superhuman, and far faster than reaching for a mouse on a 200-row list.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const target = event.target as HTMLElement;
    // Never hijack keys while the user is typing in a filter.
    if (target.matches('input, textarea, select, [contenteditable]')) return;

    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveRow((current) => Math.min(current + 1, rows.length - 1));
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveRow((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter' && activeRow >= 0) {
      const row = rows[activeRow];
      if (row && onRowClick) {
        event.preventDefault();
        onRowClick(row.original);
      }
    } else if (event.key === 'Escape') {
      setActiveRow(-1);
    }
  };

  if (error) {
    return (
      <div className={cn('rounded-lg border border-border bg-card', className)}>
        <EmptyState
          title="Could not load results"
          description={error.message}
          action={
            error.onRetry ? (
              <Button variant="outline" onClick={error.onRetry}>
                Try again
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className={cn('rounded-lg border border-border bg-card', className)}>
      {/* Wide tables scroll inside their own container; the page body never
          scrolls horizontally. */}
      <div
        className="scrollbar-thin overflow-x-auto"
        role="region"
        aria-label={caption ?? 'Results'}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <table className="w-full caption-bottom text-sm">
          {caption ? <caption className="sr-only">{caption}</caption> : null}

          <thead className="border-b border-border">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const direction = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      // Communicates sort state to assistive technology, which
                      // an arrow icon alone does not.
                      aria-sort={
                        direction === 'asc'
                          ? 'ascending'
                          : direction === 'desc'
                            ? 'descending'
                            : canSort
                              ? 'none'
                              : undefined
                      }
                      className="whitespace-nowrap px-4 py-2.5 text-left text-xs font-medium text-muted-foreground"
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1 rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {direction === 'asc' ? (
                            <ArrowUp className="size-3" aria-hidden="true" />
                          ) : direction === 'desc' ? (
                            <ArrowDown className="size-3" aria-hidden="true" />
                          ) : (
                            <ChevronsUpDown className="size-3 opacity-40" aria-hidden="true" />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="p-0">
                  <TableSkeleton columns={columns.length} />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="p-0">
                  {emptyState ?? (
                    <EmptyState
                      title="Nothing to show"
                      description="No records match the current filters."
                    />
                  )}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  onMouseEnter={() => setActiveRow(index)}
                  aria-selected={index === activeRow || undefined}
                  className={cn(
                    'border-b border-border last:border-0 transition-colors',
                    onRowClick && 'cursor-pointer',
                    index === activeRow ? 'bg-accent' : 'hover:bg-accent/50',
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-2.5">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {(cursor || totalCount !== undefined) && !loading && rows.length > 0 ? (
        <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-2.5">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {totalCount !== undefined
              ? `${rows.length} of ${totalCount.toLocaleString('en-IN')}`
              : `${rows.length} shown`}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onPreviousPage} disabled={!canGoBack}>
              Previous
            </Button>
            <Button variant="outline" size="sm" onClick={onNextPage} disabled={!cursor?.hasMore}>
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
