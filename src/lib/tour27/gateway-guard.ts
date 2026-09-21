/**
 * Tour 27 gateway guard: an explicit deployment mode in which OSIRIS exposes ONLY the Destination
 * Intelligence gateway. Upstream OSIRIS ships dozens of unauthenticated routes (including proxy-like
 * ones); none of them may be reachable next to a Tour 27 dependency. Behaviour outside this mode is
 * unchanged.
 *
 *  - deny by default: anything not on the allow-list is 404;
 *  - only GET/HEAD;
 *  - liveness/readiness probes are open (they reveal no data or secrets);
 *  - the gateway and provider-health routes require the service bearer token;
 *  - if no token is configured the protected routes FAIL CLOSED (503), never open;
 *  - token comparison is constant-time and supports two tokens for zero-downtime rotation.
 */
export const GATEWAY_MODE_ENV = 'OSIRIS_DEPLOYMENT_MODE';
export const GATEWAY_MODE_VALUE = 'tour27-gateway';
export const SERVICE_TOKEN_ENV = 'OSIRIS_SERVICE_TOKEN';
export const SERVICE_TOKEN_NEXT_ENV = 'OSIRIS_SERVICE_TOKEN_NEXT';

export const OPEN_PATHS: readonly string[] = ['/api/health', '/api/ready'];
export const PROTECTED_PATHS: readonly string[] = ['/api/tour27/destination-intelligence', '/api/tour27/health'];

export type GuardDecision =
  | { action: 'allow' }
  | { action: 'deny'; status: 401 | 404 | 405 | 503; error: string };

export interface GuardInput {
  mode: string | undefined;
  method: string;
  pathname: string;
  authorization: string | null;
  /** Configured service tokens (current + optional next); empty entries are ignored. */
  tokens: ReadonlyArray<string | undefined>;
}

/** Constant-time string equality (no early exit on the first differing byte or on length). */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function bearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer ([^\s]+)$/.exec(header.trim());
  return m ? m[1] : null;
}

export function evaluateGatewayRequest(input: GuardInput): GuardDecision {
  if (input.mode !== GATEWAY_MODE_VALUE) return { action: 'allow' };

  // Canonicalise: strip one trailing slash. Encoded dots/slashes never match the exact allow-list.
  const path = input.pathname.length > 1 && input.pathname.endsWith('/') ? input.pathname.slice(0, -1) : input.pathname;
  const isOpen = OPEN_PATHS.includes(path);
  const isProtected = PROTECTED_PATHS.includes(path);
  if (!isOpen && !isProtected) return { action: 'deny', status: 404, error: 'Not found' };

  const method = input.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return { action: 'deny', status: 405, error: 'Method not allowed' };
  if (isOpen) return { action: 'allow' };

  const configured = input.tokens.filter((t): t is string => typeof t === 'string' && t.length > 0);
  if (configured.length === 0) return { action: 'deny', status: 503, error: 'Gateway is not configured' };

  const presented = bearer(input.authorization);
  if (presented === null) return { action: 'deny', status: 401, error: 'Unauthorized' };
  // Compare against every configured token without short-circuiting.
  let ok = false;
  for (const t of configured) ok = constantTimeEqual(presented, t) || ok;
  return ok ? { action: 'allow' } : { action: 'deny', status: 401, error: 'Unauthorized' };
}
