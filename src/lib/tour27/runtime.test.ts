import { describe, it, expect, vi } from 'vitest';
import { MemoryCache, providerFetch, RequestBudget, SingleFlight, silentLogger, TOUR27_USER_AGENT, type ProviderDeps } from './runtime';

describe('MemoryCache', () => {
  it('expires entries at their TTL and never returns them afterwards', async () => {
    let t = 1000;
    const c = new MemoryCache(() => t);
    await c.set('k', 'v', 60);
    expect(await c.get('k')).toBe('v');
    t += 59_999;
    expect(await c.get('k')).toBe('v');
    t += 1;
    expect(await c.get('k')).toBeNull();
  });

  it('is bounded: the oldest entry is evicted at capacity (correctness never depends on the cache)', async () => {
    const c = new MemoryCache(() => 0, 2);
    await c.set('a', '1', 60); await c.set('b', '2', 60); await c.set('c', '3', 60);
    expect(await c.get('a')).toBeNull();
    expect(await c.get('b')).toBe('2');
    expect(await c.get('c')).toBe('3');
  });
});

describe('SingleFlight', () => {
  it('shares one computation among concurrent callers and runs again after completion', async () => {
    const sf = new SingleFlight();
    const work = vi.fn(async () => { await Promise.resolve(); return 42; });
    const [a, b, c] = await Promise.all([sf.run('k', work), sf.run('k', work), sf.run('k', work)]);
    expect([a, b, c]).toEqual([42, 42, 42]);
    expect(work).toHaveBeenCalledTimes(1);
    await sf.run('k', work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('releases the key after a failure so the next call retries', async () => {
    const sf = new SingleFlight();
    await expect(sf.run('k', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(sf.run('k', async () => 1)).resolves.toBe(1);
  });
});

describe('RequestBudget', () => {
  it('fails closed at the per-minute limit and refills as the window slides', () => {
    let t = 0;
    const b = new RequestBudget(3, () => t);
    expect([b.reserve(), b.reserve(), b.reserve(), b.reserve()]).toEqual([true, true, true, false]);
    t = 59_999;
    expect(b.reserve()).toBe(false);
    t = 60_000;
    expect(b.reserve()).toBe(true);
  });
});

describe('providerFetch — honest client', () => {
  const deps = (fetchImpl: ProviderDeps['fetch']): ProviderDeps => ({ fetch: fetchImpl, cache: new MemoryCache(), now: () => new Date(0), env: () => undefined, logger: silentLogger });

  it('always sends the honest Tour 27 User-Agent, a timeout signal and refuses redirects', async () => {
    const f = vi.fn(async () => new Response('{}'));
    await providerFetch(deps(f), 'https://example.test/x', { timeoutMs: 1234, headers: { Accept: 'application/json' } });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(TOUR27_USER_AGENT);
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('error');
  });

  it.each([['User-Agent'], ['user-agent'], ['USER-AGENT']])('a caller cannot override the User-Agent with a spoofed one (%s)', async (name) => {
    const f = vi.fn(async () => new Response('{}'));
    await providerFetch(deps(f), 'https://example.test/x', { timeoutMs: 100, headers: { [name]: 'Mozilla/5.0 (spoof)', Accept: 'application/json' } });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(TOUR27_USER_AGENT);
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === 'user-agent')).toHaveLength(1);
    expect(headers.Accept).toBe('application/json');
  });

  it('the honest UA identifies Tour 27 and never looks like a browser', () => {
    expect(TOUR27_USER_AGENT).toMatch(/^Tour27-Backend\/1\.0 \(\+https:\/\/tour27\.com/);
    expect(TOUR27_USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari/i);
  });
});
