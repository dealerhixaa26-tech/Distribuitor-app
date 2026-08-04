import { Activity, Boxes, Database, KeyRound, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';

export const metadata: Metadata = { title: 'Dashboard' };

// Health is a live signal; a cached readiness check is worse than none.
export const dynamic = 'force-dynamic';

interface HealthResponse {
  status: string;
  checks: { database: string; redis: string };
}

const API_ORIGIN = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`${API_ORIGIN}/health/ready`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    return (await response.json()) as HealthResponse;
  } catch {
    // A dashboard that throws because a dependency is down is less useful than
    // one that reports the dependency is down.
    return null;
  }
}

/**
 * Phase 1 foundation status.
 *
 * This deliberately reports what actually exists rather than rendering KPI
 * cards full of placeholder numbers. Real metrics arrive in Phase 9, backed by
 * materialised views — a dashboard showing invented figures is worse than one
 * that is honestly empty, because someone eventually believes it.
 */
export default async function DashboardPage() {
  const health = await fetchHealth();

  const foundation = [
    { label: 'Database schema', detail: '23 models · 3 migrations applied', icon: Database },
    { label: 'Access control', detail: '110 permissions · 11 roles · scoped RBAC live', icon: ShieldCheck },
    { label: 'Authentication', detail: 'Argon2id · refresh rotation · reuse detection', icon: KeyRound },
    { label: 'Outbox & worker', detail: 'Dispatcher polling · email queue live', icon: Activity },
    { label: 'Company profile', detail: '9 service lines · 5 industries seeded', icon: Boxes },
  ];

  const roadmap = [
    { phase: 3, name: 'Master Data', detail: 'Territories, geography, settings, documents' },
    { phase: 4, name: 'Catalog & Pricing', detail: 'Products, BOM, price lists, GST engine' },
    { phase: 5, name: 'Distributors', detail: 'Onboarding, KYC, credit, distributor 360' },
    { phase: 6, name: 'Inventory', detail: 'Stock ledger, serials, reservations, transfers' },
    { phase: 7, name: 'Sales', detail: 'Quotations, orders, approvals, dispatch' },
    { phase: 8, name: 'Finance', detail: 'Invoicing, payments, ledger, GST returns' },
    { phase: 9, name: 'Intelligence', detail: 'Dashboard, analytics, reports, notifications' },
  ];

  return (
    <>
      <PageHeader
        title="Foundation"
        description="Phases 1–2 are complete: infrastructure, authentication, and access control. Business modules arrive below."
        actions={
          health ? (
            <StatusBadge
              status={health.status === 'ok' ? 'ACTIVE' : 'SUSPENDED'}
              label={health.status === 'ok' ? 'All systems operational' : 'Degraded'}
            />
          ) : (
            <StatusBadge status="FAILED" label="API unreachable" />
          )
        }
      />

      <section aria-labelledby="services-heading" className="mb-8">
        <h2 id="services-heading" className="sr-only">
          Service health
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">PostgreSQL</CardTitle>
            </CardHeader>
            <CardContent>
              <StatusBadge
                status={health?.checks.database === 'up' ? 'ACTIVE' : 'FAILED'}
                label={health?.checks.database === 'up' ? 'Connected' : 'Unavailable'}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">Redis</CardTitle>
            </CardHeader>
            <CardContent>
              <StatusBadge
                status={health?.checks.redis === 'up' ? 'ACTIVE' : 'SUSPENDED'}
                label={health?.checks.redis === 'up' ? 'Connected' : 'Degraded'}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                Business mail
              </CardTitle>
            </CardHeader>
            <CardContent>
              <StatusBadge status="PENDING" label="Awaiting SMTP credentials" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">Ops mail</CardTitle>
            </CardHeader>
            <CardContent>
              <StatusBadge status="PENDING" label="Awaiting Gmail app password" />
            </CardContent>
          </Card>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="foundation-heading">
          <h2 id="foundation-heading" className="mb-3 text-sm font-semibold">
            What is built
          </h2>
          <Card>
            <ul className="divide-y divide-border">
              {foundation.map((item) => (
                <li key={item.label} className="flex items-start gap-3 p-4">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-success/10">
                    <item.icon className="size-4 text-success" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{item.label}</p>
                    <p className="text-sm text-muted-foreground">{item.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>

        <section aria-labelledby="roadmap-heading">
          <h2 id="roadmap-heading" className="mb-3 text-sm font-semibold">
            What is next
          </h2>
          <Card>
            <ul className="divide-y divide-border">
              {roadmap.map((item) => (
                <li key={item.phase} className="flex items-start gap-3 p-4">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-xs font-semibold text-muted-foreground">
                    {item.phase}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{item.name}</p>
                    <p className="text-sm text-muted-foreground">{item.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      </div>
    </>
  );
}
