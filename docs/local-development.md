# Local Development

Concise local setup for the current Lempi Crash build:

- Game: `lempi-crash`
- Currency: `HNL`
- Jurisdiction: `HN`
- RGS: `http://127.0.0.1:4500`
- Mock operator and wallet: `http://127.0.0.1:4300`
- Game client: `http://127.0.0.1:3100`

This flow uses the real RGS, Socket.IO, Prisma, Postgres, session signing, and
mock wallet callbacks. The only fake component is `apps/mock-operator`, which
acts as the casino backend and wallet.

## Prerequisites

- Bun `>=1.3.10`
- Docker Desktop or another Docker-compatible runtime
- This repository cloned locally

Install dependencies once:

```bash
bun install
```

Start Postgres:

```bash
docker compose up -d
```

The compose file exposes Postgres on `localhost:5434` with:

```text
user: yantra_gaming
password: yantra_gaming_dev
database: yantra_gaming
```

## Database

For the current Lempi/HNL local profile, use a separate scratch database:

```bash
docker exec yantra-gaming-postgres createdb -U yantra_gaming yantra_gaming_lempi_test
```

If it already exists, that command can fail harmlessly. Then push the Prisma
schema and seed the mock operator plus game configs:

```bash
cd apps/rgs-server
DATABASE_URL=postgresql://yantra_gaming:yantra_gaming_dev@localhost:5434/yantra_gaming_lempi_test \
SESSION_JWT_SECRET=dev-change-me-session-jwt-secret \
PORTAL_JWT_SECRET=dev-change-me-portal-jwt-secret \
SECRETS_MASTER_KEY_B64=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
bunx --bun prisma db push

DATABASE_URL=postgresql://yantra_gaming:yantra_gaming_dev@localhost:5434/yantra_gaming_lempi_test \
SESSION_JWT_SECRET=dev-change-me-session-jwt-secret \
PORTAL_JWT_SECRET=dev-change-me-portal-jwt-secret \
SECRETS_MASTER_KEY_B64=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
bun run seed
cd ../..
```

`prisma db push` is for this throwaway local database only. Use migrations for
production.

## Run Lempi Locally

Open three terminals from the repo root.

Terminal 1, RGS:

```bash
DATABASE_URL=postgresql://yantra_gaming:yantra_gaming_dev@localhost:5434/yantra_gaming_lempi_test \
SESSION_JWT_SECRET=dev-change-me-session-jwt-secret \
PORTAL_JWT_SECRET=dev-change-me-portal-jwt-secret \
SECRETS_MASTER_KEY_B64=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
PORT=4500 \
CORS_ORIGIN=http://localhost:3100,http://127.0.0.1:3100,http://localhost:4300,http://127.0.0.1:4300 \
GAME_CLIENT_BASE_URL=http://127.0.0.1:3100 \
bun run dev:rgs
```

Terminal 2, mock operator and mock wallet:

```bash
MOCK_OPERATOR_PORT=4300 \
RGS_BASE_URL=http://127.0.0.1:4500 \
GAME_CLIENT_BASE_URL=http://127.0.0.1:3100 \
MOCK_OPERATOR_GAME_CODE=lempi-crash \
MOCK_OPERATOR_CURRENCY=HNL \
MOCK_OPERATOR_JURISDICTION=HN \
MOCK_OPERATOR_SESSION_TTL_SECONDS=14400 \
bun run dev:mock
```

Terminal 3, game client:

```bash
VITE_RGS_SOCKET_URL=http://127.0.0.1:4500 \
VITE_RGS_BASE_URL=http://127.0.0.1:4500 \
bunx --bun vite --host 127.0.0.1 --port 3100
```

## Launch A Session

Open the mock operator:

```text
http://127.0.0.1:4300/
```

Launch one of the seeded players. The mock operator calls `POST /v1/session`
on the RGS, receives a launch URL, and redirects into:

```text
http://127.0.0.1:3100/?gameCode=lempi-crash&currency=HNL&jurisdiction=HN&...
```

The browser should show Lempi Crash in Spanish with HNL balances and a minimum
bet of `L10`.

## Useful Local Endpoints

| URL | Purpose |
| --- | --- |
| `http://127.0.0.1:4500/healthz` | RGS liveness |
| `http://127.0.0.1:4500/readyz` | RGS readiness |
| `http://127.0.0.1:4500/metrics` | Prometheus metrics |
| `http://127.0.0.1:4300/wallet/debug/balances` | Mock wallet balances |
| `http://127.0.0.1:4300/wallet/debug/tx` | Mock wallet transaction log |

## Verification

Recommended checks after frontend or game-engine changes:

```bash
bun test tests/plugin-contract
bun test tests/games/lempi-crash
bun run build:rgs
bun run build:client
```

For full money-path coverage, also run the targeted integration specs that
cover cashout, wallet win, rollback, and crash recovery.

## Common Issues

### Client connects but socket events do not arrive

Make sure the client was started with:

```bash
VITE_RGS_SOCKET_URL=http://127.0.0.1:4500
```

Without that env var, Vite may point Socket.IO at the wrong origin.

### Session opens the wrong game or currency

Check the mock operator env:

```bash
MOCK_OPERATOR_GAME_CODE=lempi-crash
MOCK_OPERATOR_CURRENCY=HNL
MOCK_OPERATOR_JURISDICTION=HN
```

### Wallet balance does not update

Confirm the RGS and mock operator are using the same database seed credentials:

```text
operatorId: 00000000-0000-4000-8000-000000000001
api key id: kid_mock_dev
wallet secret: mock-dev-wallet-secret
```

These are seeded by `apps/rgs-server/src/seed.ts` and read by
`apps/mock-operator/src/config.ts`.
