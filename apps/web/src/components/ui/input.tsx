import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex min-h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
        // Styled from aria-invalid rather than a className, so the visual state
        // and the state announced to a screen reader can never disagree.
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm',
      'placeholder:text-muted-foreground',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
      'aria-[invalid=true]:border-destructive',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
