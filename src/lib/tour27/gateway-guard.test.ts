import { describe, it, expect } from 'vitest';
import { constantTimeEqual, evaluateGatewayRequest, GATEWAY_MODE_VALUE, type GuardInput } from './gateway-guard';

const TOKEN = 'correct-horse-battery-staple-9f3a';
const base = (over: Partial<GuardInput> = {}): GuardInput => ({
  mode: GATEWAY_MODE_VALUE, method: 'GET', pathname: '/api/tour27/destination-intelligence', authorization: `Bearer ${TOKEN}`, tokens: [TOKEN], ...over,
});
const status = (i: GuardInput) => { const d = evaluateGatewayRequest(i); return d.action === 'allow' ? 200 : d.status; };

describe('gateway guard — outside gateway mode nothing changes', () => {
  it.each([[undefined], [''], ['tour27'], ['TOUR27-GATEWAY'], ['gateway']])('mode %p allows everything (upstream behaviour preserved)', (mode) => {
    for (const pathname of ['/', '/api/cctv/proxy', '/api/aircraft', '/api/tour27/destination-intelligence']) {
      expect(status(base({ mode: mode as string | undefined, pathname, authorization: null, tokens: [] }))).toBe(200);
    }
  });
});

describe('gateway guard — deny by default', () => {
  it.each([
    ['/'], ['/dashboard'], ['/api/cctv/proxy'], ['/api/cctv/resolve'], ['/api/arcgis'], ['/api/aircraft'], ['/api/ai/analyze'], ['/api/earthquakes'],
    ['/api/fires'], ['/api/weather'], ['/api/tour27'], ['/api/tour27/'], ['/api/tour27/other'], ['/api/tour27/destination-intelligence/extra'],
    ['/api/tour27/destination-intelligence/../../cctv/proxy'], ['/api/tour27/%2e%2e/health'], ['/API/TOUR27/HEALTH'], ['/api/healthz'], ['/api/ready/x'],
    ['//api/health'], ['/api/health%2f'], ['/_next/data/x.json'],
  ])('%s is 404 even with a valid token', (pathname) => {
    expect(status(base({ pathname }))).toBe(404);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s on an allowed path is 405', (method) => {
    expect(status(base({ method }))).toBe(405);
    expect(status(base({ method, pathname: '/api/health' }))).toBe(405);
  });

  it('HEAD and GET are allowed (method is case-insensitive)', () => {
    expect(status(base({ method: 'HEAD' }))).toBe(200);
    expect(status(base({ method: 'get' }))).toBe(200);
  });
});

describe('gateway guard — probes', () => {
  it.each(['/api/health', '/api/ready'])('%s is open without a token (reveals no data)', (pathname) => {
    expect(status(base({ pathname, authorization: null, tokens: [] }))).toBe(200);
  });
});

describe('gateway guard — protected routes', () => {
  it.each(['/api/tour27/destination-intelligence', '/api/tour27/health'])('%s requires the bearer token', (pathname) => {
    expect(status(base({ pathname }))).toBe(200);
    expect(status(base({ pathname, authorization: null }))).toBe(401);
    expect(status(base({ pathname, authorization: 'Bearer wrong' }))).toBe(401);
    expect(status(base({ pathname, authorization: TOKEN }))).toBe(401); // scheme required
    expect(status(base({ pathname, authorization: `Basic ${TOKEN}` }))).toBe(401);
  });

  it('FAILS CLOSED (503) when no token is configured — never open', () => {
    for (const tokens of [[], [undefined], [''], [undefined, '']]) {
      expect(status(base({ tokens }))).toBe(503);
      expect(status(base({ tokens, authorization: null }))).toBe(503);
    }
  });

  it.each([
    [`Bearer ${TOKEN}x`], [`Bearer ${TOKEN.slice(0, -1)}`], [`Bearer  ${TOKEN}`], [`bearer ${TOKEN}`], [`Bearer ${TOKEN} extra`], ['Bearer '], ['Bearer'],
  ])('a near-miss credential %p is rejected', (authorization) => {
    expect(status(base({ authorization }))).toBe(401);
  });

  it('supports two tokens for zero-downtime rotation', () => {
    const next = 'next-token-value-77';
    expect(status(base({ tokens: [TOKEN, next], authorization: `Bearer ${next}` }))).toBe(200);
    expect(status(base({ tokens: [TOKEN, next], authorization: `Bearer ${TOKEN}` }))).toBe(200);
    expect(status(base({ tokens: [TOKEN, next], authorization: 'Bearer other' }))).toBe(401);
  });

  it('a single trailing slash is canonicalised (still requires auth)', () => {
    expect(status(base({ pathname: '/api/tour27/health/' }))).toBe(200);
    expect(status(base({ pathname: '/api/tour27/health/', authorization: null }))).toBe(401);
  });

  it('never leaks the token or the expected length in the denial body', () => {
    const d = evaluateGatewayRequest(base({ authorization: 'Bearer nope' }));
    expect(JSON.stringify(d)).not.toContain(TOKEN);
  });
});

describe('constantTimeEqual', () => {
  it('is true only for identical strings, including unicode and different lengths', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual('é', 'é')).toBe(true);
    expect(constantTimeEqual('é', 'e')).toBe(false);
  });
});
