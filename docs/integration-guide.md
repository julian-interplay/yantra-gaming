# Integration Guide

A 30-minute path from zero to a working Yantra Gaming session. This guide assumes you
are an operator backend engineer who needs to launch the Ketapola dice game inside an
existing casino front-end.

The integration has four moving parts:

1. Your backend calls `POST /v1/session` on the RGS to mint a launch URL.
2. Your front-end loads that URL in an iframe (or redirects to it).
3. The RGS calls your wallet callback API (`/wallet/balance`, `/wallet/bet`, `/wallet/win`, `/wallet/rollback`) whenever money moves.
4. Every request in both directions is HMAC-signed; every money-moving call is idempotent.

If any of that is unfamiliar, read [wallet-api.md](./wallet-api.md) and
[security.md](./security.md) alongside this guide.

---

## Prerequisites

Before you start, you need four pieces of information from the Yantra onboarding team:

| Item | Purpose | Where it goes |
| --- | --- | --- |
| `operatorId` (UUID) | Opaque public tenant identifier | In every request body |
| `apiKeyId` (kid) | Public key id for your inbound signing credential | In the `X-Yantra-Key-Id` header on requests you send to the RGS |
| `apiSecret` | HMAC-SHA256 secret, ~64 random bytes | Never leaves your backend. Used to sign outbound requests to the RGS |
| `walletSignatureSecret` | HMAC-SHA256 secret for the reverse direction | Used to verify signatures on wallet callbacks the RGS sends to you |

You also need to tell us:

- Your `walletCallbackUrl` base (e.g. `https://casino.example.com/wallet`). The RGS
  will POST `/balance`, `/bet`, `/win`, `/rollback` under this base.
- Your default currency (ISO 4217 string like `LKR`, `USD`, or a crypto symbol).
- Optional: IP allow-list for your production egress.

Two sets of credentials exist because signing is symmetric in both directions, your
key signs what you send, ours signs what we send. Each is rotated independently via
`notBefore` / `notAfter` / `revokedAt` on the credential row.

---

## Step 1: Install the SDK

The SDK wraps signing, idempotency, BigInt money conversion, and the session-create
call in a typed client. The shape below matches the wire contract in
`packages/wallet-spec/src/index.ts`; if you prefer not to take a dependency you can
drop down to raw HTTP (see the `curl` example in §2).

```bash
bun add @yantra/operator-sdk
# or
npm install @yantra/operator-sdk
```

Configure it once at boot:

```ts
// src/yantra.ts
import { YantraClient } from '@yantra/operator-sdk';

export const yantra = new YantraClient({
  baseUrl:   process.env.YANTRA_BASE_URL!,   // e.g. https://rgs.yantra.example
  operatorId: process.env.YANTRA_OPERATOR_ID!,
  kid:        process.env.YANTRA_KID!,
  secret:     process.env.YANTRA_API_SECRET!,
  walletSecret: process.env.YANTRA_WALLET_SECRET!,
  timeoutMs: 5000,
});
```

All four secrets are read from environment variables. Never check them into source
control. See [security.md](./security.md) for rotation and storage rules.

---

## Step 2: Create a session

When a player clicks "Play Yantra" in your lobby, your backend mints a session.

### With the SDK

```ts
import { randomUUID } from 'node:crypto';
import { yantra } from './yantra.js';

export async function launchKetapolaDice(playerId: string) {
  const session = await yantra.createSession({
    requestUuid: randomUUID(),
    operatorId:  process.env.YANTRA_OPERATOR_ID!,
    playerRef:   playerId,                  // opaque; we never resolve it
    gameCode:    'ketapola-dice',
    currency:    'LKR',
    lang:        'si',
    jurisdiction: 'LK',
    mode:        'real',
    returnUrl:   'https://casino.example.com/lobby',
    sessionTtlSeconds: 14_400,              // optional; defaults to 4 hours
  });

  return {
    iframeSrc:    session.launchUrl,
    sessionId:    session.sessionId,
    seedCommit:   session.serverSeedHash,  // show this to the player for provably-fair
    expiresAt:    session.expiresAt,
  };
}
```

### Raw HTTP equivalent

If you are not using the SDK, here is the same call with `curl`. Note the canonical
signing string: `METHOD\nPATH\nTIMESTAMP\nSHA256(BODY_AS_HEX)`.

```bash
TS=$(date +%s)
BODY='{"requestUuid":"3f7f6c26-5c07-4a8e-9f05-9f4c9a2e3a90","operatorId":"op_abc","playerRef":"player-42","gameCode":"ketapola-dice","currency":"LKR","lang":"si","jurisdiction":"LK","mode":"real","returnUrl":"https://casino.example.com/lobby"}'
BODY_HASH=$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANONICAL=$(printf 'POST\n/v1/session\n%s\n%s' "$TS" "$BODY_HASH")
SIG=$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$YANTRA_API_SECRET" -binary | base64)

curl -sS -X POST https://rgs.yantra.example/v1/session \
  -H "content-type: application/json" \
  -H "x-yantra-key-id: $YANTRA_KID" \
  -H "x-yantra-timestamp: $TS" \
  -H "x-yantra-signature: $SIG" \
  -d "$BODY"
```

Response:

```json
{
  "sessionId": "5bb8b2e0-2b36-4a90-9a17-9a57b8a6c1e2",
  "sessionToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "launchUrl": "https://game.yantra.example/?token=eyJ...",
  "expiresAt": "2026-04-23T15:02:00Z",
  "serverSeedHash": "f1d9...a2c0"
}
```

Key points:

- `requestUuid` is your idempotency key. Retrying the same call returns the same session.
- `playerRef` is an opaque string you choose. The RGS never decodes it. A hash of your
  internal user id is fine. Do not send a raw email or phone number.
- `clientSeed` is optional. If omitted, the RGS generates one. The value is bound to
  the session and used to derive round outcomes (see [provably-fair.md](./provably-fair.md)).
- `sessionTtlSeconds` is optional. It controls the launch credential lifetime only;
  the RGS returns the authoritative `expiresAt` after applying server-side caps
  of 5 minutes minimum and 8 hours maximum. Keep responsible-gaming duration
  caps in `rgLimits.sessionTimeSeconds`.
- `serverSeedHash` is the commit half of the provably-fair scheme. Surface it to the
  player, they can verify every round after the fact.

---

## Step 3: Implement the wallet callback API

The RGS calls four endpoints on your server during play. You implement them. They
must all be HTTPS, HMAC-verified, and idempotent on `requestUuid`.

Minimum-viable Express skeleton:

```ts
// src/wallet-api.ts
import express, { type Request, type Response } from 'express';
import crypto from 'node:crypto';
import {
  RsStatus,
  SIGNATURE_HEADER,
  KEY_ID_HEADER,
  TIMESTAMP_HEADER,
  type BetRequestWire,
  type WalletResponseWire,
} from '@yantra/wallet-spec';

const WALLET_SECRET = process.env.YANTRA_WALLET_SECRET!;
const SIGNATURE_WINDOW_SECONDS = 30;

const router = express.Router();

// Preserve the raw body, JSON re-serialisation changes the bytes we need to hash.
router.use(express.raw({ type: 'application/json' }));

function verifySignature(req: Request): boolean {
  const kid = req.header(KEY_ID_HEADER);
  const ts  = req.header(TIMESTAMP_HEADER);
  const sig = req.header(SIGNATURE_HEADER);
  if (!kid || !ts || !sig) return false;

  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - tsNum) > SIGNATURE_WINDOW_SECONDS) return false;

  const bodyHash = crypto.createHash('sha256').update(req.body as Buffer).digest('hex');
  const canonical = `POST\n${req.originalUrl.split('?')[0]}\n${ts}\n${bodyHash}`;
  const expected  = crypto.createHmac('sha256', WALLET_SECRET).update(canonical).digest('base64');

  const a = Buffer.from(expected, 'base64');
  const b = Buffer.from(sig,      'base64');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseBody<T>(req: Request): T {
  return JSON.parse((req.body as Buffer).toString('utf8')) as T;
}

router.post('/wallet/bet', async (req, res) => {
  if (!verifySignature(req)) {
    return res.status(401).json({ status: RsStatus.INVALID_SIGNATURE, requestUuid: '' });
  }
  const body = parseBody<BetRequestWire>(req);

  // requestUuid-level idempotency: if you have already processed this exact HTTP
  // request, return the cached response verbatim.
  const cached = await idempotencyCache.get(body.operatorId, 'bet', body.requestUuid);
  if (cached) return res.json(cached);

  // transactionUuid-level idempotency: if you have already booked this ledger entry,
  // return the balance snapshot from that entry, status RS_OK or DUPLICATE_TRANSACTION.
  const existing = await ledger.findByTx(body.transactionUuid);
  if (existing) {
    const response: WalletResponseWire = {
      status: RsStatus.OK,
      requestUuid: body.requestUuid,
      balanceMicro: existing.balanceAfter.toString(),
      currency: body.currency,
    };
    await idempotencyCache.put(body.operatorId, 'bet', body.requestUuid, response);
    return res.json(response);
  }

  const amount = BigInt(body.amountMicro); // wire format is stringified integer micro-units
  const result = await wallet.debit(body.playerRef, body.currency, amount, {
    transactionUuid: body.transactionUuid,
    roundId: body.roundId,
  });

  const response: WalletResponseWire =
    result.ok
      ? { status: RsStatus.OK,                requestUuid: body.requestUuid, balanceMicro: result.balance.toString(), currency: body.currency }
      : { status: RsStatus.NOT_ENOUGH_MONEY,  requestUuid: body.requestUuid, balanceMicro: result.balance.toString(), currency: body.currency };

  await idempotencyCache.put(body.operatorId, 'bet', body.requestUuid, response);
  res.json(response);
});

// /wallet/balance, /wallet/win, /wallet/rollback follow the same shape.
// See wallet-api.md for every endpoint.

export default router;
```

A complete reference implementation lives in `apps/mock-operator/src/wallet/router.ts`.
Use it to smoke-test your signature verification.

Key rules, in order of how often people get them wrong:

1. **Always preserve the raw body bytes** before HMAC verification. Express's default
   JSON parser re-serialises the object, which changes the hash.
2. **Constant-time compare** the signature. Do not use `===`.
3. **Enforce the ±30s timestamp window** to block replay.
4. **Dedupe on `requestUuid` first, `transactionUuid` second.** The first blocks
   double-HTTP; the second blocks double-ledger.
5. **Return `RS_ERROR_DUPLICATE_TRANSACTION` only** if the same `transactionUuid` is
   reused with a *different* `requestUuid`. If both match, return the original response.

---

## Step 4: Redirect the player

You now have a `launchUrl`. Two common ways to load it:

### Iframe (recommended)

```html
<iframe
  src="https://game.yantra.example/?token=eyJ..."
  allow="autoplay; fullscreen"
  sandbox="allow-scripts allow-same-origin"
  style="width: 100%; height: 720px; border: 0;">
</iframe>
```

Set a Content-Security-Policy `frame-src` entry listing our game domain. See
[security.md](./security.md) for the recommended CSP header.

### Full-page redirect

```ts
res.redirect(302, session.launchUrl);
```

The game will redirect the player back to `returnUrl` on exit.

The session token in the `launchUrl` query parameter is a short-lived HS256 JWT
(≤ 60 minutes, one player, one currency). Do not cache it. Do not share it across tabs.
The RGS rejects reuse after expiry.

---

## Step 5: Handle webhooks

The MVP integration does not require any webhooks. The RGS is stateless toward your
system, all necessary state flows through the wallet callback API.

On the v1.1 roadmap (see [B2B_ROADMAP.md §17](../B2B_ROADMAP.md#17-versioning-and-delivery)):

- `round.settled` push notifications for near-real-time reconciliation.
- `session.terminated` alerts for responsible-gambling hooks.

Until then, pull `GET /v1/rounds?operatorId=…&from=…&to=…` nightly to reconcile.

---

## Step 6: Verify your integration

The repo ships a fake operator for end-to-end testing. It is a full wallet
implementation plus a lobby page with seeded players.

Run everything locally:

```bash
bun install
bun run db:migrate
bun run dev          # starts all four apps
```

Service ports:

| App | Port | URL | Role |
| --- | --- | --- | --- |
| rgs-server | 4500 | http://localhost:4500 | core backend (SLA-bound wire contract) |
| mock-operator lobby | 3102 | http://localhost:3102 | dev/test fake casino |
| mock-operator wallet | 4300 | http://localhost:4300/wallet | dev/test fake wallet |
| game-client iframe | 3100 | http://localhost:3100 | reference PixiJS player UI |
| operator-portal | 3101 | http://localhost:3101 | reference React admin UI |
| provider-admin | 3103 | http://localhost:3103 | Yantra-staff platform UI |

> The reference frontends (`game-client`, `operator-portal`, `provider-admin`)
> ship in this repo for end-to-end development and as a starting point for
> operators, see
> [B2B_ROADMAP.md §1 "Product surfaces"](../B2B_ROADMAP.md#1-what-this-is).
> Operators who prefer their own UI can build directly against the
> documented admin API; the end-to-end flow via socket + HTTP can be
> driven headlessly by `tests/e2e/mock-operator.spec.ts`
> (`E2E=1 bun test tests/e2e`).

Open http://localhost:3102, the mock lobby lists seeded players and their balances.
Click a player to launch a session. You should see:

1. The lobby POSTs to its own `/lobby/launch`, which signs and POSTs `/v1/session` on the RGS.
2. The RGS returns a `launchUrl` and the lobby redirects the browser into the game iframe.
3. When you place a bet in the iframe, the RGS calls `POST /wallet/bet` on the mock
   operator (port 4300). Check `GET http://localhost:4300/wallet/debug/balances` to see
   the balance movement.
4. After the round rolls, if you win, the RGS calls `POST /wallet/win`.

To test signature verification against your own implementation, point the RGS at your
wallet URL by updating the `walletCallbackUrl` column on the `operators` table via the
operator portal.

---

## Common pitfalls

**Symptom**: `RS_ERROR_INVALID_SIGNATURE` on every request.
**Cause**: You are signing `/balance` but the operator receives `/wallet/balance` (or
vice versa). The signed path must be the exact path the receiving server sees,
including any prefix.

**Symptom**: `RS_ERROR_INVALID_SIGNATURE` but only intermittently.
**Cause**: Express reserialised the JSON body before you computed the hash. Switch to
`express.raw({ type: 'application/json' })` for wallet routes.

**Symptom**: Double debit.
**Cause**: You ignored `requestUuid` and only deduped on `transactionUuid`. A retried
HTTP call with the same `transactionUuid` needs to return the *original response*, not
a fresh `DUPLICATE_TRANSACTION`.

**Symptom**: Stale balances in the game.
**Cause**: Your `/wallet/balance` endpoint is slow. The RGS has a 5s timeout. Add a
read-through cache and target p99 < 200 ms.

**Symptom**: Session refuses to launch with `operator_mismatch`.
**Cause**: The `operatorId` in your request body does not equal the operator that
owns the `kid` you signed with. The RGS cross-checks these.

**Symptom**: `RS_ERROR_WRONG_TYPES` on `amountMicro`.
**Cause**: You sent `"100.00"` (a decimal major-unit string). Wire format is integer
micro-units as a string: for 1,000.00 LKR, send `"100000000"`. Multiply by 100,000
(the `MICRO_PER_UNIT` constant) and call `.toString()`.

---

## Where to next

- [wallet-api.md](./wallet-api.md), complete reference for the four wallet endpoints.
- [error-codes.md](./error-codes.md), every `RS_*` status and how to handle it.
- [provably-fair.md](./provably-fair.md), verifying round outcomes offline.
- [security.md](./security.md), signing spec, threat model, SLOs.
- Per-game PAR sheet, the game math (weights, RTP, volatility). Each plugin ships its own under `games/<code>/docs/par-sheet.md`; for Ketapola Dice see [games/ketapola-dice/docs/par-sheet.md](../games/ketapola-dice/docs/par-sheet.md).
- [observability.md](./observability.md), metrics, traces, dashboards.
