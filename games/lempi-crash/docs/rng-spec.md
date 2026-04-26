# RNG Technical Specification: Lempi Crash

Lempi Crash uses Yantra's shared commit-reveal primitive:

```text
hmac = HMAC_SHA256(serverSeed, clientSeed + ':' + nonce)
bits52 = first 52 bits of hmac
u_raw = bits52 / 2^52
```

If `u_raw < houseEdge`, the crash multiplier is `1.00`. Otherwise `u_raw` is
rescaled to `[0, 1)` and mapped to:

```text
crashMultiplier = floor(100 / (1 - u)) / 100
```

The value is clamped to `[1.00, maxMultiplier]`.

The live animation does not affect RNG. It is a deterministic display curve:

```text
displayMultiplier(elapsedMs) = floor(exp(elapsedMs * multiplierGrowthRate) * 100) / 100
```

The crash time is the elapsed time at which the display curve reaches the
precomputed crash multiplier, bounded by `minFlightMs` and `maxFlightMs`.

`RNG_VERSION = "lempi-crash-rng-v1"` is stamped on every round.
