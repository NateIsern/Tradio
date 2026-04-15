import { execSync } from "child_process";
import { PYTHON } from "./config";

let cachedToken: string | null = null;
let tokenExpiry = 0;

export function getAuthToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < tokenExpiry - 60) {
    return cachedToken;
  }

  const output = execSync(`"${PYTHON}" generate-token.py 2>/dev/null`, {
    cwd: import.meta.dir,
    env: process.env,
  }).toString().trim();

  if (output.startsWith("ERROR:")) {
    throw new Error(`Auth token generation failed: ${output}`);
  }

  cachedToken = output;
  const deadline = parseInt(output.split(":")[0] ?? "0", 10);
  tokenExpiry = deadline;
  return cachedToken;
}

// --- Shared rate limiter + response cache for Lighter API ---
//
// The bot loop + backend endpoints both hammer Lighter's public API in
// parallel (one call per market for candles, plus account reads). Without a
// governor we burn through the 429 bucket within seconds. Two mechanisms
// protect the process:
//
// 1. **Token bucket.** Hard-cap concurrent outbound requests and enforce a
//    minimum spacing between them. Anything over the cap queues.
// 2. **Per-URL micro-cache.** Identical GETs within the TTL resolve from
//    memory, so the dashboard poll + bot cycle + /chat context build cannot
//    triple-request the same endpoint in the same second.
//
// On 429 we back off and retry transparently so callers never see the error.

// Lighter's public endpoints tolerate a good deal more than we're spending.
// The previous 4 req/sec limit was suffocating the bot — a single cycle wants
// 30+ candle calls. Now: 6 concurrent, 100ms gap → ~60 req/sec ceiling. The
// indicator cache in stockData.ts + the per-URL cache below collapse most
// duplicates so the real outbound rate stays well under that.
const RATE_LIMIT = {
  maxConcurrent: 6,
  minIntervalMs: 100,
  retries: 4,
  backoffMs: [750, 2000, 5000, 10000],
};
const CACHE_TTL_MS = 4000;

type PendingEntry = {
  resolve: () => void;
  reject: (err: Error) => void;
};
const queue: PendingEntry[] = [];
let activeCount = 0;
let lastReleaseAt = 0;
let lastWarnAt = 0;

function acquireSlot(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    queue.push({ resolve, reject });
    drain();
  });
}

function releaseSlot(): void {
  activeCount--;
  lastReleaseAt = Date.now();
  drain();
}

function drain(): void {
  while (activeCount < RATE_LIMIT.maxConcurrent && queue.length > 0) {
    const entry = queue.shift();
    if (!entry) break;
    const now = Date.now();
    const wait = Math.max(0, RATE_LIMIT.minIntervalMs - (now - lastReleaseAt));
    activeCount++;
    lastReleaseAt = now + wait;
    if (wait === 0) {
      entry.resolve();
    } else {
      setTimeout(() => entry.resolve(), wait);
    }
  }

  const queued = queue.length;
  if (queued > 30) {
    const now = Date.now();
    if (now - lastWarnAt > 10_000) {
      lastWarnAt = now;
      console.warn(`[rate-limit] backlog=${queued} active=${activeCount}`);
    }
  }
}

type CacheEntry = { at: number; body: Promise<string> };
const responseCache = new Map<string, CacheEntry>();

function cacheGet(key: string): Promise<string> | null {
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return hit.body;
}

function cacheSet(key: string, body: Promise<string>): void {
  responseCache.set(key, { at: Date.now(), body });
}

async function rawFetch(url: string, token: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const err = new Error(`Lighter API ${response.status}: ${text.slice(0, 200)}`);
    (err as Error & { status?: number }).status = response.status;
    throw err;
  }
  return response.text();
}

// Async HTTP GET against the Lighter API. Every call is gated through the
// shared rate limiter, de-duplicated via the in-memory cache, and retried
// with backoff on 429 so normal cycle operation survives bursts.
export async function fetchH2(url: string, token: string): Promise<string> {
  const cached = cacheGet(url);
  if (cached) return cached;

  const request = (async () => {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= RATE_LIMIT.retries; attempt++) {
      await acquireSlot();
      try {
        return await rawFetch(url, token);
      } catch (err) {
        lastErr = err as Error;
        const status = (err as Error & { status?: number }).status;
        if (status !== 429 || attempt === RATE_LIMIT.retries) throw err;
        const delay = RATE_LIMIT.backoffMs[attempt] ?? 4000;
        await new Promise((r) => setTimeout(r, delay));
      } finally {
        releaseSlot();
      }
    }
    throw lastErr ?? new Error("fetchH2 exhausted retries");
  })();

  cacheSet(url, request);
  // If the request fails, evict so the next call re-fetches instead of
  // replaying a rejected promise for CACHE_TTL_MS seconds.
  request.catch(() => responseCache.delete(url));
  return request;
}
