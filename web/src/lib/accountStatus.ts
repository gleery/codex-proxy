/**
 * Derived account status helpers.
 *
 * The backend now stores account.status as a pure rotation marker
 * (`active | expired | refreshing | disabled | banned | quota_exhausted`).
 * The "已限速 / rate_limited" state is no longer a backend-level enum value;
 * it lives in `account.quota.<bucket>.limit_reached` instead. The dashboard
 * derives the user-facing label from both signals via {@link derivedStatus}.
 *
 * Keep this helper as the single derivation point so all components agree.
 */

import type { Account, AccountQuota, AccountQuotaWindow } from "../../../shared/types";

/**
 * Mirrors the server's `isWindowSpent`: limit_reached, or 100% used before the
 * window resets (upstream reports a full window on a credit account as allowed).
 */
function isWindowSpent(window: AccountQuotaWindow | undefined | null, nowSec: number): boolean {
  if (!window) return false;
  if (window.limit_reached === true) return true;
  return (window.used_percent ?? 0) >= 100 && window.reset_at != null && window.reset_at > nowSec;
}

/** True when any of the 3 cachedQuota buckets is exhausted. */
export function isQuotaExhausted(quota: AccountQuota | undefined | null): boolean {
  if (!quota) return false;
  const nowSec = Date.now() / 1000;
  return isWindowSpent(quota.rate_limit, nowSec) ||
    isWindowSpent(quota.secondary_rate_limit, nowSec) ||
    quota.code_review_rate_limit?.limit_reached === true;
}

/**
 * Effective status: cachedQuota wins over backend status when any bucket
 * limit is reached. Returns the string the existing `statusStyles` map keys
 * on (active, expired, quota_exhausted, refreshing, disabled, banned,
 * rate_limited, credit_fallback).
 */
export function derivedStatus(account: Account): string {
  // Exhausted but opted in to keep serving from its credit balance.
  if (account.status === "active" && account.creditFallbackActive === true) {
    return "credit_fallback";
  }
  if (account.status === "active" && isQuotaExhausted(account.quota)) {
    return "rate_limited";
  }
  return account.status;
}
