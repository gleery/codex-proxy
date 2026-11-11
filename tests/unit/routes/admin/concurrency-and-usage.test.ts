import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { ClientKeyPool } from "@src/auth/client-key-pool.js";
import { createConcurrencyRoutes } from "@src/routes/admin/concurrency.js";
import { createClientKeyAdminRoutes } from "@src/routes/admin/client-keys.js";
import type { ClientKeyEntry, ClientKeyPeriodUsage } from "@src/auth/client-key-types.js";
import type { ClientKeyPersistence } from "@src/auth/client-key-persistence.js";

const MASTER = "master-for-route-tests";

function mockKeyPersistence(usage: Record<string, ClientKeyPeriodUsage> = {}) {
  let store: ClientKeyEntry[] = [];
  return {
    load: vi.fn(() => [...store]),
    save: vi.fn((keys: ClientKeyEntry[]) => { store = [...keys]; }),
    recordHourlyUsage: vi.fn(),
    queryUsageSince: vi.fn(() => structuredClone(usage)),
    deleteUsage: vi.fn(),
  } as unknown as ClientKeyPersistence & { queryUsageSince: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  setConfigForTesting(createMockConfig({ auth: { max_concurrent_per_account: 2 } }));
  delete process.env.CODEX_JWT_TOKEN;
});
afterEach(() => resetConfigForTesting());

describe("GET /admin/concurrency", () => {
  it("reports global, per-account and per-key in-flight counts", async () => {
    const accounts = new AccountPool({
      persistence: createMemoryPersistence(),
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });
    const a = accounts.addAccount(createValidJwt({ accountId: "a1", email: "a@test.com" }));
    const b = accounts.addAccount(createValidJwt({ accountId: "a2", email: "b@test.com" }));
    accounts.setMaxConcurrent(b, 5);
    accounts.acquire();
    accounts.acquire();
    accounts.acquire();

    const keys = new ClientKeyPool(mockKeyPersistence(), () => MASTER);
    const k = keys.createKey({ name: "Alice" });
    keys.acquireSlot(k.id);

    const app = new Hono().route("/", createConcurrencyRoutes(accounts, keys));
    const body = await (await app.request("/admin/concurrency")).json();

    expect(body.global).toMatchObject({ active: 3, capacity: 7, available: 4, client_key_active: 1 });
    const byId = new Map(body.accounts.map((x: { id: string }) => [x.id, x]));
    expect(byId.get(a)).toMatchObject({ max: 2 });
    expect(byId.get(b)).toMatchObject({ max: 5 });
    expect(body.client_keys).toEqual([{ id: k.id, name: "Alice", active: 1, max: null }]);
  });
});

describe("GET /admin/client-keys/usage", () => {
  it("returns per-key usage and totals for a period", async () => {
    const persistence = mockKeyPersistence();
    const pool = new ClientKeyPool(persistence, () => MASTER);
    const k = pool.createKey({ name: "Alice" });
    (persistence.queryUsageSince as ReturnType<typeof vi.fn>).mockReturnValue({
      [k.id]: { requests: 3, input_tokens: 30, output_tokens: 15, cached_tokens: 0, total_tokens: 45, cost_usd: 0.12 },
      ck_deleted: { requests: 9, input_tokens: 1, output_tokens: 1, cached_tokens: 0, total_tokens: 2, cost_usd: 9 },
    });
    const app = new Hono().route("/", createClientKeyAdminRoutes(pool, () => MASTER));

    const before = Date.now();
    const res = await app.request("/admin/client-keys/usage?period=3d", { headers: { Authorization: `Bearer ${MASTER}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.period).toBe("3d");
    expect(Object.keys(body.keys)).toEqual([k.id]);
    expect(body.totals).toEqual({ requests: 3, total_tokens: 45, cost_usd: 0.12 });

    const since = (persistence.queryUsageSince as ReturnType<typeof vi.fn>).mock.calls[0][0] as number;
    expect(Math.abs(before - 3 * 24 * 3_600_000 - since)).toBeLessThan(5_000);
  });

  it("rejects unknown periods", async () => {
    const pool = new ClientKeyPool(mockKeyPersistence(), () => MASTER);
    const app = new Hono().route("/", createClientKeyAdminRoutes(pool, () => MASTER));
    const res = await app.request("/admin/client-keys/usage?period=30d", { headers: { Authorization: `Bearer ${MASTER}` } });
    expect(res.status).toBe(400);
  });

  it("requires admin auth", async () => {
    const pool = new ClientKeyPool(mockKeyPersistence(), () => MASTER);
    const app = new Hono().route("/", createClientKeyAdminRoutes(pool, () => MASTER));
    expect((await app.request("/admin/client-keys/usage")).status).toBe(401);
  });

  it("list endpoint exposes active_requests", async () => {
    const pool = new ClientKeyPool(mockKeyPersistence(), () => MASTER);
    const k = pool.createKey({ name: "Alice" });
    pool.acquireSlot(k.id);
    const app = new Hono().route("/", createClientKeyAdminRoutes(pool, () => MASTER));
    const body = await (await app.request("/admin/client-keys", { headers: { Authorization: `Bearer ${MASTER}` } })).json();
    expect(body.keys[0].active_requests).toBe(1);
    expect(body.active_requests).toBe(1);
  });
});
