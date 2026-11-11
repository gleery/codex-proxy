/**
 * Per-account concurrency limits.
 *
 * Each account may carry its own `maxConcurrent` override. When unset (null),
 * the account inherits the global `auth.max_concurrent_per_account` setting.
 */

import type { AccountEntry } from "./types.js";

/** Fallback used when the global setting is null/missing. */
export const DEFAULT_MAX_CONCURRENT_PER_ACCOUNT = 3;

/** Upper bound accepted for a per-account override (sanity guard). */
export const MAX_ACCOUNT_CONCURRENCY_OVERRIDE = 1000;

/**
 * Normalize a persisted / user-supplied override. Anything that is not an
 * integer in [1, MAX_ACCOUNT_CONCURRENCY_OVERRIDE] becomes null (= inherit).
 */
export function normalizeMaxConcurrent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_ACCOUNT_CONCURRENCY_OVERRIDE) return null;
  return value;
}

/** Resolve the global per-account default from config. */
export function resolveGlobalMaxConcurrent(globalValue: number | null | undefined): number {
  return globalValue ?? DEFAULT_MAX_CONCURRENT_PER_ACCOUNT;
}

/** Effective concurrency cap for a single account. */
export function resolveAccountMaxConcurrent(
  entry: Pick<AccountEntry, "maxConcurrent">,
  globalMax: number,
): number {
  return normalizeMaxConcurrent(entry.maxConcurrent) ?? globalMax;
}
