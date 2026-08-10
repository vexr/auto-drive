/**
 * Types for the AI3/USD price oracle (see ./index.ts).
 *
 * All USD-per-AI3 values are integers scaled by USD_RATE_SCALE (1e18) — the
 * same representation persisted as `intents.usdRateAtCreation` — so downstream
 * USDC quote math stays integer-only. See @auto-drive/models `intent.ts`.
 */

// Price returned to callers.
export type OraclePrice = {
  // AI3/USD price scaled by USD_RATE_SCALE (1e18).
  usdPerAi3: bigint
  // When the value was fetched (the original fetch time when served as a
  // last-good fallback).
  asOf: Date
  // True only for a fresh in-memory TTL cache hit; always false for a stale
  // last-good fallback (see `stale`) and for a freshly fetched value.
  fromCache: boolean
  // Served from the last-good fallback because the latest fetch failed (still
  // within maxStaleMs).
  stale: boolean
}

/**
 * One realized swap, normalized out of the indexer's representation.
 *
 * Both legs are absolute base-unit amounts: the sign of a swap says which
 * direction it went, and a volume weighting does not care. What matters is that
 * the two legs belong to the same fill, because their ratio is a price the pool
 * actually honoured — fee and price impact included, unlike a quoted one.
 */
export type SwapSample = {
  // USDC base units (6 decimals), absolute.
  usdcAmount: bigint
  // AI3 base units (shannons, 18 decimals), absolute.
  ai3Amount: bigint
  timestampMs: number
}

/**
 * The window a rate was derived from.
 *
 * Carried rather than discarded because every consumer needs to describe it:
 * the guards judge it, the admin dashboard shows why the path is open or shut,
 * and the treasury report cannot suggest a conversion size without knowing how
 * thin the market behind the number is.
 */
export type SwapWindow = {
  // Volume-weighted AI3/USD price, scaled by USD_RATE_SCALE (1e18).
  usdPerAi3: bigint
  // Swaps that survived the outlier trim and produced the price above.
  sampleCount: number
  // Swaps dropped by the trim, kept separate so a window that is mostly
  // outliers is visible rather than merely small.
  droppedOutliers: number
  // Total USDC base units traded across the surviving samples — the weight
  // behind the average, and what makes it expensive to move.
  volumeUsdc: bigint
  // Span of the SURVIVING samples, not of everything fetched. Every field in
  // this struct describes the same set of fills, so an operator reading
  // "7 swaps over 4 days" is reading one consistent window rather than a count
  // from after the trim against a span from before it.
  newestSwapMs: number
  oldestSwapMs: number
  // Indexer head at query time. The window can be perfectly healthy while the
  // indexer that reported it has stopped, and those need different responses.
  indexerBlock: bigint
  indexerTimestampMs: number
}

/**
 * Why the oracle refused, in a form something other than a human can read.
 *
 * The message names the guard too, but a dashboard that has to regex a string
 * to render a status is a dashboard that breaks on the next wording change.
 */
export type OracleUnavailableReason =
  // The gateway could not be reached, errored, or returned unusable JSON.
  | 'gateway'
  // Too few usable swaps in the window (before or after the outlier trim).
  | 'insufficient-samples'
  // The most recent swap is older than the freshness bound — the market has
  // stopped, whatever the indexer says.
  | 'stale-window'
  // The surviving fills are packed into too short an interval to be a market.
  // A handful of swaps in one block is something anyone can print on demand;
  // a price held across hours is not.
  | 'narrow-window'
  // The window traded too little for its average to mean anything.
  | 'thin-volume'
  // The derived price sits outside the configured sanity bounds.
  | 'out-of-bounds'
  // The indexer itself is behind; the window describes a past we cannot date.
  | 'indexer-lag'
  // The indexer is current but reports that it failed to index something, so
  // what it served may be incomplete in ways we cannot see from here.
  | 'indexer-error'

/**
 * A snapshot of what the oracle currently knows, for the admin dashboard and
 * the treasury report.
 *
 * `window` is the one behind the last SUCCESSFUL read, so it survives a
 * failure: "the rate we are serving came from 7 swaps over 4 days, and the last
 * refresh failed on indexer-lag" is two facts, and an operator needs both.
 */
export type OracleHealth = {
  lastSuccessAt: Date | null
  lastFailureAt: Date | null
  lastFailureReason: OracleUnavailableReason | null
  window: SwapWindow | null
  // Serving a last-good price because the live read is failing.
  servingStale: boolean
}

/**
 * Wrapped in a neverthrow `err` when no trustworthy rate is available — i.e.
 * USDC quoting cannot safely proceed right now.
 *
 * Every guard fails closed into this one error rather than degrading to a
 * best-effort number: the alternative to a refusal is charging someone at a
 * price nothing supports.
 */
export class OracleUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: OracleUnavailableReason,
  ) {
    super(message)
    this.name = 'OracleUnavailableError'
  }
}
