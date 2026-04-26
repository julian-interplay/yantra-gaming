# Game Rules: Lempi Crash

Lempi Crash is a live-cashout crash game for HNL sessions. Each round opens an
8-second betting window, then the pilot launches and the multiplier climbs from
1.00x until the provably-fair crash point is reached.

Players may place up to two client-side bet slots per round. Each slot has a
stake and may optionally include an auto-cashout multiplier. During flight the
player may manually cash out an active slot before the crash.

## Betting

- `gameCode`: `lempi-crash`
- Currency: `HNL`
- Minimum stake: `L10` (`1_000_000` micro-units)
- Seeded maximum stake: `L100,000` (`10_000_000_000` micro-units)
- Selection shape: `{ slotId: "A" | "B", autoCashoutMultiplier?: number }`

## Outcome

The round outcome is `{ type: "CRASH", crashMultiplier, u }`. The RNG mapping
matches the Crash Minimal 1/K curve:

```text
hmac = HMAC_SHA256(serverSeed, clientSeed + ':' + nonce)
u_raw = first 52 bits / 2^52
if u_raw < houseEdge: crashMultiplier = 1.00
else crashMultiplier = floor(100 / (1 - rescaled_u)) / 100
```

Default `houseEdge = 0.01`, so theoretical RTP is 99%.

## Settlement

- Manual cashout before the crash pays `stake * displayedCashoutMultiplier`.
- Auto cashout pays `stake * autoCashoutMultiplier` if the crash reaches the target.
- Bets not cashed out before the crash lose.
- Wallet settlement uses the existing `/wallet/win` endpoint and references the original `/wallet/bet` transaction.

## Live Events

The RGS emits `multiplier_tick`, `cashout_accepted`, `cashout_rejected`,
`player_cashout`, `pool_update`, and `round_result`. The UI treats the RGS as
authoritative for all cashout and payout state.
