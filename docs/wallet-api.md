# Wallet Callback API

The canonical specification for the HTTP endpoints the operator implements and
the RGS calls on every money-moving event. All endpoints are POST, JSON, HMAC-SHA256 signed,
and idempotent on `requestUuid`. Types are defined in
`packages/wallet-spec/src/index.ts`; this document must stay in sync with that file.

**Contents**

- [Overview](#overview)
- [Naming convention](#naming-convention)
- [Authentication](#authentication)
- [Idempotency model](#idempotency-model)
- [POST /wallet/balance](#post-walletbalance)
- [POST /wallet/bet](#post-walletbet)
- [POST /wallet/win](#post-walletwin)
- [POST /wallet/award](#post-walletaward)
- [POST /wallet/rollback](#post-walletrollback)
- [Retry and rollback rules](#retry-and-rollback-rules)
- [Error codes](#error-codes)
- [Money format](#money-format)

---

## Overview

The RGS owns the game loop; the operator owns the player wallet. Whenever a player
stakes, wins, or a round must be unwound, the RGS invokes the operator's wallet
callback URL. The operator's response is authoritative: the RGS records the
transaction in its `WalletCall` audit ledger but never mutates a balance locally.

```
Yantra Engine ─────────────── HTTPS ────────────▶ Operator wallet (your service)
             (signed, idempotent, retried)
```

Endpoints under the operator-owned base URL (e.g. `https://casino.example.com/wallet`):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/wallet/balance` | Read player balance, no ledger effect |
| POST | `/wallet/bet`     | Debit stake |
| POST | `/wallet/win`     | Credit payout, referencing a previous bet |
| POST | `/wallet/award`   | Credit a free-to-play prize with no prior bet |
| POST | `/wallet/rollback` | Reverse a previous bet or win |

All four share a common request envelope:

```ts
interface WalletRequestCommon {
  requestUuid: string;  // per-HTTP-request idempotency key (UUID)
  operatorId:  string;  // your tenant id
  playerRef:   string;  // opaque player identifier you supplied at session creation
  currency:    string;  // ISO 4217 or crypto symbol, e.g. "LKR"
  gameCode:    string;  // e.g. "ketapola-dice"
}
```

All four return a common response envelope:

```ts
interface WalletResponseWire {
  status:       'RS_OK' | 'RS_ERROR_*';
  requestUuid:  string;                    // echo of the request
  balanceMicro?: string;                   // stringified integer micro-units
  currency?:    string;
  message?:     string;                    // optional human-readable detail
}
```

Success is indicated exclusively by `status: "RS_OK"` or
`status: "RS_ERROR_DUPLICATE_TRANSACTION"`. HTTP status code is a transport signal,
not a business signal, a 200 response with `RS_ERROR_NOT_ENOUGH_MONEY` means the
operator rejected the bet cleanly.

---

## Naming convention

**Yantra uses `camelCase` on the wire** (`transactionUuid`, `requestUuid`,
`amountMicro`, `operatorId`, `playerRef`). The semantics are the Hub88 seamless
wallet convention (`transaction_uuid`, `request_uuid`, `reference_transaction_uuid`,
per-HTTP + per-money-movement idempotency, `RS_*` status taxonomy), operators
migrating a Hub88-shaped wallet will recognise every field. The rename is cosmetic.

For operators integrating a wallet already built against `snake_case` (Hub88,
Softswiss, Pragmatic), the mapping is 1:1. Two ways to handle it:

- Drop in `@yantra/operator-sdk`'s `snakeToCamelMiddleware()` on the wallet
  callback handler (5 lines). The middleware transforms request bodies on
  the way in and response bodies on the way out.
- Or reach for `toSnakeCase()` / `fromSnakeCase()` directly if you need
  finer control, e.g. nested JSON `meta` blobs you want to leave alone.

Auto-generated Python / PHP / Java / .NET SDKs via `openapi-generator` off
the [OpenAPI 3.1 spec](./openapi.yaml) are planned for v1.1, see
[`B2B_ROADMAP.md` §17 "Planned for v1.1"](../B2B_ROADMAP.md#17-versioning-and-delivery).

The wire algorithm is symmetric HMAC-SHA256 (Stripe / GitHub / Shopify
convention). Operators who require asymmetric signing (RSA-SHA256, the Hub88
wire algorithm) are supported via the planned RS256 + JWKS path, see the
same section.

---

## Authentication

Every request is signed with a shared HMAC-SHA256 secret.

### Headers

```
X-Yantra-Key-Id:    <kid>             public credential id
X-Yantra-Timestamp: <unix-seconds>    integer seconds since epoch
X-Yantra-Signature: <base64-hmac>     see canonical string below
```

Header names are case-insensitive per RFC 7230. The RGS sends them lowercase. Match
against the constants in `@yantra/wallet-spec`:

```ts
export const SIGNATURE_HEADER = 'x-yantra-signature';
export const KEY_ID_HEADER    = 'x-yantra-key-id';
export const TIMESTAMP_HEADER = 'x-yantra-timestamp';
```

### Canonical string

```
METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + SHA256_HEX(BODY)
```

- `METHOD`: uppercase HTTP method, e.g. `POST`.
- `PATH`: the exact absolute request path the receiving server sees, no query string,
  no fragment, no host. For example `/wallet/bet`, not `/bet`, and not
  `/wallet/bet?foo=1`.
- `TIMESTAMP`: the exact string the client sent in `X-Yantra-Timestamp` (do not
  re-format).
- `SHA256_HEX(BODY)`: hex-encoded SHA-256 of the raw request body bytes.

### Signature

```
base64( HMAC_SHA256(secret, canonical) )
```

### Verification steps

1. Reject if any header is missing (401).
2. Parse timestamp as integer. Reject if `|now - timestamp| > 30 seconds` (401,
   blocks replay).
3. Recompute the canonical string using the raw body bytes, not a re-serialised copy.
4. Compute the expected signature with your copy of the shared secret.
5. Compare using a constant-time operation (`crypto.timingSafeEqual` in Node).
6. Only after the signature is verified, parse the JSON body and dispatch.

Reference implementation: `apps/rgs-server/src/utils/signing.ts` +
`apps/rgs-server/src/middleware/operator-auth.ts`.

### Replay window

±30 seconds. This is the default, overridable per operator. The tradeoff: a wider
window tolerates more clock skew; a narrower one tightens replay protection. NTP to
a public pool on your servers and stay within ±5s of real time.

---

## Idempotency model

There are two idempotency keys per money-moving call. They exist for different
reasons and must both be deduped.

| Key | Scope | Prevents |
| --- | --- | --- |
| `requestUuid` | Per-HTTP-request | Double-processing a retried HTTP call (network blip, client timeout) |
| `transactionUuid` | Per-ledger-movement | Two different HTTP requests both booking the same money movement |

### How the RGS uses them

- Every outbound wallet call gets a fresh `requestUuid`. If the call times out and we
  retry, **we reuse the same `requestUuid`** for the retry.
- For `bet`, `win`, `rollback`, the `transactionUuid` is stable across all retries of
  that particular money movement.
- For the `rollback` endpoint, `referenceTransactionUuid` is the `transactionUuid` of
  the bet or win being reversed.

### How the operator must handle them

- **If you see a `requestUuid` you have responded to before**: return the cached response
  byte-for-byte. Do not re-effect.
- **If the `requestUuid` is new but the `transactionUuid` already has a booked ledger
  entry**: do not double-book. Return `status: RS_OK` with the current balance, or
  `status: RS_ERROR_DUPLICATE_TRANSACTION`. The RGS treats both identically.
- **If neither is cached**: process the request normally, then store the response
  under the `(operatorId, endpoint, requestUuid)` key for at least 24 hours.

### Cache TTL

Recommended: 24 hours. The RGS retries pending jobs with exponential backoff for up
to 24 hours before alerting; matching TTL prevents mismatches. The RGS itself uses
24h TTL on its own inbound cache (`InboundIdempotency` table).

---

## POST /wallet/balance

Read the current balance for a player. No ledger effect. The RGS calls this at
session boot and optionally on reconnect.

### Request

```ts
interface BalanceRequestWire {
  requestUuid: string;
  operatorId:  string;
  playerRef:   string;
  currency:    string;
  gameCode:    string;
}
```

### Response

```ts
{
  status:       "RS_OK",
  requestUuid:  "<echo>",
  balanceMicro: "<integer-string>",
  currency:     "LKR"
}
```

### Example: curl

```bash
TS=$(date +%s)
BODY='{"requestUuid":"1ab3...","operatorId":"op_abc","playerRef":"player-42","currency":"LKR","gameCode":"ketapola-dice"}'
BODY_HASH=$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANONICAL=$(printf 'POST\n/wallet/balance\n%s\n%s' "$TS" "$BODY_HASH")
SIG=$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$WALLET_SECRET" -binary | base64)

curl -sS -X POST https://casino.example.com/wallet/balance \
  -H "content-type: application/json" \
  -H "x-yantra-key-id: $KID" \
  -H "x-yantra-timestamp: $TS" \
  -H "x-yantra-signature: $SIG" \
  -d "$BODY"
```

### Example: Node.js via SDK

```ts
import { randomUUID } from 'node:crypto';
import { yantra } from './yantra.js';

const result = await yantra.wallet.balance({
  requestUuid: randomUUID(),
  operatorId:  'op_abc',
  playerRef:   'player-42',
  currency:    'LKR',
  gameCode:    'ketapola-dice',
});
console.log(result.status, result.balanceMicro); // "RS_OK" "50000000000"
```

### Notes

- Operators with slow balance lookups (network to another service) should cache. The
  RGS calls `/balance` on session start and as a tie-breaker during reconciliation.
- Returning `status: RS_ERROR_USER_DISABLED` here terminates the session.
- This endpoint does not carry a `transactionUuid`.

---

## POST /wallet/bet

Debit a player's wallet for a stake. The RGS calls this immediately when a player
clicks "place bet". The game holds the bet in a pending register until the round
resolves.

### Request

```ts
interface BetRequestWire {
  requestUuid:     string;
  transactionUuid: string;   // stable across retries of this bet
  operatorId:      string;
  playerRef:       string;
  currency:        string;
  gameCode:        string;
  amountMicro:     string;   // integer micro-units as string, e.g. "100000000" = 1000.00 LKR
  roundId:         string;
  isFree?:         boolean;  // promotional/free-bet flag; still round through ledger
  meta?:           Record<string, unknown>;
}
```

### Response

Success:

```json
{
  "status": "RS_OK",
  "requestUuid": "<echo>",
  "balanceMicro": "49900000000",
  "currency": "LKR"
}
```

Clean rejection (do not rollback, do not retry):

```json
{
  "status": "RS_ERROR_NOT_ENOUGH_MONEY",
  "requestUuid": "<echo>",
  "balanceMicro": "1000000",
  "currency": "LKR"
}
```

Operator already processed this transaction:

```json
{
  "status": "RS_ERROR_DUPLICATE_TRANSACTION",
  "requestUuid": "<echo>",
  "balanceMicro": "49900000000",
  "currency": "LKR"
}
```

### Example: curl

```bash
TS=$(date +%s)
BODY='{"requestUuid":"2bc4...","transactionUuid":"bet_9f3a...","operatorId":"op_abc","playerRef":"player-42","currency":"LKR","gameCode":"ketapola-dice","amountMicro":"100000000","roundId":"rnd_8a2c..."}'
BODY_HASH=$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANONICAL=$(printf 'POST\n/wallet/bet\n%s\n%s' "$TS" "$BODY_HASH")
SIG=$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$WALLET_SECRET" -binary | base64)

curl -sS -X POST https://casino.example.com/wallet/bet \
  -H "content-type: application/json" \
  -H "x-yantra-key-id: $KID" \
  -H "x-yantra-timestamp: $TS" \
  -H "x-yantra-signature: $SIG" \
  -d "$BODY"
```

### Example: Node.js via SDK

```ts
import { randomUUID } from 'node:crypto';
import { toMicro } from '@yantra/wallet-spec';

const result = await yantra.wallet.bet({
  requestUuid:     randomUUID(),
  transactionUuid: randomUUID(),
  operatorId:      'op_abc',
  playerRef:       'player-42',
  currency:        'LKR',
  gameCode:        'ketapola-dice',
  amountMicro:     toMicro('1000.00').toString(), // "100000000"
  roundId:         'rnd_8a2c...',
});
```

### Notes

- `amountMicro` is always a positive integer. Debits are implied by the endpoint.
- `roundId` is the RGS-owned round identifier. The operator should store it on the
  ledger row for reconciliation but does not otherwise act on it.
- `isFree: true` indicates a promotional free bet. The operator may route these to a
  separate ledger account. The RGS still expects a balance in the response.
- On any non-OK, non-reject response (or timeout), the RGS will fire a matching
  `rollback` against the same `transactionUuid` to ensure consistency.

---

## POST /wallet/win

Credit a payout to the player. The RGS calls this once per winning bet during the
settlement phase of a round.

### Request

```ts
interface WinRequestWire {
  requestUuid:              string;
  transactionUuid:          string;  // NEW, unique id for this win movement
  referenceTransactionUuid: string;  // the transactionUuid of the original /wallet/bet call
  operatorId:               string;
  playerRef:                string;
  currency:                 string;
  gameCode:                 string;
  amountMicro:              string;  // stringified integer micro-units
  roundId:                  string;
  meta?:                    Record<string, unknown>;
}
```

### Response

```json
{
  "status": "RS_OK",
  "requestUuid": "<echo>",
  "balanceMicro": "50100000000",
  "currency": "LKR"
}
```

### Example: curl

```bash
TS=$(date +%s)
BODY='{"requestUuid":"3cd5...","transactionUuid":"win_5e8b...","referenceTransactionUuid":"bet_9f3a...","operatorId":"op_abc","playerRef":"player-42","currency":"LKR","gameCode":"ketapola-dice","amountMicro":"200000000","roundId":"rnd_8a2c..."}'
BODY_HASH=$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANONICAL=$(printf 'POST\n/wallet/win\n%s\n%s' "$TS" "$BODY_HASH")
SIG=$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$WALLET_SECRET" -binary | base64)

curl -sS -X POST https://casino.example.com/wallet/win \
  -H "content-type: application/json" \
  -H "x-yantra-key-id: $KID" \
  -H "x-yantra-timestamp: $TS" \
  -H "x-yantra-signature: $SIG" \
  -d "$BODY"
```

### Example: Node.js via SDK

```ts
const result = await yantra.wallet.win({
  requestUuid:              randomUUID(),
  transactionUuid:          randomUUID(),
  referenceTransactionUuid: originalBetTxUuid,
  operatorId:               'op_abc',
  playerRef:                'player-42',
  currency:                 'LKR',
  gameCode:                 'ketapola-dice',
  amountMicro:              toMicro('2000.00').toString(),
  roundId:                  'rnd_8a2c...',
});
```

### Notes on referenceTransactionUuid

- `referenceTransactionUuid` MUST match the `transactionUuid` of the originating
  `POST /wallet/bet` call. The operator should index its ledger by it for joins.
- If the operator cannot find the referenced bet (maybe the bet was never booked on
  their side due to a previous rollback), return
  `RS_ERROR_TRANSACTION_DOES_NOT_EXIST`. The RGS will log, alert, and treat this bet
  as settled without payout.
- A winning bet with zero payout (edge case: free bets) is still a win call with
  `amountMicro: "0"`. A losing bet generates **no** win call at all.
- Win amount is gross payout (stake × payoutMultiplier) minus any commission the
  operator has configured; see the per-game PAR sheet (e.g. [games/ketapola-dice/docs/par-sheet.md](../games/ketapola-dice/docs/par-sheet.md)).

---

## POST /wallet/award

Credit a promotional or free-to-play prize that does not reference a previous
bet debit. The first use is `rps-tournament`, where entry is free and configured
HNL prizes are awarded by final rank.

### Request

```ts
interface AwardRequestWire {
  requestUuid:     string;
  transactionUuid: string;  // NEW, unique id for this prize movement
  operatorId:      string;
  playerRef:       string;
  currency:        string;
  gameCode:        string;
  amountMicro:     string;  // stringified integer micro-units
  prizeRef:        string;  // e.g. "rps:<tournamentId>:rank:1"
  tournamentId?:   string;
  rank?:           number;
  meta?:           Record<string, unknown>;
}
```

### Response

```json
{
  "status": "RS_OK",
  "requestUuid": "<echo>",
  "balanceMicro": "50100000000",
  "currency": "HNL"
}
```

### Notes

- `transactionUuid` is idempotent exactly like `/wallet/win`.
- `prizeRef` is stable campaign/accounting metadata and should be stored in the
  operator ledger.
- Award failures are retried through the same pending wallet job queue as wins.

---

## POST /wallet/rollback

Reverse a previous bet or win. The RGS calls this in one of three circumstances:

1. A `/wallet/bet` returned an uncertain status (timeout, 5xx, invalid JSON, unknown
   status code). The RGS fires `rollback` to close the ledger with the same
   `transactionUuid` pointing back to the bet.
2. A round was voided after bets were accepted (game-side failure, admin void, crash
   recovery with unknown outcome). The RGS rolls back every accepted bet.
3. A `/wallet/win` failed and exhausted its retry budget. The RGS rolls back the
   *bet*, not the win, the win never landed, so there is nothing to reverse for the
   win itself; the bet stake is refunded and the round is voided.

### Request

```ts
interface RollbackRequestWire {
  requestUuid:              string;
  transactionUuid:          string;  // NEW, unique id for this rollback entry
  referenceTransactionUuid: string;  // the transactionUuid of the bet or win being reversed
  operatorId:               string;
  playerRef:                string;
  currency:                 string;
  gameCode:                 string;
  roundId?:                 string;
  meta?:                    Record<string, unknown>;
}
```

### Response

```json
{
  "status": "RS_OK",
  "requestUuid": "<echo>",
  "balanceMicro": "50000000000",
  "currency": "LKR"
}
```

Operator never saw the original transaction:

```json
{
  "status": "RS_ERROR_TRANSACTION_DOES_NOT_EXIST",
  "requestUuid": "<echo>"
}
```

### Example: curl

```bash
TS=$(date +%s)
BODY='{"requestUuid":"4de6...","transactionUuid":"rb_2f1a...","referenceTransactionUuid":"bet_9f3a...","operatorId":"op_abc","playerRef":"player-42","currency":"LKR","gameCode":"ketapola-dice","roundId":"rnd_8a2c..."}'
BODY_HASH=$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANONICAL=$(printf 'POST\n/wallet/rollback\n%s\n%s' "$TS" "$BODY_HASH")
SIG=$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$WALLET_SECRET" -binary | base64)

curl -sS -X POST https://casino.example.com/wallet/rollback \
  -H "content-type: application/json" \
  -H "x-yantra-key-id: $KID" \
  -H "x-yantra-timestamp: $TS" \
  -H "x-yantra-signature: $SIG" \
  -d "$BODY"
```

### Example: Node.js via SDK

```ts
await yantra.wallet.rollback({
  requestUuid:              randomUUID(),
  transactionUuid:          randomUUID(),
  referenceTransactionUuid: originalBetTxUuid, // or the win tx
  operatorId:               'op_abc',
  playerRef:                'player-42',
  currency:                 'LKR',
  gameCode:                 'ketapola-dice',
  roundId:                  'rnd_8a2c...',
});
```

### Timing semantics

The rollback endpoint is polymorphic, the operator determines whether it is
reversing a bet or a win by looking up `referenceTransactionUuid` in its own ledger.
Both cases share the same endpoint.

Rules for the operator:

1. If `referenceTransactionUuid` identifies a **bet** that was booked (debit): credit
   the stake back.
2. If `referenceTransactionUuid` identifies a **win** that was booked (credit): debit
   the payout back.
3. If `referenceTransactionUuid` identifies a transaction that was already rolled
   back: return `RS_OK` with the current balance; this is a retry of the same
   rollback, not a double-rollback.
4. If `referenceTransactionUuid` identifies nothing: return
   `RS_ERROR_TRANSACTION_DOES_NOT_EXIST`. The RGS treats this as a successful
   rollback, the operator never saw the original call, so there is nothing to undo.

Rollback is not bounded in time; the RGS may retry for up to 24 hours via
`PendingWalletJob`.

---

## Retry and rollback rules

The RGS classifies every response using this table. The classifier lives in
`packages/wallet-spec` (`isRejectStatus`, `isSuccessOrDuplicate`).

| Response | Class | RGS action |
| --- | --- | --- |
| `RS_OK` | Success | Commit, continue |
| `RS_ERROR_DUPLICATE_TRANSACTION` | Success | Commit, continue (operator already booked it) |
| `RS_ERROR_NOT_ENOUGH_MONEY` | Clean reject | Mark bet `REJECTED`, do **not** rollback, do **not** retry |
| `RS_ERROR_LIMIT_REACHED` | Clean reject | Mark bet `REJECTED`, do **not** rollback, do **not** retry |
| `RS_ERROR_USER_DISABLED` | Clean reject | Terminate session, do **not** rollback the current call |
| `RS_ERROR_INVALID_TOKEN` | Fatal | Terminate session, alert |
| `RS_ERROR_INVALID_SIGNATURE` | Fatal | Alert (our bug or operator misconfig) |
| `RS_ERROR_INVALID_PARTNER` | Fatal | Alert (operator mismatch) |
| `RS_ERROR_WRONG_CURRENCY` | Fatal | Alert, do not retry |
| `RS_ERROR_WRONG_SYNTAX` | Fatal | Alert (our bug), do not retry |
| `RS_ERROR_WRONG_TYPES` | Fatal | Alert (our bug), do not retry |
| `RS_ERROR_TOKEN_EXPIRED` | Terminate | Terminate session |
| `RS_ERROR_TRANSACTION_DOES_NOT_EXIST` | Conditional | For `/win` or `/rollback`: alert, treat as settled. For others: fatal. |
| `RS_ERROR_TIMEOUT` (synthetic) | Uncertain | Fire `rollback` with same `transactionUuid`, enqueue retry |
| `RS_ERROR_UNKNOWN` | Uncertain | Fire `rollback` with same `transactionUuid`, enqueue retry |
| HTTP 5xx | Uncertain | Map to `RS_ERROR_UNKNOWN`, then same as above |
| Network error | Uncertain | Map to `RS_ERROR_UNKNOWN`, then same as above |
| Invalid JSON | Uncertain | Map to `RS_ERROR_UNKNOWN`, then same as above |

Retries use exponential backoff starting at 1s, doubling to a cap of 60s, jittered.
After 24 hours of failed retries the `PendingWalletJob` row is marked abandoned and
a human-operator ticket is filed via the portal.

---

## Error codes

See [error-codes.md](./error-codes.md) for every code with detailed semantics.

Quick reference from `@yantra/wallet-spec`:

```ts
export const RsStatus = {
  OK:                    'RS_OK',
  UNKNOWN:               'RS_ERROR_UNKNOWN',
  INVALID_TOKEN:         'RS_ERROR_INVALID_TOKEN',
  INVALID_SIGNATURE:     'RS_ERROR_INVALID_SIGNATURE',
  INVALID_PARTNER:       'RS_ERROR_INVALID_PARTNER',
  NOT_ENOUGH_MONEY:      'RS_ERROR_NOT_ENOUGH_MONEY',
  USER_DISABLED:         'RS_ERROR_USER_DISABLED',
  TOKEN_EXPIRED:         'RS_ERROR_TOKEN_EXPIRED',
  WRONG_CURRENCY:        'RS_ERROR_WRONG_CURRENCY',
  WRONG_SYNTAX:          'RS_ERROR_WRONG_SYNTAX',
  WRONG_TYPES:           'RS_ERROR_WRONG_TYPES',
  DUPLICATE_TRANSACTION: 'RS_ERROR_DUPLICATE_TRANSACTION',
  TRANSACTION_NOT_FOUND: 'RS_ERROR_TRANSACTION_DOES_NOT_EXIST',
  LIMIT_REACHED:         'RS_ERROR_LIMIT_REACHED',
  TIMEOUT:               'RS_ERROR_TIMEOUT',
} as const;
```

---

## Money format

All amounts on the wire are **stringified positive integers in micro-units**. One
micro-unit is one hundred-thousandth of one major unit:

```
1 LKR = 100,000 micro-LKR
```

The constant is exported from `@yantra/wallet-spec`:

```ts
export const MICRO_PER_UNIT = 100_000n;
```

Examples:

| Display | Wire format | BigInt |
| --- | --- | --- |
| `1.00 LKR` | `"100000"` | `100_000n` |
| `1,000.00 LKR` | `"100000000"` | `100_000_000n` |
| `0.50 LKR` | `"50000"` | `50_000n` |
| `0.00001 LKR` | `"1"` | `1n` (one micro-unit; smallest representable) |

Helpers:

```ts
import { toMicro, fromMicro, MICRO_PER_UNIT } from '@yantra/wallet-spec';

toMicro('1000.00');   // 100_000_000n
toMicro(1000.00);     // 100_000_000n  (lossy path; prefer the string form)
fromMicro(100_000_000n); // "1000"
```

Rules:

1. Never use floating point for money. `Number.MAX_SAFE_INTEGER` is less than the
   micro-unit balance of a high-roller crypto wallet.
2. Parse with `BigInt(stringValue)` on read; call `.toString()` before putting back on
   the wire.
3. The choice of 100,000 (not 100 or 1,000,000) follows the Hub88 convention ,
   enough headroom for crypto precision while remaining under `Number.MAX_SAFE_INTEGER`
   for human-scale display amounts.
4. The RGS's outbound HttpWalletAdapter at `apps/rgs-server/src/wallet/HttpWalletAdapter.ts`
   calls `.toString()` on every `amountMicro` before sending. The operator must call
   `BigInt(body.amountMicro)` before doing any arithmetic, **never parse as
   a decimal**.

---

## See also

- [integration-guide.md](./integration-guide.md), end-to-end walkthrough.
- [error-codes.md](./error-codes.md), full status code reference.
- [security.md](./security.md), signing spec, threat model, rotation.
- [provably-fair.md](./provably-fair.md), verifying round outcomes.
- `packages/wallet-spec/src/index.ts`: the authoritative type definitions.
