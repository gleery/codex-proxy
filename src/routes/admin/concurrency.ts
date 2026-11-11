/**
 * GET /admin/concurrency — live in-flight request counts for the dashboard.
 *
 * Cheap, in-memory only (no upstream calls), so the dashboard can poll it
 * every few seconds. Protected by the dashboard auth middleware like the
 * other /admin/* routes.
 */
import { Hono } from "hono";
import type { AccountPool } from "../../auth/account-pool.js";
import type { ClientKeyPool } from "../../auth/client-key-pool.js";

export function createConcurrencyRoutes(accountPool: AccountPool, clientKeyPool?: ClientKeyPool): Hono {
  const app = new Hono();

  app.get("/admin/concurrency", (c) => {
    const accounts = accountPool.getConcurrencySnapshot();
    const capacity = accountPool.getCapacitySummary();
    const accountsActive = accounts.reduce((n, a) => n + a.active, 0);

    const clientKeys = (clientKeyPool?.getAll() ?? []).map((k) => ({
      id: k.id,
      name: k.name,
      active: clientKeyPool!.getActiveCount(k.id),
      max: k.max_concurrency,
    }));

    return c.json({
      timestamp: new Date().toISOString(),
      global: {
        /** In-flight upstream requests across all accounts. */
        active: accountsActive,
        /** Total slots across usable (active, non-exhausted) accounts. */
        capacity: capacity.total_slots,
        available: capacity.available_slots,
        max_concurrent_per_account: capacity.max_concurrent_per_account,
        /** In-flight requests authenticated with client keys. */
        client_key_active: clientKeys.reduce((n, k) => n + k.active, 0),
      },
      accounts: accounts.map((a) => ({ id: a.entryId, status: a.status, active: a.active, max: a.max })),
      client_keys: clientKeys,
    });
  });

  return app;
}
