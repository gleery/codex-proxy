import type { AccountEntry, CodexQuota, CodexQuotaCredits } from "./types.js";
import { getRateLimitIdForModel } from "./quota-utils.js";

/** A primary window at least this long is the plan's weekly cap (plans without a secondary window). */
const LONG_WINDOW_SECONDS = 24 * 60 * 60;

/** True when the primary, secondary, code_review or model-specific cachedQuota bucket reports limit_reached. */
export function isQuotaExhausted(quota: CodexQuota | null | undefined, model?: string | null): boolean {
  if (!quota) return false;
  if (
    quota.rate_limit.limit_reached === true ||
    quota.secondary_rate_limit?.limit_reached === true ||
    quota.code_review_rate_limit?.limit_reached === true
  ) {
    return true;
  }
  const limitId = getRateLimitIdForModel(model);
  if (limitId && quota.rate_limits_by_limit_id?.[limitId]?.limit_reached === true) {
    return true;
  }
  return false;
}

/**
 * True when the weekly cap is exhausted: the secondary window, or — for plans
 * that only report one window — a primary window of a day or longer.
 * A short (5-hour) primary window running out on its own does not count.
 */
export function isWeeklyQuotaExhausted(quota: CodexQuota | null | undefined): boolean {
  if (!quota) return false;
  if (quota.secondary_rate_limit) return quota.secondary_rate_limit.limit_reached === true;
  return quota.rate_limit.limit_reached === true &&
    (quota.rate_limit.limit_window_seconds ?? 0) >= LONG_WINDOW_SECONDS;
}

/** True when the account has a credit balance upstream can bill against. */
export function hasUsableCredits(credits: CodexQuotaCredits | null | undefined): boolean {
  if (!credits || credits.overage_limit_reached) return false;
  return credits.unlimited || (credits.has_credits && credits.balance > 0);
}

/**
 * True when an exhausted account should keep serving from its credit balance:
 * the operator opted in (`creditFallback`), the weekly cap is what ran out,
 * credits remain, and upstream hasn't recently rejected the account.
 */
export function isServingFromCredits(
  entry: AccountEntry,
  model?: string | null,
  nowSec: number = Date.now() / 1000,
): boolean {
  if (entry.creditFallback !== true) return false;
  const quota = entry.cachedQuota;
  if (!isQuotaExhausted(quota, model) || !isWeeklyQuotaExhausted(quota)) return false;
  if (!hasUsableCredits(quota?.credits)) return false;
  const suspendedUntil = entry.creditFallbackSuspendedUntil;
  return suspendedUntil == null || suspendedUntil <= nowSec;
}

/**
 * True when the account must be skipped for quota reasons. Accounts serving
 * from credits (see {@link isServingFromCredits}) stay usable.
 */
export function hasReachedCachedQuota(entry: AccountEntry, model?: string | null): boolean {
  return isQuotaExhausted(entry.cachedQuota, model) && !isServingFromCredits(entry, model);
}
