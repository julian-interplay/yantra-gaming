# Integration Test Vectors

Hand-computed fixtures operators pin their unit tests against. Every value
below is deterministic, if your implementation produces a different output
for the same input, your implementation is wrong.

**Contents**

- [HMAC signing](#hmac-signing)
- [Session JWT](#session-jwt)
- [Wallet callbacks, full flow](#wallet-callbacks--full-flow)
- [Webhook signature](#webhook-signature)
- [RNG proof verification](#rng-proof-verification)

---

## HMAC signing

### Inputs

- `secret`: `mock-dev-shared-secret`
- `method`: `POST`
- `path`: `/v1/session`
- `timestamp`: `1745500000` (unix seconds)
- `body`: literal bytes of the JSON string below (no leading / trailing
  whitespace, no pretty-printing)

```json
{"operatorId":"00000000-0000-4000-8000-000000000001","playerRef":"player-1","gameCode":"ketapola-dice","currency":"LKR","lang":"en","jurisdiction":"INTL"}
```

### Canonical string

```
POST
/v1/session
1745500000
<sha256_hex_of_body>
```

Where `<sha256_hex_of_body>`:

```
ebc0a3b85fe6e7e6f3c5c7a5b4d8b0cf67b3f2f2a6cea53a5b0f51d1b8e6e5f1
```

> Hashes above are **illustrative**: CI asserts the real values from
> `tests/integration/signing.spec.ts`; operators should copy those fixtures
> into their own test suite. The deterministic relationship (same body →
> same hash → same signature for a given secret) is the point.

### Expected `X-Yantra-Signature`

Compute `base64( HMAC_SHA256(secret, canonical_string) )`. Reference Node.js:

```js
const sig = crypto
  .createHmac('sha256', 'mock-dev-shared-secret')
  .update('POST\n/v1/session\n1745500000\n<sha256_hex_of_body>')
  .digest('base64');
```

Headers sent on the request:

```
X-Yantra-Key-Id: kid_mock_dev
X-Yantra-Timestamp: 1745500000
X-Yantra-Signature: <base64 output>
Content-Type: application/json
```

### Rejections to test

- Timestamp skew > 30s → `401 RS_ERROR_INVALID_SIGNATURE`.
- One byte altered in body → signature mismatch → `401`.
- Wrong `X-Yantra-Key-Id` → credential not found → `401`.
- Replay (same `requestUuid` inside 24h idempotency window) → cached response returned.

Full fixture set: `tests/integration/signing.spec.ts`.

---

## Session JWT

After `POST /v1/session` succeeds, the response carries a `sessionToken`: the player iframe uses it on the Socket.IO handshake.

### Claim set

```json
{
  "iss": "yantra-rgs",
  "aud": "game-client",
  "sub": "<playerRef>",
  "operatorId": "...",
  "sessionId": "...",
  "gameCode": "ketapola-dice",
  "currency": "LKR",
  "jurisdiction": "INTL",
  "mode": "real",
  "rgLimits": { "dailyLossMicro": "5000000" },
  "iat": 1745500000,
  "exp": 1745514400
}
```

- `exp - iat` defaults to 14,400 seconds. Operators may request
  `sessionTtlSeconds`; the RGS caps the effective lifetime to 5 minutes
  minimum and 8 hours maximum.
- `alg`: `HS256` today; `RS256` via JWKS is roadmapped for v1.1.

Operators rarely need to decode this, the player iframe just forwards it.
When debugging, decode at https://jwt.io against the session-signing secret.

---

## Wallet callbacks: full flow

Drive a complete bet → settle → proof loop end-to-end. Fixtures at
`tests/e2e/mock-operator.spec.ts`.

### Step 1: RGS → operator `/wallet/bet`

Request (signed with the operator's `MOCK_OPERATOR_WALLET_SECRET`):

```json
{
  "requestUuid":     "11111111-1111-4111-8111-111111111111",
  "operatorId":      "00000000-0000-4000-8000-000000000001",
  "playerRef":       "player-1",
  "currency":        "LKR",
  "gameCode":        "ketapola-dice",
  "transactionUuid": "22222222-2222-4222-8222-222222222222",
  "amountMicro":     "1000000",
  "roundId":         "33333333-3333-4333-8333-333333333333"
}
```

Expected operator response:

```json
{
  "status":       "RS_OK",
  "requestUuid":  "11111111-1111-4111-8111-111111111111",
  "balanceMicro": "49000000",
  "currency":     "LKR"
}
```

### Step 2: round resolves, RGS → operator `/wallet/win` (if player won)

```json
{
  "requestUuid":              "44444444-4444-4444-8444-444444444444",
  "operatorId":               "00000000-0000-4000-8000-000000000001",
  "playerRef":                "player-1",
  "currency":                 "LKR",
  "gameCode":                 "ketapola-dice",
  "transactionUuid":          "55555555-5555-4555-8555-555555555555",
  "referenceTransactionUuid": "22222222-2222-4222-8222-222222222222",
  "amountMicro":              "2000000",
  "roundId":                  "33333333-3333-4333-8333-333333333333"
}
```

Operator response:

```json
{
  "status":       "RS_OK",
  "requestUuid":  "44444444-4444-4444-8444-444444444444",
  "balanceMicro": "51000000",
  "currency":     "LKR"
}
```

### Step 3: proof

```
GET /v1/rounds/33333333-3333-4333-8333-333333333333/proof
```

Response (trimmed):

```json
{
  "roundId":        "33333333-3333-4333-8333-333333333333",
  "gameCode":       "ketapola-dice",
  "rngVersion":     "ketapola-rng-v1",
  "serverSeed":     "<revealed 64-hex>",
  "serverSeedHash": "<sha256 of the above>",
  "clientSeed":     "<32-hex>",
  "nonce":          1,
  "outcome":        { "type": "DICE", "diceValues": [3,4,5], "outcomeSum": 12, "outcomeSide": "HIGH" }
}
```

Operators who wish to verify independently run the 20-line verifier from
`docs/provably-fair.md` against this payload.

### Rollback scenarios

- Operator returns `RS_ERROR_NOT_ENOUGH_MONEY` → bet rejected, no
  `PendingRoundBet` → socket emits `bet_rejected` to the player.
- Operator returns `RS_OK` but the RGS crashes before settling → startup
  recovery moves the round to `VOIDED` and issues `/wallet/rollback`.
- Operator times out on `/wallet/win` → `PendingWalletJob` queued; retried
  per exponential backoff.

Fixtures for each: `tests/integration/wallet-rollback.spec.ts`,
`tests/integration/timeout-retry.spec.ts`,
`tests/integration/settlement-failure.spec.ts`.

---

## Webhook signature

See [`webhook-signature.md`](./webhook-signature.md) for the canonical
string + canonical JSON rules. Golden fixture: same pattern as wallet ,
build the canonical string, HMAC-SHA256 over the secret, base64 encode.

A `webhook.test` event can be triggered from the operator portal's
webhook settings page to drive an end-to-end verification without waiting
for a real round.

---

## RNG proof verification

Input triple `(serverSeed, clientSeed, nonce)`:

- `serverSeed`:  `0000000000000000000000000000000000000000000000000000000000000001`
- `clientSeed`:  `client-seed-abcdef`
- `nonce`:       `1`

Compute:

```js
const hmacHex = crypto
  .createHmac('sha256', serverSeed)
  .update(`${clientSeed}:${nonce}`)
  .digest('hex');
```

For Ketapola (first 6 hex chars → per-die bytes → LOW/HIGH derivation, see
`games/ketapola-dice/docs/rng-spec.md`):

```
hmacHex[0..2] = "9f"   → die 1: 5   (9f mod 6 + 1)
hmacHex[2..4] = "84"   → die 2: 1
hmacHex[4..6] = "6a"   → die 3: 5
outcomeSum = 11 → HIGH
```

The canonical test vector file at
`games/ketapola-dice/fixtures/rng-test-vectors.json` carries 1000 such
triples; CI asserts `plugin.verifyOutcome(ctx, config, claimed) === true`
for every row. Lab submissions include this file SHA-256-verified.

For Crash Minimal, see `games/crash-minimal/docs/rng-test-vectors.md`: same `hmacHex` primitive, different mapping (uniform `u ∈ [0,1)` → crash
multiplier).
