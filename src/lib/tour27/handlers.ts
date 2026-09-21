import type { DestinationIntelligenceGateway } from './gateway';
import { GATEWAY_MODE_ENV, GATEWAY_MODE_VALUE, SERVICE_TOKEN_ENV } from './gateway-guard';
import { parseQuery } from './query';

/** No caching anywhere between the gateway and Tour 27: freshness rules live in the providers. */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE } });
}

/** GET /api/tour27/destination-intelligence — one contract, four truth classes, explicit per-provider status. */
export async function handleDestinationIntelligence(request: Request, gateway: DestinationIntelligenceGateway, now: Date = new Date()): Promise<Response> {
  const parsed = parseQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const body = await gateway.getDestinationIntelligence(parsed.query, now);
  return json(body);
}

/** GET /api/tour27/health — provider health from the registry (no upstream fan-out per call). */
export function handleProviderHealth(gateway: DestinationIntelligenceGateway, now: Date = new Date()): Response {
  const providers = gateway.providerStatus(now);
  const impaired = providers.filter((p) => p.state === 'DEGRADED' || p.state === 'UNAVAILABLE').map((p) => p.provider);
  return json({ generatedAt: now.toISOString(), providers, summary: { impaired, pending: providers.filter((p) => p.state === 'LICENCE_PENDING' || p.state === 'TOKEN_PENDING').map((p) => p.provider) } });
}

/**
 * GET /api/ready — READINESS (distinct from /api/health liveness). Reports only names of missing
 * configuration, never values. In gateway mode the service token must be configured.
 */
export function handleReadiness(env: (name: string) => string | undefined): Response {
  const missing: string[] = [];
  if (env(GATEWAY_MODE_ENV) === GATEWAY_MODE_VALUE && !env(SERVICE_TOKEN_ENV)) missing.push(SERVICE_TOKEN_ENV);
  return missing.length === 0 ? json({ ready: true }) : json({ ready: false, missing }, 503);
}
