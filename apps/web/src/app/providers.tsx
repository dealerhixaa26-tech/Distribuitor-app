'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import * as React from 'react';
import { Toaster } from 'sonner';
import { createQueryClient } from '@/lib/query-client';

export function Providers({ children }: { children: React.ReactNode }) {
  // Created in state, not at module scope: a module-level client would be
  // shared across every request on the server and leak one user's data into
  // another user's render.
  const [queryClient] = React.useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <NuqsAdapter>
          {children}
          <Toaster position="bottom-right" closeButton richColors />
        </NuqsAdapter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
