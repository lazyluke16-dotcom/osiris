# Tour 27 Destination Intelligence — Phase 1 Implementation Plan

**Status: PLANNING ONLY. No code has been written against any Tour 27 repository. This document is a design, not an implementation.**

**Scope:** The four safest/highest-value hazard-awareness capabilities identified in `OSIRIS-TOUR27-INTEGRATION-AUDIT.md` §6 (Phase 1):
1. Weather (general/anomaly events)
2. Severe weather alerts
3. Earthquakes
4. Fires (wildfire hotspots)

**Explicitly out of scope for this plan:** CCTV, Telegram/live-incidents, maritime/AIS, aviation, public map-routing/geocoding services. These remain Phase 2/3 or DO NOT INTEGRATE per the audit and are not designed here.

**Non-negotiable design principle:** Tour 27 must never depend on `osirisai.live` or any OSIRIS-hosted infrastructure at runtime. OSIRIS is reference material only — a demonstration of which upstream endpoints exist and how to normalize them. Every adapter below calls the upstream provider directly, using Tour 27's own registered accounts/keys where required.

**Explicitly excluded patterns (per audit §3.9/§3.11, DO NOT INTEGRATE):**
- `stealthFetch.ts` — spoofed `X-Forwarded-For`, rotated user-agents, anti-rate-limit evasion. Every adapter below uses plain `fetch` with an honest, identifiable `User-Agent` (e.g. `Tour27-DestinationIntel/1.0 (contact: ops@tour27.example)`), the standard practice for well-behaved consumers of public government APIs.
- No scraping designed to bypass upstream restrictions.

**Target flow (per capability):**

```
UPSTREAM PROVIDER (NOAA/NWS, GDACS, USGS, NASA FIRMS)
  → Tour 27 Destination Intelligence adapter (fetchX / normalizeX)
  → normalization + cache layer (shared HazardEvent shape, Redis-backed TTL cache)
  → Tour 27 backend/API (/v1/hazards/*)
  → ATLAS / Tourist website / Guide app / Together (future)
```

---

## 1. Weather (general/anomaly events)

- **OSIRIS reference files:** `src/app/api/weather/route.ts` — read for the three-provider parallel-fetch pattern and the EONET category-mapping logic. Do not copy `stealthFetch` calls; replace with plain `fetch`.
- **Upstream provider(s):** NASA EONET (`eonet.gsfc.nasa.gov/api/v3/events`) for general anomaly/weather-event tracking (storms, extreme temperature); GDACS RSS (`gdacs.org/xml/rss.xml`) for global cyclone/flood/drought coordination.
- **Provider licensing/usage position:** EONET is US government open data (public domain, no auth, no documented rate limit — designed for high-volume public reuse). GDACS is a UN/EC-backed humanitarian coordination feed; **before Phase 1 ships, Tour 27 must confirm GDACS's specific terms for commercial tourism reuse** (it is generally free for non-commercial/humanitarian use, but "commercial tourism product" is not explicitly the audience it was built for — a one-time terms check, not a blocker in principle).
- **Proposed Tour 27-owned adapter:** `adapters/weather.ts` exporting `fetchEonet(bbox?): Promise<RawEonetEvent[]>` and `fetchGdacs(): Promise<RawGdacsItem[]>`, each paired with a `normalizeEonet()`/`normalizeGdacs()` mapping into the shared `HazardEvent` type (see §5 schema). A `getWeatherHazards(region)` composer calls both in parallel via `Promise.allSettled` and merges results, mirroring OSIRIS's multi-provider composition pattern (audit §3.12) without inheriting any OSIRIS code verbatim.
- **Request/response schema:**
  - Request: `GET /v1/hazards/weather?lat=&lng=&radiusKm=` (or `?bbox=`).
  - Response: `{ events: HazardEvent[], sources: ["eonet","gdacs"], generatedAt: ISODateTime }`.
  - `HazardEvent` shape (shared across all four capabilities): `{ id, type: "weather"|"severe-alert"|"earthquake"|"fire", subtype, title, description?, severity: "info"|"advisory"|"warning"|"emergency", lat, lng, radiusKm?, startedAt, updatedAt, source, sourceUrl }`.
- **Caching strategy:** Redis TTL cache, 10-minute TTL (EONET/GDACS update on the order of hours, not minutes — mirrors OSIRIS's freshness tuning per source). In-flight request dedup (single upstream call serves all concurrent identical requests) and stale-on-error fallback (serve last-known-good on upstream failure, matching `sourceCache.ts`'s pattern from the audit but Redis-backed for multi-instance correctness).
- **Error/fallback behaviour:** `Promise.allSettled` across EONET and GDACS — a failure in one provider degrades to partial results (flagged in `sources[]`) rather than a full 500. If both fail and a stale cache entry exists, serve it with a `stale: true` flag; if no cache exists, return `503` with a clear error body (never silently return an empty-but-200 payload that looks like "no hazards").
- **Rate-limit handling:** Neither provider documents a hard limit; apply a self-imposed client-side ceiling (e.g. one composite fetch per cache TTL, never per-request pass-through) so Tour 27 never becomes a bad citizen even absent a documented cap. No API key to manage for this capability.
- **Geographic query model:** Accept lat/lng + radius (or bbox) at the API layer; filter normalized events server-side by haversine distance from the query point (EONET/GDACS responses are global, so Tour 27's adapter — not the upstream provider — does the geographic filtering, same as OSIRIS does client-side today but moved server-side for a proper API).
- **Security considerations:** No PII, no client-exposed keys (no key needed for this capability). Outbound requests use an honest, identifiable User-Agent per Tour 27's no-evasion policy. Validate/clamp `radiusKm` and `bbox` inputs server-side to prevent abuse of the geographic filter as a resource-exhaustion vector.
- **Observability/logging:** Log upstream latency and success/failure per provider (structured log: `{provider, status, latencyMs, itemCount}`), cache hit/miss ratio, and stale-serve events. Alert on sustained EONET/GDACS failure (both providers down > N minutes) since that silently degrades hazard coverage.
- **Unit tests:** `normalizeEonet()`/`normalizeGdacs()` against fixture JSON/RSS (including malformed/partial upstream responses); geographic filter correctness (points inside/outside radius, antimeridian edge case); cache stale-on-error behaviour with a mocked clock.
- **Integration tests:** Contract test against a recorded real EONET/GDACS response (VCR-style cassette, not a live call in CI) to catch upstream schema drift; end-to-end `/v1/hazards/weather` request against a test Redis instance verifying TTL and dedup behaviour.
- **ATLAS consumption:** ATLAS polls `/v1/hazards/weather` for each active tour's route/destination bounding box as part of pre-departure and in-progress operational risk checks; surfaces warnings to ops staff for manual go/no-go or rerouting decisions.
- **Future Tourist/Guide/Together consumption:** Tourist website — a "current conditions/advisories" panel on destination pages. Guide app — a field-facing hazard banner scoped to the guide's active tour location, polled at a longer interval appropriate for mobile battery/data use. Together — not applicable per audit's product-surface mapping (no ✓ in that column); no design needed here.

---

## 2. Severe weather alerts

- **OSIRIS reference files:** `src/app/api/weather/route.ts` (same route — NWS `alerts/active` and GDACS "orange/red" severity items are the severe-alert subset of the same feed OSIRIS uses for general weather).
- **Upstream provider(s):** NOAA/NWS Active Alerts (`api.weather.gov/alerts/active`, **US-only**); GDACS (rest-of-world, but coarse — disaster-scale cyclone/flood/drought only, not general severe-weather like thunderstorm/tornado warnings outside the US).
- **Provider licensing/usage position:** NWS is US government public-domain data, explicitly built for high-volume public/commercial reuse (it is the feed underlying most US weather apps) — lowest possible risk. GDACS: same terms-check caveat as §1.
- **Proposed Tour 27-owned adapter:** `adapters/severeAlerts.ts` exporting `fetchNwsAlerts(state?/point?): Promise<RawNwsAlert[]>` and reusing `fetchGdacs()` from §1's adapter, filtered to high-severity items. `normalizeNwsAlert()` maps NWS's GeoJSON alert polygons into `HazardEvent` with `severity` derived from NWS's own `severity`/`urgency`/`certainty` fields (Extreme/Severe → `emergency`/`warning`).
- **Request/response schema:** `GET /v1/hazards/severe-alerts?lat=&lng=` → same `HazardEvent[]` envelope as §1, `type: "severe-alert"`. NWS alerts carry a polygon, not just a point — store/return the polygon (or its bounding box) so client apps can do proper "is my route inside this warning" checks rather than a crude radius.
- **Caching strategy:** Shorter TTL than general weather — 5 minutes — since severe alerts are genuinely time-critical (a tornado warning issued 20 minutes ago and still cached is a real operational miss). Same Redis stale-on-error pattern, but stale-serve window capped much tighter (e.g. 15 minutes max staleness before returning "unknown" rather than confidently-wrong data) given the higher stakes.
- **Error/fallback behaviour:** Same `Promise.allSettled` composition as §1. For this capability specifically, prefer **failing loud** over serving stale data past the staleness cap — an ATLAS ops dashboard showing "alert data unavailable" is safer than showing a 45-minute-old all-clear during an active severe event.
- **Rate-limit handling:** NWS asks for a descriptive `User-Agent` identifying the application/contact (documented NWS API etiquette, not a hard rate limit) — Tour 27's adapter sets this honestly per the no-evasion principle. No key required.
- **Geographic query model:** NWS's `alerts/active?point=lat,lng` endpoint does server-side point-in-polygon filtering natively — prefer this over pulling the full national feed and filtering client-side, which is both more efficient and reduces unnecessary load on NWS. GDACS remains global-fetch + Tour 27-side geographic filter as in §1.
- **Security considerations:** Same as §1 — no PII, no keys, validated geographic inputs. Because this feeds operational risk decisions, ensure the API response includes an explicit `asOf`/`generatedAt` timestamp so downstream consumers (ATLAS especially) can detect and reject stale-past-threshold data themselves rather than trusting the cache layer alone.
- **Observability/logging:** Same as §1, plus an explicit metric/alert for "severe-alert cache staleness exceeded threshold" — this should page/notify, not just log, given the operational stakes for ATLAS.
- **Unit tests:** NWS polygon parsing and severity mapping against fixture alerts (including the "this state has zero active alerts" empty case, and malformed/withdrawn-alert edge cases NWS is known to emit); staleness-cap enforcement logic.
- **Integration tests:** Recorded-cassette contract test against real NWS/GDACS alert payloads; end-to-end test simulating an upstream outage to verify the fail-loud-past-staleness-cap behaviour actually triggers.
- **ATLAS consumption:** Primary consumer. ATLAS should treat this as a higher-priority signal than §1's general weather feed — e.g. a dedicated "active severe alerts affecting today's tours" ops view, potentially with a push/notification hook (out of scope to design here, but the API should be poll-friendly with a cheap "anything changed since X" pattern, e.g. `ETag`/`If-None-Match`, to support that later).
- **Future Tourist/Guide/Together consumption:** Guide app — highest-value surface, a prominent in-field warning if the guide's current tour location falls inside an active severe polygon. Tourist website — pre-trip advisory banner on affected destination pages. Together — not applicable (per audit mapping).

---

## 3. Earthquakes

- **OSIRIS reference files:** `src/app/api/earthquakes/route.ts` — audit calls this "the safest possible integration" (~50 lines, trivial GeoJSON-to-flat-object map). Worth keeping: the `Cache-Control: public, s-maxage=60` header pattern as a reference for edge-cacheability, even though Tour 27's actual cache layer will be Redis-backed rather than relying solely on HTTP cache headers.
- **Upstream provider:** USGS Earthquake Hazards Program GeoJSON feed (`earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson`), M2.5+, rolling 24h window. (USGS also publishes 1-hour/7-day/30-day and other magnitude-threshold variants at predictable sibling URLs, worth noting for future tuning.)
- **Provider licensing/usage position:** US government public-domain data; the de facto standard feed used by virtually every earthquake-aware application. No auth, no documented rate limit, explicitly designed for high-volume reuse. Lowest-risk capability in this entire plan.
- **Proposed Tour 27-owned adapter:** `adapters/earthquakes.ts` exporting `fetchUsgsQuakes(minMagnitude, window): Promise<RawUsgsFeature[]>` and `normalizeUsgsQuake()` → `HazardEvent` with `subtype: "M{magnitude}"`, `severity` derived from a simple magnitude threshold (e.g. <4.5 `info`, 4.5–6 `advisory`, 6–7 `warning`, 7+ `emergency` — Tour 27-defined bands, not USGS's own, since USGS doesn't opine on severity).
- **Request/response schema:** `GET /v1/hazards/earthquakes?lat=&lng=&radiusKm=&minMagnitude=` → `HazardEvent[]`, `type: "earthquake"`, including `magnitude` and `depthKm` as extra fields beyond the shared schema (the shared `HazardEvent` type allows a `details: Record<string, unknown>` bag for capability-specific fields like this).
- **Caching strategy:** 5-minute Redis TTL (USGS's own feed updates roughly every 1–5 minutes internally); in-flight dedup; stale-on-error with a generous staleness cap (earthquakes are point-in-time events, not evolving conditions like a storm — a 30-minute-stale quake list is still accurate, just possibly missing the very latest event).
- **Error/fallback behaviour:** Single-provider capability (no multi-source composition needed), so failure handling is simpler than §1/§2: on fetch failure, serve stale cache if available, else `503`. No partial-result complexity since there's only one upstream.
- **Rate-limit handling:** None documented by USGS; no key needed. Same self-imposed "cache-layer is the only thing that hits upstream" discipline as the other capabilities — client requests never trigger a direct upstream call.
- **Geographic query model:** Pull the full global M2.5+ feed (small payload, typically well under a few hundred events per 24h) and filter server-side by haversine distance from the query point — same approach OSIRIS uses, appropriate here since USGS doesn't offer server-side geographic filtering on this particular feed.
- **Security considerations:** No PII, no keys. Lowest-risk capability in the plan from a security standpoint as well as a licensing one.
- **Observability/logging:** Standard fetch latency/success logging; alert only on sustained total feed failure (this is a single upstream with no fallback provider, so its unavailability is a real gap worth knowing about, even though the operational stakes are lower than severe weather alerts).
- **Unit tests:** GeoJSON parsing/normalization against USGS fixture data (including zero-quake and malformed-feature edge cases); magnitude-to-severity banding logic.
- **Integration tests:** Recorded-cassette contract test against a real USGS feed snapshot to catch schema drift; end-to-end `/v1/hazards/earthquakes` test verifying geographic filter and cache TTL.
- **ATLAS consumption:** Post-event awareness for tours in seismically active regions — e.g. flagging any tour with an active/recent itinerary point near a recent M5+ event for manual ops review.
- **Future Tourist/Guide/Together consumption:** Tourist website — informational only, likely low-priority given the audit's product-surface mapping shows this as Tourist-website-and-ATLAS-only (no Guide/Together checkmark), consistent with earthquakes being a "did something just happen here" signal rather than an ongoing field-safety concern the way severe weather is.

---

## 4. Fires (wildfire hotspots)

- **OSIRIS reference files:** `src/app/api/fires/route.ts` — audit notes a clean CSV parser and a 2000-point downsample for browser rendering performance (the downsample is a frontend-rendering concern, not something Tour 27's backend adapter needs to replicate — the API should return full fidelity and let each client downsample for its own rendering needs if any).
- **Upstream provider:** NASA FIRMS open-data CSV feeds — keyless global 24h active-fire feeds (`firms.modaps.eosdis.nasa.gov/data/active_fire/{suomi-npp-viirs-c2,modis-c6.1}/csv/*_Global_24h.csv`). NASA EONET's volcano category as a secondary/optional source (volcanic activity, related but distinct hazard).
- **Provider licensing/usage position:** NASA FIRMS is public-domain open data, free reuse with attribution requested (not required — a courtesy, but Tour 27 should include it in an "acknowledgements/data sources" page regardless, as good practice). Note per the audit: `.env.example` documents an optional `FIRMS_API_KEY` for FIRMS's separate *per-area* API (rate-limited to 5000 req/10min) which OSIRIS's current code does not use — the keyless global-CSV path used here has no documented limit and needs no key.
- **Proposed Tour 27-owned adapter:** `adapters/fires.ts` exporting `fetchFirmsCsv(source: "viirs"|"modis"): Promise<string>` (raw CSV) and `parseFirmsCsv()`/`normalizeFirmsHotspot()` → `HazardEvent` with `severity` derived from FIRMS's own `confidence`/`frp` (fire radiative power) fields (low-confidence detections should map to `info`, not `warning`, to avoid over-alerting on noisy satellite data — this is a real characteristic of FIRMS data worth designing around, not an oversight).
- **Request/response schema:** `GET /v1/hazards/fires?lat=&lng=&radiusKm=&minConfidence=` → `HazardEvent[]`, `type: "fire"`, `details: { confidence, frp, satellite }`.
- **Caching strategy:** 15-minute Redis TTL (FIRMS's global CSV feeds refresh a few times a day per source, not continuously — no need for aggressive polling); in-flight dedup; stale-on-error with a moderate staleness cap similar to earthquakes (a wildfire hotspot list a few hours stale is still broadly informative, but shouldn't be served indefinitely during an outage).
- **Error/fallback behaviour:** Two independent satellite sources (VIIRS, MODIS) fetched via `Promise.allSettled` — partial degradation (one satellite's data missing) is acceptable and should be flagged in `sources[]`, not treated as total failure. Total failure (both CSVs unreachable) → stale-serve within cap, else `503`.
- **Rate-limit handling:** No documented limit on the keyless global-CSV path used here; no key needed for Phase 1. (If Tour 27 later needs finer per-area queries, registering for `FIRMS_API_KEY` and respecting its documented 5000/10min limit is a Phase-2-scale consideration, not needed for this plan.)
- **Geographic query model:** CSV rows include lat/lng per hotspot directly; parse full global CSV, filter server-side by haversine distance from query point — same pattern as earthquakes.
- **Security considerations:** No PII, no keys required for the keyless path used here. CSV parsing should be defensive against malformed/truncated upstream responses (NASA feeds occasionally serve partial files during their own refresh windows — the parser should fail safe, not throw an unhandled exception that takes down the request).
- **Observability/logging:** Per-satellite-source fetch success/failure and row count logged separately (useful for spotting when one satellite's feed silently degrades to a much smaller hotspot count than usual, a real-world FIRMS quirk worth monitoring for).
- **Unit tests:** CSV parser against fixture data including malformed/truncated rows, empty-feed case, confidence-to-severity banding; geographic filter correctness reused/shared with the earthquakes test suite where the logic is common.
- **Integration tests:** Recorded-cassette contract test against a real FIRMS CSV snapshot; end-to-end `/v1/hazards/fires` test verifying partial-source degradation behaviour (simulate one satellite feed failing, confirm the other still serves).
- **ATLAS consumption:** Wildfire-proximity warnings for tours/routes/campgrounds in fire-prone destinations and seasons — likely the single highest-value Phase 1 capability for ATLAS's operational risk monitoring given how directly it can affect an active tour's route or safety.
- **Future Tourist/Guide/Together consumption:** Tourist website, Guide app, Roaming/Quick Tours, Group Tours, Custom Tours all map to this per the audit's product-surface table — smoke/air-quality-adjacent advisories and route-avoidance information are broadly relevant across nearly every customer-facing surface. Together remains not applicable per the audit mapping.

---

## 5. Shared Design Elements (cross-cutting, not per-capability)

- **Shared `HazardEvent` schema** (used by all four capabilities above) lives in `core/normalize.ts`, one canonical type consumed by every adapter's `normalizeX()` function — this is the direct analog of OSIRIS's per-domain normalization pattern (audit §3.12), which the audit identifies as the single most valuable and safely extractable architectural idea in the whole repository.
- **`core/cache.ts`** — Redis-backed TTL cache + in-flight dedup + stale-on-error, one shared module parameterized per-capability TTL/staleness-cap rather than four separate cache implementations.
- **`core/ratelimit.ts`** — Redis-backed sliding-window limiter for *inbound* requests to Tour 27's own `/v1/hazards/*` API (protecting Tour 27's service from its own clients' abuse), adapted from the audit's `isRateLimited`/`getClientIp` pattern (§3.13) — notably including the detail of preferring platform-set headers (e.g. a CDN's client-IP header) over spoofable `X-Forwarded-For`, which the audit specifically flags as a good practice worth copying.
- **No `ssrf-guard.ts` needed for Phase 1** — that guard exists in OSIRIS to protect its own tile/image-proxying routes (which are explicitly out of scope here); Phase 1's adapters only call four well-known, hardcoded upstream hostnames (no user-supplied URLs), so SSRF is not an applicable risk surface for this phase.
- **All four adapters share one `honestFetch()` helper** — a thin wrapper around `fetch` with a fixed, honest `User-Agent` and a timeout, explicitly the opposite of `stealthFetch.ts`. This is the one piece of shared plumbing every adapter uses, and its existence (a single, auditable, honest-headers fetch helper) is itself the concrete implementation of "do not copy stealthFetch."

---

## 6. What This Plan Does Not Cover

Per the mission constraints, this plan does not include: CCTV, Telegram/live-incidents, maritime/AIS, aviation, or map-routing/geocoding adapters (all Phase 2/3 or excluded per the audit). It does not touch any Tour 27 production repository, provision any infrastructure (including the Redis instance referenced above, which is a future implementation dependency, not something provisioned by this document), deploy anything, or purchase any API access. No code has been written against Tour 27's actual codebase — this document is the design to be reviewed before that work begins.
