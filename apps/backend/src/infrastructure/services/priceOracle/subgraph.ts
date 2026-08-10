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
import {
  POOL_ID,
  USDC_ADDRESS,
  USDC_DECIMALS,
  WAI3_ADDRESS,
  WAI3_DECIMALS,
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
    pool(id: $pool) {
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
    ) {
      id
      timestamp
      amount0
      amount1
      transaction {
        blockNumber
      }
    }
  }
`

type GraphSwap = {
  id: string
  timestamp: string
  amount0: string
  amount1: string
  transaction: { blockNumber: string } | null
}

type GraphResponse = {
  data?: {
    _meta: {
      block: { number: number; timestamp: number }
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

const requireEndpoint = (): { url: string; apiKey: string } => {
  const apiKey = config.priceOracle.graphApiKey
  if (!apiKey) {
    throw new Error(
      'GRAPH_API_KEY is not set — the AI3/USD oracle cannot query the pool ' +
        'subgraph, so USDC payments cannot be quoted',
    )
  }
  return { url: config.priceOracle.subgraphUrl || defaultSubgraphUrl(), apiKey }
}

const assertPoolIdentity = (
  pool: NonNullable<NonNullable<GraphResponse['data']>['pool']>,
): void => {
  const expected = [
    { side: 'token0', address: WAI3_ADDRESS, decimals: WAI3_DECIMALS },
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
 * Fetch the most recent `limit` swaps for the pool.
 *
 * Throws on anything that makes the response unusable — transport failure,
 * GraphQL errors, a missing or mismatched pool, an unparseable amount. The
 * caller turns that into an oracle outage; there is no partially usable window.
 */
export const fetchRecentSwaps = async (
  limit: number,
  signal?: AbortSignal,
): Promise<SwapWindowResponse> => {
  const { url, apiKey } = requireEndpoint()

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
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
  if (body.errors?.length) {
    throw new Error(
      `Subgraph query returned errors: ${body.errors
        .map((e) => e.message)
        .join('; ')
        .slice(0, 300)}`,
    )
  }
  if (!body.data?._meta) {
    throw new Error('Subgraph query returned no indexing metadata')
  }
  if (!body.data.pool) {
    throw new Error(
      `Subgraph has no pool ${POOL_ID} — wrong subgraph, or the pool identity ` +
        'in pool.ts is stale',
    )
  }
  assertPoolIdentity(body.data.pool)

  // A swap with a zero leg has no price and would divide by zero downstream.
  // Dropping it here rather than throwing is deliberate: it is one unusable
  // row, not an unusable response, and the sample-count guard already decides
  // whether what remains is enough.
  const samples: SwapSample[] = body.data.swaps.flatMap((swap) => {
    const ai3Amount = toBaseUnits(swap.amount0, WAI3_DECIMALS)
    const usdcAmount = toBaseUnits(swap.amount1, USDC_DECIMALS)
    if (ai3Amount <= 0n || usdcAmount <= 0n) {
      return []
    }
    return [
      {
        ai3Amount,
        usdcAmount,
        timestampMs: Number(swap.timestamp) * 1000,
        blockNumber: BigInt(swap.transaction?.blockNumber ?? 0),
      },
    ]
  })

  return {
    samples,
    indexerBlock: BigInt(body.data._meta.block.number),
    indexerTimestampMs: body.data._meta.block.timestamp * 1000,
    hasIndexingErrors: body.data._meta.hasIndexingErrors,
  }
}
