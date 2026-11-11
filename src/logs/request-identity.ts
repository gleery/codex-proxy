/**
 * Request → caller identity registry.
 *
 * The auth middleware knows which client key (or master key) made a request,
 * but log records are written from many places (route handlers, stream close
 * hooks, egress logging) that only carry the requestId. This registry bridges
 * the two: auth registers the identity keyed by requestId, and the log entry
 * helpers look it up when a record is enqueued.
 *
 * Entries are released with a grace period so that late writers (stream close
 * events, final usage patches) can still resolve the identity, and the map is
 * size-bounded so a leak can never grow without limit.
 */

export type RequestAuthRole = "master" | "client_key";

export interface RequestIdentity {
  authRole: RequestAuthRole;
  clientKeyId: string | null;
  clientKeyName: string | null;
}

const RELEASE_GRACE_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 10_000;

const identities = new Map<string, RequestIdentity>();
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function setRequestIdentity(requestId: string | undefined, identity: RequestIdentity): void {
  if (!requestId || requestId === "-") return;
  const timer = releaseTimers.get(requestId);
  if (timer) {
    clearTimeout(timer);
    releaseTimers.delete(requestId);
  }
  identities.delete(requestId); // refresh insertion order
  identities.set(requestId, identity);
  while (identities.size > MAX_ENTRIES) {
    const oldest = identities.keys().next().value;
    if (oldest === undefined) break;
    forget(oldest);
  }
}

export function getRequestIdentity(requestId: string | undefined): RequestIdentity | null {
  if (!requestId) return null;
  return identities.get(requestId) ?? null;
}

/** Schedule removal after a grace period (late log writers may still need it). */
export function releaseRequestIdentity(requestId: string | undefined, graceMs = RELEASE_GRACE_MS): void {
  if (!requestId || !identities.has(requestId)) return;
  const existing = releaseTimers.get(requestId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => forget(requestId), graceMs);
  timer.unref?.();
  releaseTimers.set(requestId, timer);
}

function forget(requestId: string): void {
  identities.delete(requestId);
  const timer = releaseTimers.get(requestId);
  if (timer) clearTimeout(timer);
  releaseTimers.delete(requestId);
}

/** Test helper. */
export function clearRequestIdentitiesForTesting(): void {
  for (const timer of releaseTimers.values()) clearTimeout(timer);
  releaseTimers.clear();
  identities.clear();
}
