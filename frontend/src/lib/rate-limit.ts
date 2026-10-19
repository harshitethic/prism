import { NextResponse } from "next/server";

const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_WINDOW = 30;

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory, per-process fixed-window limiter. Good enough to stop a single
 * client from hammering the public Horizon/Soroban RPC nodes through this
 * API — NOT distributed, so it resets per instance on a multi-instance
 * deployment. A real deployment behind a shared cache (Redis, etc.) would
 * need a proper distributed limiter instead. Buckets are keyed by
 * `${scope}:${clientIp}` so different routes can carry independent limits.
 */
const buckets = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}, 5 * 60_000).unref?.();

function getClientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

/** Returns a 429 response if the caller is over the limit, or null if the request should proceed. */
export function rateLimit(req: Request, opts?: { scope?: string; max?: number }): NextResponse | null {
  const max = opts?.max ?? DEFAULT_MAX_PER_WINDOW;
  const key = `${opts?.scope ?? "default"}:${getClientKey(req)}`;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return null;
  }

  if (bucket.count >= max) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((bucket.resetAt - now) / 1000)) } }
    );
  }

  bucket.count += 1;
  return null;
}
