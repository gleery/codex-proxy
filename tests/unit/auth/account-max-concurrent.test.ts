/**
 * Per-account concurrency limit (AccountEntry.maxConcurrent).
 * Zero vi.mock() — config injected via setConfigForTesting().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { AccountQueryService } from "@src/services/account-query.js";
import {
  normalizeMaxConcurrent,
  resolveAccountMaxConcurrent,
} from "@src/auth/account-concurrency.js";

function makePool(): AccountPool {
  return new AccountPool({
    persistence: createMemoryPersistence(),
    rotationStrategy: "least_used",
    initialToken: null,
    rateLimitBackoffSeconds: 60,
  });
}

function acquireN(pool: AccountPool, n: number): Array<string | null> {
  const out: Array<string | null> = [];
  for (let i = 0; i < n; i++) out.push(pool.acquire()?.entryId ?? null);
  return out;
}

beforeEach(() => {
  delete process.env.CODEX_JWT_TOKEN;
});

afterEach(() => {
  resetConfigForTesting();
});

describe("normalizeMaxConcurrent", () => {
  it("accepts positive integers within range", () => {
    expect(normalizeMaxConcurrent(1)).toBe(1);
    expect(normalizeMaxConcurrent(1000)).toBe(1000);
  });

  it("maps invalid values to null (inherit global)", () => {
    for (const v of [undefined, null, 0, -1, 1.5, 1001, "2", NaN, {}]) {
      expect(normalizeMaxConcurrent(v)).toBeNull();
    }
  });

  it("resolves override before global", () => {
    expect(resolveAccountMaxConcurrent({ maxConcurrent: 5 }, 2)).toBe(5);
    expect(resolveAccountMaxConcurrent({ maxConcurrent: null }, 2)).toBe(2);
    expect(resolveAccountMaxConcurrent({}, 2)).toBe(2);
  });
});

describe("acquire honours per-account maxConcurrent", () => {
  it("override above global lets one account take more slots", () => {
    setConfigForTesting(createMockConfig({ auth: { max_concurrent_per_account: 1 } }));
    const pool = makePool();
    const id = pool.addAccount(createValidJwt({ accountId: "a1", email: "a@test.com" }));

    expect(pool.setMaxConcurrent(id, 3)).toBe(true);
    expect(acquireN(pool, 4)).toEqual([id, id, id, null]);
    expect(pool.getActiveSlotCount(id)).toBe(3);
  });

  it("override below global caps a single account", () => {
    setConfigForTesting(createMockConfig({ auth: { max_concurrent_per_account: 5 } }));
    const pool = makePool();
    const id = pool.addAccount(createValidJwt({ accountId: "a1", email: "a@test.com" }));

    pool.setMaxConcurrent(id, 1);
    expect(acquireN(pool, 2)).toEqual([id, null]);

    pool.release(id);
    expect(pool.acquire()?.entryId).toBe(id);
  });

  it("limited account overflows to other accounts", () => {
    setConfigForTesting(createMockConfig({ auth: { max_concurrent_per_account: 2 } }));
    const pool = makePool();
    const limited = pool.addAccount(createValidJwt({ accountId: "a1", email: "a@test.com" }));
    const normal = pool.addAccount(createValidJwt({ accountId: "a2", email: "b@test.com" }));
    pool.setMaxConcurrent(limited, 1);

    const got = acquireN(pool, 4);
    expect(got.filter((x) => x === limited)).toHaveLength(1);
    expect(got.filter((x) => x === normal)).toHaveLength(2);
    expect(got[3]).toBeNull();
  });

  it("null reverts to the global setting", () => {
    setConfigForTesting(createMockConfig({ auth: { max_concurrent_per_account: 1 } }));
    const pool = makePool();
    const id = pool.addAccount(createValidJwt({ accountId: "a1", email: "a@test.com" }));
    pool.setMaxConcurrent(id, 4);
    pool.setMaxConcurrent(id, null);

    expect(pool.getEntry(id)!.maxConcurrent).toBeNull();
    expect(acquireN(pool, 2)).toEqual([id, null]);
  });

  it("lowering the cap doesn't drop in-flight slots but blocks new ones", () => {
    setConfigForTesting(createMockConfig({ auth: { max_concurrent_per_account: 3 } }));
    const pool = makePool();
    const id = pool.addAccount(createValidJwt({ accountId: "a1", email: "a@test.com" }));
    acquireN(pool, 3);

    pool.setMaxConcurrent(id, 1);
    expect(pool.getActiveSlotCount(id)).toBe(3);
    expect(pool.acquire()).toBeNull();

    pool.release(id);
    pool.release(id);
    expect(pool.acquire()).toBeNull(); // still 1 in flight == cap
    pool.release(id);
    expect(pool.acquire()?.entryId).toBe(id);
  });

  it("setMaxConcurrent returns false for unknown accounts", () => {
    setConfigForTesting(createMockConfig());
    expect(makePool().setMaxConcurrent("nope", 2)).toBe(false);
  });
});

describe("capacity + listing", () => {
  it("capacity summary sums per-account caps", () => {
    setConfigForTesting(createMockConfig({ auth: { max_concurrent_per_account: 3 } }));
    const pool = makePool();
    const a = pool.addAccount(createValidJwt({ accountId: "a1", email: "a@test.com" }));
    pool.addAccount(createValidJwt({ accountId: "a2", email: "b@test.com" }));
    pool.setMaxConcurrent(a, 10);

    const summary = pool.getCapacitySummary();
    expect(summary.max_concurrent_per_account).toBe(3);
    expect(summary.total_slots).toBe(13);
    expect(summary.available_slots).toBe(13);
  });

  it("account listing defaults the global cap to 3 when no getter is injected", () => {
    setConfigForTesting(createMockConfig());
    const pool = makePool();
    pool.addAccount(createValidJwt({ accountId: "a1", email: "a@test.com" }));
    expect(new AccountQueryService(pool).listCached()[0].effectiveMaxConcurrent).toBe(3);
  });

  it("account listing exposes override, effective cap and in-flight count", () => {
    setConfigForTesting(createMockConfig({ auth: { max_concurrent_per_account: 2 } }));
    const pool = makePool();
    const a = pool.addAccount(createValidJwt({ accountId: "a1", email: "a@test.com" }));
    const b = pool.addAccount(createValidJwt({ accountId: "a2", email: "b@test.com" }));
    pool.setMaxConcurrent(a, 7);
    pool.setMaxConcurrent(b, 1);
    pool.acquire(); // goes to some account; check totals below

    const list = new AccountQueryService(pool, undefined, () => 2).listCached();
    const byId = new Map(list.map((x) => [x.id, x]));
    expect(byId.get(a)).toMatchObject({ maxConcurrent: 7, effectiveMaxConcurrent: 7 });
    expect(byId.get(b)).toMatchObject({ maxConcurrent: 1, effectiveMaxConcurrent: 1 });
    expect(list.reduce((n, x) => n + x.activeRequests, 0)).toBe(1);

    pool.setMaxConcurrent(a, null);
    const after = new AccountQueryService(pool, undefined, () => 2).listCached().find((x) => x.id === a)!;
    expect(after).toMatchObject({ maxConcurrent: null, effectiveMaxConcurrent: 2 });
  });
});
