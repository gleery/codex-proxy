import type { AccountEntry, CodexQuota, CodexQuotaCredits, CodexQuotaWindow } from "./types.js";
import { getRateLimitIdForModel } from "./quota-utils.js";

/** A primary window at least this long is the plan's weekly cap (plans without a secondary window). */
const LONG_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * True when a usage window is spent: upstream flagged `limit_reached`, or
 * usage hit 100% and the window has not reset yet.
 *
 * The usage check matters for accounts with credits: `/codex/usage` reports a
 * full window as `allowed` / not reached because upstream would bill the
 * credit balance, while response headers mark the same window reached. Going
 * by `limit_reached` alone made those accounts flip between "exhausted" and
 * "has quota", spending credits on accounts that never opted in. A future
 * `reset_at` is required so a stale 100% cannot lock an account forever.
 */
export function isWindowSpent(
  window: (CodexQuotaWindow & { limit_reached?: boolean }) | null | undefined,
  nowSec: number = Date.now() / 1000,
): boolean {
  if (!window) return false;
  if (window.limit_reached === true) return true;
  return (window.used_percent ?? 0) >= 100 && window.reset_at != null && window.reset_at > nowSec;
}

/**
 * True when the primary, secondary, code_review or model-specific cachedQuota
 * bucket is exhausted. Primary and secondary also count once usage hits 100%
 * (see {@link isWindowSpent}).
 */
export function isQuotaExhausted(
  quota: CodexQuota | null | undefined,
  model?: string | null,
  nowSec: number = Date.now() / 1000,
): boolean {
  if (!quota) return false;
  if (
    isWindowSpent(quota.rate_limit, nowSec) ||
    isWindowSpent(quota.secondary_rate_limit, nowSec) ||
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
 * True when the weekly cap is exhausted: a spent window of a day or longer —
 * the primary window on plans whose primary is the weekly cap (Pro), or the
 * secondary window (Plus). A secondary window with an unknown length counts as
 * weekly; a short (5-hour) primary window running out on its own does not.
 *
 * Decided per window rather than "secondary if present": upstream can report
 * an empty secondary window (0% used, no length, no reset) next to a spent
 * weekly primary, which must not hide the exhausted weekly cap.
 */
export function isWeeklyQuotaExhausted(
  quota: CodexQuota | null | undefined,
  nowSec: number = Date.now() / 1000,
): boolean {
  if (!quota) return false;
  const primary = quota.rate_limit;
  if (isWindowSpent(primary, nowSec) && (primary.limit_window_seconds ?? 0) >= LONG_WINDOW_SECONDS) {
    return true;
  }
  const secondary = quota.secondary_rate_limit;
  return secondary != null &&
    isWindowSpent(secondary, nowSec) &&
    (secondary.limit_window_seconds == null || secondary.limit_window_seconds >= LONG_WINDOW_SECONDS);
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
  if (!isQuotaExhausted(quota, model, nowSec) || !isWeeklyQuotaExhausted(quota, nowSec)) return false;
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
