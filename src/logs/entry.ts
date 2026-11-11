import { randomUUID } from "crypto";
import { logStore, type LogDirection, type LogRecord } from "./store.js";
import type { LogMetrics } from "./metrics.js";
import type { UsageInfo } from "../translation/codex-event-extractor.js";
import { getRequestIdentity } from "./request-identity.js";

export function enqueueLogEntry(entry: {
  requestId: string;
  direction: LogDirection;
  method: string;
  path: string;
  model?: string | null;
  provider?: string | null;
  account?: string | null;
  fallback?: boolean;
  authRole?: "master" | "client_key" | null;
  clientKeyId?: string | null;
  clientKeyName?: string | null;
  status?: number | null;
  latencyMs?: number | null;
  stream?: boolean | null;
  error?: string | null;
  request?: unknown;
  response?: unknown;
  ttftMs?: number | null;
  durationMs?: number | null;
  costUsd?: number | null;
  tokensPerSecond?: number | null;
  usage?: UsageInfo | null;
  metrics?: LogMetrics | null;
}): void {
  // Attribute the record to the caller registered by the auth middleware,
  // unless the writer supplied an explicit identity.
  const identity = entry.clientKeyId === undefined && entry.authRole === undefined
    ? getRequestIdentity(entry.requestId)
    : null;
  logStore.enqueue({
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...(identity
      ? { authRole: identity.authRole, clientKeyId: identity.clientKeyId, clientKeyName: identity.clientKeyName }
      : {}),
    ...entry,
  });
}

export function updateLogEntry(requestId: string, patch: Partial<LogRecord>): boolean {
  return logStore.updateByRequestId(requestId, patch);
}
