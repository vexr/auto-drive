import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from '@jest/globals'
import {
  fetchRecentSwapsFrom,
  resolveEndpoint,
  RECENT_SWAPS_QUERY,
} from '../../../src/infrastructure/services/priceOracle/subgraph.js'
import {
  POOL_ID,
  USDC_ADDRESS,
  WAI3_ADDRESS,
} from '../../../src/infrastructure/services/priceOracle/pool.js'

// Shapes taken from a real gateway response (verified 2026-08-10): amounts are
// BigDecimal strings in WHOLE TOKENS and signed by direction, `_meta.block
// .timestamp` is nullable in graph-node's schema, and the pool's tokens come
// back lowercased.
const meta = (overrides: Record<string, unknown> = {}) => ({
  block: { number: 25_725_462, timestamp: 1_786_375_343 },
  hasIndexingErrors: false,
  ...overrides,
})

const pool = () => ({
  token0: { id: WAI3_ADDRESS.toLowerCase(), decimals: '18' },
  token1: { id: USDC_ADDRESS.toLowerCase(), decimals: '6' },
})

const swap = (amount0: string, amount1: string, timestamp = '1785917567') => ({
  id: `0xdeadbeef-${timestamp}-${amount0}`,
  timestamp,
  amount0,
  amount1,
})

// An explicit endpoint, so nothing here depends on what happens to be in .env.
const ENDPOINT = { url: 'https://subgraph.test/query', apiKey: 'test-key' }

const fetchSwaps = (limit: number) => fetchRecentSwapsFrom(ENDPOINT, limit)

const respondWith = (
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
) =>
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response)

describe('priceOracle/subgraph', () => {
  beforeEach(() => {
    // Any test that forgets to stub the response must fail loudly rather than
    // reach the real gateway. Without this the suite silently queries the live
    // subgraph — which is how a passing test can depend on whether a pool
    // traded this week, and on a metered API key.
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`unstubbed network call to ${String(input)}`)
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('mapping', () => {
    it('scales whole-token BigDecimals into base units and drops the sign', () => {
      // 199392.024 WAI3 out for 477.1285 USDC in, as the pool actually filled it.
      const fetchMock = respondWith({
        data: {
          _meta: meta(),
          pool: pool(),
          swaps: [swap('199392.024', '-477.1285')],
        },
      })

      return fetchSwaps(10).then((result) => {
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(result.samples).toEqual([
          {
            ai3Amount: 199_392_024_000_000_000_000_000n,
            usdcAmount: 477_128_500n,
            timestampMs: 1_785_917_567_000,
          },
        ])
      })
    })

    it('handles either trade direction', async () => {
      respondWith({
        data: {
          _meta: meta(),
          pool: pool(),
          swaps: [swap('-1000.5', '6.4032'), swap('1000.5', '-6.4032')],
        },
      })

      const { samples } = await fetchSwaps(10)

      expect(samples).toHaveLength(2)
      expect(samples[0]).toEqual(samples[1])
    })

    it('truncates fractional dust below one base unit rather than failing', async () => {
      // BigDecimal can carry more precision than USDC can represent.
      respondWith({
        data: {
          _meta: meta(),
          pool: pool(),
          swaps: [swap('1.0', '-0.0000004')],
        },
      })

      const { samples } = await fetchSwaps(10)

      // 0.4 base units truncates to 0, which makes the leg unusable and the
      // sample is dropped rather than priced at zero.
      expect(samples).toHaveLength(0)
    })

    it('drops a swap with a zero leg instead of rejecting the response', async () => {
      respondWith({
        data: {
          _meta: meta(),
          pool: pool(),
          swaps: [swap('0', '-5.0'), swap('1000.5', '-6.4032')],
        },
      })

      const { samples } = await fetchSwaps(10)

      expect(samples).toHaveLength(1)
    })

    it('reports the indexer head and its error flag', async () => {
      respondWith({
        data: {
          _meta: meta({ hasIndexingErrors: true }),
          pool: pool(),
          swaps: [],
        },
      })

      const result = await fetchSwaps(10)

      expect(result.indexerBlock).toBe(25_725_462n)
      expect(result.indexerTimestampMs).toBe(1_786_375_343_000)
      expect(result.hasIndexingErrors).toBe(true)
    })
  })

  describe('identity', () => {
    it('rejects a pool whose currencies are the other way round', async () => {
      // The failure this exists for: every price would simply be inverted, and
      // nothing downstream could tell.
      respondWith({
        data: {
          _meta: meta(),
          pool: {
            token0: { id: USDC_ADDRESS.toLowerCase(), decimals: '6' },
            token1: { id: WAI3_ADDRESS.toLowerCase(), decimals: '18' },
          },
          swaps: [swap('1000.5', '-6.4032')],
        },
      })

      await expect(fetchSwaps(10)).rejects.toThrow(
        /ordered the other way round/,
      )
    })

    it('rejects decimals that contradict the price scaling', async () => {
      respondWith({
        data: {
          _meta: meta(),
          pool: {
            token0: { id: WAI3_ADDRESS.toLowerCase(), decimals: '9' },
            token1: { id: USDC_ADDRESS.toLowerCase(), decimals: '6' },
          },
          swaps: [],
        },
      })

      await expect(fetchSwaps(10)).rejects.toThrow(/decimals=9/)
    })

    it('rejects a subgraph that does not have the pool', async () => {
      respondWith({ data: { _meta: meta(), pool: null, swaps: [] } })

      await expect(fetchSwaps(10)).rejects.toThrow(
        new RegExp(`no pool ${POOL_ID}`),
      )
    })
  })

  describe('unusable responses', () => {
    it('surfaces an HTTP failure with its status', async () => {
      respondWith({ message: 'rate limited' }, { ok: false, status: 429 })

      await expect(fetchSwaps(10)).rejects.toThrow(/HTTP 429/)
    })

    it('surfaces GraphQL errors', async () => {
      respondWith({ errors: [{ message: 'indexers failed' }] })

      await expect(fetchSwaps(10)).rejects.toThrow(/indexers failed/)
    })

    it('refuses a null block timestamp rather than reading it as zero', async () => {
      // `_Block_.timestamp` is nullable in graph-node's schema. Read as a
      // number it becomes 0, and the lag guard then reports the indexer as
      // fifty-odd years behind, forever.
      respondWith({
        data: {
          _meta: {
            block: { number: 25_725_462, timestamp: null },
            hasIndexingErrors: false,
          },
          pool: pool(),
          swaps: [],
        },
      })

      await expect(fetchSwaps(10)).rejects.toThrow(/no block timestamp/)
    })

    it('refuses a response with no swaps collection', async () => {
      respondWith({ data: { _meta: meta(), pool: pool() } })

      await expect(fetchSwaps(10)).rejects.toThrow(/no swaps collection/)
    })
  })

  describe('endpoint', () => {
    it('requires an API key when talking to the gateway', () => {
      expect(() => resolveEndpoint(undefined, undefined)).toThrow(
        /GRAPH_API_KEY/,
      )
    })

    it('allows an unauthenticated local mirror via the URL override', () => {
      const local = 'http://localhost:8000/subgraphs/name/uniswap-v4'

      expect(resolveEndpoint(local, undefined)).toEqual({
        url: local,
        apiKey: undefined,
      })
    })

    it('defaults to the pinned gateway subgraph when no override is given', () => {
      const { url, apiKey } = resolveEndpoint(undefined, 'a-key')

      expect(url).toContain('gateway.thegraph.com')
      expect(apiKey).toBe('a-key')
    })

    it('sends the pool id and limit as query variables', async () => {
      const fetchMock = respondWith({
        data: { _meta: meta(), pool: pool(), swaps: [] },
      })

      await fetchSwaps(7)

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(JSON.parse(init.body as string)).toEqual({
        query: RECENT_SWAPS_QUERY,
        variables: { pool: POOL_ID, first: 7 },
      })
    })

    it('asks for data alongside indexing errors rather than instead of it', () => {
      // graph-node defaults every root field to `subgraphError: deny`, which
      // fails the whole query when the deployment has an indexing error — so the
      // hasIndexingErrors flag would never be seen and the outage would be
      // misreported as a gateway failure.
      expect(RECENT_SWAPS_QUERY).toMatch(
        /pool\(id: \$pool, subgraphError: allow\)/,
      )
      expect(RECENT_SWAPS_QUERY).toMatch(/subgraphError: allow\s*\)\s*\{/)
    })
  })
})
