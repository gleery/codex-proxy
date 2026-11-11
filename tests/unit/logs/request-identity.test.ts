import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clearRequestIdentitiesForTesting,
  getRequestIdentity,
  releaseRequestIdentity,
  setRequestIdentity,
} from "@src/logs/request-identity.js";
import { enqueueLogEntry } from "@src/logs/entry.js";
import { logStore } from "@src/logs/store.js";

const alice = { authRole: "client_key" as const, clientKeyId: "ck_alice", clientKeyName: "Alice" };

beforeEach(() => {
  clearRequestIdentitiesForTesting();
  logStore.clear();
});

afterEach(() => {
  vi.useRealTimers();
  clearRequestIdentitiesForTesting();
});

describe("request identity registry", () => {
  it("stores and returns identities by requestId", () => {
    setRequestIdentity("r1", alice);
    expect(getRequestIdentity("r1")).toEqual(alice);
    expect(getRequestIdentity("missing")).toBeNull();
  });

  it("ignores empty / placeholder request ids", () => {
    setRequestIdentity(undefined, alice);
    setRequestIdentity("-", alice);
    expect(getRequestIdentity("-")).toBeNull();
  });

  it("keeps the identity through the grace period after release", () => {
    vi.useFakeTimers();
    setRequestIdentity("r1", alice);
    releaseRequestIdentity("r1", 1000);
    vi.advanceTimersByTime(999);
    expect(getRequestIdentity("r1")).toEqual(alice);
    vi.advanceTimersByTime(1);
    expect(getRequestIdentity("r1")).toBeNull();
  });

  it("re-registering cancels a pending release", () => {
    vi.useFakeTimers();
    setRequestIdentity("r1", alice);
    releaseRequestIdentity("r1", 1000);
    setRequestIdentity("r1", alice);
    vi.advanceTimersByTime(5000);
    expect(getRequestIdentity("r1")).toEqual(alice);
  });
});

describe("enqueueLogEntry attribution", () => {
  it("attaches the registered caller to log records", async () => {
    setRequestIdentity("r1", alice);
    enqueueLogEntry({ requestId: "r1", direction: "egress", method: "POST", path: "/codex/responses" });
    await Promise.resolve();

    const [record] = logStore.list({}).records;
    expect(record).toMatchObject({ clientKeyId: "ck_alice", clientKeyName: "Alice", authRole: "client_key" });
  });

  it("does not override an explicit identity", async () => {
    setRequestIdentity("r1", alice);
    enqueueLogEntry({
      requestId: "r1", direction: "egress", method: "POST", path: "/x",
      authRole: "master", clientKeyId: null, clientKeyName: null,
    });
    await Promise.resolve();
    expect(logStore.list({}).records[0]).toMatchObject({ authRole: "master", clientKeyName: null });
  });

  it("makes records searchable by client key name", async () => {
    setRequestIdentity("r1", alice);
    enqueueLogEntry({ requestId: "r1", direction: "egress", method: "POST", path: "/x" });
    enqueueLogEntry({ requestId: "r2", direction: "egress", method: "POST", path: "/x" });
    await Promise.resolve();
    const found = logStore.list({ search: "alice" });
    expect(found.total).toBe(1);
    expect(found.records[0].requestId).toBe("r1");
  });
});
