# OSIRIS → Tour 27 / ATLAS Integration Audit

**Scope:** Read-only architectural inventory of the OSIRIS repository (branch `tour27/osiris-intelligence-audit`), evaluated for reusable capabilities relevant to Tour 27 (tourism company) and ATLAS (its ops platform).
**Method:** Direct source inspection of `.env.example`, `README.md`, `intel/`, `engine/`, `src/app/api/**`, `src/lib/**`, `package.json`, `docker-compose.yml`. No code was modified, no dependencies were installed, no scripts were executed.

---

## 1. Executive Summary

OSIRIS is a single Next.js 16 / TypeScript application that aggregates dozens of free, mostly keyless public data feeds (USGS, NASA, NOAA, OpenSky, adsb.fi, OpenAQ, GDACS, various state/national DOT camera APIs, OSM routing/geocoding, etc.) behind a set of `/api/*` Next.js route handlers, and renders them on a single MapLibre GL globe. There is no separate "engine" or "intel" backend of real substance — `engine/` contains only stray Python `.pyc` cache files (no source, unrelated to this app), and `intel/` is a small Express **RECON scanner** microservice (port scan / DNS / WHOIS / vuln lookups), not a data-source adapter layer.

For Tour 27's purposes, the genuinely valuable and cleanly extractable material is the **data-normalization pattern**: dozens of small, single-purpose TypeScript functions that call a public upstream API and reshape its response into a consistent internal type. Weather, earthquakes, fires, air quality, aviation, geocoding/routing, and space weather are all low-risk, open-government-data sources with clean, portable adapter code (10–100 lines each, no OSIRIS-specific coupling beyond `NextResponse`). CCTV and maritime are higher-value for a "Live World Map" feature but carry real complexity (CCTV: 48 region-specific scrapers of varying legality/ToS; maritime: paid websocket API). Two components are **security/ethical red flags that Tour 27 should not copy**: `stealthFetch.ts` (spoofs `X-Forwarded-For` headers with fake residential IPs and rotates user-agents specifically to evade upstream rate-limiting/blocking) and the Telegram-scraping "intel" feed (unauthenticated HTML scraping of `t.me/s/<channel>`, paired with a crude keyword-based "risk score" mislabeled in an earlier version as AI analysis).

The repository's own code is MIT-licensed, but **almost none of the value is in OSIRIS's code — it is in knowing which upstream endpoints exist and how to normalize their responses.** Every upstream provider's data carries its own separate terms of use that Tour 27 must independently verify; MIT covers none of that data.

---

## 2. Repository Overview

- **What it is:** "OSIRIS — Open Source Intelligence & Reconnaissance Integrated System," a self-hostable, single-tenant OSINT/situational-awareness dashboard (live demo: osirisai.live). Positioned partly as a hobbyist/"RedTeam" cyber-OSINT tool (port scanning, WHOIS, crypto-wallet tracing, OFAC sanctions screening, malware/CVE feeds), partly as a general live-world map (flights, ships, cameras, weather, quakes, fires, news).
- **Tech stack:** Next.js 16 (App Router) + TypeScript 5 + React 19, MapLibre GL 6.7 for WebGL map rendering (`react-map-gl` wrapper), `framer-motion` for UI animation, `satellite.js` for orbital mechanics, `ws` for the maritime AIS WebSocket client, `sharp` for image processing, `@google/generative-ai` for the "AI Analysis" panel (Gemini), `rss-parser` for RSS feeds, `hls.js`/`lightweight-charts` for media/markets widgets. No database — everything is in-memory caching plus an optional on-disk JSON snapshot for the CCTV catalogue. `vitest` for tests. Deployed via a standalone Next.js Docker image; `docker-compose.yml` adds an `nginx:alpine` cache-proxy sidecar and the small `intel` (RECON scanner) Express service. **No Redis, no Postgres/PostGIS** — caching and rate limiting are both pure in-process JS (`Map`-based), which will not survive a multi-instance/serverless deployment without modification.
- **`engine/` directory:** contains only compiled Python `__pycache__/*.pyc` files (`ledger`, `oracle`, `swarm`, `webhooks`, `world_state`, etc.) with **no corresponding source** tracked in the repo. This looks like leftover build artifacts from an unrelated project (naming suggests a crypto trading/agent "swarm" system) accidentally committed, not part of OSIRIS's actual runtime. **Not usable, not investigated further, and should not be assumed to be part of OSIRIS's real architecture.**
- **`intel/` directory:** a minimal Express server (`intel/server.js`) — the backend for the RECON toolkit (port scanner, DNS, WHOIS, SSL inspector, vuln scanner). Not a data-source adapter hub; not relevant to tourism/weather/CCTV capabilities.

### Licensing — two separate things

1. **OSIRIS's own software license: MIT** (`LICENSE`, copyright "simplifaisoul", 2026). This covers only the code OSIRIS wrote (the Next.js app, its normalization functions, UI). Tour 27 may freely copy, modify, and relicense this code under MIT's terms (attribution required).
2. **Third-party data/content terms: NOT covered by OSIRIS's MIT license.** Every upstream feed (NOAA, USGS, NASA FIRMS, OpenAQ, OpenSky, adsb.fi/adsb.lol, aisstream.io, state DOT camera feeds, Telegram, OpenStreetMap/Nominatim/Photon/Valhalla/OSRM, OpenSanctions, etc.) has its own independent terms of use, rate limits, and attribution requirements that OSIRIS's MIT license has no bearing on. **Tour 27 must independently review each provider's ToS before using their data in a commercial product**, especially: OpenSky Network (network ToS restricts commercial redistribution without agreement), state/national DOT camera feeds (mostly public-safety data meant for driver information, not general redistribution), and Telegram (scraping the public web preview without the Bot API is against Telegram's ToS in spirit even though technically unauthenticated).
3. **Notably, no cryptocurrency-token, ICO, or "get rich" language was found** anywhere in `package.json`, `README.md`, or `docker-compose.yml`. The crypto-related features (`/api/crypto`, `/api/osint/crypto`, `ChainBrief.tsx`, `TokenPanel.tsx`) are wallet forensics/OFAC-sanctions-screening tools (BTC/ETH balance and transaction lookups via mempool.space/Blockscout, cross-checked against OFAC SDN lists) — not a token sale or "OSIRIS coin." This is factually noted per the audit instructions but is not a red flag in the ICO-scam sense.
4. **One mild promotional-oddity flag:** the README's Patreon section references an unreleased "🔴 RedTeam Console" role and "encrypted developer comms" for supporters — cosmetic marketing language, not a functional or licensing concern, but worth knowing this is a community/hobby project rather than a vetted commercial vendor.

---

## 3. Capability-by-Capability Inventory

### 3.1 Weather (severe events / anomalies)

- **Source files:** `src/app/api/weather/route.ts`
- **Upstream providers:** NASA EONET (`eonet.gsfc.nasa.gov/api/v3/events`), NOAA/NWS Active Alerts (`api.weather.gov/alerts/active`, US-only), GDACS RSS (`gdacs.org/xml/rss.xml`, global cyclones/floods/droughts).
- **Auth:** none required for any of the three.
- **Rate limits:** not documented by any provider in-code; NWS/EONET/GDACS are all free government/inter-agency feeds with generous fair-use limits.
- **License/terms risk:** Low. NWS and EONET are US government open data (public domain). GDACS is a UN/EC-backed disaster-alerting coordination system, generally free for non-commercial and humanitarian reuse — Tour 27 should confirm GDACS's specific reuse terms for a commercial tourism product before shipping.
- **Extraction:** Clean. `route.ts` is self-contained: three parallel `fetch`/`stealthFetch` calls, three small parsers (`parseGdacsRss` via regex, GeoJSON walk for NWS, EONET category mapping), normalized into one `WeatherEvent[]` shape. Swap `stealthFetch` for plain `fetch` and it lifts out directly.
- **Recommendation:** **COPY/ADAPT.** This is exactly the kind of "is there a storm/hurricane near this destination or excursion route" signal Tour 27 needs. Replace `stealthFetch` with plain `fetch`.
- **Dependencies:** none beyond global `fetch`.
- **Security/privacy:** None — no PII, no client-exposed keys (server-side route). Only concern: it uses `stealthFetch` (see §3.11 flag) for two of the three calls, which should be stripped when adapted.

### 3.2 Severe weather alerts

Covered by the same route as above (NWS `alerts/active` is the severe-alert feed for the US; GDACS covers rest-of-world cyclone/flood/drought alerts at "orange/red" severity). No separate route exists. Same recommendation: **COPY/ADAPT**, US-only granularity from NWS, global-but-coarser from GDACS. For destinations outside the US, Tour 27 will want a supplementary global severe-weather-alert provider (e.g., a commercial one) since GDACS only covers a handful of hazard types (TC/FL/DR) and is disaster-scale, not "will it rain on my tour" scale.

### 3.3 Fires (wildfire hotspots)

- **Source files:** `src/app/api/fires/route.ts`
- **Upstream providers:** NASA FIRMS open-data CSV feeds (`firms.modaps.eosdis.nasa.gov/data/active_fire/{suomi-npp-viirs-c2,modis-c6.1}/csv/*_Global_24h.csv`) — keyless; NASA EONET volcanoes category as a secondary source.
- **Auth:** none used by the keyless CSV route. `.env.example` documents an optional `FIRMS_API_KEY` for the *per-area* FIRMS API (not used by current code) — limit documented as 5000 req/10 min if that path is used.
- **License/terms risk:** Low. NASA FIRMS open data is public domain / free reuse with attribution requested.
- **Extraction:** Clean. Simple CSV parser (`parseCSV`), a 2000-point downsample for browser performance, straightforward.
- **Recommendation:** **COPY/ADAPT.** Directly useful for wildfire-proximity warnings on tour routes/campgrounds, especially in fire-prone destinations.
- **Security/privacy:** None.

### 3.4 Earthquakes

- **Source files:** `src/app/api/earthquakes/route.ts`
- **Upstream provider:** USGS Earthquake Hazards Program GeoJSON feed (`earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson`), M2.5+, rolling 24h.
- **Auth:** none.
- **Rate limits:** none documented; USGS feeds are designed for high-volume public consumption.
- **License/terms risk:** Very low — US government public-domain data, this is the standard feed used by virtually every earthquake app.
- **Extraction:** Trivial — ~50 lines, straight GeoJSON-to-flat-object map. Includes `Cache-Control: public, s-maxage=60` header pattern worth keeping.
- **Recommendation:** **COPY/ADAPT** (Phase 1, safest possible integration).
- **Security/privacy:** None.

### 3.5 Air quality

- **Source files:** `src/app/api/air-quality/route.ts`
- **Upstream provider:** OpenAQ **v2** API (`api.openaq.org/v2/latest`), PM2.5 only, keyless.
- **Auth:** none currently; OpenAQ has since migrated most traffic to a v3 API that **requires a free API key** — this v2 code should be assumed partially deprecated/rate-limited and needs re-validation before reuse, not a straight copy.
- **License/terms risk:** Low — OpenAQ aggregates government and research air-quality stations, CC-BY-4.0-style open data, but Tour 27 should register for its own OpenAQ v3 key and confirm current terms.
- **Extraction:** Clean, small (~70 lines), simple AQI color-banding logic worth reusing.
- **Recommendation:** **COPY/ADAPT with rework** — migrate to OpenAQ v3 + API key before use (Phase 2, needs provider review because of the v2→v3 transition).
- **Security/privacy:** None.

### 3.6 Public CCTV / cameras

- **Source files:** `src/app/api/cctv/route.ts` (orchestrator, ~1000 lines) + **48 per-region/per-country adapter files** in `src/app/api/cctv/*.ts` (e.g. `texas.ts`, `germany.ts`, `japan.ts`, `hongkong.ts`, `netherlands.ts`, `asfinag.ts` for Austria, `opencctv.ts`, `world-live.ts`, etc.), plus `src/lib/camera-catalog.ts`, `src/lib/camera-feed.ts`, `src/lib/camera-preview.ts`, `src/lib/cctv-snapshot.ts` (disk persistence of the aggregated catalogue), `src/app/api/cctv/proxy/route.ts` (image proxy) and `src/app/api/cctv/resolve/route.ts`.
- **Upstream providers (representative, not exhaustive):** UK TfL JamCams, US state DOTs (WSDOT, Caltrans, TxDOT/IBI511, ODOT, UDOT, NDOT, MDOT, INDOT, LADOTD, FL/GA/NC 511, Butler County OH sheriff cams), Canadian provincial 511 systems (Ottawa, Quebec 511, 511 Ontario, DriveBC, Alberta 511, Toronto Open Data), Singapore LTA `data.gov.sg`, Netherlands Rijkswaterstaat, Austria ASFINAG, Hong Kong Transport Dept, Taiwan THB, New Zealand NZTA, plus curated/YouTube-embed cameras for Israel/Lebanon and various "world-live"/"asia-live"/"opencctv" catch-all webcam indexes.
- **Auth:** none for any of these — all are public open-data traffic-camera indexes or public webcam directories.
- **Rate limits:** not documented per-source; the orchestrator (`fetch-pool.ts` `REGION_CONCURRENCY = 4`, `REGION_BUDGET_MS = 12s`) exists specifically because unthrottled fan-out to 48 sources at once caused upstream connection failures — i.e., self-imposed throttling to be a good citizen, not a documented provider limit.
- **License/terms risk: Mixed, source-by-source, and this is the highest-risk capability area.** Government traffic-camera feeds (state DOTs, TfL, provincial 511 systems) are generally intended for driver/public-safety information and often carry explicit terms restricting commercial redistribution or requiring attribution; a handful of "curated" entries in `us-east`/`middle-east` regions are **YouTube live-stream embeds** and **direct hotlinks to a sheriff's department camera server** (`gsccam.butlersheriff.org`) — these specific entries carry meaningfully higher ToS/liability risk than open-data feeds and should not be copied as-is. Tour 27 must review each jurisdiction's specific terms (most explicitly disclaim liability for redistribution and some require non-commercial use) before using any of these in a customer-facing product.
- **Extraction:** Moderately clean per-adapter (each file is small and self-contained, following one of a few repeated patterns: fetch → filter valid lat/lng → map to a common `{id, lat, lng, name, city, country, feed_url, source}` shape), but the **orchestration layer is heavily bespoke to OSIRIS** (global in-memory `Map` caches, a hand-rolled concurrency pool, disk-snapshot persistence, gzip pre-serialization, ETag handling, ~1000 lines of region-bounding-box logic). Extracting a handful of individual country adapters is easy; extracting the whole system is a multi-day rewrite, not a lift-and-shift.
- **Recommendation:** **Phase 2/3 — SELECTIVE COPY.** Take only the specific country/region adapters relevant to Tour 27's actual destinations (e.g. if Tour 27 operates in specific countries), rewrite the orchestration layer from scratch against Tour 27's own caching/infra, and drop the YouTube-embed and sheriff-camera entries entirely. Do not bulk-import all 48 regions.
- **Security/privacy:** CCTV of public roads/public spaces raises no direct PII risk in itself (public infrastructure cameras), but redistributing a foreign government's traffic-camera feed inside a commercial tourism app is the single biggest ToS-compliance question in this whole audit and needs Tour 27 legal review before Phase-2 work begins.

### 3.7 Aviation

- **Source files:** `src/app/api/flights/route.ts` (live map layer — OpenSky + adsb.fi), `src/app/api/aircraft/route.ts` (per-aircraft identity + flown track — adsb.lol traces + adsbdb), `src/app/api/flight-route/route.ts`, `src/lib/airports.ts`.
- **Upstream providers:** OpenSky Network (`opensky-network.org/api/states/all`, OAuth2 client-credentials since March 2025), adsb.fi (`opendata.adsb.fi/api/v2`, keyless, ~1 req/s soft limit observed empirically), adsb.lol trace files (`adsb.lol/data/traces`, keyless readsb shard files), adsbdb (`api.adsbdb.com`, keyless aircraft-registration lookup).
- **Auth:** `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET` optional (documented in `.env.example`); anonymous OpenSky pool is 400 credits/day (~100 calls), authenticated is 4000 credits/day. The code contains detailed, hard-won operational notes about OpenSky's per-IP throttling and 429 cooldown handling — genuinely useful engineering knowledge if Tour 27 ever needs live flight data (e.g., for airport pickup coordination).
- **Rate limits:** OpenSky documented above; adsb.fi ~1 req/s soft-throttled (returns 200 with empty results rather than 429, discovered through production debugging per the code comments).
- **License/terms risk:** Medium. OpenSky Network's terms restrict use of the "impala" bulk historical database but the live REST API is intended for exactly this kind of consumption; however, OpenSky is a research/academic-affiliated non-profit network and Tour 27 should read its ToS regarding commercial use before depending on it for anything operationally important. adsb.fi/adsb.lol/adsbdb are community, best-effort, no-SLA volunteer feeds — fine for a "nice to have" map layer, not for anything time-critical like actual flight tracking for guest pickups.
- **Extraction:** Clean-ish for `earthquakes`-style simplicity is not present here — this is the most operationally sophisticated route in the repo (military/private/jet classification heuristics, OpenSky OAuth token caching, multi-provider fallback chains, in-memory 90s response cache). The classification logic (`classifyFlight`) is generic and portable; the caching/fallback machinery is OSIRIS-specific but small enough (~500 lines) to adapt directly.
- **Recommendation:** **CALL directly (Phase 2).** If Tour 27/ATLAS ever wants a "where is my guest's incoming flight" or general aviation-awareness feature, register directly with OpenSky and/or adsb.fi rather than depending on OSIRIS; the normalization code here is a good reference implementation to adapt, but the *dependency* should be Tour 27's own OpenSky account, not OSIRIS.
- **Security/privacy:** None beyond OAuth secret handling (server-side only, correctly never exposed to client).

### 3.8 Maritime / AIS

- **Source files:** `src/app/api/maritime/route.ts`.
- **Upstream provider:** aisstream.io — real-time AIS vessel positions via WebSocket (`wss://stream.aisstream.io/v0/stream`).
- **Auth:** `AIS_API_KEY` required (aisstream.io is a paid/tiered service; free tier has a bounding-box/volume cap — the code subscribes to nine specific high-traffic bounding boxes plus one deliberately-limited global fallback box specifically to stay inside the free tier, per its own comments).
- **License/terms risk:** Medium — aisstream.io is a commercial API (with a free tier); its ToS govern redistribution of AIS data, which is itself subject to some jurisdictions' restrictions on vessel-tracking data. Static port/chokepoint reference data (39 ports, 10 chokepoints) is OSIRIS's own hand-authored dataset and is safe to reuse as general reference data under the MIT license.
- **Extraction:** The static port/chokepoint list is directly reusable. The live-ship ingestion is a long-lived process-global WebSocket client with an in-memory `Map` cache and a 5s-TTL pre-serialized JSON snapshot — architecturally sound for a single long-running Node process, but **will not work in serverless/edge deployment** (relies on `globalThis` state persisting between requests) and needs its own API key/account.
- **Recommendation:** **IGNORE for now / low priority.** Maritime tracking has limited direct value for a tourism company unless Tour 27 runs coastal/cruise-adjacent tours; if it becomes relevant later, register directly with aisstream.io rather than depending on this OSIRIS instance, and note the serverless-incompatibility issue.
- **Security/privacy:** API key is server-side only (not exposed to client) — correct pattern.

### 3.9 Live incidents (news / OSINT / conflict)

- **Source files:** `src/app/api/live-news/route.ts` (labelled "Military-Grade Intelligence API" — Telegram scraping), `src/app/api/news/route.ts`, `src/app/api/gdelt/route.ts`, `src/app/api/gdelt-events/route.ts`, `src/app/api/conflicts/route.ts`, `src/app/api/frontlines/route.ts`, `src/app/api/country-risk/route.ts`, `src/app/api/region-dossier/route.ts`.
- **Upstream providers:** Unauthenticated scrape of `t.me/s/<channel>` public Telegram previews (channels hardcoded: OSINTtechnical, Faytuks, Liveuamap, CyberKnow — overridable via `OSIRIS_TELEGRAM_CHANNELS`), with RSS fallback to BBC World, Al Jazeera, GDACS; GDELT Events API (global news-event database, keyless); static hand-curated "13 active conflict zones" dataset.
- **Auth:** none.
- **License/terms risk: High for the Telegram component specifically.** Scraping `t.me/s/<channel>` bypasses Telegram's Bot API and ToS around automated access to the platform; this is explicitly the kind of "public but not meant for bulk automated redistribution" gray area Tour 27 should avoid in a commercial product. GDELT and standard news RSS feeds are lower risk (GDELT is an open academic/research dataset explicitly built for reuse; BBC/Al Jazeera RSS feeds are meant for syndication but usually restrict commercial redistribution of full content — check each publisher's feed terms).
- **Extraction:** Trivial to disable (delete the Telegram scraper), but the file also contains a "risk_score" the code's own comments admit was previously mislabeled as "AI Analysis" when it is in fact a simple keyword-count heuristic (`RISK_KEYWORDS` list) — worth noting as a **credibility/trust concern**, not just a licensing one, if Tour 27 were to reuse the pattern of presenting a keyword count as an intelligence assessment.
- **Recommendation:** **DO NOT INTEGRATE** the Telegram-scraping piece. Country-risk/conflict-zone static data and GDELT-based general news-event awareness are lower-risk and could inform a general "is this destination currently stable" signal (**Phase 3 — experimental**, given GDELT's noisiness and the need for careful presentation so a keyword hit doesn't get overstated as "AI analysis" the way OSIRIS's own comments admit it previously was).
- **Security/privacy:** Scraping Telegram at scale risks the source IP getting blocked by Telegram (the code has an explicit fallback for exactly this) — an operational risk, not a data-privacy one, but a proxy IP getting blocked has reputational spillover if it's a shared corporate IP.

### 3.10 Transport / location intelligence

- **Source files:** `src/app/api/directions/route.ts` (turn-by-turn routing), `src/app/api/geosearch/route.ts` (location search/autocomplete), `src/app/api/geo/route.ts`, `src/app/api/entity/expand/route.ts`.
- **Upstream providers:** Valhalla public demo instance (`valhalla1.openstreetmap.de`) for turn-by-turn routing (driving/bicycle/pedestrian) with a fallback to the OSRM public demo (`router.project-osrm.org`, driving only); Photon (Komoot's OSM-based autocomplete, `photon.komoot.io`) as primary geocoder with Nominatim (`nominatim.openstreetmap.org`) as a supplementary structured-query fallback.
- **Auth:** none — all are free public OpenStreetMap-ecosystem demo/community services.
- **License/terms risk: Medium-High for production commercial use, even though the underlying map data (OSM) is ODbL-open.** The specific *hosted demo instances* used here (`valhalla1.openstreetmap.de`, `router.project-osrm.org`, `nominatim.openstreetmap.org`, `photon.komoot.io`) are **community-run public demo servers explicitly intended for light/non-commercial testing use, not production commercial traffic** — Nominatim's usage policy in particular explicitly caps request rates and discourages heavy automated/commercial use of the public instance. **Tour 27 must not point production traffic at these public demo endpoints**; the correct path is either self-hosting Valhalla/Nominatim/Photon against an OSM extract, or using a commercial geocoding/routing provider (Mapbox, Google, HERE, etc.).
- **Extraction:** The normalization logic itself is excellent and genuinely reusable — clean, well-commented polyline decoding, maneuver-type mapping, OSRM/Valhalla response unification, Photon/Nominatim result de-duplication and ranking (`mergeResults`). This is some of the best-engineered code in the repository and is provider-agnostic: point the same normalization functions at a self-hosted or commercial Valhalla/Nominatim-compatible endpoint and it works unchanged.
- **Recommendation:** **COPY the normalization code (Phase 1), but CALL a different backend** — either Tour 27's own self-hosted Valhalla/Nominatim instance or a commercial routing/geocoding API, not the public demo servers OSIRIS currently points at.
- **Security/privacy:** None directly, but be aware every geosearch query (potentially containing a user's planned destination) would be sent to a third-party demo server if left unchanged — a minor privacy consideration for guest itinerary data.

### 3.11 Mapping / geospatial architecture

- **Source files:** `src/components/OsirisMap.tsx`, `src/lib/map-projection.ts`, `src/lib/map-tile-layout.ts`, `src/lib/map-terrain.ts`, `src/lib/map-palette.ts`, `src/lib/terrain-tiles.ts`, `src/lib/skyline.ts`, `tools/prepare-map-worker.mjs`, `src/app/api/proxy-tiles/route.ts`, `src/app/api/arcgis/route.ts`.
- **Stack:** MapLibre GL JS 6.7 (open-source, BSD-licensed WebGL map renderer — the actively maintained fork of Mapbox GL JS after Mapbox's license change) via `react-map-gl` 8.1. Base style is a "dark-matter" vector style; terrain/skyline layers use dedicated tile-layout and projection math.
- **License/terms risk:** Low for MapLibre GL itself (BSD-3). The **basemap tile source and terrain tile source** are what actually carry usage terms — whichever vector-tile/terrain provider `dark-matter-style.json` points to (not fully traced in this audit; worth a follow-up read of that style file and `proxy-tiles/route.ts`/`arcgis/route.ts` before reuse) will have its own attribution and rate-limit requirements.
- **Extraction:** The MapLibre GL architecture choice itself (vs. proprietary Mapbox GL) is the most valuable, low-risk takeaway here — it's a mature, free, open-source rendering engine well suited to a "Tour 27 Live World Map" feature. The specific style/terrain pipeline is moderately OSIRIS-specific (custom dark theme, custom terrain exaggeration) but conceptually simple to rebuild.
- **Recommendation:** **COPY the architectural pattern (MapLibre GL + react-map-gl), not the specific style/tile config** — Phase 1 for "use MapLibre," Phase 2 for "figure out which tile provider to pay for."
- **Security/privacy:** `proxy-tiles/route.ts` and `arcgis/route.ts` proxy third-party tile requests through the OSIRIS server — worth checking (not fully audited here) whether they enforce the same SSRF guard used elsewhere (`ssrf-guard.ts`) before Tour 27 reuses this pattern for its own tile proxying.

### 3.12 API normalization / adapters

- **Source files:** virtually every route in `src/app/api/**/route.ts`; the pattern is consistent across ~50 routes.
- **Pattern:** Each route (a) defines TypeScript interfaces for the upstream provider's raw response shape, (b) fetches one or more upstream sources (often in parallel via `Promise.allSettled`), (c) has a dedicated `normalizeX()` function per provider mapping raw shape → a shared internal type, (d) merges/deduplicates when multiple providers cover the same domain (e.g., weather: EONET + NWS + GDACS; geosearch: Photon + Nominatim), (e) returns via `NextResponse.json` with an explicit `Cache-Control` header tuned per data-freshness needs.
- **Reusability:** **This pattern itself — not any specific route — is the single most valuable and safely extractable thing in the whole repository.** It is standard, well-executed backend-for-frontend adapter design with no security or licensing entanglement of its own. It generalizes directly to a Tour 27 "Destination Intelligence Service" (see §5).
- **Recommendation:** **COPY the pattern** as the architectural template for Tour 27's own service (Phase 1).

### 3.13 Caching / rate limiting

- **Source files:** `src/lib/sourceCache.ts` (TTL cache + in-flight dedup + stale-on-error fallback for upstream index data), `src/lib/fetch-pool.ts` (bounded-concurrency work pool), `src/lib/ssrf-guard.ts` (`isRateLimited`/`getClientIp` — simple in-memory per-IP sliding-window limiter for inbound proxy abuse prevention), `src/lib/cctv-snapshot.ts` (disk-persisted snapshot + gzip-precompressed payload caching for the CCTV catalogue).
- **Design:** All caching is **in-process JavaScript `Map` objects** (no Redis, no external cache store — confirmed absent from `docker-compose.yml`, which only adds an `nginx:alpine` reverse-proxy cache in front of the whole app, not a data-layer cache). This is well-engineered for a single long-running Node.js container (the comments throughout `sourceCache.ts`/`fetch-pool.ts`/`cctv/route.ts` show real production debugging of stampede/timeout/fan-out problems) but **will not work correctly across multiple instances or in a serverless/edge deployment** — every instance would maintain its own independent cache and rate-limit state.
- **Rate limiting specifics:** `isRateLimited(ip, limit=20, windowMs=60000)` — a simple sliding-window counter keyed by best-effort client IP (correctly prefers platform-set headers like `cf-connecting-ip` over spoofable `x-forwarded-for`, a detail worth copying directly). Used to protect the RECON scanner proxy from abuse, not applied broadly to every route.
- **License/terms risk:** None — pure OSIRIS-authored code, MIT.
- **Extraction:** Very clean, and the `getClientIp` header-precedence logic and the `sourceCache` stale-on-error pattern are both genuinely good small utilities worth lifting directly into a Tour 27 backend, with the caveat that a production ATLAS service will likely want Redis (or similar) for multi-instance consistency rather than `globalThis`-backed `Map`s.
- **Recommendation:** **COPY the design patterns (Phase 1)**; reimplement the storage layer on Redis/shared cache if Tour 27's service needs to scale beyond a single instance.

### 3.14 Data-source configuration

- **Source file:** `.env.example` (7KB, extensively commented — the single best map of every upstream integration point in the repo, including several **not yet wired into code** — `FIRMS_API_KEY`, `OPENSKY_CLIENT_ID/SECRET`, `N2YO_API_KEY`, `AIS_API_KEY` for future/optional use).
- **Notably also present:** `SCANNER_URL`/`SCANNER_KEY` (RECON backend, irrelevant to Tour 27), `CLOUDFLARE_API_TOKEN` (Cloudflare Radar — internet-outage/attack-origin map layers, not tourism-relevant), `ETHERSCAN_API_KEY`/`HELIUS_API_KEY` (crypto-forensics deepening, not tourism-relevant), `OSIRIS_TELEGRAM_CHANNELS` (see §3.9 risk).
- **Recommendation:** Use this file purely as a **reference checklist of "what public geo/environmental APIs exist and what auth they need"** — do not carry over the crypto/scanner/Telegram-specific variables into a Tour 27 config.

---

## 4. Product-Surface Mapping

| Capability | A. Tourist website | B. Guide app | C. Roaming/Quick Tours | D. Group Tours | E. Custom Tours | F. Tour 27 Together | G. ATLAS ops | H. Live World Map |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Weather / severe alerts | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ |
| Fires | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ |
| Earthquakes | ✓ | | | | | | ✓ | ✓ |
| Air quality | ✓ | ✓ | | | ✓ | | | ✓ |
| CCTV / traffic cams | | ✓ | ✓ | ✓ | | | ✓ | ✓ |
| Aviation (flight tracking) | | | | | | | ✓ (guest pickup) | ✓ |
| Maritime / AIS | | | | | | | | ✓ (if coastal) |
| Live incidents / news | | | | | | | ✓ | ✓ |
| Directions / routing | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Geosearch / geocoding | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Mapping/geospatial (MapLibre) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| API normalization pattern | (infra) | (infra) | (infra) | (infra) | (infra) | (infra) | (infra) | (infra) |
| Caching/rate-limiting pattern | (infra) | (infra) | (infra) | (infra) | (infra) | (infra) | (infra) | (infra) |

Notes: routing/geocoding and the MapLibre rendering pattern are the broadest-value items, touching nearly every surface. Weather/fire/air-quality hazard awareness is most valuable for anything involving outdoor movement (roaming tours, group tours, guide app field use) and for ATLAS's operational risk monitoring. CCTV and aviation are primarily ATLAS/ops and "Live World Map" plays, not customer-facing features, given the licensing complexity noted in §3.6/§3.7.

---

## 5. Recommended Architecture: "Tour 27 Destination Intelligence Service"

A **Tour 27-owned backend service**, independent of osirisai.live or any OSIRIS-hosted infrastructure, following the adapter pattern OSIRIS itself demonstrates but rebuilt cleanly and scaled for production multi-instance use.

**Structure:**

```
tour27-destination-intel/
  adapters/
    weather.ts        → NOAA/NWS + GDACS (+ a global commercial provider for non-US coverage)
    fires.ts          → NASA FIRMS CSV
    earthquakes.ts     → USGS GeoJSON
    airquality.ts      → OpenAQ v3 (own API key)
    routing.ts          → self-hosted Valhalla or commercial routing API
    geocoding.ts        → self-hosted Nominatim/Photon or commercial geocoding API
    [future: aviation.ts → own OpenSky account, if guest-pickup tracking is built]
  core/
    normalize.ts        → shared response-shape types, one per domain
    cache.ts             → Redis-backed TTL cache + in-flight dedup + stale-on-error (same design as sourceCache.ts, different storage)
    ratelimit.ts          → Redis-backed sliding window (same algorithm as isRateLimited, shared across instances)
    pool.ts                → bounded-concurrency fan-out for multi-source domains (same design as fetch-pool.ts)
    ssrf-guard.ts            → reused near-verbatim from OSIRIS (host validation, no proprietary logic, purely defensive)
  api/
    /v1/weather, /v1/hazards, /v1/routing, /v1/geosearch, ...
```

**Adapter pattern:** one small module per upstream provider, each exporting a `fetchX(): Promise<RawX>` and a `normalizeX(raw: RawX): DomainType`. Multi-provider domains (e.g. weather) compose several adapters behind one merged endpoint, exactly as OSIRIS's `weather/route.ts` does — this is the one piece of OSIRIS architecture worth copying almost verbatim.

**Caching/rate-limiting:** same conceptual design as OSIRIS (TTL cache with stale-on-error, in-flight request dedup, bounded concurrency pool, sliding-window inbound rate limiting) but backed by **Redis or a managed cache** instead of `globalThis` `Map`s, since ATLAS and any customer-facing app will need this to be correct across multiple server instances/regions and to survive restarts.

**Consumption:** Tour 27's tourist website, guide app, and ATLAS all call this one internal service's REST API rather than each app independently calling NOAA/USGS/etc. — centralizing API-key management, rate-limit budgeting, ToS compliance, and caching in one place, and giving Tour 27 a single point of control to swap a provider (e.g., moving off a public OSM demo server onto a paid geocoding API) without touching every client app.

**Explicitly do not:** depend on osirisai.live, any OSIRIS-hosted API, or the OSIRIS GitHub repo at runtime. Everything above calls upstream providers directly, using Tour 27's own registered API keys/accounts where required.

---

## 6. Ranked Implementation Shortlist

### PHASE 1 — Safest / highest-value (low licensing risk, clean extraction, clear Tour 27 value)
- **Earthquakes** (USGS GeoJSON) — public-domain, trivial adapter, zero risk.
- **Fires** (NASA FIRMS CSV) — public-domain, trivial adapter.
- **Weather / severe alerts (US + global via GDACS)** (NOAA/NWS + GDACS) — open government data, small adapter; confirm GDACS commercial-reuse terms first.
- **Routing/geocoding normalization code** (Valhalla/OSRM/Photon/Nominatim normalizers from `directions/route.ts` and `geosearch/route.ts`) — excellent code, but **must be pointed at self-hosted or commercial endpoints**, never at the public OSM demo servers.
- **MapLibre GL + react-map-gl as the map rendering stack** — mature, open, free, well-suited for a Live World Map.
- **Caching/rate-limiting/SSRF-guard design patterns** (`sourceCache.ts`, `fetch-pool.ts`, `ssrf-guard.ts`) — reimplement storage on Redis for production scale.

### PHASE 2 — Useful but needs provider/licensing review
- **Air quality** (OpenAQ) — needs migration from v2 to v3 + own API key + terms re-check.
- **Aviation / flight tracking** — genuinely useful for guest-pickup ATLAS ops, but needs Tour 27's own OpenSky account and a read of OpenSky's commercial-use terms; adsb.fi/adsb.lol are best-effort volunteer feeds, not SLA-backed.
- **Select CCTV country adapters** (only for countries Tour 27 actually operates in) — extract individual adapter files, not the whole 48-region system; requires per-jurisdiction ToS review; drop the YouTube-embed and sheriff's-department-hotlink entries entirely.
- **Maritime/AIS** — only if Tour 27 develops coastal/cruise-adjacent offerings; requires a paid aisstream.io account and architecture rework for serverless compatibility.
- **GDELT-based general destination stability/news signal** — useful conceptually for ATLAS risk monitoring, but needs careful product framing so a keyword/event count isn't presented as more authoritative than it is (OSIRIS's own code comments flag this exact problem in its predecessor).

### PHASE 3 — Experimental
- **Country-risk / conflict-zone static reference data** as one input into an ATLAS destination-risk dashboard, combined with better-vetted sources — not as a standalone product feature.
- **Space weather** (NOAA SWPC Kp index/solar flares) — low relevance to tourism generally, but cheap/clean to add if ATLAS wants a broad "world situational awareness" panel.

### DO NOT INTEGRATE
- **`stealthFetch.ts`** — deliberately spoofs `X-Forwarded-For` with fake residential IPs and rotates user-agents specifically to evade upstream rate-limiting and anti-scraping detection. This is a bad practice to inherit into any Tour 27 codebase: it is the kind of thing that gets an IP or account permanently banned by an upstream provider and creates real legal/ToS exposure for a company with a public brand and ongoing vendor relationships to protect. Any adapter that uses it (weather's two calls, cctv orchestrator's several calls, flights route) should be re-implemented with plain `fetch` and honest headers.
- **Telegram-scraping live-incident feed** (`live-news/route.ts`) — unauthenticated scraping of `t.me/s/<channel>`, against the spirit of Telegram's ToS for automated access; also historically mislabeled a keyword-count heuristic as "AI Analysis" (acknowledged in the code's own comments) — both a ToS risk and a credibility/trust risk if inherited.
- **RECON toolkit / `intel/` scanner service** (port scanning, WHOIS, vuln scanning, crypto-wallet tracing, OFAC screening) — not relevant to a tourism product; running unauthorized-adjacent network-scanning tooling under a Tour 27-branded service is a reputational and legal liability with zero product upside.
- **CCTV curated YouTube-embeds / direct sheriff-camera hotlinks** — specific entries within the CCTV data (not the capability as a whole) that carry disproportionate ToS/liability risk relative to their value; exclude even if Tour 27 proceeds with Phase 2 CCTV work.
- **`engine/` directory** — not usable; contains only orphaned Python bytecode cache files with no tracked source, apparently unrelated to OSIRIS's actual runtime (naming suggests a crypto trading/agent system). Nothing to integrate.
