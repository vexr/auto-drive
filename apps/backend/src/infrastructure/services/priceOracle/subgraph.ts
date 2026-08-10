/**
 * Reads the pool's recent trade history from its subgraph on The Graph.
 *
 * I/O and mapping only: this module turns a GraphQL response into
 * `SwapSample`s and says nothing about whether the window is usable. Every
 * judgement — how old is too old, how thin is too thin — belongs to index.ts,
 * so there is exactly one place where a refusal can originate.
 *
 * The one exception is identity. A response describing the WRONG pool is not a
 * market condition to be judged, it is a misconfiguration, and it is checked
 * here because this is where the answer arrives: the tokens are verified
 * against POOL_KEY's ordering before any amount is mapped. Silently accepting
 * a pool with the currencies the other way round would invert every price the
 * oracle produces, which no downstream guard could detect — the numbers would
 * simply be wrong, and plausibly so.
 */

import { config } from '../../../config.js'
import { AI3_DECIMALS, USDC_DECIMALS } from '../../../shared/utils/index.js'
import {
  POOL_ID,
  USDC_ADDRESS,
  WAI3_ADDRESS,
  defaultSubgraphUrl,
} from './pool.js'
import { parseDecimalToScaledBigint } from './quote.js'
import type { SwapSample } from './types.js'

export type SwapWindowResponse = {
  // Newest first, as returned; samples with a zero leg are already dropped.
  samples: SwapSample[]
  indexerBlock: bigint
  indexerTimestampMs: number
  // The subgraph's own report that it failed to index something. Surfaced
  // rather than acted on here — index.ts owns what to do about it.
  hasIndexingErrors: boolean
}

/**
 * One round trip for everything a window needs: the indexer's head (is the
 * source current?), the pool's identity (are we reading what we think?), and
 * the swaps themselves.
 *
 * Amounts come back as BigDecimal strings in whole tokens — "199392.024", not
 * base units — and signed by direction, since one leg enters the pool while the
 * other leaves. `amountUSD` is deliberately not requested: it is the subgraph's
 * own valuation derived through its pricing paths, whereas amount1 IS the USDC
 * that changed hands. A realized fill is the whole point.
 */
export const RECENT_SWAPS_QUERY = `
  query RecentSwaps($pool: ID!, $first: Int!) {
    _meta {
      block {
        number
        timestamp
      }
      hasIndexingErrors
    }
    pool(id: $pool, subgraphError: allow) {
      token0 {
        id
        decimals
      }
      token1 {
        id
        decimals
      }
    }
    swaps(
      first: $first
      orderBy: timestamp
      orderDirection: desc
      where: { pool: $pool }
      subgraphError: allow
    ) {
      id
      timestamp
      amount0
      amount1
    }
  }
`

type GraphSwap = {
  id: string
  timestamp: string
  amount0: string
  amount1: string
}

type GraphResponse = {
  data?: {
    _meta: {
      // `timestamp` is NULLABLE in graph-node's schema (`_Block_`), so it is
      // typed as such here and validated below rather than trusted: read as a
      // number it would silently become 0, and every read would then refuse
      // with "the indexer is 1.7 billion seconds behind".
      block: { number: number; timestamp: number | null }
      hasIndexingErrors: boolean
    } | null
    pool: {
      token0: { id: string; decimals: string }
      token1: { id: string; decimals: string }
    } | null
    swaps: GraphSwap[]
  }
  errors?: { message: string }[]
}

// A BigDecimal amount in whole tokens, signed by direction, as the base-unit
// magnitude the price math works in. The sign carries no price information —
// which side of the trade a leg is on is the same fact twice — so it is dropped
// here rather than propagated for every caller to remember to ignore.
const toBaseUnits = (amount: string, decimals: number): bigint =>
  parseDecimalToScaledBigint(amount.trim().replace(/^-/, ''), decimals)

/**
 * Where to send the query, and with what credential.
 *
 * Takes its inputs as arguments rather than reading `config` directly so it can
 * be exercised without one: `config` snapshots the environment at import, so a
 * test that mutates `process.env` changes nothing — a trap worth designing out
 * rather than remembering.
 *
 * The key authenticates against The Graph's gateway and nothing else, so it is
 * required only when we are actually talking to the gateway. A local mirror or
 * a test double needs no credential, and demanding a dummy one would make the
 * documented override unusable for the thing it exists for.
 */
export type SubgraphEndpoint = { url: string; apiKey?: string }

export const resolveEndpoint = (
  override: string | undefined,
  apiKey: string | undefined,
): SubgraphEndpoint => {
  if (!override && !apiKey) {
    throw new Error(
      'GRAPH_API_KEY is not set — the AI3/USD oracle cannot query the pool ' +
        'subgraph through the gateway, so USDC payments cannot be quoted ' +
        '(set GRAPH_SUBGRAPH_URL instead to point at an unauthenticated mirror)',
    )
  }
  return { url: override || defaultSubgraphUrl(), apiKey }
}

const assertPoolIdentity = (
  pool: NonNullable<NonNullable<GraphResponse['data']>['pool']>,
): void => {
  const expected = [
    { side: 'token0', address: WAI3_ADDRESS, decimals: AI3_DECIMALS },
    { side: 'token1', address: USDC_ADDRESS, decimals: USDC_DECIMALS },
  ] as const
  const actual = [pool.token0, pool.token1]

  expected.forEach(({ side, address, decimals }, index) => {
    const token = actual[index]
    if (token.id.toLowerCase() !== address.toLowerCase()) {
      throw new Error(
        `Subgraph pool ${POOL_ID} has ${side}=${token.id}, expected ` +
          `${address} — this is a different pool, or its currencies are ` +
          'ordered the other way round, either of which inverts every price',
      )
    }
    if (Number(token.decimals) !== decimals) {
      throw new Error(
        `Subgraph pool ${POOL_ID} reports ${side} decimals=${token.decimals}, ` +
          `expected ${decimals} — the price scaling assumes otherwise`,
      )
    }
  })
}

/**
 * Fetch the most recent `limit` swaps for the pool from a given endpoint.
 *
 * Throws on anything that makes the response unusable — transport failure,
 * GraphQL errors, a missing or mismatched pool, an unparseable amount. The
 * caller turns that into an oracle outage; there is no partially usable window.
 *
 * Takes the endpoint rather than resolving one, so that everything below can be
 * exercised without an environment. `config` snapshots env at import: a suite
 * that resolved its own endpoint would pass on a developer machine holding a
 * key in .env and fail in CI, which is precisely how this seam came to exist.
 */
export const fetchRecentSwapsFrom = async (
  { url, apiKey }: SubgraphEndpoint,
  limit: number,
  signal?: AbortSignal,
): Promise<SwapWindowResponse> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      query: RECENT_SWAPS_QUERY,
      variables: { pool: POOL_ID, first: limit },
    }),
    signal,
  })

  if (!response.ok) {
    // The body may carry the reason (rate limit, exhausted budget); the key is
    // never in it, and must never be logged from here either.
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Subgraph query failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
    )
  }

  const body = (await response.json()) as GraphResponse
  const errors = body.errors ?? []

  // Errors are NOT automatically fatal, and the order here is the whole point.
  //
  // Under `subgraphError: allow`, graph-node returns the data it has AND an
  // entry in `errors` — its own test suite pins this: "With `allow`, the error
  // remains but the data is included", against `{"message": "indexing_error"}`.
  // Throwing on any `errors` would therefore report every indexing failure as a
  // gateway outage and make the `indexer-error` reason unreachable, which is
  // exactly the diagnosis an operator needs to tell "The Graph is broken" from
  // "we cannot reach The Graph".
  //
  // So the presence of usable data decides. No data means the query itself
  // failed — a validation error, a timeout, indexers giving up — and that is an
  // outage. Data present means the errors accompanying it are the indexing kind,
  // and the window is refused downstream with the reason that names them.
  if (!body.data?._meta) {
    throw new Error(
      errors.length
        ? `Subgraph query returned errors: ${errors
            .map((e) => e.message)
            .join('; ')
            .slice(0, 300)}`
        : 'Subgraph query returned no indexing metadata',
    )
  }
  const indexerTimestamp = body.data._meta.block.timestamp
  if (typeof indexerTimestamp !== 'number') {
    throw new Error(
      'Subgraph reported no block timestamp, so how far behind it is cannot ' +
        'be judged',
    )
  }
  if (!body.data.pool) {
    throw new Error(
      `Subgraph has no pool ${POOL_ID} — wrong subgraph, or the pool identity ` +
        'in pool.ts is stale',
    )
  }
  if (!Array.isArray(body.data.swaps)) {
    throw new Error('Subgraph query returned no swaps collection')
  }
  assertPoolIdentity(body.data.pool)

  // A swap with a zero leg has no price and would divide by zero downstream.
  // Dropping it here rather than throwing is deliberate: it is one unusable
  // row, not an unusable response, and the sample-count guard already decides
  // whether what remains is enough.
  const samples: SwapSample[] = body.data.swaps.flatMap((swap) => {
    const ai3Amount = toBaseUnits(swap.amount0, AI3_DECIMALS)
    const usdcAmount = toBaseUnits(swap.amount1, USDC_DECIMALS)
    if (ai3Amount <= 0n || usdcAmount <= 0n) {
      return []
    }
    return [
      {
        ai3Amount,
        usdcAmount,
        timestampMs: Number(swap.timestamp) * 1000,
      },
    ]
  })

  return {
    samples,
    indexerBlock: BigInt(body.data._meta.block.number),
    indexerTimestampMs: indexerTimestamp * 1000,
    // Either signal counts. `hasIndexingErrors` is the deployment's own record
    // of past failures, while an error riding alongside the data is this
    // response saying it is incomplete right now — and a response that had to
    // be served under `allow` is not one to price a charge from either way.
    hasIndexingErrors: body.data._meta.hasIndexingErrors || errors.length > 0,
  }
}

// The one line that reads configuration, kept thin so everything it wraps stays
// testable without one.
export const fetchRecentSwaps = (
  limit: number,
  signal?: AbortSignal,
): Promise<SwapWindowResponse> =>
  fetchRecentSwapsFrom(
    resolveEndpoint(
      config.priceOracle.subgraphUrl,
      config.priceOracle.graphApiKey,
    ),
    limit,
    signal,
  )
