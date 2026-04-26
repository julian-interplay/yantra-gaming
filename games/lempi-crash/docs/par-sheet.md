# PAR Sheet: Lempi Crash

## Configuration

| Field | Default | Meaning |
| --- | ---: | --- |
| `houseEdge` | `0.01` | Pre-roll bust probability, setting RTP to 99%. |
| `maxMultiplier` | `1000` | Hard cap on crash outcomes and display. |
| `multiplierGrowthRate` | `0.00011` | Exponential display curve used during live flight. |
| `minFlightMs` | `700` | Minimum visual flight time. |
| `maxFlightMs` | `120000` | Maximum visual flight time. |

## Distribution

For cashout multiplier `K`:

```text
P(win at K) = (1 - houseEdge) / K
RTP(K) = K * P(win at K) = 1 - houseEdge
```

At the default `houseEdge = 0.01`, theoretical RTP is `0.99` for every manual
or auto cashout multiplier. The player changes volatility by changing cashout
target, not expected return.

## Exposure

```text
maxPayoutMicro = maxBetMicro * maxMultiplier - commissionMicro
```

With seeded HNL config this is bounded by `L100,000 * 1000`.
