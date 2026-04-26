# RNG Test Vectors: Lempi Crash

Machine-readable vectors live at
[`../fixtures/rng-test-vectors.json`](../fixtures/rng-test-vectors.json) and
are enforced by `tests/games/lempi-crash/rng-test-vectors.spec.ts`.

| # | serverSeed | clientSeed | nonce | crashMultiplier | u |
| --- | --- | --- | ---: | ---: | ---: |
| 1 | `0000...0000` | `lempi-a` | 0 | 1.73 | 0.429196131705311 |
| 2 | `1111...1111` | `lempi-a` | 1 | 1.33 | 0.2573002268926785 |
| 3 | `2222...2222` | `lempi-b` | 17 | 2.67 | 0.6302711525973779 |
| 4 | `abcdef...abcd` | `player-seed` | 42 | 2.61 | 0.6217241948785344 |
