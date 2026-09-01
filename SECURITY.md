# Security hardening

A record of a focused security pass on Inbound's real auth/authorization
surface: an audit, a new authorization layer, a static analysis pass, and a
dynamic analysis pass against a running instance. Written to be accurate, not
impressive — findings and non-findings are both reported as they actually
came out.

## Threat model

Inbound is a small Next.js app; the codebase targets Cloud SQL Postgres, but
the actual deployed instance is Neon (a documented gap in its own right, see
below). Identity comes
from Firebase Auth; authorization is enforced almost entirely in Postgres Row
Level Security, keyed on a `firebase_uid` the app sets per transaction after
verifying a bearer token (`withUser()` in `src/lib/db/pool.ts`). The
interesting attacker here isn't a nation-state — it's a signed-in user trying
to read or modify another user's rows (an IDOR/broken-access-control problem),
or an operator misconfiguration that quietly disables the RLS the app assumes
is active (the runtime connecting as a table owner, which bypasses every
policy). Both classes are addressed below. Out of scope: DoS, supply-chain
compromise, and anything requiring Firebase/Google infrastructure itself to be
compromised.

## What was done

### 1. Audit

Traced the full chain: client Firebase ID token → `getAuthedUser()` verifies
it via `firebase-admin` → `withUser(uid, fn)` opens a transaction and
`SET LOCAL app.firebase_uid` → 22 RLS policies in `firebase/schema/0003_rls.sql`
enforce per-row access via `current_firebase_uid()`. The key finding from the
audit: **all authorization logic lives in SQL, not application code** — the
app layer only authenticates. That's a reasonable design, but it means the
entire authorization boundary depends on one thing never going wrong: the
runtime connecting as a non-owner role. CLAUDE.md already documented that this
was violated in production (`neondb_owner`, which owns every table and
carries `BYPASSRLS`) — unexploitable at the time only because no sign-in UI
existed yet.

### 2. Scoped app-token authorization layer

Added `src/lib/auth/appToken.ts`: short-lived (5 minute), HS256-signed tokens
minted by `POST /api/auth/token` after a Firebase token is verified, scoped to
one action (`reviews:write` today). `reviews/submit` now requires both a valid
Firebase token *and* a matching-uid, matching-scope app token before touching
`withUser`. This is deliberately additive to RLS, not a replacement for it —
Firebase claims are coarse and valid for up to an hour; this narrows that to a
specific action for a few minutes, and gives a second, independent gate that
has to be defeated alongside RLS rather than in place of it. Scope: touches
only the one authenticated write route that exists in this app today
(`spots/search` and `itineraries/generate` are public reads with no ownership
boundary — a write-scoped token adds nothing there).

### 3. Static analysis — Semgrep

Ran `semgrep` with `p/javascript`, `p/typescript`, `p/nextjs`,
`p/security-audit`, `p/secrets`, `p/owasp-top-ten` (157 rules) against the
full tracked repo (63 files).

**Before → after: 1 finding → 0 findings.**

`src/lib/db/pool.ts` set `ssl: { rejectUnauthorized: false }` unconditionally
for any non-local connection, including production — the code's own comment
even predicted the fix and it was never done. This disables TLS certificate
verification, leaving the database connection open to a MITM presenting any
certificate. The first pass at a fix assumed a Cloud SQL-style private CA
(verify against `PGSSLROOTCERT` if set, fall back to unverified otherwise) —
wrong for what's actually deployed. Checked against Neon's own docs: Neon
terminates TLS with the public ISRG Root X1 (Let's Encrypt) certificate,
already in Node's default trust store, so the correct fix is unconditional
verification (`rejectUnauthorized: true`) with no custom CA at all;
`PGSSLROOTCERT` remains only as an escape hatch for a provider that does use
a private CA. Verified against the real production Neon instance before
merging — pushed to a branch, checked `/api/health` on the resulting preview
deployment (`"database":"connected"`), then merged and re-checked the same
endpoint on production once live. No unverified fallback remains.

Honest limitation: Semgrep's generic rulesets don't know what
`spots_near_station` or the RLS policies are supposed to enforce, so this
pass can't and didn't catch authorization-logic bugs — that's what the audit
and dynamic pass are for.

### 4. Dynamic analysis

OWASP ZAP wasn't a good fit and I said so instead of forcing it: the Homebrew
cask is deprecated (Gatekeeper-blocked as of the day of this pass) and there's
no Docker for the headless scanner, but more fundamentally, ZAP's
spider/active-scan model targets browsable multi-page apps with forms and
sessions — this app's live surface is six stateless JSON endpoints. Instead,
targeted manual/scripted testing ran against the real local app
(`npm run dev` + local Postgres/PostGIS), covering exactly what was asked:

- **Session fixation — tested, not applicable.** No response sets
  `Set-Cookie` anywhere; auth is a bearer token re-verified per request, with
  no server-side session for an attacker to fixate. Reported honestly as "the
  vulnerability class doesn't apply here," not as a passed check.
- **IDOR — tested, one real finding and fix.** Two identities were seeded and,
  as `attacker-uid`, UPDATE/DELETE/spoofed-INSERT attempts against
  `victim-uid`'s `user_reviews` row were all correctly blocked by RLS. Getting
  a meaningful test required first fixing something real: **local dev's own
  `DATABASE_URL` connected as the table owner (`postgres`), which bypasses
  RLS entirely** — the same class of gap CLAUDE.md documents for production.
  Every IDOR attempt would have silently succeeded against that connection.
  Fixed for real, not just for this session: `scripts/local-db.sh` now
  creates the non-owner `inbound_app` role automatically, and the README
  quickstart points local dev at it instead of the owner role.
- **Injection — tested, clean.** SQLi payloads in `station_id`/`category`
  query params were rejected by zod before reaching SQL. A payload in
  `body_text` (`'); DROP TABLE user_reviews; --`) went through the real
  parameterized insert and was stored inertly as text — table intact.
  Path-traversal and host-injection payloads against the Google Photos proxy
  (`/api/photos/[...name]`) were rejected by its resource-name regex, while a
  correctly-shaped resource passed the regex and reached the upstream fetch —
  confirming the check gates on shape, not merely presence.

### 5. Encryption — field-level, at rest

The TLS fix in step 3 is transport encryption (data in flight); it says
nothing about data at rest, which is a separate control. `app_users.email` is
the one column in the schema holding genuine PII, and it's write-mostly — only
`ensureAppUser` writes it, and until this pass nothing read it back at all —
so there's no `WHERE email = ...` anywhere in the app to constrain the design.
That makes randomized authenticated encryption the right choice with no
deterministic-encryption or searchable-index tradeoff to reason about:

- `src/lib/crypto/piiCipher.ts` — AES-256-GCM, a fresh 96-bit IV per call, key
  from `PII_ENCRYPTION_KEY` (32 bytes, required at least that long or the
  module refuses to run). Ciphertext is `base64(iv || authTag || ciphertext)`.
  The GCM auth tag means a tampered or corrupted stored value fails to
  decrypt rather than silently returning garbage - it fails closed.
- `ensureAppUser` (`src/lib/auth.ts`) encrypts before insert; a new
  `getUserEmail` decrypts, so the round trip has a real caller and isn't
  write-only-forever. Nothing currently calls `getUserEmail` from a route -
  no admin UI exists yet that needs it - documented as such rather than
  wiring it in just to have a caller.
- No `pgcrypto`/database-side encryption: keeping this in application code
  means the key is never handed to Postgres, and the approach isn't tied to
  one provider's crypto extension.
- `firebase/schema/0006_encrypt_email.sql` documents the column via
  `COMMENT ON` rather than a type change (ciphertext is still `text`). No
  backfill: at the time this shipped there was no sign-in UI and no way to
  mint a verified Firebase token, so `app_users` held no rows with real
  plaintext email addresses — the same "unexploitable today" reasoning
  CLAUDE.md already uses for the RLS gap.
- Verified two ways, not just unit tests: 6 Vitest cases in
  `piiCipher.test.ts` (round-trip, distinct ciphertext per call, tamper
  detection, wrong-key rejection, missing/short-key rejection), plus a real
  run against the local Postgres instance through `ensureAppUser` →
  `getUserEmail` — confirmed the stored column value is opaque base64, not a
  visible email address, and that it decrypts back correctly.
- Deployed the same way as the TLS fix: pushed to a branch, confirmed the
  preview deployment builds and `/api/health` stays green (nothing imports
  cleanly-but-breaks-at-runtime), then merged. `PII_ENCRYPTION_KEY` is set on
  Vercel; the migration itself is a `COMMENT ON` and has no functional effect
  even if it's never applied to the live database.

## Findings summary

| Source | Before | After | Real fixes |
|---|---|---|---|
| Semgrep (157 rules) | 1 | 0 | TLS certificate verification added for Postgres connections |
| Dynamic (manual, targeted) | — | — | Local dev RLS-bypass (owner-role connection) fixed in `local-db.sh` + README |

Not claimed as fixed: the production RLS gap documented in CLAUDE.md
(`neondb_owner` owning tables + `BYPASSRLS`). That fix is a role change on
the Neon side (`create role inbound_app ...`) that this pass didn't have
credentials to make — it's called out here, not silently left out.

## What this pass does not cover

No fuzzing beyond the manual injection attempts above, no dependency/SCA
scan, no rate-limiting or abuse-resistance testing (`reviews/submit` has
none), and no authenticated end-to-end testing through real Firebase tokens
(Firebase is unconfigured in this environment, so authenticated-flow testing
happened at the SQL/RLS layer directly rather than through the HTTP API with
real tokens). Those are the honest edges of this pass, not gaps papered over.
