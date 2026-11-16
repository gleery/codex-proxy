/**
 * Tests for the per-account credit fallback API.
 * PATCH /auth/accounts/:id/credit-fallback — opt in/out of serving from
 * credits once the weekly window is exhausted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
    server: { proxy_api_key: null },
  })),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token.slice(0, 4)}@test.com`,
    chatgpt_plan_type: "team",
    chatgpt_user_id: `uid-${token.slice(0, 8)}`,
  })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));

vi.mock("@src/auth/oauth-pkce.js", () => ({
  startOAuthFlow: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

import { Hono } from "hono";
import { AccountPool } from "@src/auth/account-pool.js";
import { createAccountRoutes } from "@src/routes/accounts.js";

const mockScheduler = {
  scheduleOne: vi.fn(),
  clearOne: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

describe("account credit fallback API", () => {
  let pool: AccountPool;
  let app: Hono;
  let accountId: string;

  beforeEach(() => {
    pool = new AccountPool();
    const routes = createAccountRoutes(pool, mockScheduler as never);
    app = new Hono();
    app.route("/", routes);
    accountId = pool.addAccount("testtoken-padding-for-length");
  });

  const patch = (id: string, body: unknown) =>
    app.request(`/auth/accounts/${id}/credit-fallback`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("PATCH toggles credit fallback and the account list reflects it", async () => {
    const on = await patch(accountId, { enabled: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ success: true, enabled: true });
    expect(pool.getAccounts()[0].creditFallback).toBe(true);

    const off = await patch(accountId, { enabled: false });
    expect(off.status).toBe(200);
    expect(pool.getAccounts()[0].creditFallback).toBe(false);
  });

  it("PATCH with a non-boolean returns 400", async () => {
    const res = await patch(accountId, { enabled: "yes" });
    expect(res.status).toBe(400);
    expect(pool.getAccounts()[0].creditFallback).toBe(false);
  });

  it("PATCH on nonexistent account returns 404", async () => {
    const res = await patch("nonexistent", { enabled: true });
    expect(res.status).toBe(404);
  });
});
