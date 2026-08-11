import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'hixaa:idempotent';

/**
 * Marks a handler as requiring an `Idempotency-Key`.
 *
 * `docs/03-api-design.md` §5 promised this on every request that moves money or
 * commits an irreversible decision. Until Phase 11 the promise was structural
 * only: the `idempotency_key` table existed, so did the error code, the nightly
 * purge job, the CORS allowance and the client's own option — and no
 * interceptor read the header. A retried "approve order" could approve twice.
 *
 * Marking is EXPLICIT rather than inferred from the route path. Matching
 * `/approve` as a string would silently miss `POST /payments/:id/verify`, which
 * is the financial event (ADR-0018), and would silently start covering any
 * future route that happened to contain the word. `idempotency-coverage.spec.ts`
 * asserts the required set is decorated by reading the metadata back off the
 * controller, so a new money endpoint that forgets this fails the build.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);
