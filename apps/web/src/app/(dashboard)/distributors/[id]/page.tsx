'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  FileText,
  Pin,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, api } from '@/lib/api-client';
import { formatDate, formatMoney, formatRelative, humanizeEnum } from '@/lib/utils';

/**
 * Distributor 360.
 *
 * The response shape already carries a `commercials` block with nulls and a
 * note, so orders (Phase 7) and outstanding (Phase 8) slot in without this
 * component's contract changing.
 */
interface DistributorDetail {
  id: string;
  code: string;
  legalName: string;
  tradeName: string | null;
  type: string;
  status: string;
  gstin: string | null;
  pan: string | null;
  territoryName: string | null;
  accountManagerName: string | null;
  creditLimit: string;
  creditDays: number;
  bankAccountMasked: string | null;
  tags: string[];
  onboardedAt: string | null;
  createdAt: string;
  kycVerified: boolean;
  kycMissing: string[];
  contacts: Array<{
    id: string;
    name: string;
    designation: string | null;
    email: string | null;
    phone: string | null;
    isPrimary: boolean;
    portalUserId: string | null;
  }>;
  documents: Array<{
    id: string;
    type: string;
    verifiedAt: string | null;
    rejectedAt: string | null;
    rejectionReason: string | null;
    expiresAt: string | null;
    document: { originalName: string; sizeBytes: number } | null;
  }>;
  notes: Array<{
    id: string;
    body: string;
    isPinned: boolean;
    createdAt: string;
    authorName: string | null;
  }>;
  agreements: Array<{
    id: string;
    reference: string | null;
    startDate: string;
    endDate: string | null;
    targetAmount: string | null;
    status: string;
  }>;
  commercials: { outstanding: string | null; ordersLast12Months: number | null; note: string };
}

export default function DistributorDetailPage() {
  const params = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['distributors', params.id],
    queryFn: () => api.get<DistributorDetail>(`/distributors/${params.id}`),
  });

  if (isLoading) {
    return (
      <Card>
        <TableSkeleton rows={6} columns={3} />
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <EmptyState
          title="Could not load distributor"
          description={
            error instanceof ApiError
              ? error.problem.detail
              : 'This distributor may be outside your territory.'
          }
          action={
            <Link href="/distributors" className="text-sm text-primary hover:underline">
              Back to distributors
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <>
      <Link
        href="/distributors"
        className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Distributors
      </Link>

      <PageHeader
        title={data.legalName}
        description={
          [data.tradeName, humanizeEnum(data.type), data.territoryName]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        actions={<StatusBadge status={data.status} />}
      />

      {data.kycMissing.length > 0 && data.status !== 'TERMINATED' ? (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <div>
            <p className="font-medium text-warning">KYC incomplete</p>
            <p className="mt-0.5 text-muted-foreground">
              {data.kycMissing.map(humanizeEnum).join(', ')} not yet verified. Approval is blocked
              until they are — an unverified partner would produce legally defective invoices.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Commercial terms</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Field label="Credit limit" value={formatMoney(data.creditLimit)} />
                <Field label="Credit days" value={`${data.creditDays} days`} />
                <Field label="GSTIN" value={data.gstin ?? '—'} mono />
                <Field label="PAN" value={data.pan ?? '—'} mono />
                <Field label="Bank account" value={data.bankAccountMasked ?? '—'} mono />
                <Field label="Account manager" value={data.accountManagerName ?? 'Unassigned'} />
                <Field
                  label="Onboarded"
                  value={data.onboardedAt ? formatDate(data.onboardedAt) : 'Not yet'}
                />
                <Field label="Created" value={formatDate(data.createdAt)} />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>KYC documents</CardTitle>
            </CardHeader>
            {data.documents.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="No documents"
                description="Attach a GST certificate, PAN card, and signed agreement to enable approval."
              />
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                {data.documents.map((doc) => (
                  <li key={doc.id} className="flex items-center gap-3 p-4">
                    {doc.verifiedAt ? (
                      <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
                    ) : doc.rejectedAt ? (
                      <XCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
                    ) : (
                      <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{humanizeEnum(doc.type)}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {doc.document?.originalName ?? '—'}
                        {doc.expiresAt ? ` · expires ${formatDate(doc.expiresAt)}` : ''}
                      </p>
                      {doc.rejectionReason ? (
                        <p className="mt-0.5 text-xs text-destructive">{doc.rejectionReason}</p>
                      ) : null}
                    </div>
                    <StatusBadge
                      status={doc.verifiedAt ? 'CLEAN' : doc.rejectedAt ? 'REJECTED' : 'PENDING'}
                      label={doc.verifiedAt ? 'Verified' : doc.rejectedAt ? 'Rejected' : 'Pending'}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Notes</CardTitle>
            </CardHeader>
            {data.notes.length === 0 ? (
              <EmptyState title="No notes" description="Record context about this relationship." />
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                {data.notes.map((note) => (
                  <li key={note.id} className="p-4">
                    <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      {note.isPinned ? (
                        <Pin className="size-3 text-primary" aria-hidden="true" />
                      ) : null}
                      <span>{note.authorName ?? 'System'}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatRelative(note.createdAt)}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{note.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Contacts</CardTitle>
            </CardHeader>
            {data.contacts.length === 0 ? (
              <EmptyState title="No contacts" description="At least one is required for approval." />
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                {data.contacts.map((contact) => (
                  <li key={contact.id} className="p-4">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium">{contact.name}</p>
                      {contact.isPrimary ? (
                        <CheckCircle2
                          className="size-3 text-primary"
                          aria-label="Primary contact"
                        />
                      ) : null}
                    </div>
                    {contact.designation ? (
                      <p className="text-xs text-muted-foreground">{contact.designation}</p>
                    ) : null}
                    <p className="mt-1 text-xs">{contact.email ?? '—'}</p>
                    <p className="text-xs text-muted-foreground">{contact.phone ?? '—'}</p>
                    {contact.portalUserId ? (
                      <StatusBadge
                        status="ACTIVE"
                        label="Portal access"
                        tone="info"
                        className="mt-1.5"
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Commercials</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Honest about what does not exist yet, rather than showing a
                  zero that looks like a real figure. */}
              <p className="text-sm text-muted-foreground">{data.commercials.note}</p>
            </CardContent>
          </Card>

          {data.agreements.length > 0 ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle>Agreements</CardTitle>
              </CardHeader>
              <ul className="divide-y divide-border border-t border-border">
                {data.agreements.map((agreement) => (
                  <li key={agreement.id} className="p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">{agreement.reference ?? 'Agreement'}</p>
                      <StatusBadge status={agreement.status} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatDate(agreement.startDate)} →{' '}
                      {agreement.endDate ? formatDate(agreement.endDate) : 'open'}
                    </p>
                    {agreement.targetAmount ? (
                      <p className="mt-1 text-xs tabular">
                        Target {formatMoney(agreement.targetAmount)}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 text-sm ${mono ? 'font-mono text-xs' : ''} tabular`}>{value}</dd>
    </div>
  );
}
