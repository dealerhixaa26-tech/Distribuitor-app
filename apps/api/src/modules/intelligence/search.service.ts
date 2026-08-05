import { Injectable } from '@nestjs/common';
import type { GlobalSearchQuery, SearchEntity } from '@hixaa/contracts';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * Cross-entity search behind the ⌘K palette.
 *
 * ── Everything here reads through `prisma.db` ──────────────────────────────
 * Which means the scope extension bounds every result. That is not a detail:
 * an unscoped search is an enumeration oracle, and it would undo the reasoning
 * behind returning 404 rather than 403 for an out-of-scope record
 * (`NotFoundError`'s comment, docs/03 §3). A user who cannot open an invoice
 * must not be able to learn its number by typing three characters.
 *
 * ── Why `contains` and not the trigram operator ────────────────────────────
 * HANDOFF §4.11: pg_trgm's `%` compares WHOLE strings, so
 * `similarity('Raksha IoT Gateway', 'raksah')` is 0.18 — below the 0.3 default
 * — and a typo-tolerant search over long names silently finds nothing.
 * `word_similarity` fixes that and is what `products.service.ts` uses for the
 * catalog.
 *
 * Here the other entities are matched on IDENTIFIERS — invoice numbers, codes,
 * GSTINs — where a case-insensitive substring match is both correct and
 * exactly what someone typing "INV/2026" expects. Fuzzy matching a document
 * number would return neighbours of the number you asked for, which is worse
 * than nothing.
 */

const GROUP_LABELS: Record<SearchEntity, string> = {
  INVOICE: 'Invoices',
  ORDER: 'Orders',
  QUOTATION: 'Quotations',
  DISTRIBUTOR: 'Distributors',
  CUSTOMER: 'Customers',
  PRODUCT: 'Products',
};

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SearchService.name);
  }

  async search(query: GlobalSearchQuery) {
    const wanted: SearchEntity[] = query.entities
      ? Array.isArray(query.entities)
        ? query.entities
        : [query.entities]
      : (Object.keys(GROUP_LABELS) as SearchEntity[]);

    const term = query.q.trim();
    const take = query.limit;

    // Every group runs concurrently and independently: one slow entity should
    // not hold up a palette the user is typing into.
    const groups = await Promise.all(
      wanted.map(async (entity) => ({
        entity,
        label: GROUP_LABELS[entity],
        hits: await this.searchEntity(entity, term, take),
      })),
    );

    const populated = groups.filter((group) => group.hits.length > 0);

    return {
      query: term,
      totalHits: populated.reduce((sum, group) => sum + group.hits.length, 0),
      groups: populated,
    };
  }

  private async searchEntity(entity: SearchEntity, term: string, take: number) {
    const like = { contains: term, mode: 'insensitive' as const };

    switch (entity) {
      case 'INVOICE': {
        const rows = await this.prisma.db.invoice.findMany({
          where: { OR: [{ number: like }, { counterpartyName: like }, { counterpartyGstin: like }] },
          orderBy: { createdAt: 'desc' },
          take,
          select: {
            id: true,
            number: true,
            counterpartyName: true,
            grandTotal: true,
            status: true,
          },
        });
        return rows.map((row) => ({
          entity,
          id: row.id,
          title: row.number ?? 'Draft invoice',
          subtitle: `${row.counterpartyName} · ₹${row.grandTotal.toFixed(2)} · ${row.status}`,
          href: `/invoices/${row.id}`,
        }));
      }

      case 'ORDER': {
        const rows = await this.prisma.db.order.findMany({
          where: { OR: [{ number: like }, { customerPoNumber: like }] },
          orderBy: { createdAt: 'desc' },
          take,
          select: {
            id: true,
            number: true,
            status: true,
            distributor: { select: { legalName: true } },
            customer: { select: { name: true } },
          },
        });
        return rows.map((row) => ({
          entity,
          id: row.id,
          title: row.number,
          subtitle: `${row.distributor?.legalName ?? row.customer?.name ?? '—'} · ${row.status}`,
          href: `/orders/${row.id}`,
        }));
      }

      case 'QUOTATION': {
        const rows = await this.prisma.db.quotation.findMany({
          where: { number: like },
          orderBy: { createdAt: 'desc' },
          take,
          select: {
            id: true,
            number: true,
            status: true,
            distributor: { select: { legalName: true } },
            customer: { select: { name: true } },
          },
        });
        return rows.map((row) => ({
          entity,
          id: row.id,
          title: row.number,
          subtitle: `${row.distributor?.legalName ?? row.customer?.name ?? '—'} · ${row.status}`,
          href: `/quotations/${row.id}`,
        }));
      }

      case 'DISTRIBUTOR': {
        const rows = await this.prisma.db.distributor.findMany({
          where: {
            OR: [{ code: like }, { legalName: like }, { tradeName: like }, { gstin: like }],
          },
          orderBy: { legalName: 'asc' },
          take,
          select: { id: true, code: true, legalName: true, status: true },
        });
        return rows.map((row) => ({
          entity,
          id: row.id,
          title: row.legalName,
          subtitle: `${row.code} · ${row.status}`,
          href: `/distributors/${row.id}`,
        }));
      }

      case 'CUSTOMER': {
        const rows = await this.prisma.db.customer.findMany({
          where: { OR: [{ code: like }, { name: like }, { gstin: like }] },
          orderBy: { name: 'asc' },
          take,
          select: { id: true, code: true, name: true, siteName: true },
        });
        return rows.map((row) => ({
          entity,
          id: row.id,
          title: row.name,
          subtitle: [row.code, row.siteName].filter(Boolean).join(' · ') || null,
          href: `/customers/${row.id}`,
        }));
      }

      case 'PRODUCT': {
        // The catalog already has a `search_vector` GIN index and a
        // `word_similarity` fallback (Phase 4). Reusing that ranking rather
        // than substring-matching here keeps one definition of "product
        // search" — see products.service.ts `searchIds()`.
        const ids = await this.productSearchIds(term, take);
        if (ids.length === 0) return [];

        const rows = await this.prisma.db.product.findMany({
          where: { id: { in: ids } },
          select: { id: true, sku: true, name: true, status: true },
        });
        const byId = new Map(rows.map((row) => [row.id, row]));

        // Preserve the rank order the search returned; a findMany does not.
        return ids.flatMap((id) => {
          const row = byId.get(id);
          if (!row) return [];
          return [
            {
              entity,
              id: row.id,
              title: row.name,
              subtitle: `${row.sku} · ${row.status}`,
              href: `/products/${row.id}`,
            },
          ];
        });
      }
    }
  }

  /**
   * Full-text then trigram, mirroring `ProductsService.searchIds()`.
   *
   * Raw SQL because `search_vector` is trigger-maintained and invisible to
   * Prisma. It is safe here for the reason ADR-0020 §2 requires: the term is a
   * bound parameter, never interpolated. Products are company-wide reference
   * data and deliberately NOT scoped (see SCOPE_REGISTRY), so no scope
   * predicate is missing — that is a decision, not an oversight.
   */
  private async productSearchIds(term: string, take: number): Promise<string[]> {
    const rows = await this.prisma.db.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM product
      WHERE deleted_at IS NULL
        AND (
          search_vector @@ websearch_to_tsquery('english', ${term})
          OR word_similarity(${term}, name) > 0.3
          OR sku ILIKE ${'%' + term + '%'}
        )
      ORDER BY
        ts_rank(search_vector, websearch_to_tsquery('english', ${term})) DESC,
        word_similarity(${term}, name) DESC
      LIMIT ${take}
    `;
    return rows.map((row) => row.id);
  }
}
