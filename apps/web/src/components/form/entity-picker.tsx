'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Loader2, X } from 'lucide-react';
import * as React from 'react';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import type { FieldControlProps } from './field';

/**
 * A searchable lookup over a list endpoint — territory, product, distributor,
 * customer, user, price list.
 *
 * Why not a `<select>`: there are 100k distributors and 1M products at the
 * volume 11.2 load-tested. A select would render the first page and quietly
 * omit the rest, which is the silent-truncation failure this project keeps
 * finding — a control that looks complete and is not. So the list is always
 * server-filtered, and what it cannot show it says it cannot show.
 *
 * Implements the ARIA 1.2 combobox pattern: `role="combobox"` on the input with
 * `aria-expanded`/`aria-controls`/`aria-activedescendant`, `role="listbox"` on
 * the list, `role="option"` on each row. Focus stays in the input throughout —
 * moving it into the list is what breaks these for screen-reader users.
 */

export interface PickerOption {
  id: string;
  label: string;
  /** Second line — a code, a territory, a status. */
  hint?: string;
}

interface EntityPickerProps {
  /** The selected id, or '' for none. */
  value: string;
  onChange: (id: string) => void;
  onBlur?: () => void;

  /** List endpoint, e.g. `/products`. Searched with `?q=`. */
  path: string;
  /** Maps one row of the endpoint's response to an option. */
  toOption: (row: never) => PickerOption;
  /** Extra query parameters — a warehouse filter, a status filter. */
  query?: Record<string, string | number | boolean | undefined>;

  /**
   * Label for the current value on an edit form.
   *
   * Without it the field would show a bare UUID until the user typed something
   * that happened to return the row they already had selected.
   */
  initialLabel?: string;

  placeholder?: string;
  disabled?: boolean;
  control: FieldControlProps;
}

/**
 * Two shapes come back from list endpoints, and the difference is load-bearing.
 *
 * `apiFetch` returns the whole envelope only when `meta` is present (§4.10), so
 * a PAGINATED endpoint yields `{ data, meta }` while a small reference lookup —
 * `/territories`, `/categories`, `/geography/uoms` — yields the bare array.
 * Reading `.data` off both would leave every reference picker permanently
 * showing "No matches" against a 200 OK, with nothing to see in the console.
 *
 * The distinction also decides where filtering happens. A paginated endpoint
 * has already applied `?q=` server-side and may be hiding more rows. A bare
 * array IS the whole list — the endpoint ignored `q` — so it must be filtered
 * here, or typing would narrow nothing.
 */
type ListResponse = unknown[] | { data: unknown[]; meta?: { cursor?: { hasMore?: boolean } } };

function readList(response: ListResponse | undefined): {
  rows: unknown[];
  paginated: boolean;
  hasMore: boolean;
} {
  if (!response) return { rows: [], paginated: false, hasMore: false };
  if (Array.isArray(response)) return { rows: response, paginated: false, hasMore: false };
  return {
    rows: response.data ?? [],
    paginated: true,
    hasMore: response.meta?.cursor?.hasMore ?? false,
  };
}

export function EntityPicker({
  value,
  onChange,
  onBlur,
  path,
  toOption,
  query,
  initialLabel,
  placeholder = 'Search…',
  disabled,
  control,
}: EntityPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(-1);
  /**
   * What the user has chosen in this session — NOT the label to display.
   *
   * Mirroring `initialLabel` into state and syncing it in an effect is the
   * derive-state-from-props antipattern: it costs a second render and goes
   * stale whenever the prop changes without the effect running. The label is
   * computed below instead, so there is one source for it.
   */
  const [picked, setPicked] = React.useState<PickerOption | null>(null);

  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listboxId = `${control.id}-listbox`;

  // A keystroke per request would be a request per keystroke against a table
  // 11.2 measured at a million rows.
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 200);
    return () => clearTimeout(timer);
  }, [search]);

  // The label belongs to whatever `value` currently is: the option just picked
  // if it is that one, otherwise the label the form was loaded with.
  const selectedLabel = value ? (picked?.id === value ? picked.label : (initialLabel ?? '')) : '';

  const { data, isFetching } = useQuery({
    queryKey: ['picker', path, debounced, query],
    queryFn: () =>
      api.get<ListResponse>(path, { query: { q: debounced || undefined, limit: 20, ...query } }),
    // Nothing is fetched until the field is opened: thirteen pickers on one
    // form would otherwise be thirteen requests on page load.
    enabled: open,
    staleTime: 30_000,
  });

  const { options, hasMore } = React.useMemo(() => {
    const { rows, paginated, hasMore: more } = readList(data);
    const all = rows.map((row) => toOption(row as never));
    if (paginated || !debounced) return { options: all, hasMore: more };

    // A bare array is the complete list and the endpoint ignored `q`, so the
    // narrowing has to happen here.
    const needle = debounced.toLowerCase();
    return {
      options: all.filter(
        (option) =>
          option.label.toLowerCase().includes(needle) ||
          (option.hint?.toLowerCase().includes(needle) ?? false),
      ),
      hasMore: false,
    };
  }, [data, toOption, debounced]);

  const close = React.useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    setSearch('');
  }, []);

  const select = React.useCallback(
    (option: PickerOption) => {
      onChange(option.id);
      setPicked(option);
      close();
      inputRef.current?.focus();
    },
    [onChange, close],
  );

  const clear = React.useCallback(() => {
    onChange('');
    setPicked(null);
    setSearch('');
    inputRef.current?.focus();
  }, [onChange]);

  // A click elsewhere is a dismissal, not a selection — the value must not
  // change just because the list closed.
  React.useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (options.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((previous) => {
        const next = previous + step;
        if (next < 0) return options.length - 1;
        if (next >= options.length) return 0;
        return next;
      });
      return;
    }

    if (event.key === 'Home' && open) {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End' && open) {
      event.preventDefault();
      setActiveIndex(options.length - 1);
      return;
    }

    if (event.key === 'Enter') {
      // Only swallowed when it is choosing an option; otherwise Enter must
      // still submit the form.
      if (open && activeIndex >= 0 && options[activeIndex]) {
        event.preventDefault();
        select(options[activeIndex]);
      }
      return;
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault();
      // Escape does not clear the selection — closing a list you opened by
      // accident should not throw away what was already chosen.
      close();
    }
  };

  const activeId = activeIndex >= 0 && options[activeIndex] ? `${listboxId}-${activeIndex}` : undefined;

  return (
    <div ref={containerRef} className="relative">
      <div
        className={cn(
          'flex min-h-9 w-full items-center gap-1 rounded-md border border-input bg-background px-2',
          'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
          control['aria-invalid'] ? 'border-destructive' : null,
          disabled ? 'cursor-not-allowed opacity-50' : null,
        )}
      >
        <input
          ref={inputRef}
          id={control.id}
          role="combobox"
          type="text"
          autoComplete="off"
          disabled={disabled}
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-invalid={control['aria-invalid']}
          aria-describedby={control['aria-describedby']}
          aria-required={control['aria-required']}
          // While closed the field reads as the current selection; while open it
          // is a search box. Two modes, one control — which is what a combobox is.
          value={open ? search : selectedLabel}
          placeholder={value && !open ? undefined : placeholder}
          onChange={(event) => {
            setSearch(event.target.value);
            setActiveIndex(-1);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
        />

        {isFetching ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : null}

        {value && !disabled ? (
          <button
            type="button"
            onClick={clear}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3.5" aria-hidden="true" />
            <span className="sr-only">Clear selection</span>
          </button>
        ) : null}

        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>

      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Suggestions"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-card p-1 shadow-lg"
        >
          {options.length === 0 ? (
            <li className="px-2 py-3 text-center text-xs text-muted-foreground" role="presentation">
              {isFetching ? 'Searching…' : debounced ? 'No matches' : 'Type to search'}
            </li>
          ) : null}

          {options.map((option, index) => (
            <li
              key={option.id}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={option.id === value}
              // pointerdown, not click: the dismiss handler also listens for
              // pointerdown and would otherwise close the list first, so the
              // click would land on nothing.
              onPointerDown={(event) => {
                event.preventDefault();
                select(option);
              }}
              onPointerEnter={() => setActiveIndex(index)}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm',
                index === activeIndex ? 'bg-accent' : null,
              )}
            >
              <Check
                className={cn('size-3.5 shrink-0', option.id === value ? 'opacity-100' : 'opacity-0')}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{option.label}</span>
                {option.hint ? (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {option.hint}
                  </span>
                ) : null}
              </span>
            </li>
          ))}

          {hasMore ? (
            // Said out loud rather than silently truncated: a picker that shows
            // twenty of four hundred matches and does not say so is how someone
            // concludes a record does not exist.
            <li
              role="presentation"
              className="border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground"
            >
              More matches exist — narrow the search to see them.
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
