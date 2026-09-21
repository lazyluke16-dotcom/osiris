# Tour 27 OSIRIS gateway — runbook

Providers, freshness and the single-instance assumption: see the generated `PROVIDERS.md`.

## Run
`docker compose -f deploy/tour27/docker-compose.yml up -d --build` with `OSIRIS_SERVICE_TOKEN` (and optionally
`OSIRIS_SERVICE_TOKEN_NEXT`, `NASA_FIRMS_MAP_KEY`) supplied from the secret store. Bound to loopback; expose only via the reverse proxy.
**Single instance only** (in-memory cache and per-instance provider budgets).

## Verify
`SMOKE_TARGET=url BASE_URL=http://127.0.0.1:3000 OSIRIS_SERVICE_TOKEN=... node deploy/tour27/smoke.mjs` → `SMOKE_RESULT=PASS`.
`/api/health` liveness, `/api/ready` readiness (503 names the missing config, never values), `/api/tour27/health` provider health (token required).

## Token rotation (no downtime)
1. `rotate` writes a new token to `OSIRIS_SERVICE_TOKEN_NEXT`; restart OSIRIS (accepts both).
2. Switch the backend to the new token; run `smoke`.
3. `promote`, restart OSIRIS with only the new token as `OSIRIS_SERVICE_TOKEN`.

## Rollback
- Behavioural (instant, no deploy): set `DESTINATION_INTELLIGENCE_MODE=DIRECT` on the backend and restart it. DIRECT is the default and the fallback for any unrecognised value.
- Gateway: `docker compose down`; the backend in DIRECT mode does not depend on it.
- Secrets: `service-token.mjs rollback --apply` removes both parameters.

## Incidents
A single failed probe is transient (`DEGRADED`). Only 3 consecutive failed canary runs are `UNHEALTHY` and raise an incident.
`LICENCE_PENDING` (BOM) and `TOKEN_PENDING` (MeteoAlarm) are expected, not failures.
