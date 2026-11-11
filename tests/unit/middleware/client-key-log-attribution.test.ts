/**
 * End-to-end through the middleware chain: requestId → logCapture → apiKeyAuth
 * → handler. Verifies request logs record which client key made the call and
 * that in-flight counts are tracked even for keys without a concurrency cap.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { loadConfig } from "@src/config.js";
import { apiKeyAuth } from "@src/middleware/api-key-auth.js";
import { requestId } from "@src/middleware/request-id.js";
import { logCapture } from "@src/middleware/log-capture.js";
import { ClientKeyPool } from "@src/auth/client-key-pool.js";
import { logStore } from "@src/logs/store.js";
import { enqueueLogEntry } from "@src/logs/entry.js";
import { clearRequestIdentitiesForTesting } from "@src/logs/request-identity.js";
import type { AccountPool } from "@src/auth/account-pool.js";
import type { ClientKeyEntry } from "@src/auth/client-key-types.js";
import type { ClientKeyPersistence } from "@src/auth/client-key-persistence.js";

const MASTER_KEY = "master-key-for-attribution-test";

function createMockPersistence(): ClientKeyPersistence {
  let store: ClientKeyEntry[] = [];
  return {
    load: vi.fn(() => [...store]),
    save: vi.fn((keys: ClientKeyEntry[]) => { store = [...keys]; }),
  } as unknown as ClientKeyPersistence;
}

async function flushLogs() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("client key attribution in request logs", () => {
  let pool: ClientKeyPool;
  let app: Hono;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null;

  beforeEach(() => {
    loadConfig();
    logStore.clear();
    clearRequestIdentitiesForTesting();
    streamController = null;
    pool = new ClientKeyPool(createMockPersistence(), () => MASTER_KEY);
    const accountPool = {
      validateProxyApiKey: vi.fn((key: string) => key === MASTER_KEY),
    } as unknown as AccountPool;

    app = new Hono();
    app.use("*", requestId);
    app.use("*", logCapture);
    app.post("/v1/chat/completions", apiKeyAuth(accountPool, pool), (c) => {
      // Route handlers log with only the requestId, like the real routes.
      enqueueLogEntry({ requestId: c.get("requestId"), direction: "ingress", method: "POST", path: c.req.path, model: "gpt-5.4" });
      if (c.req.header("x-stream") === "1") {
        const stream = new ReadableStream<Uint8Array>({ start(ctrl) { streamController = ctrl; } });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      return c.json({ ok: true });
    });
  });

  it("records the client key name on the request log", async () => {
    const key = pool.createKey({ name: "Alice" });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}`, "x-request-id": "req-alice" },
    });
    expect(res.status).toBe(200);
    await flushLogs();

    const records = logStore.list({}).records.filter((r) => r.requestId === "req-alice");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      authRole: "client_key",
      clientKeyId: key.id,
      clientKeyName: "Alice",
      status: 200,
    });
  });

  it("marks master-key requests as master", async () => {
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${MASTER_KEY}`, "x-request-id": "req-master" },
    });
    await flushLogs();
    const record = logStore.list({}).records.find((r) => r.requestId === "req-master");
    expect(record).toMatchObject({ authRole: "master", clientKeyId: null, clientKeyName: null });
  });

  it("attributes rejected (over-concurrency) requests too", async () => {
    const key = pool.createKey({ name: "Bob", max_concurrency: 1 });
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}`, "x-stream": "1", "x-request-id": "req-bob-1" },
    });
    const res2 = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}`, "x-request-id": "req-bob-2" },
    });
    expect(res2.status).toBe(429);
    await flushLogs();

    const rejected = logStore.list({}).records.find((r) => r.requestId === "req-bob-2");
    expect(rejected).toMatchObject({ clientKeyName: "Bob", status: 429 });
    streamController?.close();
  });

  it("counts in-flight requests for keys without a concurrency cap", async () => {
    const key = pool.createKey({ name: "Unlimited" });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}`, "x-stream": "1" },
    });
    expect(pool.getActiveCount(key.id)).toBe(1);
    expect(pool.getAllPublicSummaries()[0].active_requests).toBe(1);

    streamController!.close();
    await res.text();
    await flushLogs();
    expect(pool.getActiveCount(key.id)).toBe(0);
  });
});
