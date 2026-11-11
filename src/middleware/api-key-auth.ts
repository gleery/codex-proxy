import type { Context, Next, MiddlewareHandler } from "hono";
import { getConfig } from "../config.js";
import { extractProxyApiKey } from "../utils/extract-api-key.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { ClientKeyPool } from "../auth/client-key-pool.js";
import type { ClientKeyEntry } from "../auth/client-key-types.js";
import { releaseRequestIdentity, setRequestIdentity } from "../logs/request-identity.js";

function makeOpenAIError(message: string, code = "invalid_api_key", type = "invalid_request_error") {
  return {
    error: {
      message,
      type,
      param: null,
      code,
    },
  };
}

function makeAnthropicError(message: string, type = "authentication_error") {
  return {
    type: "error",
    error: {
      type,
      message,
    },
  };
}

function makeGeminiError(code: number, message: string, status = "UNAUTHENTICATED") {
  return {
    error: {
      code,
      message,
      status,
    },
  };
}

function formatAuthError(path: string, message: string, code = "invalid_api_key", statusCode = 401) {
  if (path.startsWith("/admin/")) {
    return { error: message };
  }
  if (path.startsWith("/v1/messages")) {
    const anthropicType =
      statusCode === 429
        ? "rate_limit_error"
        : statusCode === 403
          ? "permission_error"
          : "authentication_error";
    return makeAnthropicError(message, anthropicType);
  }
  if (path.startsWith("/v1beta/")) {
    const geminiStatus =
      statusCode === 429
        ? "RESOURCE_EXHAUSTED"
        : statusCode === 403
          ? "PERMISSION_DENIED"
          : "UNAUTHENTICATED";
    return makeGeminiError(statusCode, message, geminiStatus);
  }
  return makeOpenAIError(message, code);
}

function wrapStreamWithSlotRelease(body: ReadableStream<Uint8Array>, onRelease: () => void): ReadableStream<Uint8Array> {
  let released = false;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      onRelease();
    }
  };

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush() {
      releaseOnce();
    },
  });

  body.pipeTo(transformStream.writable).then(releaseOnce, releaseOnce);

  return transformStream.readable;
}

/**
 * Run the downstream handler and invoke `onRelease` once the request is truly
 * finished: immediately for regular responses, or when an SSE body has been
 * fully consumed / cancelled.
 */
async function runReleasingAfterStream(c: Context, next: Next, onRelease: () => void): Promise<Response | void> {
  let isStreamResponse = false;
  try {
    const res = await next();
    const contentType = c.res?.headers?.get("Content-Type") || "";
    const isEventStream = contentType.includes("text/event-stream");

    if (isEventStream && c.res && c.res.body && typeof (c.res.body as ReadableStream).getReader === "function") {
      isStreamResponse = true;
      const originalBody = c.res.body as ReadableStream<Uint8Array>;
      c.res = new Response(wrapStreamWithSlotRelease(originalBody, onRelease), c.res);
    }
    return res;
  } finally {
    if (!isStreamResponse) onRelease();
  }
}

export function apiKeyAuth(accountPool: AccountPool, clientKeyPool?: ClientKeyPool): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const config = getConfig();
    const providedKey = extractProxyApiKey(c);
    const path = c.req.path;

    const requestId = c.get("requestId");

    // 1. Check Master Key first (either config proxy_api_key or pool account key)
    if (providedKey && accountPool.validateProxyApiKey(providedKey)) {
      c.set("authRole", "master");
      setRequestIdentity(requestId, { authRole: "master", clientKeyId: null, clientKeyName: null });
      return runReleasingAfterStream(c, next, () => releaseRequestIdentity(requestId));
    }

    // 2. Check Client Key Pool
    if (clientKeyPool && providedKey) {
      // Client keys must NEVER access /admin/* routes
      if (path.startsWith("/admin/")) {
        c.status(401);
        return c.json({ error: "Client access keys cannot access admin routes" });
      }

      const clientKey = clientKeyPool.getByKey(providedKey);
      if (clientKey) {
        // Register the caller before validation so rejected requests
        // (disabled, over budget, concurrency-limited) are attributed too.
        setRequestIdentity(requestId, {
          authRole: "client_key",
          clientKeyId: clientKey.id,
          clientKeyName: clientKey.name,
        });
        const validation = clientKeyPool.validateAccess(providedKey);
        if (!validation.allowed) {
          releaseRequestIdentity(requestId);
          const status = validation.statusCode ?? 401;
          c.status(status);
          return c.json(
            formatAuthError(path, validation.message || "Unauthorized", validation.reason, status),
          );
        }

        // Acquire concurrency slot
        const acquired = clientKeyPool.acquireSlot(clientKey.id);
        if (!acquired) {
          releaseRequestIdentity(requestId);
          c.status(429);
          return c.json(
            formatAuthError(
              path,
              "Client key concurrency limit exceeded",
              "concurrency_limit_exceeded",
              429,
            ),
          );
        }

        c.set("authRole", "client_key");
        c.set("clientKey", clientKey);
        c.set("clientKeyPool", clientKeyPool);

        return runReleasingAfterStream(c, next, () => {
          clientKeyPool.releaseSlot(clientKey.id);
          releaseRequestIdentity(requestId);
        });
      }
    }

    // 3. No master proxy_api_key configured on server:
    // Allow non-admin requests to pass through (passthrough / no-auth mode)
    const hasMasterKeyConfig = Boolean(config.server.proxy_api_key);
    if (!hasMasterKeyConfig && !path.startsWith("/admin/")) {
      return next();
    }

    // 4. Fallback unauthorized
    c.status(401);
    return c.json(formatAuthError(path, "Invalid proxy API key", "invalid_api_key", 401));
  };
}
