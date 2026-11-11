/**
 * AccountQueryService — list, enrich, and export accounts.
 * Extracted from routes/accounts.ts (Phase 3).
 */

import type { AccountPool } from "../auth/account-pool.js";
import type { AccountEntry, AccountInfo, CodexQuota } from "../auth/types.js";
import { resolveAccountMaxConcurrent, resolveGlobalMaxConcurrent } from "../auth/account-concurrency.js";

export type EnrichedAccountInfo = AccountInfo & {
  proxyId: string;
  proxyName: string;
  quota?: CodexQuota;
  /** Concurrency cap actually applied (override or global default). */
  effectiveMaxConcurrent: number;
  /** Requests currently in flight on this account. */
  activeRequests: number;
};

export interface ProxyResolver {
  getAssignment(accountId: string): string;
  getAssignmentDisplayName(accountId: string): string;
}

export class AccountQueryService {
  constructor(
    private pool: AccountPool,
    private proxyResolver?: ProxyResolver,
    /** Returns the global `auth.max_concurrent_per_account` (null = default). */
    private getGlobalMaxConcurrent: () => number | null | undefined = () => null,
  ) {}

  listCached(): EnrichedAccountInfo[] {
    return this.pool.getAccounts().map((acct) => this.enrich(acct));
  }

  listFresh(): EnrichedAccountInfo[] {
    return this.listCached();
  }

  exportFull(ids?: string[]): AccountEntry[] {
    let entries = this.pool.getAllEntries();
    if (ids) {
      const idSet = new Set(ids);
      entries = entries.filter((e) => idSet.has(e.id));
    }
    return entries;
  }

  exportMinimal(
    ids?: string[],
  ): Array<{ refreshToken: string; label?: string }> {
    let entries = this.pool.getAllEntries();
    if (ids) {
      const idSet = new Set(ids);
      entries = entries.filter((e) => idSet.has(e.id));
    }
    return entries
      .filter((e) => e.refreshToken)
      .map((e) => {
        const item: { refreshToken: string; label?: string } = {
          refreshToken: e.refreshToken!,
        };
        if (e.label) item.label = e.label;
        return item;
      });
  }

  private enrich(acct: AccountInfo): EnrichedAccountInfo {
    const globalMax = resolveGlobalMaxConcurrent(this.getGlobalMaxConcurrent());
    return {
      ...acct,
      effectiveMaxConcurrent: resolveAccountMaxConcurrent(acct, globalMax),
      activeRequests: this.pool.getActiveSlotCount(acct.id),
      proxyId: this.proxyResolver?.getAssignment(acct.id) ?? "global",
      proxyName:
        this.proxyResolver?.getAssignmentDisplayName(acct.id) ??
        "Global Default",
    };
  }
}
