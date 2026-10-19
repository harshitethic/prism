import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("rateLimit fixed-window admission", () => {
  let rateLimit: typeof import("./rate-limit").rateLimit;

  const request = (forwardedFor = "203.0.113.7") =>
    new Request("https://example.org/api/contract", {
      headers: { "x-forwarded-for": forwardedFor },
    });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.resetModules(); // each case gets a fresh in-memory bucket map
    ({ rateLimit } = await import("./rate-limit"));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("allows requests through the cap, then returns a 429 and Retry-After", async () => {
    expect(rateLimit(request(), { max: 2 })).toBeNull();
    expect(rateLimit(request(), { max: 2 })).toBeNull();

    const response = rateLimit(request(), { max: 2 });
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("60");
    expect(await response?.json()).toEqual({
      error: "Rate limit exceeded. Try again shortly.",
    });

    vi.advanceTimersByTime(1_200);
    expect(rateLimit(request(), { max: 2 })?.headers.get("Retry-After")).toBe("59");
  });

  it("opens a fresh bucket exactly when the 60-second window expires", () => {
    expect(rateLimit(request(), { max: 1 })).toBeNull();
    expect(rateLimit(request(), { max: 1 })?.status).toBe(429);
    vi.advanceTimersByTime(60_000);
    expect(rateLimit(request(), { max: 1 })).toBeNull();
    expect(rateLimit(request(), { max: 1 })?.status).toBe(429);
  });

  it("tracks independent scope buckets for the same client", () => {
    expect(rateLimit(request(), { scope: "events", max: 1 })).toBeNull();
    expect(rateLimit(request(), { scope: "contracts", max: 1 })).toBeNull();
    expect(rateLimit(request(), { scope: "events", max: 1 })?.status).toBe(429);
    expect(rateLimit(request(), { scope: "contracts", max: 1 })?.status).toBe(429);
  });

  it("tracks separate clients and uses the first forwarded IP", () => {
    expect(rateLimit(request("198.51.100.4, 127.0.0.1"), { max: 1 })).toBeNull();
    expect(rateLimit(request("198.51.100.5"), { max: 1 })).toBeNull();
    expect(rateLimit(request("198.51.100.4, 10.0.0.2"), { max: 1 })?.status).toBe(429);
  });
});
