import { describe, expect, it } from "vitest";
import type { Account } from "../../../shared/types";
import { derivedStatus, isQuotaExhausted } from "./accountStatus";

const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

function fullWindow(overrides: Record<string, unknown> = {}) {
  return { used_percent: 100, limit_reached: false, reset_at: nowSec() + 2 * HOUR, limit_window_seconds: 604800, ...overrides };
}

describe("isQuotaExhausted", () => {
  it("counts a window at 100% that upstream still reports as not reached", () => {
    expect(isQuotaExhausted({ rate_limit: fullWindow() })).toBe(true);
    expect(isQuotaExhausted({ rate_limit: { used_percent: 40 }, secondary_rate_limit: fullWindow() })).toBe(true);
  });

  it("ignores a stale or reset-less 100%", () => {
    expect(isQuotaExhausted({ rate_limit: fullWindow({ reset_at: nowSec() - 60 }) })).toBe(false);
    expect(isQuotaExhausted({ rate_limit: fullWindow({ reset_at: null }) })).toBe(false);
  });
});

describe("derivedStatus", () => {
  const account = (over: Partial<Account>): Account =>
    ({ id: "a", status: "active", quota: { rate_limit: fullWindow() }, ...over }) as Account;

  it("shows a full account without the credit toggle as rate limited", () => {
    expect(derivedStatus(account({ creditFallbackActive: false }))).toBe("rate_limited");
  });

  it("shows an opted-in account as using credits", () => {
    expect(derivedStatus(account({ creditFallbackActive: true }))).toBe("credit_fallback");
  });
});
