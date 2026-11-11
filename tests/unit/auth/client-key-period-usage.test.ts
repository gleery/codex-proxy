import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ClientKeyPersistence } from "@src/auth/client-key-persistence.js";
import { ClientKeyPool } from "@src/auth/client-key-pool.js";

const HOUR = 3_600_000;
const delta = (cost: number, input = 10, output = 5) => ({
  requests: 1, input_tokens: input, output_tokens: output, cached_tokens: 0, cost_usd: cost,
});

describe("client key hourly usage", () => {
  let dir: string;
  let persistence: ClientKeyPersistence;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ck-usage-"));
    persistence = new ClientKeyPersistence(join(dir, "ck.sqlite"), join(dir, "ck.json"));
  });

  afterEach(() => {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("aggregates buckets by key within the window (SQLite)", () => {
    const now = Date.now();
    persistence.recordHourlyUsage("ck_a", now, delta(0.1));
    persistence.recordHourlyUsage("ck_a", now, delta(0.2));
    persistence.recordHourlyUsage("ck_a", now - 2 * 24 * HOUR, delta(1));
    persistence.recordHourlyUsage("ck_b", now - 5 * 24 * HOUR, delta(3));

    const day = persistence.queryUsageSince(now - 24 * HOUR);
    expect(day.ck_a.requests).toBe(2);
    expect(day.ck_a.cost_usd).toBeCloseTo(0.3);
    expect(day.ck_a.total_tokens).toBe(30);
    expect(day.ck_b).toBeUndefined();

    const threeDays = persistence.queryUsageSince(now - 3 * 24 * HOUR);
    expect(threeDays.ck_a.requests).toBe(3);
    expect(threeDays.ck_b).toBeUndefined();

    const week = persistence.queryUsageSince(now - 7 * 24 * HOUR);
    expect(week.ck_b.cost_usd).toBeCloseTo(3);
  });

  it("survives reopening the database", () => {
    const now = Date.now();
    persistence.recordHourlyUsage("ck_a", now, delta(0.5));
    persistence.close();
    const reopened = new ClientKeyPersistence(join(dir, "ck.sqlite"), join(dir, "ck.json"));
    expect(reopened.queryUsageSince(now - HOUR).ck_a.cost_usd).toBeCloseTo(0.5);
    reopened.close();
  });

  it("deleteUsage removes a key's history", () => {
    const now = Date.now();
    persistence.recordHourlyUsage("ck_a", now, delta(0.5));
    persistence.recordHourlyUsage("ck_b", now, delta(0.5));
    persistence.deleteUsage("ck_a");
    const usage = persistence.queryUsageSince(now - HOUR);
    expect(usage.ck_a).toBeUndefined();
    expect(usage.ck_b.requests).toBe(1);
  });

  it("falls back to memory when SQLite cannot be opened", () => {
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const broken = new ClientKeyPersistence(join(blocker, "sub", "ck.sqlite"), join(dir, "fallback.json"));
    const now = Date.now();
    broken.recordHourlyUsage("ck_a", now, delta(0.25));
    broken.recordHourlyUsage("ck_a", now - 10 * 24 * HOUR, delta(9));
    const usage = broken.queryUsageSince(now - 24 * HOUR);
    expect(usage.ck_a).toMatchObject({ requests: 1 });
    expect(usage.ck_a.cost_usd).toBeCloseTo(0.25);
  });

  it("ClientKeyPool.recordUsage feeds the period stats and hides deleted keys", () => {
    const pool = new ClientKeyPool(persistence, () => null);
    const a = pool.createKey({ name: "A" });
    const b = pool.createKey({ name: "B" });
    pool.recordUsage(a.id, "gpt-5.4", { input_tokens: 100, output_tokens: 50 }, 0.01);
    pool.recordUsage(a.id, "gpt-5.4", { input_tokens: 10, output_tokens: 5 }, 0.02);
    pool.recordUsage(b.id, "gpt-5.4", { input_tokens: 1, output_tokens: 1 }, 0.5);

    const usage = pool.getUsageSince(Date.now() - 24 * HOUR);
    expect(usage[a.id]).toMatchObject({ requests: 2, input_tokens: 110, output_tokens: 55, total_tokens: 165 });
    expect(usage[a.id].cost_usd).toBeCloseTo(0.03);

    pool.deleteKey(b.id);
    expect(pool.getUsageSince(Date.now() - 24 * HOUR)[b.id]).toBeUndefined();
  });
});
