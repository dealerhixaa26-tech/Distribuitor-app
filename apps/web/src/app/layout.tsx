import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: {
    default: 'Hixaa DMS',
    template: '%s · Hixaa DMS',
  },
  description: 'Distributor Management System for Hixaa Technologies Pvt. Ltd.',
  // An internal business system has no reason to appear in a search index.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Not capped: pinch-zoom must stay available for WCAG 2.2 §1.4.4.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#08090f' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning is required by next-themes: the theme class is
    // applied before hydration to avoid a flash of the wrong theme.
    <html lang="en" suppressHydrationWarning>
      <body>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
        >
          Skip to main content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
