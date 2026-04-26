# Security Model and SLOs

This document describes the threats Yantra Gaming defends against, the controls it
uses, and the service-level objectives those controls must meet. Cross-reference
with [wallet-api.md](./wallet-api.md) for the signing spec and
[error-codes.md](./error-codes.md) for the behavioural contract.

---

## Threat model

The RGS sits between an untrusted player browser and a semi-trusted operator backend.
Five threat actors and what they try to do:

| Actor | What they want | Controls |
| --- | --- | --- |
| **Unauthenticated external requester** | Call the RGS API without credentials | All public endpoints except `/healthz` / `/readyz` / `/metrics` require a valid operator-signed request. All `/v1/*` endpoints run through `operatorAuth` middleware |
| **Man-in-the-middle on the network path** | Read or tamper with traffic between operator and RGS | TLS 1.3 minimum, HSTS, no certificate pinning (see notes). Body hash is part of the HMAC canonical string, so tampering breaks the signature |
| **Replay attacker** | Re-send a captured valid request to double-spend or trigger a side-effect | ±30 s timestamp window in the HMAC canonical string; 24 h idempotency cache keyed on `(operatorId, endpoint, requestUuid)` |
| **Malicious operator** | Produce fake rounds, claim wins that did not happen, forge proofs | Per-tenant isolation on every row; commit-reveal RNG (operator cannot forge outcomes without also forging the pre-committed `serverSeedHash`); every round signed by the RGS |
| **Compromised operator** (credential leak) | Use leaked `apiSecret` to impersonate the operator | Credentials have `notBefore` / `notAfter` / `revokedAt` on `OperatorCredential`; envelope encryption at rest (AES-GCM); per-operator IP allow-list; rotate-on-incident workflow in the operator portal |

Not in scope for the RGS to defend against: the operator's own KYC, AML, deposit,
or withdrawal flows. Those are operator responsibilities.

---

## Transport

### TLS 1.3

Ingress terminates TLS 1.3 only. TLS 1.2 is acceptable as a downstream-origin
fallback for legacy operators but disabled by default. No TLS 1.0 / 1.1 / SSL under
any circumstance. Preferred cipher suites:

- `TLS_AES_256_GCM_SHA384`
- `TLS_CHACHA20_POLY1305_SHA256`
- `TLS_AES_128_GCM_SHA256`

### HSTS

`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` on every
response from the RGS and game-client domains. Preload submission is part of the
production deployment checklist.

### Certificate pinning

HPKP (HTTP Public Key Pinning) is not recommended in 2026 and is not used. It has a
well-documented operational-risk profile (wedged pins brick the service) and has been
deprecated by browsers. Equivalent protection is achieved via CAA records on the DNS
zone and Certificate Transparency monitoring via tools such as CertStream.

---

## Request signing

Symmetric HMAC-SHA256 on every request in both directions. See
[wallet-api.md](./wallet-api.md#authentication) for the full canonical-string spec.
Summary:

```
canonical = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + SHA256_HEX(BODY)
signature = base64( HMAC_SHA256(secret, canonical) )
```

Headers:

```
X-Yantra-Key-Id:    <kid>
X-Yantra-Timestamp: <unix-seconds>
X-Yantra-Signature: <base64>
```

### Constant-time comparison

Signature verification uses `crypto.timingSafeEqual` in Node. A naive `===` compare
leaks byte-wise equality through wall-clock timing differences, allowing an attacker
to reconstruct a valid signature byte by byte via repeated probing. The
implementation lives in `apps/rgs-server/src/utils/signing.ts`:

```ts
const a = Buffer.from(expected, 'base64');
const b = Buffer.from(signature, 'base64');
if (a.length !== b.length) return false;
return crypto.timingSafeEqual(a, b);
```

Any operator SDK consuming this spec must do the same.

### ±30 second clock window

The receiver rejects any request with `|now - timestamp| > 30 s`. A wider window
tolerates more clock skew but extends the replay-attack grace period. NTP your
servers and stay within ±5 s of real time.

The window is configured via `SIGNATURE_WINDOW_SECONDS` (default 30) in
`apps/rgs-server/src/config.ts`.

### Why not asymmetric

Symmetric HMAC is simpler to implement and has no operational downsides for the
operator-to-RGS path. For the reverse direction (player launch) the roadmap plans
RS256 + JWKS to remove the shared-secret burden from operators, see
[Forward path](#forward-path-asymmetric-launch-requests) below.

---

## Idempotency cache

The `InboundIdempotency` table caches the response for every inbound request for 24
hours, keyed on `(operatorId, requestUuid, endpoint)`. Rows expire via a background
cleaner.

Purpose:

1. **Replay protection beyond the 30 s window.** Even if an attacker got inside the
   window, re-sending the same signed request returns the cached response instead of
   re-effecting.
2. **Safe retries for operators.** An operator retrying a session-create after a
   network blip gets the original response, not a second session.

Schema excerpt:

```prisma
model InboundIdempotency {
  operatorId   String
  requestUuid  String
  endpoint     String
  responseBody Json
  httpStatus   Int
  createdAt    DateTime @default(now())
  expiresAt    DateTime

  @@id([operatorId, requestUuid, endpoint])
}
```

The cache is consulted by `middleware/idempotency.ts` before the handler runs.

---

## Secret management

Every operator credential secret is stored encrypted with AES-256-GCM using a
master key that never leaves the RGS process memory. `OperatorCredential.cipherBlob`
is the ciphertext.

### Envelope encryption

```
dataKey    = random 32 bytes per credential
ciphertext = AES-256-GCM(dataKey, plaintext)
wrappedKey = AES-256-GCM(masterKey, dataKey)
cipherBlob = concat(iv, wrappedKey, iv2, ciphertext, tag)
```

In production the master key is sourced from a KMS (AWS KMS, GCP KMS, or HashiCorp
Vault Transit). In this repo, development uses `SECRETS_MASTER_KEY_B64` in `.env`,
validated at boot as 32 base64-decoded bytes (`apps/rgs-server/src/config.ts`).

**KMS vs HSM, what belongs where.** Two distinct key classes, two distinct stores:

| Key | Role | Production store | Rotation |
| --- | --- | --- | --- |
| **Data-encryption master key** | Wraps per-credential AES-256-GCM data keys (envelope encryption above). | **KMS** (AWS KMS / GCP KMS / Vault Transit) is sufficient, FIPS 140-2 L2 baseline. | Annual, key-lineage stored in `OperatorCredential.cipherBlob` header so older rows remain decryptable. |
| **Outbound HMAC signing secrets** | Per-operator, signed on every outbound `/wallet/*` call. | KMS-wrapped at rest; hot copy in RGS process memory (short-lived). | 90-day rotation cadence (NIST SP 800-57 Part 1 r5 §5.3, originator-usage period for symmetric authentication). `OperatorCredential.notBefore / notAfter / revokedAt` implements the overlap window. |
| **Launch-JWT signing keys (RS256, v1.1)** | Signs the operator → RGS session-launch JWT. Verified by JWKS. | **FIPS 140-2 L3 HSM** (AWS CloudHSM / Azure Dedicated HSM / Entrust nShield) when the operator is regulated in **Germany (GGL), Malta (MGA), Brazil (SPA)**: those jurisdictions expect HSM-resident signing keys in the SOC 2 / ISO 27001 evidence pack. KMS-resident is accepted elsewhere. | 90-day; JWKS `kid` rotation, the JWKS endpoint serves both current and previous keys during the overlap window. |

For operators deploying into regulated markets, the runbook
(`docs/runbook.md`) documents the CloudHSM / Dedicated HSM provisioning flow
and the KMS-to-HSM migration checklist. For operators outside those markets,
KMS-only is compliant and is the default.

### Rotation

`OperatorCredential` carries three fields:

- `notBefore`: credential is valid from this timestamp.
- `notAfter`: credential stops being accepted on reads after this timestamp.
- `revokedAt`: hard kill, takes effect immediately on any read.

Rotation is an overlap-then-cut pattern:

1. Mint a new credential with `notBefore = now`.
2. Share with the operator out of band.
3. Operator switches their outbound signing to the new `kid`.
4. After confirmation, set `notAfter = now + 24h` on the old credential.
5. Revoke (set `revokedAt`) once traffic has fully shifted.

The operator portal surfaces this as "Rotate key" → "Retire old key" two-step flow.

### Disposal

Revoked credentials are never deleted from the table, the ciphertext is zeroed but
the row persists for audit trail. `OperatorConfigAuditLog` retains the full rotation
history.

---

## Rate limiting

Two-tier token-bucket limiters per operator, implemented in
`middleware/operator-rate-limit.ts`:

### Tier 1: session creation

Burst 10, steady 5 per second per `operatorId`. This is the only inbound money-path
endpoint that creates new resources (sessions). Bursting above tier 1 returns
`HTTP 429` with `Retry-After`.

### Tier 2: read endpoints

`GET /v1/rounds`, `GET /v1/rounds/:id`, `GET /v1/reports/*`. Burst 60, steady 20 per
second per `operatorId`. These are reconciliation reads; they are not in the hot
path.

### Tier 3: outbound

Not a rate limit per se, a circuit breaker on the RGS → operator call path. See
next section.

Rate-limit decisions are made per-operator, not global, so a noisy tenant cannot
starve a quiet one. IP-based limits are layered at the reverse proxy (Cloudflare,
Nginx, etc.) and not in the application.

---

## Circuit breaker on outbound wallet calls

An operator whose wallet is returning errors harms both us and their players. The
outbound path wraps every call with a circuit breaker:

- **Open**: after 5 consecutive non-OK responses on the same `(operatorId, endpoint)`
  pair, the circuit opens. New calls fail immediately with `RS_ERROR_TIMEOUT` and
  enter the retry queue without hitting the operator.
- **Half-open**: 30 seconds after opening, one probe call is allowed through. If it
  succeeds, the circuit closes. If it fails, wait another 30 s and retry.
- **Closed**: normal operation.

Circuit state is per `(operatorId, endpoint)` pair so a `/wallet/win` outage does not
block `/wallet/bet`. Metrics exposed at `circuit_state{operator, endpoint}`; see
[observability.md](./observability.md).

---

## Session token security

Player session tokens are short-lived HS256 JWTs:

```json
{
  "sub":          "<opaque-playerRef>",
  "operatorId":   "<tenant>",
  "sessionId":    "<uuid>",
  "currency":     "LKR",
  "jurisdiction": "LK",
  "lang":         "si",
  "mode":         "real",
  "rgLimits":     { "dailyLossMicro": "…", "dailyWagerMicro": "…", "sessionTimeSeconds": 3600 },
  "iat":          1745400000,
  "exp":          1745414400
}
```

Rules:

- Signed with `SESSION_JWT_SECRET`. Separate from the operator signing secret.
- Default lifetime is 4 hours. Operators may request `sessionTtlSeconds` at
  session creation; the RGS applies server-side min/max caps and enforces the
  resulting `exp` claim on every socket handshake and every REST call scoped to
  a session.
- Single player, single game, single currency per token.
- The token is conveyed via the `launchUrl` query string and placed into
  `socket.handshake.auth.token` for the WebSocket leg. Not stored in `localStorage`;
  held only in memory on the game client.
- On `RS_ERROR_USER_DISABLED` or `RS_ERROR_TOKEN_EXPIRED` the token is invalidated
  RGS-side and the socket is force-closed.

### Forward path: asymmetric launch requests

For `POST /v1/session` specifically, the medium-term direction is RS256 (RSA-PSS) or
ES256 (ECDSA) over a JWKS URL published by the operator. The RGS fetches and caches
the operator's public key via JWKS and verifies signed launch requests with it. This
removes the shared-secret risk on the highest-value endpoint.

An algorithm allowlist is enforced per-credential, a `OperatorCredential` row
declares `allowedAlgs: ["RS256"]` and the RGS refuses to validate with anything else.
This blocks the classic `alg: "none"` and RS256-to-HS256 confusion CVEs that
continued to surface throughout 2024-2026.

---

## IP allow-list per operator

`Operator.ipAllowList` is a `String[]` column. When non-empty, every inbound request
from that operator is additionally checked against the caller IP (extracted from
`X-Forwarded-For` honouring the reverse-proxy trust configuration). Mismatches return
`HTTP 403` before the signature is even verified.

This is belt-and-braces against credential theft, even with a valid signed request,
the attacker must also be coming from an approved IP.

For operators that cannot pin their egress IPs (they run from dynamic cloud
infrastructure), the allow-list is left empty; signature is the sole control.

---

## Content Security Policy on the game iframe

The game-client is served with a strict CSP header:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  connect-src 'self' wss://rgs.yantra.example;
  frame-ancestors https://*.operator-domain.example;
  base-uri 'self';
  form-action 'self';
```

`frame-ancestors` is the critical bit, it restricts which parent pages can iframe
the game. The allow-list is per-operator, set via `Operator.frameAncestors` (or the
equivalent column). Any attempt to iframe from a domain not on the list returns a
browser-enforced block.

The RGS also sets `X-Frame-Options: SAMEORIGIN` on non-game pages (the operator
portal) to prevent clickjacking.

### Per-operator `frame-ancestors` bootstrap

When a new operator is onboarded, or an existing operator launches a new
brand domain, the `frame-ancestors` allow-list must be updated before the
iframe will render anywhere new. The flow:

1. **Operator requests a domain addition** via the operator-portal
   `Settings → Branding` page (written to `Operator.frameAncestors` as a
   pending row; emits an `OperatorConfigAuditLog` entry).
2. **Yantra staff review** in `provider-admin`: sanity-check the
   domain is controlled by the operator (DNS TXT challenge on
   `_yantra-verify.<domain>` carrying `Operator.verificationToken` is the
   default verification mechanism, same shape as ACME DNS-01).
3. **Approval** writes the domain into `Operator.frameAncestors` with
   `approvedAt` + `approvedBy`.
4. **CSP rebuild**: the next `rgs-server` response to any
   `routes/session.ts`-minted launch URL embeds the updated `frame-ancestors`
   allowlist. There is no reload or restart, the header is computed
   per-response from `Operator.frameAncestors`.
5. **Effective TTL**: the CSP header itself is per-response. The
   `Operator.frameAncestors` row is read through a 60-second in-memory cache
   (`EngineRegistry.operatorCache`); a new domain becomes effective within
   one minute of approval.

Domain removal is symmetric, `revokedAt` is set and the CSP stops including
the domain within the cache TTL. Existing iframes already loaded against the
old CSP will continue to render until the page is reloaded (browser caches
the enforcing CSP with the document).

For staged rollouts (brand A → brand B migration), operators typically list
both domains in `frame-ancestors` for the overlap window and cut the old one
once traffic has shifted.

---

## Published SLOs

These are the published service-level objectives. They are committed to in operator
contracts and enforced by CI load tests (`tests/load/k6-bet-flow.js`) and by
multi-window burn-rate alerts in production ([observability.md](./observability.md#slo-burn-rate-alerts)).

| Objective | Target | Window | Source metric |
| --- | --- | --- | --- |
| `POST /wallet/bet` outbound latency | p99 < 300 ms | 30 days | `wallet_call_latency_ms{endpoint="bet"}` |
| `POST /wallet/bet` outbound latency | p99.9 < 800 ms | 30 days | `wallet_call_latency_ms{endpoint="bet"}` |
| Bet → settlement end-to-end | p99 < 1.5 s | 30 days | `bet_to_settlement_ms` |
| `POST /v1/session` inbound latency | p99 < 150 ms | 30 days | HTTP server histogram |
| `/wallet/bet` error budget | < 0.1% failure rate | 30 days | `wallet_call_errors_total{endpoint="bet"} / wallet_call_total{endpoint="bet"}` |
| Round-state-machine uptime | > 99.9% | 30 days | `up{job="rgs-server"}` |

Burn-rate alerts (multi-window, multi-burn-rate per the Google SRE book) fire
before the budget is exhausted. See
[observability.md](./observability.md#slo-burn-rate-alerts).

---

## Responsible disclosure

Security issues should be reported via the channel in `SECURITY.md` at the repo
root. The policy in short:

- Email `security@yantra.example` with PGP-encrypted payload (public key in
  `SECURITY.md`).
- 90-day coordinated disclosure window.
- Safe harbour for good-faith research against the staging environment.
- Out of scope: anything targeting an operator's production wallet or any player
  account.

For integration-time questions (not vulnerabilities), use the normal support
channels.

---

## Cloudflare Turnstile (optional bot challenge on /v1/session)

`POST /v1/session` supports an optional Cloudflare Turnstile verification
step, enabled by setting `TURNSTILE_SECRET_KEY` in the RGS environment. When
set, every session-create request must present a Turnstile token in either
the `cfTurnstileToken` body field or the `cf-turnstile-response` header;
the RGS verifies it via Cloudflare's `siteverify` endpoint before minting
the session.

Flow:

1. Operator renders a Turnstile widget on the launch page (client-side).
2. Player solves the challenge; Cloudflare returns a token to the browser.
3. Operator's backend relays that token in the `POST /v1/session` body.
4. RGS verifies via Cloudflare; on failure, returns `401 turnstile_verification_failed`.
5. On success, the session is minted and the token is discarded (one-shot use
   is enforced by Cloudflare, not by the RGS).

Operational notes:

- Leave `TURNSTILE_SECRET_KEY` unset in dev and staging environments ,
  the middleware is a pass-through when the secret is absent. Set it in
  production once the operator's launch page renders a Turnstile widget
  and relays the token.
- Default behaviour on Cloudflare being unreachable is **fail-open** (log,
  increment `turnstile_verifications_total{status="error"}`, allow through).
  Set `failClosedOnError: true` when wiring the middleware if you prefer to
  block on network failure.
- The outcome distribution is visible as the `turnstile_verifications_total`
  Prometheus counter, labelled `status=ok|fail|skip|error`. Alert if
  `rate(turnstile_verifications_total{status="fail"}[5m])` spikes ,
  indicates either a bot wave or a broken operator integration.
- Reference: `apps/rgs-server/src/middleware/turnstile.ts`.

---

## See also

- [wallet-api.md](./wallet-api.md), the signing spec applied to each endpoint.
- [error-codes.md](./error-codes.md), `INVALID_SIGNATURE`, `INVALID_PARTNER`,
  `INVALID_TOKEN` handling.
- [observability.md](./observability.md), the metrics and alerts that enforce these
  SLOs in practice.
- `apps/rgs-server/src/utils/signing.ts`: signing reference implementation.
- `apps/rgs-server/src/middleware/operator-auth.ts`: verification reference
  implementation.
- `apps/rgs-server/src/middleware/turnstile.ts`: optional Turnstile verifier.
