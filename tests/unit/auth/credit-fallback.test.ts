/**
 * Per-account credit fallback (AccountEntry.creditFallback): once the weekly
 * window is exhausted, an opted-in account keeps serving from its credit
 * balance instead of dropping out of rotation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool, CREDIT_FALLBACK_SUSPEND_SECONDS } from "@src/auth/account-pool.js";
import {
  hasReachedCachedQuota,
  hasUsableCredits,
  isServingFromCredits,
  isWeeklyQuotaExhausted,
} from "@src/auth/quota-skip.js";
import type { CodexQuota, CodexQuotaCredits } from "@src/auth/types.js";

const HOUR = 3600;
const WEEK = 7 * 24 * HOUR;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function credits(overrides?: Partial<CodexQuotaCredits>): CodexQuotaCredits {
  return { has_credits: true, unlimited: false, overage_limit_reached: false, balance: 120, ...overrides };
}

/** Plus-style quota: 5h primary + weekly secondary. */
function quota(opts: {
  primaryReached?: boolean;
  weeklyReached?: boolean;
  credits?: CodexQuotaCredits | null;
} = {}): CodexQuota {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: !opts.primaryReached,
      limit_reached: opts.primaryReached ?? false,
      used_percent: opts.primaryReached ? 100 : 40,
      reset_at: nowSec() + 2 * HOUR,
      limit_window_seconds: 5 * HOUR,
    },
    secondary_rate_limit: {
      limit_reached: opts.weeklyReached ?? false,
      used_percent: opts.weeklyReached ? 100 : 60,
      reset_at: nowSec() + 3 * 24 * HOUR,
      limit_window_seconds: WEEK,
    },
    code_review_rate_limit: null,
    credits: opts.credits === undefined ? credits() : opts.credits,
  };
}

function makePool(): AccountPool {
  return new AccountPool({
    persistence: createMemoryPersistence(),
    rotationStrategy: "least_used",
    initialToken: null,
    rateLimitBackoffSeconds: 60,
  });
}

let seq = 0;
function addAccount(pool: AccountPool, q?: CodexQuota, creditFallback = false): string {
  seq++;
  const id = pool.addAccount(createValidJwt({ accountId: `acct-${seq}`, email: `u${seq}@test.com` }));
  if (q) pool.updateCachedQuota(id, q);
  if (creditFallback) pool.setCreditFallback(id, true);
  return id;
}

beforeEach(() => {
  delete process.env.CODEX_JWT_TOKEN;
  setConfigForTesting(createMockConfig());
});

afterEach(() => {
  resetConfigForTesting();
});

describe("quota helpers", () => {
  it("isWeeklyQuotaExhausted looks at the weekly window, not the 5h one", () => {
    expect(isWeeklyQuotaExhausted(quota({ weeklyReached: true }))).toBe(true);
    expect(isWeeklyQuotaExhausted(quota({ primaryReached: true }))).toBe(false);
    expect(isWeeklyQuotaExhausted(null)).toBe(false);
  });

  it("isWeeklyQuotaExhausted treats a long single primary window as the weekly cap", () => {
    const single = (windowSec: number): CodexQuota => ({
      ...quota(),
      rate_limit: { allowed: false, limit_reached: true, used_percent: 100, reset_at: null, limit_window_seconds: windowSec },
      secondary_rate_limit: null,
    });
    expect(isWeeklyQuotaExhausted(single(WEEK))).toBe(true);
    expect(isWeeklyQuotaExhausted(single(5 * HOUR))).toBe(false);
  });

  it("hasUsableCredits requires a positive balance or unlimited, and no overage cap", () => {
    expect(hasUsableCredits(credits())).toBe(true);
    expect(hasUsableCredits(credits({ balance: 0 }))).toBe(false);
    expect(hasUsableCredits(credits({ has_credits: false }))).toBe(false);
    expect(hasUsableCredits(credits({ balance: 0, unlimited: true }))).toBe(true);
    expect(hasUsableCredits(credits({ overage_limit_reached: true }))).toBe(false);
    expect(hasUsableCredits(null)).toBe(false);
  });
});

describe("which exhausted accounts stay usable", () => {
  it("keeps a weekly-exhausted account with credits when opted in", () => {
    const pool = makePool();
    const id = addAccount(pool, quota({ primaryReached: true, weeklyReached: true }), true);
    const entry = pool.getEntry(id)!;
    expect(isServingFromCredits(entry)).toBe(true);
    expect(hasReachedCachedQuota(entry)).toBe(false);
  });

  it("skips it when the toggle is off (default)", () => {
    const pool = makePool();
    const id = addAccount(pool, quota({ weeklyReached: true }));
    const entry = pool.getEntry(id)!;
    expect(entry.creditFallback).toBe(false);
    expect(hasReachedCachedQuota(entry)).toBe(true);
  });

  it("does not bill credits when only the 5h window ran out", () => {
    const pool = makePool();
    const id = addAccount(pool, quota({ primaryReached: true }), true);
    expect(hasReachedCachedQuota(pool.getEntry(id)!)).toBe(true);
  });

  it("skips it once the credit balance is gone", () => {
    const pool = makePool();
    const id = addAccount(pool, quota({ weeklyReached: true, credits: credits({ balance: 0 }) }), true);
    expect(hasReachedCachedQuota(pool.getEntry(id)!)).toBe(true);
  });

  it("returns to normal rotation once the weekly window resets", () => {
    const pool = makePool();
    const id = addAccount(pool, quota({ weeklyReached: true }), true);
    pool.updateCachedQuota(id, quota());
    const entry = pool.getEntry(id)!;
    expect(isServingFromCredits(entry)).toBe(false);
    expect(hasReachedCachedQuota(entry)).toBe(false);
  });
});

describe("acquire", () => {
  it("prefers accounts with plan quota over billing credits", () => {
    const pool = makePool();
    const credit = addAccount(pool, quota({ weeklyReached: true }), true);
    const normal = addAccount(pool, quota());
    for (let i = 0; i < 3; i++) {
      expect(pool.acquire()?.entryId).toBe(normal);
    }
    expect(pool.getActiveSlotCount(credit)).toBe(0);
  });

  it("falls back to the credit account when no plan quota is left", () => {
    const pool = makePool();
    const credit = addAccount(pool, quota({ weeklyReached: true }), true);
    addAccount(pool, quota({ weeklyReached: true }));
    expect(pool.acquire()?.entryId).toBe(credit);
  });

  it("overflows to the credit account when plan-quota accounts are at capacity", () => {
    setConfigForTesting(createMockConfig({ auth: { max_concurrent_per_account: 1 } }));
    const pool = makePool();
    const credit = addAccount(pool, quota({ weeklyReached: true }), true);
    const normal = addAccount(pool, quota());
    expect(pool.acquire()?.entryId).toBe(normal);
    expect(pool.acquire()?.entryId).toBe(credit);
    expect(pool.acquire()).toBeNull();
  });

  it("counts credit-serving accounts as available capacity", () => {
    const pool = makePool();
    addAccount(pool, quota({ weeklyReached: true }), true);
    expect(pool.hasAvailableAccounts()).toBe(true);
    expect(pool.isAuthenticated()).toBe(true);
    expect(pool.getCapacitySummary().total_slots).toBe(3);
  });
});

describe("rate-limit side effects", () => {
  it("keeps in-flight slots when passive headers re-mark a credit-serving account", () => {
    const pool = makePool();
    const id = addAccount(pool, quota({ primaryReached: true, weeklyReached: true }), true);
    expect(pool.acquire()?.entryId).toBe(id);

    // Successful responses on a credit-billed account still report 100% used.
    pool.applyRateLimit429(id, { resetsAtSec: nowSec() + 2 * HOUR });
    expect(pool.getActiveSlotCount(id)).toBe(1);
  });

  it("still clears slots for accounts that become unusable", () => {
    const pool = makePool();
    const id = addAccount(pool, quota());
    expect(pool.acquire()?.entryId).toBe(id);
    pool.applyRateLimit429(id, { retryAfterSec: 600 });
    expect(pool.getActiveSlotCount(id)).toBe(0);
  });
});

describe("suspension after upstream rejection", () => {
  it("is a no-op for accounts without credit fallback", () => {
    const pool = makePool();
    const id = addAccount(pool, quota({ weeklyReached: true }));
    expect(pool.suspendCreditFallback(id, 600)).toBe(false);
    expect(pool.getEntry(id)!.creditFallbackSuspendedUntil ?? null).toBeNull();
  });

  it("drops the account from rotation until upstream's retry hint", () => {
    const pool = makePool();
    const id = addAccount(pool, quota({ weeklyReached: true }), true);
    const before = Date.now() / 1000;
    expect(pool.suspendCreditFallback(id, 600)).toBe(true);

    const entry = pool.getEntry(id)!;
    expect(entry.creditFallbackSuspendedUntil).toBeGreaterThanOrEqual(before + 600);
    expect(hasReachedCachedQuota(entry)).toBe(true);
    expect(pool.acquire()).toBeNull();

    // Once the hint has passed the account serves from credits again.
    expect(isServingFromCredits(entry, null, entry.creditFallbackSuspendedUntil! + 1)).toBe(true);
  });

  it("uses a default pause when upstream gave no retry hint", () => {
    const pool = makePool();
    const id = addAccount(pool, quota({ weeklyReached: true }), true);
    const before = Date.now() / 1000;
    pool.suspendCreditFallback(id);
    const until = pool.getEntry(id)!.creditFallbackSuspendedUntil!;
    expect(until).toBeGreaterThanOrEqual(before + CREDIT_FALLBACK_SUSPEND_SECONDS);
    expect(until).toBeLessThan(before + CREDIT_FALLBACK_SUSPEND_SECONDS + 5);
  });

  it("never shortens an existing pause", () => {
    const pool = makePool();
    const id = addAccount(pool, quota({ weeklyReached: true }), true);
    pool.suspendCreditFallback(id, 3 * HOUR);
    const longer = pool.getEntry(id)!.creditFallbackSuspendedUntil!;
    pool.suspendCreditFallback(id, 60);
    expect(pool.getEntry(id)!.creditFallbackSuspendedUntil).toBe(longer);
  });

  it("re-enabling the toggle clears the pause", () => {
    const pool = makePool();
    const id = addAccount(pool, quota({ weeklyReached: true }), true);
    pool.suspendCreditFallback(id, 600);
    pool.setCreditFallback(id, false);
    pool.setCreditFallback(id, true);
    expect(pool.getEntry(id)!.creditFallbackSuspendedUntil).toBeNull();
    expect(pool.acquire()?.entryId).toBe(id);
  });
});

describe("account info", () => {
  it("reports the toggle, whether credits are being used, and any pause", () => {
    const pool = makePool();
    const id = addAccount(pool, quota({ weeklyReached: true }), true);
    const info = () => pool.getAccounts().find((a) => a.id === id)!;

    expect(info()).toMatchObject({ creditFallback: true, creditFallbackActive: true, creditFallbackSuspendedUntil: null });

    pool.suspendCreditFallback(id, 600);
    expect(info().creditFallbackActive).toBe(false);
    expect(info().creditFallbackSuspendedUntil).toBeGreaterThan(Date.now() / 1000);

    expect(pool.setCreditFallback("missing", true)).toBe(false);
  });

  it("defaults new accounts to off", () => {
    const pool = makePool();
    const id = addAccount(pool, quota());
    expect(pool.getAccounts().find((a) => a.id === id)).toMatchObject({
      creditFallback: false,
      creditFallbackActive: false,
      creditFallbackSuspendedUntil: null,
    });
  });
});
