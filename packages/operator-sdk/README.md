# @yantra/operator-sdk

Official SDK for integrating the Yantra Gaming Remote Gaming Server into an operator platform.

The SDK gives you two things:

1. `createSession()`: mint a player launch session at the RGS.
2. `verifyWebhookSignature()`: verify inbound wallet callbacks are authentically from the RGS.

It also re-exports the wire-contract types, status-code classifiers, header names, and money helpers from `@yantra/wallet-spec` so your application only takes one dependency.

> **Status:** internal workspace package; published to npm per release cycle as `@yantra/operator-sdk`, versioned semver. Operators integrate via `npm install @yantra/operator-sdk`. Inside this monorepo it's linked via `workspace:*`.

---

## Install

Within this monorepo (Bun workspace):

```bash
# already linked via workspace:*: no install needed
```

In a real-world operator project:

```bash
npm install @yantra/operator-sdk
# or
bun add @yantra/operator-sdk
```

---

## Quick example

```ts
import express from 'express';
import {
  createSession,
  verifyWebhookSignature,
  parseWalletCallback,
  RsStatus,
  toMicro,
} from '@yantra/operator-sdk';

const app = express();

// IMPORTANT: keep the raw body around, the webhook signature is over the raw bytes
app.use(express.json({
  verify: (req, _res, buf) => { (req as any).rawBody = buf; },
}));

// ─── 1. launch a game session ───────────────────────────

app.post('/launch/yantra', async (req, res) => {
  const { launchUrl } = await createSession({
    endpoint:  'https://rgs.yantra.example/v1/session',
    apiKeyId:  process.env.YANTRA_KEY_ID!,
    apiSecret: process.env.YANTRA_API_SECRET!,
    payload: {
      operatorId:   'op_abc123',
      playerRef:    req.user.id,
      gameCode:     'ketapola-dice',
      currency:     'LKR',
      lang:         'si',
      jurisdiction: 'LK',
      mode:         'real',
      returnUrl:    'https://casino.example.com/lobby',
      rgLimits:     { dailyLossMicro: '5000000000' }, // 50,000.00 LKR / day
    },
  });
  res.redirect(launchUrl);
});

// ─── 2. receive wallet callbacks ────────────────────────

app.post('/wallet/bet', async (req, res) => {
  const rawBody = (req as any).rawBody as Buffer;

  const ok = verifyWebhookSignature({
    method:    req.method,
    path:      req.path,
    body:      rawBody,
    secret:    process.env.YANTRA_WALLET_SECRET!,
    timestamp: req.header('x-yantra-timestamp')!,
    signature: req.header('x-yantra-signature')!,
  });
  if (!ok) {
    return res.status(401).json({
      status:      RsStatus.INVALID_SIGNATURE,
      requestUuid: req.body?.requestUuid ?? 'unknown',
    });
  }

  const { body } = parseWalletCallback('bet', req.body);
  const amount = toMicro(body.amountMicro); // BigInt

  // ... debit the player, persist, respond RS_OK ...
});
```

---

## API reference

### `createSession(params)`

Mints a player launch session at the RGS. See the SDK source for the full parameter list.

Throws `SessionCreationError`. The error has a `retryable` flag:

```ts
try {
  await createSession({ ... });
} catch (err) {
  if (err instanceof SessionCreationError && err.retryable) {
    // timeout or 5xx, retry with backoff
  } else {
    // 4xx or invalid response, do not retry, surface to user
  }
}
```

Returns a `CreateSessionResult` with:

| Field | Type | Meaning |
| --- | --- | --- |
| `sessionId` | `string` | The RGS-assigned session id. |
| `sessionToken` | `string` | JWT used by the game-client to open its socket. Embedded in `launchUrl`. |
| `launchUrl` | `string` | The URL to redirect the player to (or put in an `<iframe src>`). |
| `expiresAt` | `string` (ISO 8601) | Authoritative session expiry. Defaults to 4 hours; `sessionTtlSeconds` is capped to 5 minutes minimum and 8 hours maximum. |
| `serverSeedHash` | `string` | Hex SHA-256 of the server seed committed at session creation. The RGS will reveal the seed later via `/v1/rounds/:id/proof`. |
| `requestUuid` | `string` | Echo of the request UUID used (auto-generated if you didn't supply one). |

### `verifyWebhookSignature(params)`

Verifies an inbound RGS webhook (wallet callback, report delivery, etc.).

- Returns `true` on valid signature + fresh timestamp (± 30 s by default).
- Returns `false` on mismatched signature or expired timestamp.
- Throws `WebhookHeaderError` only if required headers are missing.

Always pass the **raw request body**, not a re-serialised JSON string. The signature is over the exact bytes the RGS sent. (See the Express `express.json({ verify })` pattern above.)

### `parseWalletCallback(endpoint, body)`

Shape-checks an already-verified wallet callback body against one of `'balance' | 'bet' | 'win' | 'rollback'` and returns a discriminated union so `.body` is correctly typed for each case.

Does **not** verify the signature, always call `verifyWebhookSignature` first.

---

## Exported helpers

Re-exported from [`@yantra/wallet-spec`](../wallet-spec/README.md) so you only take one dependency:

- `RsStatus`: constant object of every status code (`RS_OK`, `RS_ERROR_NOT_ENOUGH_MONEY`, etc).
- `isRejectStatus(s)`: `true` for statuses that mean "cleanly reject the bet, do not roll back" (`NOT_ENOUGH_MONEY`, `LIMIT_REACHED`, `USER_DISABLED`).
- `isSuccessOrDuplicate(s)`: `true` for statuses that mean the operation was accepted (`OK`, `DUPLICATE_TRANSACTION`).
- `toMicro(stringOrNumber)` / `fromMicro(bigint)`: convert between decimal major-units (`"1000.00"`) and integer micro-units (`100000000n`). 1 major unit = 100 000 micro-units. All amounts on the wire are micro-units as a stringified integer.
- `signPayload()` / `verifyPayload()`: the signing primitives, for operators who want to sign their own outbound calls (e.g. to call back into the RGS reconciliation endpoints).

See [`docs/error-codes.md`](../../docs/error-codes.md) for the full retry-vs-rollback-vs-reject rules.

---

## Versioning and stability

- The **wire contract** (`@yantra/wallet-spec`) is pinned per major version. Field additions are backwards-compatible; renames or removals are never.
- The **SDK surface** (this package) may grow; it will never remove exported symbols within a major version.
- Breaking changes to the RGS are only introduced with a new versioned path (`/v2/session`, etc). Your `createSession({ endpoint })` URL determines the contract version you get.

## Testing your integration

Run the `apps/mock-operator` in the repo to exercise every failure mode: timeouts, 5xx, `RS_ERROR_NOT_ENOUGH_MONEY`, duplicate transactions, network partitions. See [`B2B_ROADMAP.md` §17](../../B2B_ROADMAP.md#17-versioning-and-delivery) and the top-level README Quickstart.

## License

Apache License 2.0, see the repository root.
