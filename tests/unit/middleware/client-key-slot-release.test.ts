/**
 * Client-key in-flight counts must drop back to zero however a streaming
 * request ends — including when the client disconnects while the proxy is
 * still waiting for upstream, before the SSE response is handed to the
 * server. Runs through a real @hono/node-server listener because the leak
 * lives in how the server writes (or never writes) the response body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { request as httpRequest, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "@src/config.js";
import { apiKeyAuth } from "@src/middleware/api-key-auth.js";
import { requestId } from "@src/middleware/request-id.js";
import { ClientKeyPool } from "@src/auth/client-key-pool.js";
import { clearRequestIdentitiesForTesting } from "@src/logs/request-identity.js";
import type { AccountPool } from "@src/auth/account-pool.js";
import type { ClientKeyEntry } from "@src/auth/client-key-types.js";
import type { ClientKeyPersistence } from "@src/auth/client-key-persistence.js";

const MASTER_KEY = "master-key-for-slot-release-test";

function createMockPersistence(): ClientKeyPersistence {
  let store: ClientKeyEntry[] = [];
  return {
    load: vi.fn(() => [...store]),
    save: vi.fn((keys: ClientKeyEntry[]) => { store = [...keys]; }),
  } as unknown as ClientKeyPersistence;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) return;
    await sleep(10);
  }
}

describe("client key slot release with a real HTTP server", () => {
  let pool: ClientKeyPool;
  let server: ServerType;
  let port: number;
  let upstreamCancelled: boolean;
  /** How long the handler "waits for upstream" before returning the SSE response. */
  let handlerDelayMs: number;
  /** Number of SSE chunks the fake upstream emits before closing (Infinity = never ends). */
  let upstreamChunks: number;
  const openRequests: ClientRequest[] = [];

  beforeEach(async () => {
    loadConfig();
    clearRequestIdentitiesForTesting();
    upstreamCancelled = false;
    handlerDelayMs = 0;
    upstreamChunks = Infinity;
    pool = new ClientKeyPool(createMockPersistence(), () => MASTER_KEY);
    const accountPool = {
      validateProxyApiKey: vi.fn((key: string) => key === MASTER_KEY),
    } as unknown as AccountPool;

    const app = new Hono();
    app.use("*", requestId);
    app.post("/v1/responses", apiKeyAuth(accountPool, pool), async () => {
      await sleep(handlerDelayMs);
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setInterval> | undefined;
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          timer = setInterval(() => {
            if (sent >= upstreamChunks) {
              clearInterval(timer);
              ctrl.close();
              return;
            }
            sent++;
            ctrl.enqueue(encoder.encode(`data: {"n":${sent}}\n\n`));
          }, 20);
        },
        cancel() {
          clearInterval(timer);
          upstreamCancelled = true;
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });

    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        port = info.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    for (const req of openRequests.splice(0)) req.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function startRequest(key: string, onData?: (req: ClientRequest) => void): ClientRequest {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    });
    req.on("error", () => {});
    req.on("response", (res) => {
      res.on("data", () => onData?.(req));
      res.on("error", () => {});
    });
    req.end("{}");
    openRequests.push(req);
    return req;
  }

  it("releases the slot when the client disconnects before the response is returned", async () => {
    const key = pool.createKey({ name: "early-abort" });
    handlerDelayMs = 200;

    const req = startRequest(key.key);
    await waitFor(() => pool.getActiveCount(key.id) === 1);
    expect(pool.getActiveCount(key.id)).toBe(1);

    // Client gives up while the proxy is still waiting for upstream.
    await sleep(50);
    req.destroy();

    await waitFor(() => pool.getActiveCount(key.id) === 0 && upstreamCancelled, 1500);
    expect(pool.getActiveCount(key.id)).toBe(0);
    // The orphaned upstream stream is cancelled instead of left hanging.
    expect(upstreamCancelled).toBe(true);
  });

  it("releases the slot when the client disconnects mid-stream", async () => {
    const key = pool.createKey({ name: "mid-stream-abort" });

    let destroyed = false;
    startRequest(key.key, (req) => {
      if (!destroyed) {
        destroyed = true;
        req.destroy();
      }
    });

    await waitFor(() => destroyed && pool.getActiveCount(key.id) === 0);
    expect(destroyed).toBe(true);
    expect(pool.getActiveCount(key.id)).toBe(0);
  });

  it("releases the slot when the stream completes normally", async () => {
    const key = pool.createKey({ name: "complete" });
    upstreamChunks = 3;

    startRequest(key.key);
    await waitFor(() => pool.getActiveCount(key.id) === 1);
    await waitFor(() => pool.getActiveCount(key.id) === 0);
    expect(pool.getActiveCount(key.id)).toBe(0);
  });
});
