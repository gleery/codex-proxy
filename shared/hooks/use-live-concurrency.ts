import { useEffect, useState } from "preact/hooks";

export interface LiveConcurrency {
  timestamp: string;
  global: {
    active: number;
    capacity: number;
    available: number;
    max_concurrent_per_account: number;
    client_key_active: number;
  };
  accounts: Array<{ id: string; status: string; active: number; max: number }>;
  client_keys: Array<{ id: string; name: string; active: number; max: number | null }>;
}

const DEFAULT_INTERVAL_MS = 3000;

/**
 * Poll `/admin/concurrency` for live in-flight counts. Pauses while the page
 * is hidden and refreshes immediately when it becomes visible again.
 */
export function useLiveConcurrency(intervalMs = DEFAULT_INTERVAL_MS, enabled = true): LiveConcurrency | null {
  const [data, setData] = useState<LiveConcurrency | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const resp = await fetch("/admin/concurrency");
        if (!resp.ok) return;
        const json = (await resp.json()) as LiveConcurrency;
        if (!cancelled) setData(json);
      } catch {
        // transient network errors: keep last snapshot
      }
    };

    const onVisibility = () => {
      if (!document.hidden) void load();
    };

    void load();
    timer = setInterval(() => void load(), intervalMs);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled]);

  return data;
}
