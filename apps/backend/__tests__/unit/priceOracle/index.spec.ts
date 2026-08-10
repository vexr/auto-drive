import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from '@jest/globals'
import { priceOracle } from '../../../src/infrastructure/services/priceOracle/index.js'
import { SubgraphConfigError } from '../../../src/infrastructure/services/priceOracle/subgraph.js'
import type { SwapSample } from '../../../src/infrastructure/services/priceOracle/types.js'

// Defaults from config: cacheTtlMs 60s, maxStaleMs 600s, requestTimeoutMs 10s,
// sample size 10 / floor 5, max swap age 24h, max index lag 15min, min window
// volume 1000 USDC, outlier trim at 25%, bounds [0.0001, 100] USD/AI3.
const TTL_MS = 60_000
const MAX_STALE_MS = 600_000
const MAX_SWAP_AGE_MS = 86_400_000
const MAX_INDEX_LAG_MS = 900_000

const PRICE = 6_400_000_000_000_000n // 0.0064 USD/AI3, scaled 1e18
const BLOCK = 21_000_000n

// A swap of 50,000 AI3 for 320 USDC — 0.0064 USD/AI3. Five of these clear the
// 1000 USDC window-volume floor, so a healthy fixture is five of them.
const AI3_PER_SWAP = 50_000n * 10n ** 18n
const USDC_PER_SWAP = 320_000_000n

const swapsAt = (
  count: number,
  timestampMs: number,
  usdcAmount: bigint = USDC_PER_SWAP,
): SwapSample[] =>
  Array.from({ length: count }, (_, i) => ({
    usdcAmount,
    ai3Amount: AI3_PER_SWAP,
    // Spread backwards an hour apart, so `newest` is the one at timestampMs and
    // the window clears the 2h minimum span.
    timestampMs: timestampMs - i * 3_600_000,
  }))

// This pool's real fills, read from the gateway on 2026-08-10 and ordered newest
// first, as [AI3 whole tokens, USDC whole tokens, seconds before now]. Volume is
// doubled and the timestamps compressed so that the freshness and volume guards
// pass and the price TREND is the only thing under test — the prices themselves
// are exactly what the pool filled at, falling 59% across the window.
const LIVE_DOWNTREND: [number, number, number][] = [
  [199392.024, 477.128529, 600],
  [91895.484, 286.993475, 3600],
  [35931.88, 127.829951, 7200],
  [118194.35, 501.438685, 10800],
  [8120.565, 39.943132, 14400],
  [29431.44, 151.891229, 18000],
  [10000.0013, 54.31106, 21600],
  [10000, 55.773014, 25200],
  [10000, 57.29481, 28800],
  [10000, 58.879753, 32400],
]

const liveDowntrendAt = (now: number): SwapSample[] =>
  LIVE_DOWNTREND.map(([ai3, usdc, secondsAgo]) => ({
    // x2 volume, via whole tokens -> base units without float error at 1e18.
    ai3Amount: BigInt(Math.round(ai3 * 2 * 1e6)) * 10n ** 12n,
    usdcAmount: BigInt(Math.round(usdc * 2 * 1e6)),
    timestampMs: now - secondsAgo * 1000,
  }))

const windowAt = (
  now: number,
  overrides: {
    samples?: SwapSample[]
    indexerTimestampMs?: number
    indexerBlock?: bigint
    hasIndexingErrors?: boolean
  } = {},
) => ({
  samples: overrides.samples ?? swapsAt(5, now - 60_000),
  indexerBlock: overrides.indexerBlock ?? BLOCK,
  indexerTimestampMs: overrides.indexerTimestampMs ?? now - 12_000,
  hasIndexingErrors: overrides.hasIndexingErrors ?? false,
})

const mockWindow = (
  build: (now: number) => ReturnType<typeof windowAt> = (now) => windowAt(now),
) =>
  jest
    .spyOn(priceOracle._internal, 'fetchRecentSwaps')
    .mockImplementation(async () => build(Date.now()))

// Every test here stubs the adapter, so nothing should ever reach `fetch`. That
// is asserted rather than assumed: `config` reads a developer's .env at import,
// so a test that forgot to stub would quietly query the live gateway — and pass
// or fail depending on whether the pool traded this week.
const failOnUnstubbedFetch = () =>
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    throw new Error(`unstubbed network call to ${String(input)}`)
  })

describe('priceOracle.getPrice', () => {
  beforeEach(() => {
    priceOracle._reset()
    failOnUnstubbedFetch()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('returns the volume-weighted average of the recent swaps', async () => {
    mockWindow()

    const result = await priceOracle.getPrice()

    expect(result.isOk()).toBe(true)
    const price = result._unsafeUnwrap()
    expect(price.usdPerAi3).toBe(PRICE)
    expect(price.fromCache).toBe(false)
    expect(price.stale).toBe(false)
  })

  it('weights by size: one big fill outvotes many small ones', async () => {
    // Four small swaps at 0.007 USD/AI3 against one fill at 0.0064 that is
    // three orders of magnitude larger. A count-weighted mean would land near
    // 0.00688; the volume-weighted one sits within 0.004% of the big fill.
    mockWindow((now) => ({
      ...windowAt(now),
      samples: [
        ...Array.from({ length: 4 }, (_, i) => ({
          usdcAmount: 350_000n, // 0.35 USDC
          ai3Amount: 50n * 10n ** 18n, // 50 AI3 -> 0.007 USD/AI3
          timestampMs: now - 60_000 - i * 3_600_000,
        })),
        {
          usdcAmount: 3_200_000_000n, // 3200 USDC
          ai3Amount: 500_000n * 10n ** 18n, // 500k AI3 -> 0.0064
          timestampMs: now - 60_000,
        },
      ],
    }))

    const price = (await priceOracle.getPrice())._unsafeUnwrap()

    expect(price.usdPerAi3).toBeGreaterThan(6_400_000_000_000_000n)
    expect(price.usdPerAi3).toBeLessThan(6_401_000_000_000_000n)
  })

  it('refuses rather than mispricing when dust swaps outnumber the real fill', async () => {
    // The trim measures against the MEDIAN, which is count-based: four wash
    // trades at 0.01 make the honest 0.0064 fill the outlier, and it is the one
    // discarded. The result is a refusal (too few samples survive), never a
    // price set by the dust — which is the direction this must fail in. Pinned
    // as a test because it is the known limit of a trade-history oracle on a
    // pool this thin: cheap to deny, not cheap to move.
    mockWindow((now) => ({
      ...windowAt(now),
      samples: [
        ...Array.from({ length: 4 }, (_, i) => ({
          usdcAmount: 500_000n, // 0.5 USDC
          ai3Amount: 50n * 10n ** 18n, // 50 AI3 -> 0.01 USD/AI3
          timestampMs: now - 60_000 - i * 3_600_000,
        })),
        {
          usdcAmount: 3_200_000_000n,
          ai3Amount: 500_000n * 10n ** 18n, // 0.0064, 1000x the volume
          timestampMs: now - 60_000,
        },
      ],
    }))

    const result = await priceOracle.getPrice()

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().reason).toBe('insufficient-samples')
  })

  it('serves subsequent calls from cache within the TTL', async () => {
    const spy = mockWindow()

    const first = await priceOracle.getPrice()
    const second = await priceOracle.getPrice()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(first._unsafeUnwrap().fromCache).toBe(false)
    expect(second._unsafeUnwrap().fromCache).toBe(true)
    expect(second._unsafeUnwrap().usdPerAi3).toBe(PRICE)
  })

  it('refreshes after the TTL expires', async () => {
    const spy = mockWindow()

    await priceOracle.getPrice()
    jest.advanceTimersByTime(TTL_MS + 1)
    await priceOracle.getPrice()

    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('collapses concurrent refreshes into one upstream query', async () => {
    const spy = mockWindow()

    const [a, b, c] = await Promise.all([
      priceOracle.getPrice(),
      priceOracle.getPrice(),
      priceOracle.getPrice(),
    ])

    expect(spy).toHaveBeenCalledTimes(1)
    expect(a._unsafeUnwrap().usdPerAi3).toBe(PRICE)
    expect(b._unsafeUnwrap().usdPerAi3).toBe(PRICE)
    expect(c._unsafeUnwrap().usdPerAi3).toBe(PRICE)
  })

  it('falls back to the last-good price when a read fails', async () => {
    const spy = mockWindow()
    await priceOracle.getPrice()

    jest.advanceTimersByTime(TTL_MS + 1) // expire cache + clear throttle
    spy.mockRejectedValueOnce(new Error('gateway 503'))
    const result = await priceOracle.getPrice()

    expect(result.isOk()).toBe(true)
    const price = result._unsafeUnwrap()
    expect(price.stale).toBe(true)
    expect(price.fromCache).toBe(false)
    expect(price.usdPerAi3).toBe(PRICE)
  })

  it('throttles upstream during an outage', async () => {
    const spy = mockWindow()
    await priceOracle.getPrice()

    jest.advanceTimersByTime(TTL_MS + 1)
    spy.mockRejectedValueOnce(new Error('gateway 503'))
    await priceOracle.getPrice()
    expect(spy).toHaveBeenCalledTimes(2)

    // Within the throttle window the last-good value is served without another
    // upstream call.
    const stale = await priceOracle.getPrice()
    expect(stale._unsafeUnwrap().stale).toBe(true)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('errors once the last-good price ages past maxStaleMs', async () => {
    const spy = mockWindow()
    await priceOracle.getPrice()

    jest.advanceTimersByTime(MAX_STALE_MS + 1)
    spy.mockRejectedValue(new Error('gateway 503'))
    const result = await priceOracle.getPrice()

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().reason).toBe('gateway')
  })

  describe('guards', () => {
    // With no last-good value to fall back on, the guard's own reason reaches
    // the caller — which is what #747 maps to a status code and #811 renders.
    const refusalReason = async () => {
      const result = await priceOracle.getPrice()
      expect(result.isErr()).toBe(true)
      return result._unsafeUnwrapErr().reason
    }

    it('refuses when the gateway cannot be read', async () => {
      jest
        .spyOn(priceOracle._internal, 'fetchRecentSwaps')
        .mockRejectedValue(new Error('ECONNRESET'))

      expect(await refusalReason()).toBe('gateway')
    })

    it('separates a wrong deployment from an unreachable one', async () => {
      // A stale POOL_ID or a missing GRAPH_API_KEY is fixed by a redeploy, not
      // by waiting, and reporting it as `gateway` would send whoever is paged
      // to The Graph's status page to debug our own constant.
      jest
        .spyOn(priceOracle._internal, 'fetchRecentSwaps')
        .mockRejectedValue(
          new SubgraphConfigError('Subgraph has no pool 0xdead'),
        )

      expect(await refusalReason()).toBe('misconfigured')
    })

    it('refuses when the indexer reports indexing errors', async () => {
      mockWindow((now) => ({ ...windowAt(now), hasIndexingErrors: true }))

      expect(await refusalReason()).toBe('indexer-error')
    })

    it('refuses when the indexer is behind, even with a healthy window', async () => {
      mockWindow((now) => ({
        ...windowAt(now),
        indexerTimestampMs: now - MAX_INDEX_LAG_MS - 1,
      }))

      expect(await refusalReason()).toBe('indexer-lag')
    })

    it('refuses a window with too few swaps', async () => {
      mockWindow((now) => ({ ...windowAt(now), samples: swapsAt(4, now) }))

      expect(await refusalReason()).toBe('insufficient-samples')
    })

    it('refuses when the newest swap is older than the freshness bound', async () => {
      mockWindow((now) => ({
        ...windowAt(now),
        samples: swapsAt(5, now - MAX_SWAP_AGE_MS - 1),
      }))

      expect(await refusalReason()).toBe('stale-window')
    })

    it('does not let ancient fills carry the median and price the window', async () => {
      // The regression this guards: eight fills from long ago at 0.02, two from
      // today at 0.0064. Without a lower bound the eight are the median, the
      // trim discards TODAY's fills as outliers, and a rate from another era is
      // served and charged. The window bound drops them first, leaving two —
      // below the floor, so the oracle refuses.
      mockWindow((now) => ({
        ...windowAt(now),
        samples: [
          ...swapsAt(2, now - 60_000),
          ...Array.from({ length: 8 }, (_, i) => ({
            usdcAmount: 1_000_000_000n,
            ai3Amount: 50_000n * 10n ** 18n, // 0.02 USD/AI3
            timestampMs: now - 30 * 86_400_000 - i * 3_600_000,
          })),
        ],
      }))

      expect(await refusalReason()).toBe('insufficient-samples')
    })

    it('refuses a burst of fills that never held a price', async () => {
      // Six fills inside ten minutes: enough of them, enough volume, all fresh —
      // and printable on demand by anyone willing to trade against themselves.
      mockWindow((now) => ({
        ...windowAt(now),
        samples: Array.from({ length: 6 }, (_, i) => ({
          usdcAmount: USDC_PER_SWAP,
          ai3Amount: AI3_PER_SWAP,
          timestampMs: now - 60_000 - i * 120_000, // 2 min apart
        })),
      }))

      expect(await refusalReason()).toBe('narrow-window')
    })

    it('judges freshness on the newest swap, not the window span', async () => {
      // Five swaps an hour apart: the oldest is 5h back, well inside the bound,
      // and the window is served.
      mockWindow((now) => ({
        ...windowAt(now),
        samples: swapsAt(5, now - 1000),
      }))

      const result = await priceOracle.getPrice()

      expect(result.isOk()).toBe(true)
    })

    it('refuses when the outlier trim leaves too few swaps', async () => {
      mockWindow((now) => ({
        ...windowAt(now),
        samples: [
          ...swapsAt(3, now - 60_000),
          // Two swaps at 10x the median price: trimmed, leaving 3 < floor of 5.
          ...swapsAt(2, now - 60_000, USDC_PER_SWAP * 10n),
        ],
      }))

      expect(await refusalReason()).toBe('insufficient-samples')
    })

    it('refuses when the market has re-priced past the window', async () => {
      // The defect this closes, taken from this pool's own history rather than
      // invented: the price fell 59% across the window, so the fills carrying
      // the NEW price were the minority — and a count-based median trims the
      // minority. The seven survivors average 0.004698 USD/AI3 while the pool's
      // most recent fill was 0.002393, a rate 96% above anything that traded,
      // and it clears every other guard (7 samples, 1839 USDC, spanning 6h, in
      // bounds). Charging at the old regime is the one outcome worse than not
      // quoting, so the newest fill gets a veto.
      mockWindow((now) => ({
        ...windowAt(now),
        samples: liveDowntrendAt(now),
      }))

      expect(await refusalReason()).toBe('market-moved')
    })

    it('still trims an outlier that is not the newest fill', async () => {
      // The veto must not cost the trim its original job. One absurd print in
      // the middle of the window is dropped and the rest prices as before,
      // because the market's latest fill still agrees with the median.
      mockWindow((now) => ({
        ...windowAt(now),
        samples: [
          ...swapsAt(3, now - 60_000),
          ...swapsAt(1, now - 60_000 - 3 * 3_600_000, USDC_PER_SWAP * 10n),
          ...swapsAt(3, now - 60_000 - 4 * 3_600_000),
        ],
      }))

      const result = await priceOracle.getPrice()

      expect(result.isOk()).toBe(true)
      expect(result._unsafeUnwrap().usdPerAi3).toBe(PRICE)
      expect(priceOracle.getHealth().window).toMatchObject({
        sampleCount: 6,
        droppedOutliers: 1,
      })
    })

    it('prices a market that moved within the trim band', async () => {
      // Volatility is not a regime change: a newest fill 20% off the median
      // survives the trim, so it votes instead of vetoing.
      mockWindow((now) => ({
        ...windowAt(now),
        samples: [
          ...swapsAt(1, now - 60_000, (USDC_PER_SWAP * 80n) / 100n),
          ...swapsAt(4, now - 60_000 - 3_600_000),
        ],
      }))

      const result = await priceOracle.getPrice()

      expect(result.isOk()).toBe(true)
      expect(result._unsafeUnwrap().usdPerAi3).toBeLessThan(PRICE)
    })

    it('refuses a window that traded below the volume floor', async () => {
      // Five swaps totalling 50 USDC — well-formed, fresh, and meaningless.
      mockWindow((now) => ({
        ...windowAt(now),
        samples: swapsAt(5, now - 60_000, 10_000_000n).map((s) => ({
          ...s,
          ai3Amount: AI3_PER_SWAP / 32n,
        })),
      }))

      expect(await refusalReason()).toBe('thin-volume')
    })

    it('refuses a price outside the sanity bounds', async () => {
      // 1000 USDC for 1 AI3 — above the 100 USD/AI3 ceiling.
      mockWindow((now) => ({
        ...windowAt(now),
        samples: swapsAt(5, now - 60_000, 1_000_000_000n).map((s) => ({
          ...s,
          ai3Amount: 10n ** 18n,
        })),
      }))

      expect(await refusalReason()).toBe('out-of-bounds')
    })

    it('does not cache or remember a refused window', async () => {
      mockWindow((now) => ({ ...windowAt(now), samples: swapsAt(4, now) }))

      await priceOracle.getPrice()

      expect(priceOracle.getHealth().window).toBeNull()
      expect(priceOracle.getHealth().lastSuccessAt).toBeNull()
    })
  })
})

describe('priceOracle.getHealth', () => {
  beforeEach(() => {
    priceOracle._reset()
    failOnUnstubbedFetch()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('starts empty', () => {
    expect(priceOracle.getHealth()).toEqual({
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      window: null,
      servingStale: false,
    })
  })

  it('describes the window behind the served rate', async () => {
    mockWindow()
    await priceOracle.getPrice()

    const health = priceOracle.getHealth()

    expect(health.lastSuccessAt).not.toBeNull()
    expect(health.lastFailureReason).toBeNull()
    expect(health.window).toMatchObject({
      usdPerAi3: PRICE,
      sampleCount: 5,
      droppedOutliers: 0,
      volumeUsdc: USDC_PER_SWAP * 5n,
      indexerBlock: BLOCK,
    })
  })

  it('keeps the last good window while reporting the current failure', async () => {
    const spy = mockWindow()
    await priceOracle.getPrice()

    jest.advanceTimersByTime(TTL_MS + 1)
    spy.mockRejectedValueOnce(new Error('gateway 503'))
    await priceOracle.getPrice()

    const health = priceOracle.getHealth()

    expect(health.lastFailureReason).toBe('gateway')
    expect(health.window?.usdPerAi3).toBe(PRICE) // the successful one, retained
    expect(health.servingStale).toBe(true)
  })

  it('reports a recovery as recovered, without losing the blip', async () => {
    const spy = mockWindow()
    await priceOracle.getPrice()

    jest.advanceTimersByTime(TTL_MS + 1)
    spy.mockRejectedValueOnce(new Error('gateway 503'))
    await priceOracle.getPrice()

    jest.advanceTimersByTime(TTL_MS + 1)
    await priceOracle.getPrice()

    const health = priceOracle.getHealth()

    // No longer degraded — the current read succeeds.
    expect(health.servingStale).toBe(false)
    // But the failure stays on the record, and stays PAIRED with its reason:
    // clearing one and not the other rendered "last failure 5m ago (null)".
    expect(health.lastFailureAt).not.toBeNull()
    expect(health.lastFailureReason).toBe('gateway')
  })

  it('does not trigger an upstream read', async () => {
    const spy = mockWindow()

    priceOracle.getHealth()

    expect(spy).not.toHaveBeenCalled()
  })
})
