/**
 * Runtime primitives shared by the Tour 27 provider ports. Everything a provider needs from the
 * outside world is injected (fetch, clock, cache, env, logger), so provider code is deterministic
 * and testable without network access.
 *
 * HONEST CLIENT RULES (Tour 27 authoritative integrations): identifiable User-Agent, documented
 * endpoints and auth only, no User-Agent/proxy rotation, no anti-bot bypass, no rate-limit evasion,
 * and none of the upstream OSIRIS `stealthFetch` pattern. Every outbound call goes through
 * `providerFetch`, which enforces a timeout and a fixed honest User-Agent.
 */

export const TOUR27_USER_AGENT = 'Tour27-Backend/1.0 (+https://tour27.com; destination-intelligence)';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

/** Log lines must never carry exact user coordinates or secrets; providers log counts/timings only. */
export const consoleLogger: Logger = {
  info: (m) => console.info(`[tour27] ${m}`),
  warn: (m) => console.warn(`[tour27] ${m}`),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {} };

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Bounded in-memory TTL cache. Correctness never depends on it (a miss only costs a provider call). */
export class MemoryCache implements CacheStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly clock: () => number = Date.now, private readonly maxEntries = 5000) {}

  async get(key: string): Promise<string | null> {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return null;
    }
    return e.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.clock() + ttlSeconds * 1000 });
  }
}

export interface ProviderDeps {
  fetch: FetchLike;
  cache: CacheStore;
  now: () => Date;
  env: (name: string) => string | undefined;
  logger: Logger;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** The single outbound door: timeout + honest User-Agent; the caller decides what an HTTP status means. */
export async function providerFetch(deps: ProviderDeps, url: string, opts: { timeoutMs: number; headers?: Record<string, string> }): Promise<Response> {
  // The User-Agent is fixed and honest: a caller-supplied one (in any header casing) is dropped, so no
  // provider port can spoof a browser or rotate identities.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) if (k.toLowerCase() !== 'user-agent') headers[k] = v;
  headers['User-Agent'] = TOUR27_USER_AGENT;
  return deps.fetch(url, {
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs),
    redirect: 'error',
  });
}

/** Concurrent callers for one key share a single computation (and a single provider call). */
export class SingleFlight {
  private readonly inflight = new Map<string, Promise<unknown>>();
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const p = work().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

/** Per-process request budget that FAILS CLOSED when exhausted (never queues, never evades). */
export class RequestBudget {
  private stamps: number[] = [];
  constructor(private readonly perMinute: number, private readonly clock: () => number = Date.now) {}
  reserve(): boolean {
    const t = this.clock();
    this.stamps = this.stamps.filter((s) => t - s < 60_000);
    if (this.stamps.length >= this.perMinute) return false;
    this.stamps.push(t);
    return true;
  }
}

export const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
