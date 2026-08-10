import { err, ok, Result } from 'neverthrow'
import { config } from '../../../config.js'
import { createLogger } from '../../drivers/logger.js'
import { withTimeout } from '../../../shared/utils/index.js'
import {
  isFresh,
  isWithinBounds,
  parseDecimalToScaledBigint,
  trimOutliers,
  volumeWeightedPrice,
  windowVolumeUsdc,
} from './quote.js'
import { fetchRecentSwaps } from './subgraph.js'
import {
  OracleUnavailableError,
  type OracleHealth,
  type OraclePrice,
  type OracleUnavailableReason,
  type SwapWindow,
} from './types.js'

const logger = createLogger('PriceOracle')

// Parse a configured USD/AI3 bound into the 1e18-scaled integer domain. Reads
// the raw env string directly (config keeps it unparsed) so we neither lose
// precision nor trip Number.toString()'s exponential notation for small values
// (e.g. Number('0.0000001').toString() === '1e-7'), and we fail fast at import
// with a message that names the offending variable.
const parseBound = (raw: string, name: string): bigint => {
  try {
    return parseDecimalToScaledBigint(raw)
  } catch {
    throw new Error(
      `Invalid ${name}: "${raw}" — use a plain decimal (e.g. 0.0001), not ` +
        'exponential notation',
    )
  }
}

const minScaled = parseBound(
  config.priceOracle.minUsdPerAi3,
  'ORACLE_MIN_USD_PER_AI3',
)
const maxScaled = parseBound(
  config.priceOracle.maxUsdPerAi3,
  'ORACLE_MAX_USD_PER_AI3',
)
if (minScaled > maxScaled) {
  throw new Error(
    `ORACLE_MIN_USD_PER_AI3 (${config.priceOracle.minUsdPerAi3}) must be <= ` +
      `ORACLE_MAX_USD_PER_AI3 (${config.priceOracle.maxUsdPerAi3})`,
  )
}

if (config.priceOracle.minSwapSamples > config.priceOracle.swapSampleSize) {
  throw new Error(
    `ORACLE_MIN_SWAP_SAMPLES (${config.priceOracle.minSwapSamples}) must be ` +
      `<= ORACLE_SWAP_SAMPLE_SIZE (${config.priceOracle.swapSampleSize}) — ` +
      'the floor cannot exceed the number of swaps ever requested, or every ' +
      'window fails the sample-count guard',
  )
}

// Percent thresholds are converted to basis points once, at load, so a
// malformed value fails here — naming the variable — rather than as a bare
// `RangeError` from BigInt(NaN) at the first import that pulls this module in.
const parsePercentToBps = (value: number, name: string): bigint => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid ${name}: "${value}" — use a non-negative number of percent ` +
        '(e.g. 2 or 2.5)',
    )
  }
  return BigInt(Math.round(value * 100))
}

const maxSwapDeviationBps = parsePercentToBps(
  config.priceOracle.maxSwapDeviationPercent,
  'ORACLE_MAX_SWAP_DEVIATION',
)

// Configured in whole USDC because that is how a human reasons about "is this
// market thick enough to price against"; compared in base units because that is
// what the samples carry.
const minWindowVolumeBaseUnits = (() => {
  try {
    return parseDecimalToScaledBigint(config.priceOracle.minWindowVolumeUsdc, 6)
  } catch {
    throw new Error(
      'Invalid ORACLE_MIN_WINDOW_VOLUME_USDC: ' +
        `"${config.priceOracle.minWindowVolumeUsdc}" — use a plain decimal ` +
        'number of USDC (e.g. 1000)',
    )
  }
})()

type CacheEntry = { value: OraclePrice; expiresAt: number }

// Module-level singleton state (same shape as paymentManager):
// - `cache`         last successful fresh price, valid until expiresAt.
// - `lastGood`      last successful price, served (as stale) during an outage.
// - `nextAttemptAt` earliest time we may query the indexer again; set after
//                   EVERY attempt so a degraded upstream is retried at most once
//                   per cacheTtlMs rather than on every request.
// - `inFlight`      collapses concurrent refreshes into one upstream round-trip.
let cache: CacheEntry | null = null
let lastGood: OraclePrice | null = null
let nextAttemptAt = 0
let inFlight: Promise<Result<OraclePrice, OracleUnavailableError>> | null = null
// Last observed state, for the admin dashboard and the treasury report. Held
// separately from `cache` because a failure must not evict a usable price, and
// because "why is the USDC path shut" is answered by the failure, not the price.
let lastWindow: SwapWindow | null = null
let lastSuccessAt: Date | null = null
let lastFailureAt: Date | null = null
let lastFailureReason: OracleUnavailableReason | null = null

const unavailable = (
  message: string,
  reason: OracleUnavailableReason,
): OracleUnavailableError => {
  lastFailureAt = new Date()
  lastFailureReason = reason
  logger.warn(`Price oracle unavailable (${reason}): ${message}`)
  return new OracleUnavailableError(message, reason)
}

/**
 * Read the recent swap window and reduce it to one rate, or refuse.
 *
 * The guards run cheapest-and-most-structural first, and each one fails closed:
 * there is no partial answer between "here is a rate the market supports" and
 * "do not charge anyone right now".
 *
 * Order is deliberate. Indexer lag comes before anything derived from the
 * samples, because a stalled indexer makes every subsequent judgement a
 * statement about the past dressed up as the present. Freshness comes before
 * the outlier trim, because trimming cannot rescue a window whose newest fill
 * is a week old. Volume is judged after the trim, since the volume that backs
 * the average is the surviving volume, not what was discarded with the
 * outliers.
 */
const buildWindow = async (): Promise<
  Result<SwapWindow, OracleUnavailableError>
> => {
  const controller = new AbortController()
  let response: Awaited<ReturnType<typeof fetchRecentSwaps>>
  try {
    response = await withTimeout(
      internal.fetchRecentSwaps(
        config.priceOracle.swapSampleSize,
        controller.signal,
      ),
      config.priceOracle.requestTimeoutMs,
      'priceOracle:subgraph',
      controller,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(unavailable(`could not read the subgraph: ${message}`, 'gateway'))
  }

  const now = Date.now()

  if (response.hasIndexingErrors) {
    return err(
      unavailable(
        'the subgraph reports indexing errors, so the swap history it served ' +
          'may be missing fills we cannot detect from here',
        'indexer-error',
      ),
    )
  }

  if (
    !isFresh(
      response.indexerTimestampMs,
      now,
      config.priceOracle.maxIndexLagMs,
    )
  ) {
    const lagMs = now - response.indexerTimestampMs
    return err(
      unavailable(
        `the indexer is ${Math.round(lagMs / 1000)}s behind at block ` +
          `${response.indexerBlock}, past the ` +
          `${config.priceOracle.maxIndexLagMs}ms limit`,
        'indexer-lag',
      ),
    )
  }

  const samples = response.samples
  if (samples.length < config.priceOracle.minSwapSamples) {
    return err(
      unavailable(
        `the pool has only ${samples.length} usable recent swaps, below the ` +
          `floor of ${config.priceOracle.minSwapSamples}`,
        'insufficient-samples',
      ),
    )
  }

  const newestSwapMs = Math.max(...samples.map((s) => s.timestampMs))
  const oldestSwapMs = Math.min(...samples.map((s) => s.timestampMs))
  if (!isFresh(newestSwapMs, now, config.priceOracle.maxSwapAgeMs)) {
    const ageMs = now - newestSwapMs
    return err(
      unavailable(
        `the most recent swap is ${Math.round(ageMs / 3_600_000)}h old, past ` +
          `the ${Math.round(config.priceOracle.maxSwapAgeMs / 3_600_000)}h ` +
          'limit — the market has stopped, whatever the indexer reports',
        'stale-window',
      ),
    )
  }

  const { kept, dropped } = trimOutliers(samples, maxSwapDeviationBps)
  if (kept.length < config.priceOracle.minSwapSamples) {
    return err(
      unavailable(
        `${dropped} of ${samples.length} swaps deviated past ` +
          `${config.priceOracle.maxSwapDeviationPercent}% from the window ` +
          `median, leaving ${kept.length} — below the floor of ` +
          `${config.priceOracle.minSwapSamples}`,
        'insufficient-samples',
      ),
    )
  }

  const volumeUsdc = windowVolumeUsdc(kept)
  if (volumeUsdc < minWindowVolumeBaseUnits) {
    return err(
      unavailable(
        `the window traded ${volumeUsdc} USDC base units, below the ` +
          `${config.priceOracle.minWindowVolumeUsdc} USDC floor — an average ` +
          'over dust is not a market price',
        'thin-volume',
      ),
    )
  }

  const usdPerAi3 = volumeWeightedPrice(kept)
  if (!isWithinBounds(usdPerAi3, minScaled, maxScaled)) {
    return err(
      unavailable(
        `the window averages ${usdPerAi3} (scaled 1e18), outside the ` +
          `configured bounds [${minScaled}, ${maxScaled}]`,
        'out-of-bounds',
      ),
    )
  }

  return ok({
    usdPerAi3,
    sampleCount: kept.length,
    droppedOutliers: dropped,
    volumeUsdc,
    newestSwapMs,
    oldestSwapMs,
    indexerBlock: response.indexerBlock,
    indexerTimestampMs: response.indexerTimestampMs,
  })
}

// Grouped so unit tests can spy on the collaborators (jest.spyOn), mirroring how
// paymentManager exposes _viemClient. Not for use outside tests.
const internal = {
  fetchRecentSwaps,
  buildWindow,
}

// Serve the last good price as a stale fallback, or error if none is fresh
// enough.
//
// The error always carries the reason the READ failed, never "there was no
// fallback": the absence of a fallback is why the caller is seeing an error at
// all, but what closed the payment path is the guard, and that is what a status
// code (#747) and a dashboard (#811) have to name. Whether a fallback was
// available is visible through `getHealth`.
const serveStaleOrError = (
  failureReason: OracleUnavailableReason,
): Result<OraclePrice, OracleUnavailableError> => {
  if (
    lastGood &&
    Date.now() - lastGood.asOf.getTime() < config.priceOracle.maxStaleMs
  ) {
    // A stale fallback is never a fresh TTL cache hit — `fromCache` is reserved
    // for the live cache hit in getPrice, so it is always false here.
    return ok({ ...lastGood, fromCache: false, stale: true })
  }
  return err(
    new OracleUnavailableError(
      'Price oracle unavailable: the recent-swap window could not be used ' +
        `(${failureReason}), and no last-good price is within ` +
        `${config.priceOracle.maxStaleMs}ms`,
      failureReason,
    ),
  )
}

// Refresh from the indexer, updating cache + last-good on success. Always
// resolves (never rejects) so the neverthrow contract holds.
const refresh = async (): Promise<
  Result<OraclePrice, OracleUnavailableError>
> => {
  const window = await internal.buildWindow()
  // Throttle the next upstream attempt regardless of outcome, so a degraded
  // source is retried at most once per cacheTtlMs instead of on every request.
  nextAttemptAt = Date.now() + config.priceOracle.cacheTtlMs

  if (window.isErr()) {
    return serveStaleOrError(window.error.reason)
  }

  const value: OraclePrice = {
    usdPerAi3: window.value.usdPerAi3,
    asOf: new Date(),
    fromCache: false,
    stale: false,
  }
  cache = { value, expiresAt: Date.now() + config.priceOracle.cacheTtlMs }
  lastGood = value
  lastWindow = window.value
  lastSuccessAt = value.asOf
  lastFailureReason = null
  logger.debug(
    `Price oracle refreshed AI3/USD=${window.value.usdPerAi3.toString()} ` +
      `(scaled 1e18) from ${window.value.sampleCount} swaps totalling ` +
      `${window.value.volumeUsdc} USDC base units`,
  )
  return ok(value)
}

/**
 * Current AI3/USD price as USD-per-AI3 scaled by USD_RATE_SCALE (1e18).
 *
 * The volume-weighted average of the pool's most recent swaps — what the market
 * has actually been filling at, rather than what the pool would quote for one
 * more trade. Both the display rate and the charged rate derive from this one
 * number; the only wedge between them is USD_QUOTE_MARGIN, applied at the
 * quoting layer (see `applyMarginPercent`).
 *
 * Serves the cached value while fresh; otherwise re-reads the window, with
 * concurrent callers sharing one in-flight request. When a recent read failed,
 * subsequent calls within `cacheTtlMs` serve the last-good value (or error)
 * without re-hitting upstream, so a degraded source is not hammered.
 *
 * Caching an average over days is not the compromise caching a spot price would
 * be: a minute of staleness cannot move a figure built from a week of fills.
 *
 * Returns `err(OracleUnavailableError)` when no trustworthy price is available;
 * `error.reason` says which guard closed the door, and the USDC payment path
 * is expected to stay shut until it opens.
 */
const getPrice = async (): Promise<
  Result<OraclePrice, OracleUnavailableError>
> => {
  const now = Date.now()
  if (cache && now < cache.expiresAt) {
    return ok({ ...cache.value, fromCache: true })
  }
  if (now < nextAttemptAt) {
    // Upstream was attempted recently and is degraded; serve the last-good
    // fallback (stale) rather than re-querying.
    return serveStaleOrError(lastFailureReason ?? 'gateway')
  }
  if (inFlight) {
    return inFlight
  }
  inFlight = refresh()
  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

/**
 * What the oracle currently knows, for the admin dashboard and the treasury
 * report.
 *
 * Deliberately a plain snapshot with no side effects: a status panel must never
 * be the thing that triggers an upstream read, or watching the dashboard would
 * change what the dashboard reports.
 */
const getHealth = (): OracleHealth => ({
  lastSuccessAt,
  lastFailureAt,
  lastFailureReason,
  window: lastWindow,
  // "The last attempt failed and there is still something to serve." Note this
  // cannot be inferred from `cache` being expired: a failed refresh leaves the
  // stale entry in place rather than evicting it, so an expired cache is the
  // normal state between reads, not a symptom.
  servingStale:
    lastFailureReason !== null &&
    lastGood !== null &&
    Date.now() - lastGood.asOf.getTime() < config.priceOracle.maxStaleMs,
})

// Clear all singleton state. Test-only (the service is a module singleton).
const reset = (): void => {
  cache = null
  lastGood = null
  nextAttemptAt = 0
  inFlight = null
  lastWindow = null
  lastSuccessAt = null
  lastFailureAt = null
  lastFailureReason = null
}

export const priceOracle = {
  getPrice,
  getHealth,
  // Internal collaborators exposed for unit tests (spy/override), matching the
  // `_`-prefixed convention used by paymentManager.
  _internal: internal,
  _refresh: refresh,
  _reset: reset,
}
