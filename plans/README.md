# Game implementation plans

| Plan | Scope | Priority | Effort | Status |
|---|---|---|---|---|
| [001](001-pinball-after-dark.md) | Pinball After Dark inside the existing Yantra RGS | P1 | L | IMPLEMENTED AND REVIEWED — release gates remain open |

Execution checkout: `/private/tmp/yantra-pinball-execution`, branch `codex/pinball-after-dark`, based on `171c6f0` plus preserved original working changes. Source is uncommitted; no merge or deployment performed.

Independent checks: 84 game/plugin tests, 36 integration/jurisdiction tests, client/RGS builds, eight browser fixtures, launch/reload/replay, portrait/landscape and accessible controls passed. The 92-artifact packet hashes and isolated math execution were verified. Exact RTP 98%; independent 100-million-round simulation 98.0030094%.

Physical-device performance acceptance and independent release approval remain open. Provisional high-tier p95 exceeded the proposed target; existing repository typecheck/wallet-suite limitations are documented. Review evidence and demo startup instructions are under `games/pinball-after-dark/docs` in the execution checkout.
