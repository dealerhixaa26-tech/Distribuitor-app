# ADR-0026 — CSRF enforcement triggers on the CSRF cookie, not the refresh cookie

- **Status:** Accepted
- **Date:** 2026-08-11
- **Reverses:** an implicit assumption in the original `CsrfGuard`, not a prior ADR

## Context

`CsrfGuard` implements double-submit CSRF: the API issues a JS-readable `csrf_token` cookie, and a
state-changing request must echo it in an `X-CSRF-Token` header. A cross-origin attacker can cause
the cookie to be *sent* but cannot *read* it, and that asymmetry is the whole mechanism.

The guard exempts requests that carry no session cookie, on the reasoning that a pure bearer-token
caller — a server-to-server client, a future mobile app — has no ambient credential to forge against.
That exemption was written as:

```ts
const hasSessionCookie = Boolean(request.cookies?.[this.config.auth.cookieName]);
if (!hasSessionCookie) return true;
```

`config.auth.cookieName` is the **refresh** cookie, `hixaa_rt`. The API deliberately scopes it to
`/api/v1/auth`, and the BFF rewrites that to `/api/bff/auth` so the browser will send it back to the
right place. Both of those are correct on their own terms.

Together they mean the browser never sends `hixaa_rt` to `/api/bff/distributors`, or to any other
non-auth route. The BFF forwards only what the browser sent. So on every mutation the admin UI makes,
the API sees no refresh cookie, classes the request as a pure bearer call, and returns before
comparing anything.

Measured on the running stack, against the API directly:

| Request shape | Status |
|---|---|
| refresh cookie sent + **forged** CSRF header | `401` |
| refresh cookie sent + correct CSRF header | `201` |
| **refresh cookie absent** + forged CSRF header | `201` |

The third row is the shape of every request the admin UI makes. Through the BFF,
`POST /api/bff/reports/run` returns `201` with a forged token, and `201` with no token at all.

The guard is not broken — rows one and two prove it works exactly as designed. It is **unreachable**
on the only path that matters. This is the defect this project keeps finding: not a failure, but a
control that succeeds while doing nothing (HANDOFF §2, ADR-0021, ADR-0022, §4.27).

What still stands between a hostile page and an approved order is `SameSite=Lax` on the access-token
cookie, which does block a cross-site POST. That is a real control. It is also *one* control, and the
guard's own comment states the position this codebase took: "`SameSite=Lax` blocks most of that, but
it is a single control with known gaps, and an ERP that can approve orders warrants two."

The trigger is being examined now, before create/edit forms exist, because the entire write surface
of the product is about to be built on top of this path. Forty mutations from now, the same finding
is forty times harder to reason about.

## Decision

**CSRF is enforced whenever a `csrf_token` cookie accompanies the request, regardless of which other
cookies do.**

The exemption for cookie-free bearer callers is kept — it is legitimate, and it is what lets a
server-to-server integration authenticate without a browser's machinery. What changes is how the
guard recognises one. A caller that presents no cookies at all is a bearer caller. A caller that
presents the CSRF cookie is a browser, and browsers get the second control.

`csrf_token` is issued with `Path=/`, so it reaches every route the BFF proxies. `apiFetch` already
reads it and sets the header on every non-GET request, so the client side needs no change — it has
been sending a header nothing checked.

## Consequences

**The double-submit check now actually runs.** A forged or missing header on a proxied mutation is
refused with `CSRF_INVALID`, which is what the architecture always claimed.

**A cross-site attacker gains nothing from the new trigger.** Under `SameSite=Lax` a cross-site POST
carries no cookies at all — not the access token, and not `csrf_token`. Such a request is exempted
as a bearer call, arrives with no credential, and is rejected as unauthenticated. The guard's value
is against the cases Lax does not cover, which is precisely why a second control exists.

**A bearer-only client must not send a CSRF cookie.** That is the correct constraint: a client that
sends browser cookies is asking to be treated as a browser. Nothing in the codebase does this today.

**Server-side fetches from Next must be checked, not assumed.** The BFF forwards the browser's cookie
jar upstream, so anything issuing a proxied mutation must also set the header. `apiFetch` does. Any
future server component that POSTs directly must, and the smoke check below will catch it if it does
not.

**This is verified by refusal, not by a passing request** (§4.4). The regression check asserts that a
forged header through the BFF returns `401` and that a correct one returns `2xx`. A check that only
asserted success would pass identically against the broken guard — which is exactly how the defect
survived to be found here.
