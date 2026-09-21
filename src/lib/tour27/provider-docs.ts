import { PROVIDER_REGISTRY } from './registry';
import type { ProviderId } from './contract';
import { ECCC_EMPTY_ZONE_TTL_SECONDS, ECCC_FRESH_SECONDS, ECCC_MAX_REQUESTS_PER_MINUTE, ECCC_ZONE_TTL_SECONDS } from './providers/eccc';
import { EONET_DEGRADED_SECONDS, EONET_FRESH_SECONDS, EONET_STALE_SECONDS } from './providers/eonet';
import { FIRMS_DEGRADED_SECONDS, FIRMS_FRESH_SECONDS, FIRMS_STALE_SECONDS } from './providers/firms';
import { METNO_FALLBACK_FRESH_SECONDS, METNO_STALE_WINDOW_SECONDS } from './providers/metno';
import { FRESH_DEFAULT_SECONDS, FRESH_MAX_SECONDS, FRESH_MIN_SECONDS, OUTSIDE_COVERAGE_TTL_SECONDS } from './providers/nws';
import { USGS_FRESH_SECONDS, USGS_STALE_SECONDS } from './providers/usgs';
import { GATEWAY_MODE_ENV, GATEWAY_MODE_VALUE, SERVICE_TOKEN_ENV, SERVICE_TOKEN_NEXT_ENV } from './gateway-guard';
import { buildDefaultProviders } from './default-gateway';
import { DestinationIntelligenceGateway } from './gateway';
import { MemoryCache, silentLogger } from './runtime';

/** Which providers the shipped gateway actually wires (never called: no network). */
function implementedProviders(): ReadonlySet<ProviderId> {
  const deps = { fetch: (async () => { throw new Error('docs only'); }) as unknown as typeof fetch, cache: new MemoryCache(), now: () => new Date(0), env: () => undefined, logger: silentLogger };
  return new DestinationIntelligenceGateway(buildDefaultProviders(deps), silentLogger).implemented();
}

const fmt = (s: number): string => (s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

/** Freshness semantics as implemented (constants are imported from the providers, so this cannot drift). */
export const FRESHNESS: Record<string, string> = {
  USGS: `fresh ${fmt(USGS_FRESH_SECONDS)}; on upstream failure a copy up to ${fmt(USGS_STALE_SECONDS)} old is served flagged \`stale: true\``,
  NASA_FIRMS: `fresh ${fmt(FIRMS_FRESH_SECONDS)}; stale copy up to ${fmt(FIRMS_STALE_SECONDS)} flagged \`stale: true\`; degraded answers cached ${fmt(FIRMS_DEGRADED_SECONDS)} and never reused as stale`,
  NASA_EONET: `fresh ${fmt(EONET_FRESH_SECONDS)}; stale copy up to ${fmt(EONET_STALE_SECONDS)} flagged \`stale: true\`; degraded (one box failed) cached ${fmt(EONET_DEGRADED_SECONDS)}`,
  MET_NORWAY: `fresh until the provider's exact \`Expires\` (fallback ${fmt(METNO_FALLBACK_FRESH_SECONDS)}); stale window ${fmt(METNO_STALE_WINDOW_SECONDS)} from expiry; conditional \`If-Modified-Since\` refresh`,
  NWS: `fresh from \`max-age\` clamped ${FRESH_MIN_SECONDS}-${FRESH_MAX_SECONDS} s (default ${FRESH_DEFAULT_SECONDS} s); outside-coverage cached ${fmt(OUTSIDE_COVERAGE_TTL_SECONDS)}; official warnings are never served stale`,
  ECCC: `alerts fresh ${fmt(ECCC_FRESH_SECONDS)} (never stale); zone geography ${fmt(ECCC_ZONE_TTL_SECONDS)} (empty ${fmt(ECCC_EMPTY_ZONE_TTL_SECONDS)}); fail-closed budget ${ECCC_MAX_REQUESTS_PER_MINUTE} req/min`,
  BOM: 'not implemented (licence pending)',
  METEOALARM: 'not implemented (token pending)',
};

/**
 * Scale-out / restart analysis. The runtime cache, single-flight and request budgets are IN-PROCESS.
 * Correctness never depends on them (every answer is derived from the provider; a cold cache only costs a
 * request), but provider LOAD and budget enforcement are per instance.
 */
export const DEPLOYMENT_NOTES: Record<string, { correctness: string; load: string; restart: string; scaleOut: string }> = {
  USGS: { correctness: 'None: stateless per query.', load: 'One upstream call per distinct query per fresh window per instance.', restart: 'Cold cache; stale fallback lost until the next success.', scaleOut: 'Load multiplies by instance count; no correctness impact.' },
  NASA_FIRMS: { correctness: 'None; degraded answers are never reused as stale.', load: 'Counts against the MAP_KEY transaction allowance per instance.', restart: 'Cold cache; stale fallback lost.', scaleOut: 'MAP_KEY allowance is consumed by ALL instances but not coordinated: multiply load by N before scaling.' },
  NASA_EONET: { correctness: 'None.', load: 'One or two calls per query per fresh window per instance.', restart: 'Cold cache; stale fallback lost.', scaleOut: 'Load multiplies; no correctness impact.' },
  MET_NORWAY: { correctness: 'None; exact Expires respected per instance.', load: 'MET Norway terms require respecting Expires and conditional requests; each instance does so independently.', restart: 'Loses Last-Modified/Expires state, so the first request per location is unconditional.', scaleOut: 'N instances = N independent conditional-request streams; keep well inside MET Norway load guidance or use a shared cache first.' },
  NWS: { correctness: 'None: alerts are never served stale and per-point cache is short.', load: 'One call per point per fresh window per instance (max-age respected).', restart: 'Cold cache; nothing safety-relevant is lost.', scaleOut: 'Load multiplies; no correctness impact.' },
  ECCC: { correctness: 'None: current alerts are always read BEFORE cached geography.', load: `The ${ECCC_MAX_REQUESTS_PER_MINUTE} req/min budget is PER INSTANCE and fail-closed; with N instances the effective ceiling is N x ${ECCC_MAX_REQUESTS_PER_MINUTE}.`, restart: 'Budget window and zone cache reset, so a restart burst is possible; single-flight limits it.', scaleOut: 'The budget is not globally shared; do not scale beyond one instance without a shared budget/cache (Redis) or a lowered per-instance limit.' },
  BOM: { correctness: 'n/a (not implemented)', load: 'n/a', restart: 'n/a', scaleOut: 'n/a' },
  METEOALARM: { correctness: 'n/a (not implemented)', load: 'n/a', restart: 'n/a', scaleOut: 'n/a' },
};

export const DEPLOYMENT_ASSUMPTION = 'Supported deployment: a SINGLE OSIRIS gateway instance with an in-memory cache. Do not run multiple replicas until a shared cache / request budget exists (see the per-provider scale-out column).';

export function renderProviderDocs(): string {
  const implemented = implementedProviders();
  const rows = PROVIDER_REGISTRY.map((d) => `| ${d.provider} | ${d.truthClass} | ${d.capability} | ${d.coverage} | ${d.requiredSecret ? `\`${d.requiredSecret}\`` : '-'} | ${d.licenceStatus} | ${implemented.has(d.provider) ? 'implemented' : d.pendingState ?? 'not implemented'} | ${FRESHNESS[d.provider] ?? 'n/a'} |`);
  const notes = PROVIDER_REGISTRY.map((d) => {
    const n = DEPLOYMENT_NOTES[d.provider];
    return `| ${d.provider} | ${n.correctness} | ${n.load} | ${n.restart} | ${n.scaleOut} |`;
  });
  return [
    '<!-- GENERATED by src/lib/tour27/provider-docs.ts from PROVIDER_REGISTRY. Do not edit by hand; run `UPDATE_TOUR27_DOCS=1 npx vitest run src/lib/tour27/provider-docs.test.ts`. -->',
    '# Tour 27 Destination Intelligence — providers',
    '',
    '| Provider | Truth class | Capability | Coverage | Required secret | Access / licence | Implementation | Freshness semantics |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '`LICENCE_PENDING` (BOM) and `TOKEN_PENDING` (MeteoAlarm) are expected states, not failures. Absence of an alert is never evidence of safety.',
    '',
    '## Configuration (names only, never values)',
    '',
    `- \`${GATEWAY_MODE_ENV}=${GATEWAY_MODE_VALUE}\` — deny everything except the allow-listed Tour 27 routes.`,
    `- \`${SERVICE_TOKEN_ENV}\` — bearer token the Tour 27 backend presents; \`${SERVICE_TOKEN_NEXT_ENV}\` — second accepted token for rotation.`,
    ...PROVIDER_REGISTRY.filter((d) => d.requiredSecret).map((d) => `- \`${d.requiredSecret}\` — ${d.provider}.`),
    '',
    '## Deployment assumption: cache, budgets and scale-out',
    '',
    DEPLOYMENT_ASSUMPTION,
    '',
    '| Provider | Correctness consequence | Provider-load consequence | Restart consequence | Scale-out consequence |',
    '|---|---|---|---|---|',
    ...notes,
    '',
  ].join('\n');
}
