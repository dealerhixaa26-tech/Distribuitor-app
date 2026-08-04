import { cn } from '@/lib/utils';

/**
 * Loading placeholder.
 *
 * Skeletons must match the final layout's dimensions — a skeleton that is a
 * different size than the content it replaces causes a layout jump, which is
 * the CLS regression the performance budget in docs/08 §9 exists to prevent.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted', className)}
      aria-hidden="true"
      {...props}
    />
  );
}

/** Table placeholder sized to the real row height. */
export function TableSkeleton({ rows = 8, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-px" role="status" aria-label="Loading results">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4 border-b border-border px-4 py-3">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={cn('h-4', columnIndex === 0 ? 'w-1/4' : 'flex-1')}
            />
          ))}
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
