// case-study.js — full case-study pipeline for lakesidethreadz.com
//
// Extracted + adapted from midwestcnc's reference worker.js (which powers the
// case-study feed for Midwest CNC). Wires into site/worker.js via exported
// handlers, the scheduled cron + the maybeLogTraffic middleware.
//
// Endpoints:
//   GET  /api/case-study.json               — public CORS feed for heyaaronmarketing.com
//   GET  /<INDEXNOW_KEY>.txt                — IndexNow verification file (served from static)
//   GET  /admin/login                       — password login
//   POST /admin/login                       — session mint
//   GET  /admin/logout                      — clears session
//   GET  /admin/case-study                  — stats dashboard + CSV upload
//   POST /admin/case-study                  — CSV upload handler
//   POST /admin/case-study/refresh          — manual GSC+Bing+DFS+IndexNow refresh
//   GET  /admin/traffic                     — bot crawl + AI referral log
//
// Required Worker bindings (wrangler.jsonc):
//   DB        — D1 database "lakesidethreadz-case-study"
//   ASSETS    — static assets (used by pingIndexNow to fetch sitemap)
//
// Required Worker secrets:
//   ADMIN_PASSWORD           — strong password for /admin login
//   SESSION_SECRET           — 64+ random bytes (openssl rand -hex 32)
//   GSC_SERVICE_ACCOUNT_JSON — full JSON key from a Google Cloud SA with GSC Owner
//   BING_API_KEY             — 32-char hex from bing.com/webmasters -> API Access
//   DATAFORSEO_LOGIN         — DataForSEO account login (email)
//   DATAFORSEO_PASSWORD      — DataForSEO API password
//
// Cron (set in wrangler.jsonc):
//   "0 13 * * 1"  — Monday 13:00 UTC = 7 AM Central
//   → worker.js scheduled() must call runCaseStudyRefresh(env, {source:"cron"})

const SITE_HOST = "lakesidethreadz.com";
const SESSION_COOKIE = "lit_admin";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

// IndexNow — deterministic key = sha256("lakesidethreadz-indexnow-v1")[:32].
// Verification file lives at public/<key>.txt and must return the key with
// no whitespace or BOM. IndexNow proves ownership by fetching that URL.
export const INDEXNOW_KEY = "a97321ae687a3df3c2756734fe4bef42";
const INDEXNOW_HOST = SITE_HOST;

const GSC_PROPERTY = "sc-domain:lakesidethreadz.com";
const BING_SITE_URL = "https://lakesidethreadz.com";

// DataForSEO SERP ranking pull — tracks position for Lakeside's core money
// keywords on Google (US desktop). Weekly cron inserts a row per keyword
// into cs_dfs_rankings; the /api/case-study.json endpoint returns the
// most recent snapshot plus a 30-day movement delta per keyword.
//
// Edit this list to change what we track. Keep it tight (~20-30 keywords)
// — each pull is a billable DFS SERP task (~$0.0006 each).
export const DFS_KEYWORDS = [
  "custom embroidery lake livingston",
  "embroidered hats livingston tx",
  "dtf printing livingston tx",
  "custom shirts livingston tx",
  "team uniforms lake livingston",
  "chamber polos livingston",
  "church shirts lake livingston",
  "trucker hats embroidery texas",
  "custom polos livingston tx",
  "spirit wear livingston isd",
  "coaches polos texas",
  "booster club shirts",
  "custom beanie embroidery texas",
  "richardson 112 custom embroidery",
  "bella canvas custom printing",
  "small batch embroidery texas",
  "family reunion shirts lake livingston",
  "golf tournament apparel texas",
  "custom branded apparel small business",
  "no minimum embroidery texas",
  "lake livingston custom apparel",
  "polk county custom shirts",
  "san jacinto county custom apparel",
  "wedding party embroidered gifts",
  "fishing shirts lake livingston",
];

// =====================================================================
// D1 schemas (idempotent — CREATE TABLE IF NOT EXISTS)
// =====================================================================

const CASE_STUDY_SCHEMA = `
CREATE TABLE IF NOT EXISTS cs_gsc_daily (
  date TEXT PRIMARY KEY,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cs_gsc_queries (
  query TEXT PRIMARY KEY,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cs_gsc_pages (
  page TEXT PRIMARY KEY,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cs_ai_daily (
  date TEXT PRIMARY KEY,
  citations INTEGER NOT NULL DEFAULT 0,
  cited_pages INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cs_bing_daily (
  date TEXT PRIMARY KEY,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cs_dfs_rankings (
  date TEXT NOT NULL,
  keyword TEXT NOT NULL,
  position INTEGER,
  ranked_url TEXT,
  serp_type TEXT,
  PRIMARY KEY (date, keyword)
);
CREATE INDEX IF NOT EXISTS idx_dfs_keyword ON cs_dfs_rankings(keyword, date);
CREATE TABLE IF NOT EXISTS cs_meta (
  k TEXT PRIMARY KEY,
  v TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const TRAFFIC_SCHEMA = `
CREATE TABLE IF NOT EXISTS traffic_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  path TEXT NOT NULL,
  bot TEXT,
  referer_host TEXT,
  country TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_traffic_ts ON traffic_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_traffic_bot ON traffic_log(bot);
CREATE INDEX IF NOT EXISTS idx_traffic_ref ON traffic_log(referer_host);
`;

// HTML-escape helper used by every renderLayout / admin page template.
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function ensureCaseStudySchema(env) {
  if (!env.DB) return false;
  await env.DB.exec(CASE_STUDY_SCHEMA.replace(/\n/g, " ")).catch(() => {});
  return true;
}

// =====================================================================
// Public endpoint — GET /api/case-study.json
// =====================================================================

export async function handleCaseStudyJson(env) {
  if (!env.DB) return jsonResponse({ error: "database not configured" }, 503);
  await ensureCaseStudySchema(env);

  const [daily, queries, pages, ai, metaRows, traffic, dfs] = await Promise.all([
    env.DB.prepare("SELECT date, clicks, impressions, position FROM cs_gsc_daily ORDER BY date").all(),
    env.DB.prepare("SELECT query, clicks, position FROM cs_gsc_queries WHERE clicks > 0 ORDER BY clicks DESC LIMIT 25").all(),
    env.DB.prepare("SELECT page, clicks, impressions, position FROM cs_gsc_pages WHERE clicks > 0 ORDER BY clicks DESC LIMIT 25").all(),
    env.DB.prepare("SELECT date, citations, cited_pages FROM cs_ai_daily ORDER BY date").all(),
    env.DB.prepare("SELECT k, v FROM cs_meta").all(),
    caseStudyTrafficSection(env),
    caseStudyDfsSection(env),
  ]);

  const meta = {};
  for (const row of metaRows.results || []) meta[row.k] = row.v;

  const dailyRows = daily.results || [];
  const gsc = summarizeGsc(dailyRows);
  const aiRows = ai.results || [];
  const aiSummary = summarizeAi(aiRows);

  const allTime = totals(dailyRows);
  const firstDate = dailyRows.length ? dailyRows[0].date : null;
  const lastDate = dailyRows.length ? dailyRows[dailyRows.length - 1].date : null;

  const headline = [];
  if (aiSummary.delta.citations_pct !== null && aiSummary.delta.citations_pct !== undefined) {
    headline.push({ label: "AI citations, last 30d vs prior 30d", value: aiSummary.last30.citations, delta_pct: aiSummary.delta.citations_pct, source: "Bing AI Performance Overview" });
  }
  if (gsc.delta.clicks_pct !== null && gsc.delta.clicks_pct !== undefined) {
    headline.push({ label: "Google clicks, last 90d vs prior 90d", value: gsc.last90.clicks, delta_pct: gsc.delta.clicks_pct, source: "Google Search Console" });
  }
  headline.push(
    { label: "AI citations, all-time", value: aiSummary.total, source: "Bing AI Performance Overview" },
    { label: "Google clicks, all-time", value: allTime.clicks, source: "Google Search Console" },
    { label: "Google impressions, all-time", value: allTime.impressions, source: "Google Search Console" },
    { label: "Avg Google rank, last 90d", value: round(gsc.last90.position, 1), source: "Google Search Console" },
    { label: "Tracked SERP keywords on page 1", value: dfs.summary ? dfs.summary.page_1_count : 0, source: "DataForSEO" },
  );

  return jsonResponse({
    schema_version: "1.1",
    slug: "lakesidethreadz",
    last_updated: new Date().toISOString(),
    data_as_of: meta.data_as_of || null,
    client: {
      name: "Lakeside Ink & Threadz",
      industry: "Custom embroidery · DTF printing · branded apparel",
      location: "Livingston, Texas",
      service_area_states: 1,
      website: "https://lakesidethreadz.com",
      launched: "2026-06-14",
      bing_portfolio_topic: {
        primary: meta.bing_topic_primary || null,
        volume_range: meta.bing_topic_volume_range || null,
        queries_range: meta.bing_topic_queries_range || null,
        sites_range: meta.bing_topic_sites_range || null,
      },
    },
    headline_stats: headline,
    google_search: {
      all_time: {
        clicks: allTime.clicks,
        impressions: allTime.impressions,
        avg_position: round(allTime.position, 1),
        days: dailyRows.length,
        first_date: firstDate,
        last_date: lastDate,
      },
      last_90d: {
        clicks: gsc.last90.clicks,
        impressions: gsc.last90.impressions,
        avg_position: round(gsc.last90.position, 1),
      },
      prior_90d: {
        clicks: gsc.prior90.clicks,
        impressions: gsc.prior90.impressions,
        avg_position: round(gsc.prior90.position, 1),
      },
      delta_90d: {
        clicks_pct: gsc.delta.clicks_pct,
        impressions_pct: gsc.delta.impressions_pct,
      },
      queries_ranking: (queries.results || []).length,
      top_queries: (queries.results || []).slice(0, 25).map((q) => ({
        query: q.query, clicks: q.clicks, position: round(q.position, 1),
      })),
      top_pages: (pages.results || []).slice(0, 25).map((p) => ({
        page: p.page, clicks: p.clicks, position: round(p.position, 1),
      })),
      daily: dailyRows.map((d) => ({ date: d.date, clicks: d.clicks, impressions: d.impressions })),
      source: "Google Search Console",
      updated: meta.gsc_updated || null,
      last_error: meta.gsc_last_error || null,
    },
    ai_search: {
      all_time: {
        total_citations: aiSummary.total,
        days: aiRows.length,
        first_date: aiRows.length ? aiRows[0].date : null,
        last_date: aiRows.length ? aiRows[aiRows.length - 1].date : null,
      },
      last_30d: {
        citations: aiSummary.last30.citations,
        pages_cited: aiSummary.last30.pages,
      },
      prior_30d_citations: aiSummary.prior30,
      delta_30d_pct: aiSummary.delta.citations_pct,
      best_day: aiSummary.best_day,
      monthly: aiSummary.monthly,
      daily: aiRows.map((d) => ({ date: d.date, citations: d.citations, cited_pages: d.cited_pages })),
      source: "Bing — AI Performance Overview",
      updated: meta.ai_updated || null,
      last_error: meta.ai_last_error || null,
    },
    dfs_rankings: dfs,
    traffic_signals: traffic,
    // Diagnostic: last-run timestamps + any errors from each pull. Helps
    // debug "why didn't my DFS/Bing show data?" without hitting the DB.
    _meta: meta,
    site_structure: {
      pages: 58,
      schema_nodes: null,
      faq_qa_pairs: null,
      pricing_in_schema: false,
      broken_links: 0,
    },
    capabilities_shown: [
      "Vite SPA → Cloudflare Workers static-mirror rebuild",
      "9-step quote wizard with 24 school-branded landing pages",
      "KV-backed B2B outreach engine + warm-intro schools lane",
      "GSC + Bing + DataForSEO weekly cron + IndexNow push",
      "Server-side AI-bot crawl + AI-referral logging",
      "Trailing-slash 301 + full AI-crawler allowlist",
    ],
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}

function round(n, dp) {
  if (n === null || n === undefined || !isFinite(n)) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function summarizeGsc(rows) {
  if (!rows.length) {
    return {
      last90:  { clicks: 0, impressions: 0, position: 0 },
      prior90: { clicks: 0, impressions: 0, position: 0 },
      delta:   { clicks_pct: 0, impressions_pct: 0 },
    };
  }
  const last90 = totals(rows.slice(-90));
  const prior90 = totals(rows.slice(-180, -90));
  return {
    last90, prior90,
    delta: {
      clicks_pct: prior90.clicks ? Math.round(((last90.clicks - prior90.clicks) / prior90.clicks) * 100) : null,
      impressions_pct: prior90.impressions ? Math.round(((last90.impressions - prior90.impressions) / prior90.impressions) * 100) : null,
    },
  };
}

function totals(rows) {
  if (!rows.length) return { clicks: 0, impressions: 0, position: 0 };
  let c = 0, i = 0, p = 0;
  for (const r of rows) { c += r.clicks; i += r.impressions; p += r.position; }
  return { clicks: c, impressions: i, position: p / rows.length };
}

function summarizeAi(rows) {
  if (!rows.length) {
    return {
      total: 0,
      last30: { citations: 0, pages: 0 },
      prior30: 0,
      delta: { citations_pct: null },
      best_day: null,
      monthly: [],
    };
  }
  const last30 = rows.slice(-30);
  const prior30 = rows.slice(-60, -30);
  const sumC = (rs) => rs.reduce((a, r) => a + r.citations, 0);
  const total = sumC(rows);
  const l30 = sumC(last30);
  const p30 = sumC(prior30);
  const bestDay = rows.reduce((best, r) => (r.citations > (best?.citations || 0) ? r : best), null);
  const byMonth = {};
  for (const r of rows) {
    const m = r.date.slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { month: m, citations: 0, days: 0 };
    byMonth[m].citations += r.citations;
    byMonth[m].days += 1;
  }
  return {
    total,
    last30: { citations: l30, pages: Math.max(0, ...last30.map((r) => r.cited_pages)) },
    prior30: p30,
    delta: { citations_pct: p30 ? Math.round(((l30 - p30) / p30) * 100) : null },
    best_day: bestDay
      ? { date: bestDay.date, citations: bestDay.citations, cited_pages: bestDay.cited_pages }
      : null,
    monthly: Object.values(byMonth),
  };
}

export async function runCaseStudyRefresh(env, meta = {}) {
  await ensureCaseStudySchema(env);
  const results = { source: meta.source || "manual", started: new Date().toISOString() };

  // Rate-limit guard: refuse to refresh if we ran successfully in the
  // last 60 minutes. Prevents Bing ThrottleIP + IndexNow 429 errors
  // from someone clicking "Refresh now" repeatedly. Cron trigger
  // bypasses this (source === "cron") since it fires weekly.
  if (meta.source !== "cron") {
    const lastRow = await env.DB.prepare(
      "SELECT v FROM cs_meta WHERE k = 'last_refresh_ok_at'"
    ).first();
    if (lastRow && lastRow.v) {
      const lastMs = Date.parse(lastRow.v);
      const ageMin = Math.floor((Date.now() - lastMs) / 60000);
      if (ageMin < 60) {
        results.skipped = `rate-limited: last successful refresh was ${ageMin} min ago (60 min minimum)`;
        results.retry_after_min = 60 - ageMin;
        results.finished = new Date().toISOString();
        return results;
      }
    }
  }

  try {
    const g = await pullGsc(env);
    results.gsc = g;
    await setMeta(env, "gsc_updated", new Date().toISOString());
    await setMeta(env, "gsc_last_error", "");
  } catch (e) {
    results.gsc = { error: String(e && e.message || e) };
    await setMeta(env, "gsc_last_error", results.gsc.error);
    console.log("GSC pull failed:", results.gsc.error);
  }

  try {
    const b = await pullBing(env);
    results.bing = b;
    await setMeta(env, "bing_updated", new Date().toISOString());
    await setMeta(env, "bing_last_error", "");
  } catch (e) {
    results.bing = { error: String(e && e.message || e) };
    await setMeta(env, "bing_last_error", results.bing.error);
    console.log("Bing pull failed:", results.bing.error);
  }

  try {
    const d = await pullDataForSEO(env);
    results.dfs = d;
    await setMeta(env, "dfs_updated", new Date().toISOString());
    await setMeta(env, "dfs_last_error", "");
  } catch (e) {
    results.dfs = { error: String(e && e.message || e) };
    await setMeta(env, "dfs_last_error", results.dfs.error);
    console.log("DFS pull failed:", results.dfs.error);
  }

  try {
    const inx = await pingIndexNow(env);
    results.indexnow = inx;
    await setMeta(env, "indexnow_updated", new Date().toISOString());
    await setMeta(env, "indexnow_last_error", "");
  } catch (e) {
    results.indexnow = { error: String(e && e.message || e) };
    await setMeta(env, "indexnow_last_error", results.indexnow.error);
    console.log("IndexNow push failed:", results.indexnow.error);
  }

  await setMeta(env, "data_as_of", new Date().toISOString());
  // Only mark a successful refresh when GSC actually pulled (the money
  // source). Bing or IndexNow throttles don't block subsequent retries.
  if (results.gsc && !results.gsc.error) {
    await setMeta(env, "last_refresh_ok_at", new Date().toISOString());
  }
  results.finished = new Date().toISOString();
  return results;
}

// ---------- IndexNow ----------

async function pingIndexNow(env) {
  // Parse the sitemap at /sitemap.xml and push every URL to IndexNow.
  // Bing + Yandex + Seznam.cz + Naver all participate and re-crawl
  // within minutes. Google does not participate yet — GSC's own
  // "URL inspection" tool is Google's equivalent (manual only).
  const sitemapReq = new Request(`https://${INDEXNOW_HOST}/sitemap.xml`, { method: "GET" });
  const smResp = await env.ASSETS.fetch(sitemapReq);
  if (!smResp.ok) {
    throw new Error(`sitemap fetch failed: ${smResp.status}`);
  }
  const xml = await smResp.text();
  const urls = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]);
  if (!urls.length) return { skipped: "no URLs in sitemap" };

  const resp = await fetch("https://api.indexnow.org/IndexNow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: INDEXNOW_HOST,
      key: INDEXNOW_KEY,
      keyLocation: `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt`,
      urlList: urls,
    }),
  });
  // IndexNow accepted codes: 200 (ok), 202 (accepted, processing),
  // 422 (invalid URLs — partial success). 400+ else is an error.
  if (resp.status === 200 || resp.status === 202) {
    return { urls_submitted: urls.length, status: resp.status };
  }
  const body = await resp.text().catch(() => "");
  throw new Error(`IndexNow HTTP ${resp.status}: ${body.slice(0, 200)}`);
}

async function setMeta(env, k, v) {
  await env.DB.prepare(
    "INSERT INTO cs_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=CURRENT_TIMESTAMP"
  ).bind(k, v).run();
}

// ---------- GSC ----------

async function pullGsc(env) {
  if (!env.GSC_SERVICE_ACCOUNT_JSON) {
    return { skipped: "GSC_SERVICE_ACCOUNT_JSON not set" };
  }
  const sa = JSON.parse(env.GSC_SERVICE_ACCOUNT_JSON);
  const token = await mintGoogleAccessToken(sa, "https://www.googleapis.com/auth/webmasters.readonly");

  // Pull the full 16-month window the GSC API allows (480 days to
  // stay well under the 490-day ceiling). cs_gsc_daily upserts, so
  // historic rows outside the window are preserved.
  const today = new Date();
  const start = new Date(today.getTime() - 480 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const startDate = fmt(start);
  const endDate = fmt(today);

  const daily = await gscQuery(token, { startDate, endDate, dimensions: ["date"], rowLimit: 500 });
  const queries = await gscQuery(token, { startDate, endDate, dimensions: ["query"], rowLimit: 1000 });
  const pages = await gscQuery(token, { startDate, endDate, dimensions: ["page"], rowLimit: 1000 });

  // Upsert daily (preserves older rows outside the 90-day window)
  if (daily.rows?.length) {
    const stmts = daily.rows.map((r) => env.DB.prepare(
      "INSERT INTO cs_gsc_daily (date, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(date) DO UPDATE SET clicks=excluded.clicks, impressions=excluded.impressions, ctr=excluded.ctr, position=excluded.position"
    ).bind(r.keys[0], r.clicks, r.impressions, r.ctr, r.position));
    await env.DB.batch(stmts);
  }

  // Replace queries + pages (they're a point-in-time top-N snapshot)
  if (queries.rows?.length) {
    await env.DB.exec("DELETE FROM cs_gsc_queries");
    const stmts = queries.rows.map((r) => env.DB.prepare(
      "INSERT INTO cs_gsc_queries (query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?)"
    ).bind(r.keys[0], r.clicks, r.impressions, r.ctr, r.position));
    await env.DB.batch(stmts);
  }
  if (pages.rows?.length) {
    await env.DB.exec("DELETE FROM cs_gsc_pages");
    const stmts = pages.rows.map((r) => env.DB.prepare(
      "INSERT INTO cs_gsc_pages (page, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?)"
    ).bind(r.keys[0], r.clicks, r.impressions, r.ctr, r.position));
    await env.DB.batch(stmts);
  }

  return {
    daily_rows: daily.rows?.length || 0,
    query_rows: queries.rows?.length || 0,
    page_rows: pages.rows?.length || 0,
    window: `${startDate} → ${endDate}`,
  };
}

async function gscQuery(token, body) {
  const url =
    "https://searchconsole.googleapis.com/webmasters/v3/sites/" +
    encodeURIComponent(GSC_PROPERTY) + "/searchAnalytics/query";
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`GSC ${resp.status}: ${t.slice(0, 300)}`);
  }
  return resp.json();
}

async function mintGoogleAccessToken(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const b64url = (bytes) => b64UrlEncode(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
  const hb = b64url(JSON.stringify(header));
  const cb = b64url(JSON.stringify(claims));
  const signingInput = `${hb}.${cb}`;

  // Import PEM private key
  const pem = sa.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sigBytes = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)));
  const jwt = `${signingInput}.${b64url(sigBytes)}`;

  const tokResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  if (!tokResp.ok) {
    throw new Error(`OAuth exchange failed ${tokResp.status}: ${(await tokResp.text()).slice(0, 300)}`);
  }
  const tok = await tokResp.json();
  return tok.access_token;
}

// ---------- Bing ----------

async function pullBing(env) {
  if (!env.BING_API_KEY) {
    return { skipped: "BING_API_KEY not set" };
  }
  // Bing Webmaster Tools API v1. GetRankAndTrafficStats returns daily
  // clicks + impressions for the site. GetQueryStats returns top queries.
  const base =
    "https://ssl.bing.com/webmaster/api.svc/json/" +
    "GetRankAndTrafficStats?siteUrl=" + encodeURIComponent(BING_SITE_URL) +
    "&apikey=" + encodeURIComponent(env.BING_API_KEY);
  const resp = await fetch(base);
  if (!resp.ok) {
    throw new Error(`Bing ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const data = await resp.json();
  const stats = (data && data.d) || [];
  // Upsert into cs_bing_daily (table created lazily below)
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS cs_bing_daily (" +
    "date TEXT PRIMARY KEY, clicks INTEGER NOT NULL DEFAULT 0, " +
    "impressions INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0);"
  );
  if (stats.length) {
    const stmts = stats.map((s) => {
      // Bing returns "Date":"/Date(1234567890000)/" epoch-ms
      const ms = parseInt(String(s.Date).replace(/[^0-9]/g, ""), 10);
      const date = new Date(ms).toISOString().slice(0, 10);
      return env.DB.prepare(
        "INSERT INTO cs_bing_daily (date, clicks, impressions, position) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(date) DO UPDATE SET clicks=excluded.clicks, impressions=excluded.impressions, position=excluded.position"
      ).bind(date, s.Clicks || 0, s.Impressions || 0, s.AvgImpressionPosition || 0);
    });
    await env.DB.batch(stmts);
  }
  return { bing_daily_rows: stats.length };
}

// =====================================================================
// DataForSEO SERP ranking pull — Google US desktop, one SERP per keyword
// =====================================================================
// Pulls current rank for each keyword in DFS_KEYWORDS. Inserts one row per
// keyword into cs_dfs_rankings with today's date. Historical rows are kept
// so case-study JSON can compute movement deltas over time.
//
// API: POST https://api.dataforseo.com/v3/serp/google/organic/live/advanced
// Auth: HTTP Basic (login:password) as DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD
// Cost: ~$0.0006/keyword. 25 keywords = ~$0.015 per weekly pull.

async function pullDataForSEO(env) {
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) {
    return { skipped: "DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD not set" };
  }
  const basic = btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  // One task per keyword; US desktop, location_code 2840.
  const tasks = DFS_KEYWORDS.map((kw) => ({
    keyword: kw,
    language_code: "en",
    location_code: 2840,
    device: "desktop",
    os: "windows",
    depth: 20,
  }));
  const resp = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
    body: JSON.stringify(tasks),
  });
  if (!resp.ok) {
    throw new Error(`DFS ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const data = await resp.json();
  const results = (data && data.tasks) || [];
  const today = new Date().toISOString().slice(0, 10);
  const ourHost = "lakesidethreadz.com";

  // Find our best rank for each keyword (lowest-numbered organic position
  // whose URL is on our domain). Null if we don't rank in top 20.
  const stmts = [];
  let hits = 0;
  for (const t of results) {
    const kw = t.data?.keyword;
    if (!kw) continue;
    const items = (t.result && t.result[0] && t.result[0].items) || [];
    let position = null, rankedUrl = null, serpType = null;
    for (const it of items) {
      if (it.type !== "organic") continue;
      const url = it.url || "";
      if (url.includes(ourHost)) {
        position = it.rank_absolute || it.rank_group || null;
        rankedUrl = url;
        serpType = "organic";
        break;
      }
    }
    if (position) hits++;
    stmts.push(env.DB.prepare(
      "INSERT INTO cs_dfs_rankings (date, keyword, position, ranked_url, serp_type) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(date, keyword) DO UPDATE SET position=excluded.position, ranked_url=excluded.ranked_url, serp_type=excluded.serp_type"
    ).bind(today, kw, position, rankedUrl, serpType));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { keywords_checked: DFS_KEYWORDS.length, keywords_ranked: hits, snapshot_date: today };
}

// Summary section for /api/case-study.json — latest snapshot + 30d deltas.
async function caseStudyDfsSection(env) {
  try {
    const latest = await env.DB.prepare(
      "SELECT keyword, position, ranked_url FROM cs_dfs_rankings " +
      "WHERE date = (SELECT MAX(date) FROM cs_dfs_rankings) ORDER BY position ASC NULLS LAST"
    ).all();
    const rows = latest.results || [];
    if (!rows.length) return { status: "no data yet" };

    // 30-day movement per keyword (first vs latest in window)
    const windowStart = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const prior = await env.DB.prepare(
      "SELECT keyword, position FROM cs_dfs_rankings " +
      "WHERE date = (SELECT MIN(date) FROM cs_dfs_rankings WHERE date > ?)"
    ).bind(windowStart).all();
    const priorMap = {};
    for (const r of prior.results || []) priorMap[r.keyword] = r.position;

    const items = rows.map((r) => ({
      keyword: r.keyword,
      position: r.position,
      ranked_url: r.ranked_url,
      prior_position: priorMap[r.keyword] ?? null,
      delta: (r.position && priorMap[r.keyword]) ? (priorMap[r.keyword] - r.position) : null,
    }));
    const page1 = items.filter((x) => x.position && x.position <= 10).length;
    const page2 = items.filter((x) => x.position && x.position > 10 && x.position <= 20).length;

    return {
      source: "DataForSEO (Google US desktop, top 20 organic)",
      snapshot_date: rows[0] && (await env.DB.prepare("SELECT MAX(date) AS d FROM cs_dfs_rankings").first())?.d,
      summary: {
        keywords_tracked: DFS_KEYWORDS.length,
        ranked_in_top_20: items.filter((x) => x.position).length,
        page_1_count: page1,
        page_2_count: page2,
      },
      keywords: items,
    };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

// =====================================================================
// Admin UI — /admin/login, /admin/case-study, /admin/traffic
// =====================================================================
// All /admin/* paths require ADMIN_PASSWORD + SESSION_SECRET to be set.
// Session is an HMAC-signed cookie, 7-day TTL.

const SESSION_COOKIE_NAME = SESSION_COOKIE; // alias for clarity below

async function getSession(request, env) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  return verifySessionCookie(match[1], env.SESSION_SECRET);
}

async function mintSessionCookie(secret) {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = String(expiry);
  const sig = await hmacSha256B64(secret, payload);
  return `${payload}.${sig}`;
}

async function verifySessionCookie(cookie, secret) {
  const dot = cookie.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = cookie.slice(0, dot);
  const providedSig = cookie.slice(dot + 1);
  const expectedSig = await hmacSha256B64(secret, payload);
  if (!(await constantTimeStringEquals(providedSig, expectedSig))) return null;
  const expiry = parseInt(payload, 10);
  if (!Number.isFinite(expiry) || expiry < Math.floor(Date.now() / 1000)) return null;
  return { expiry };
}

async function hmacSha256B64(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return b64UrlEncode(new Uint8Array(sig));
}

function b64UrlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function constantTimeStringEquals(a, b) {
  // Hash both first so we never leak length via early return.
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const av = new Uint8Array(ha), bv = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    },
  });
}

const BASE_CSS = `
  :root {
    --accent: #b8341a; --accent-dark: #8f2814; --line: #e4e2df;
    --surface: #ffffff; --surface-2: #f7f5f2; --bg: #fbf9f6;
    --fg: #1a1a1a; --muted: #6b6b6b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 16px/1.55 -apple-system, BlinkMacSystemFont,
      "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg); color: var(--fg);
  }
  a { color: var(--accent-dark); }
  header.admin-nav {
    background: #1a1a1a; color: #fff; padding: 12px 24px;
    display: flex; align-items: center; gap: 20px;
  }
  header.admin-nav a { color: #fff; text-decoration: none; opacity: 0.85; }
  header.admin-nav a:hover { opacity: 1; }
  header.admin-nav .brand { font-weight: 700; letter-spacing: 0.02em; }
  header.admin-nav .spacer { flex: 1; }
  main.admin {
    max-width: 1200px; margin: 0 auto; padding: 24px;
  }
  h1 { margin: 0 0 16px 0; font-size: 1.5rem; }
  h2 { margin: 24px 0 8px 0; font-size: 1.1rem; }
  .filters {
    display: flex; gap: 12px; margin-bottom: 16px; align-items: center;
    flex-wrap: wrap;
  }
  .filters input, .filters select {
    padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px;
    font: inherit; background: #fff;
  }
  .filters .grow { flex: 1; min-width: 200px; }
  .btn {
    display: inline-block; padding: 8px 14px; background: var(--accent);
    color: #fff; text-decoration: none; border: 0; border-radius: 6px;
    cursor: pointer; font: inherit; font-weight: 600;
  }
  .btn:hover { background: var(--accent-dark); }
  .btn.secondary { background: #fff; color: var(--fg); border: 1px solid var(--line); }
  .btn.secondary:hover { background: var(--surface-2); }
  table.admin-table {
    width: 100%; border-collapse: collapse; background: #fff;
    border-radius: 8px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.04);
  }
  table.admin-table th, table.admin-table td {
    padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left;
    vertical-align: top;
  }
  table.admin-table th {
    background: var(--surface-2); font-weight: 600; font-size: 0.85rem;
    text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted);
  }
  table.admin-table tr:last-child td { border-bottom: 0; }
  table.admin-table tr:hover { background: #fafafa; }
  .status {
    display: inline-block; padding: 3px 8px; border-radius: 10px;
    font-size: 0.8rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .status.new       { background: #fff4e6; color: #a55b00; }
  .status.contacted { background: #e6f2ff; color: #0057b3; }
  .status.quoted    { background: #efe6ff; color: #5a2ea6; }
  .status.won       { background: #e6f9ee; color: #1b7a3a; }
  .status.dead      { background: #f0f0f0; color: #6b6b6b; }
  .empty {
    padding: 40px; text-align: center; color: var(--muted); background: #fff;
    border-radius: 8px; border: 1px dashed var(--line);
  }
  .toast {
    padding: 10px 14px; background: #e6f9ee; border: 1px solid #b8e6c5;
    border-radius: 6px; color: #1b7a3a; margin-bottom: 16px;
  }
  .detail {
    background: #fff; border-radius: 8px; padding: 24px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
  }
  .kv { display: grid; grid-template-columns: 160px 1fr; gap: 8px 16px; }
  .kv dt { color: var(--muted); font-weight: 600; }
  .kv dd { margin: 0; word-break: break-word; }
  .message-block {
    background: var(--surface-2); border-left: 3px solid var(--accent);
    padding: 12px 16px; border-radius: 4px; white-space: pre-wrap;
    margin: 4px 0;
  }
  form.update-form {
    margin-top: 24px; padding-top: 24px; border-top: 1px solid var(--line);
    display: flex; flex-direction: column; gap: 12px;
  }
  form.update-form label { font-weight: 600; font-size: 0.9rem; }
  form.update-form select, form.update-form textarea {
    font: inherit; padding: 8px 10px; border: 1px solid var(--line);
    border-radius: 6px; background: #fff;
  }
  form.update-form textarea { min-height: 120px; resize: vertical; }
  .email-badge {
    display: inline-block; padding: 3px 8px; border-radius: 10px;
    font-size: 0.75rem; font-weight: 600;
  }
  .email-badge.ok { background: #e6f9ee; color: #1b7a3a; }
  .email-badge.fail { background: #ffe6e6; color: #a11616; }
  .login-wrap {
    max-width: 380px; margin: 80px auto; padding: 32px;
    background: #fff; border-radius: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.06);
  }
  .login-wrap h1 { text-align: center; margin-bottom: 24px; }
  .login-wrap form { display: flex; flex-direction: column; gap: 12px; }
  .login-wrap input {
    font: inherit; font-size: 1rem; padding: 12px;
    border: 1px solid var(--line); border-radius: 6px;
  }
  .login-wrap .btn { padding: 12px; font-size: 1rem; }
  .login-wrap .error {
    color: #a11616; background: #ffe6e6; padding: 10px;
    border-radius: 6px; text-align: center; font-size: 0.9rem;
  }
`;

function renderLayout(title, body, opts = {}) {
  const nav = opts.hideNav ? "" : `
    <header class="admin-nav">
      <span class="brand">Lakeside — Admin</span>
      <a href="/admin/case-study">Case Study</a>
      <a href="/admin/traffic">Traffic</a>
      <span class="spacer"></span>
      <a href="/admin/logout">Sign out</a>
    </header>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${BASE_CSS}</style>
</head><body>
${nav}
<main class="admin">${body}</main>
</body></html>`;
}

function renderLogin(errorMsg) {
  return renderLayout("Sign in", `
    <div class="login-wrap">
      <h1>Sign in</h1>
      ${errorMsg ? `<div class="error">${esc(errorMsg)}</div>` : ""}
      <form method="POST" action="/admin/login" autocomplete="off">
        <input type="password" name="password" placeholder="Admin password"
               required autofocus autocomplete="current-password">
        <button type="submit" class="btn">Sign in</button>
      </form>
    </div>
  `, { hideNav: true });
}

function renderConfigError(missingPassword, missingSecret) {
  const items = [];
  if (missingPassword) items.push("<code>ADMIN_PASSWORD</code>");
  if (missingSecret)   items.push("<code>SESSION_SECRET</code>");
  return renderLayout("Admin — configuration error", `
    <div class="empty">
      <p><strong>Admin is not fully configured.</strong></p>
      <p>Missing Cloudflare Worker secret${items.length > 1 ? "s" : ""}:
      ${items.join(" and ")}.</p>
      <p>Add ${items.length > 1 ? "them" : "it"} in the Cloudflare dashboard
      under Workers &amp; Pages → midwestcnc → Settings → Variables and Secrets.</p>
    </div>
  `, { hideNav: true });
}

function renderList(rows, params) {
  const statusOptions = ["", ...STATUS_OPTIONS]
    .map((s) => `<option value="${esc(s)}"${s === params.status ? " selected" : ""}>${s || "All statuses"}</option>`)
    .join("");

  const body = `
    <h1>Leads <span style="color:var(--muted);font-weight:400;">(${rows.length}${rows.length === 500 ? "+, showing latest 500" : ""})</span></h1>

    <form class="filters" method="GET" action="/admin">
      <input type="search" name="q" class="grow" value="${esc(params.q)}"
             placeholder="Search name, company, email, phone…">
      <select name="status">${statusOptions}</select>
      <button type="submit" class="btn">Filter</button>
      ${params.q || params.status ? `<a href="/admin" class="btn secondary">Reset</a>` : ""}
    </form>

    ${rows.length === 0 ? `
      <div class="empty">
        <p>No leads yet.</p>
        <p style="font-size:0.9rem;">Submissions to the quote form will appear here.</p>
      </div>
    ` : `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Date</th><th>Name</th><th>Company</th><th>Phone</th>
            <th>Service</th><th>Status</th><th>Email</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(formatDate(r.created_at))}</td>
              <td>${esc(r.name)}</td>
              <td>${esc(r.company)}</td>
              <td><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></td>
              <td>${esc(r.service)}</td>
              <td><span class="status ${esc(r.status)}">${esc(r.status)}</span></td>
              <td>${r.email_sent
                ? '<span class="email-badge ok">sent</span>'
                : '<span class="email-badge fail">no</span>'}</td>
              <td><a href="/admin/quote/${r.id}" class="btn secondary">View</a></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `}
  `;
  return renderLayout("Leads — Lakeside Admin", body);
}

function renderDetail(r, saved) {
  const statusOptions = STATUS_OPTIONS
    .map((s) => `<option value="${esc(s)}"${s === r.status ? " selected" : ""}>${s}</option>`)
    .join("");

  const body = `
    <p><a href="/admin">&larr; All leads</a></p>
    <h1>Quote #${r.id} &mdash; ${esc(r.name)}</h1>
    ${saved ? `<div class="toast">Changes saved.</div>` : ""}

    <div class="detail">
      <dl class="kv">
        <dt>Submitted</dt>            <dd>${esc(formatDate(r.created_at))}</dd>
        <dt>Name</dt>                 <dd>${esc(r.name)}</dd>
        <dt>Company</dt>              <dd>${esc(r.company)}</dd>
        <dt>Phone</dt>                <dd><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></dd>
        <dt>Email</dt>                <dd><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></dd>
        <dt>Machine brand</dt>        <dd>${esc(r.machine_brand || "—")}</dd>
        <dt>Machine model</dt>        <dd>${esc(r.machine_model || "—")}</dd>
        <dt>Service needed</dt>       <dd>${esc(r.service)}</dd>
        <dt>Message</dt>              <dd><div class="message-block">${esc(r.message)}</div></dd>
        <dt>Email delivery</dt>       <dd>${r.email_sent
          ? '<span class="email-badge ok">sent to Ken</span>'
          : `<span class="email-badge fail">not sent</span> ${r.email_error ? `<br><small style="color:var(--muted);">${esc(r.email_error)}</small>` : ""}`}</dd>
        <dt>Source IP</dt>            <dd style="font-family:monospace;font-size:0.85rem;color:var(--muted);">${esc(r.ip || "—")}</dd>
      </dl>

      <form class="update-form" method="POST" action="/admin/quote/${r.id}">
        <label for="status-select">Status</label>
        <select id="status-select" name="status">${statusOptions}</select>

        <label for="notes-field">Notes (called, quoted, follow-up dates, etc.)</label>
        <textarea id="notes-field" name="notes" placeholder="Freeform notes on this lead…">${esc(r.notes || "")}</textarea>

        <button type="submit" class="btn">Save changes</button>
      </form>
    </div>
  `;
  return renderLayout(`Quote #${r.id} — Lakeside Admin`, body);
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

async function handleCaseStudyAdminPage(env) {
  if (!env.DB) {
    return htmlResponse(renderLayout("Case Study", `<p>DB not configured.</p>`));
  }
  await ensureCaseStudySchema(env);
  const [daily, ai, meta] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM cs_gsc_daily").first(),
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM cs_ai_daily").first(),
    env.DB.prepare("SELECT k, v FROM cs_meta").all(),
  ]);
  const metaMap = {};
  for (const r of meta.results || []) metaMap[r.k] = r.v;

  const body = `
    <p><a href="/admin">&larr; All leads</a></p>
    <h1>Case Study Data</h1>
    <p style="color:var(--muted);">
      Powers <code>/api/case-study.json</code>. Weekly cron (Mon 7 AM Central)
      pulls GSC + Bing automatically. Paste CSVs below for one-off AI
      Overview refreshes or manual catch-up.
    </p>

    <div class="detail">
      <h2>Current data</h2>
      <dl class="kv">
        <dt>GSC daily rows</dt>   <dd>${daily?.n || 0} ${daily?.first ? `(${daily.first} → ${daily.last})` : ""}</dd>
        <dt>AI daily rows</dt>    <dd>${ai?.n || 0} ${ai?.first ? `(${ai.first} → ${ai.last})` : ""}</dd>
        <dt>GSC last updated</dt> <dd>${esc(metaMap.gsc_updated || "never")} ${metaMap.gsc_last_error ? `<span class="email-badge fail">error</span> <small style="color:var(--muted);">${esc(metaMap.gsc_last_error)}</small>` : ""}</dd>
        <dt>Bing last updated</dt><dd>${esc(metaMap.bing_updated || "never")} ${metaMap.bing_last_error ? `<span class="email-badge fail">error</span> <small style="color:var(--muted);">${esc(metaMap.bing_last_error)}</small>` : ""}</dd>
        <dt>Data as of</dt>       <dd>${esc(metaMap.data_as_of || "never")}</dd>
        <dt>Live JSON</dt>        <dd><a href="/api/case-study.json" target="_blank">/api/case-study.json</a></dd>
      </dl>

      <form method="POST" action="/admin/case-study/refresh" style="margin-top:16px;">
        <button type="submit" class="btn">Refresh GSC + Bing now</button>
        <small style="color:var(--muted);margin-left:12px;">Pulls latest 90 days. Runs automatically every Monday.</small>
      </form>

      <form class="update-form" method="POST" action="/admin/case-study" enctype="multipart/form-data">
        <label for="csv_type">Which CSV is this?</label>
        <select id="csv_type" name="csv_type">
          <option value="gsc_chart">GSC — Chart.csv (daily clicks/impressions/CTR/position)</option>
          <option value="gsc_queries">GSC — Queries.csv (query / clicks / impressions / CTR / position)</option>
          <option value="gsc_pages">GSC — Pages.csv (page / clicks / impressions / CTR / position)</option>
          <option value="ai_overview">AI Performance Overview (Date / Citations / Cited Pages)</option>
        </select>

        <label for="csv_text">Paste CSV content here:</label>
        <textarea id="csv_text" name="csv_text" placeholder="Copy the CSV file contents and paste here.&#10;First row = headers, same as GSC exports."></textarea>

        <button type="submit" class="btn">Upload &amp; refresh</button>
      </form>
    </div>
  `;
  return htmlResponse(renderLayout("Case Study — Admin", body));
}

async function handleCaseStudyUpload(request, env, url) {
  await ensureCaseStudySchema(env);
  const form = await request.formData().catch(() => null);
  if (!form) return new Response("Bad request", { status: 400 });
  const csvType = (form.get("csv_type") || "").toString();
  const csvText = (form.get("csv_text") || "").toString().trim();
  if (!csvText) {
    return htmlResponse(renderLayout("Case Study", `<p>No CSV content.</p><p><a href="/admin/case-study">Back</a></p>`));
  }

  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return htmlResponse(renderLayout("Case Study", `<p>CSV had no data rows.</p><p><a href="/admin/case-study">Back</a></p>`));
  }
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const dataRows = rows.slice(1);
  let inserted = 0;

  if (csvType === "gsc_chart") {
    const stmts = dataRows
      .filter((r) => r[0])
      .map((r) => env.DB.prepare(
        "INSERT INTO cs_gsc_daily (date, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(date) DO UPDATE SET clicks=excluded.clicks, impressions=excluded.impressions, ctr=excluded.ctr, position=excluded.position"
      ).bind(r[0], intOr0(r[1]), intOr0(r[2]), pctOr0(r[3]), floatOr0(r[4])));
    await env.DB.batch(stmts);
    inserted = stmts.length;
  } else if (csvType === "gsc_queries") {
    await env.DB.exec("DELETE FROM cs_gsc_queries");
    const stmts = dataRows
      .filter((r) => r[0])
      .map((r) => env.DB.prepare(
        "INSERT OR REPLACE INTO cs_gsc_queries (query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?)"
      ).bind(r[0], intOr0(r[1]), intOr0(r[2]), pctOr0(r[3]), floatOr0(r[4])));
    await env.DB.batch(stmts);
    inserted = stmts.length;
  } else if (csvType === "gsc_pages") {
    await env.DB.exec("DELETE FROM cs_gsc_pages");
    const stmts = dataRows
      .filter((r) => r[0])
      .map((r) => env.DB.prepare(
        "INSERT OR REPLACE INTO cs_gsc_pages (page, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?)"
      ).bind(r[0], intOr0(r[1]), intOr0(r[2]), pctOr0(r[3]), floatOr0(r[4])));
    await env.DB.batch(stmts);
    inserted = stmts.length;
  } else if (csvType === "ai_overview") {
    const stmts = dataRows
      .filter((r) => r[0])
      .map((r) => env.DB.prepare(
        "INSERT INTO cs_ai_daily (date, citations, cited_pages) VALUES (?, ?, ?) " +
        "ON CONFLICT(date) DO UPDATE SET citations=excluded.citations, cited_pages=excluded.cited_pages"
      ).bind(normalizeDate(r[0]), intOr0(r[1]), intOr0(r[2])));
    await env.DB.batch(stmts);
    inserted = stmts.length;
  } else {
    return new Response("Unknown csv_type", { status: 400 });
  }

  const now = new Date().toISOString();
  const metaKey = csvType.startsWith("gsc_") ? "gsc_updated" : "ai_updated";
  await env.DB.prepare(
    "INSERT INTO cs_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=CURRENT_TIMESTAMP"
  ).bind(metaKey, now).run();
  await env.DB.prepare(
    "INSERT INTO cs_meta (k, v) VALUES ('data_as_of', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=CURRENT_TIMESTAMP"
  ).bind(now).run();

  return new Response(null, {
    status: 303,
    headers: { Location: new URL(`/admin/case-study?uploaded=${inserted}`, url).toString() },
  });
}

function parseCsv(text) {
  // Minimal RFC-4180 parser: handles quoted fields with embedded commas/quotes.
  const rows = [];
  let row = [], field = "", inQuotes = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ""; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0]));
}

function intOr0(v) { const n = parseInt(String(v || "").replace(/,/g, ""), 10); return isNaN(n) ? 0 : n; }
function floatOr0(v) { const n = parseFloat(String(v || "").replace(/,/g, "")); return isNaN(n) ? 0 : n; }
function pctOr0(v) {
  const s = String(v || "").replace(/,/g, "").replace("%", "").trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : (n > 1 ? n / 100 : n);
}
function normalizeDate(v) {
  // Accepts "YYYY-MM-DD", "M/D/YYYY", "M/D/YYYY 12:00:00 AM" → YYYY-MM-DD
  const s = String(v || "").trim().split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return s;
}

export async function handleAdmin(request, env, url) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return htmlResponse(renderConfigError(!env.ADMIN_PASSWORD, !env.SESSION_SECRET), 500);
  }
  const path = url.pathname;
  const method = request.method;

  if (path === "/admin/login") {
    if (method === "GET") return htmlResponse(renderLogin(""));
    if (method === "POST") return handleLogin(request, env, url);
    return new Response("Method not allowed", { status: 405 });
  }
  if (path === "/admin/logout") {
    return new Response(null, {
      status: 303,
      headers: {
        Location: new URL("/admin/login", url).toString(),
        "Set-Cookie": `${SESSION_COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  const session = await getSession(request, env);
  if (!session) {
    return new Response(null, { status: 303, headers: { Location: new URL("/admin/login", url).toString() }});
  }
  if (method === "POST") {
    const origin = request.headers.get("origin") || "";
    if (origin && !origin.startsWith(`${url.protocol}//${url.host}`)) {
      return new Response("Bad origin", { status: 403 });
    }
  }

  if (path === "/admin" || path === "/admin/") {
    return new Response(null, { status: 303, headers: { Location: new URL("/admin/case-study", url).toString() }});
  }
  if (path === "/admin/case-study") {
    if (method === "GET") return handleCaseStudyAdminPage(env);
    if (method === "POST") return handleCaseStudyUpload(request, env, url);
    return new Response("Method not allowed", { status: 405 });
  }
  if (path === "/admin/case-study/refresh") {
    if (method !== "POST") return new Response("Method not allowed", { status: 405 });
    const result = await runCaseStudyRefresh(env, { source: "manual" });
    const q = result.skipped
      ? `?rate_limited=${encodeURIComponent((result.retry_after_min || 0) + " min")}`
      : "?refreshed=1";
    return new Response(null, { status: 303, headers: { Location: new URL(`/admin/case-study${q}`, url).toString() }});
  }
  if (path === "/admin/traffic") {
    if (method !== "GET") return new Response("Method not allowed", { status: 405 });
    return handleTrafficAdminPage(env);
  }
  return htmlResponse(renderLayout("Not found", `<p>Not found.</p>`), 404);
}

// Login handler
async function handleLogin(request, env, url) {
  const form = await request.formData().catch(() => null);
  if (!form) return htmlResponse(renderLogin("Bad request."));
  const password = (form.get("password") || "").toString();
  if (!password) return htmlResponse(renderLogin("Enter a password."));
  const ok = await constantTimeStringEquals(password, env.ADMIN_PASSWORD);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 500));
    return htmlResponse(renderLogin("Wrong password."), 401);
  }
  const cookie = await mintSessionCookie(env.SESSION_SECRET);
  return new Response(null, {
    status: 303,
    headers: {
      Location: new URL("/admin/case-study", url).toString(),
      "Set-Cookie": `${SESSION_COOKIE}=${cookie}; Path=/admin; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

// AI bot user-agent patterns. Order matters — more specific first.
const AI_BOT_PATTERNS = [
  ["GPTBot",             /GPTBot/i],
  ["ChatGPT-User",       /ChatGPT-User/i],
  ["OAI-SearchBot",      /OAI-SearchBot/i],
  ["ClaudeBot",          /ClaudeBot/i],
  ["Claude-Web",         /Claude-Web/i],
  ["anthropic-ai",       /anthropic-ai/i],
  ["PerplexityBot",      /PerplexityBot/i],
  ["Perplexity-User",    /Perplexity-User/i],
  ["Google-Extended",    /Google-Extended/i],
  ["GoogleOther",        /GoogleOther/i],
  ["Applebot-Extended",  /Applebot-Extended/i],
  ["meta-externalagent", /meta-externalagent/i],
  ["FacebookBot",        /FacebookBot/i],
  ["Amazonbot",          /Amazonbot/i],
  ["cohere-ai",          /cohere-ai/i],
  ["CCBot",              /CCBot/i],
  ["Bytespider",         /Bytespider/i],
  ["MistralAI-User",     /MistralAI-User/i],
  ["Diffbot",            /Diffbot/i],
  // Traditional search bots — we track them separately but same table
  ["Googlebot",          /Googlebot(?!-Image)/i],
  ["Bingbot",            /Bingbot/i],
  ["DuckDuckBot",        /DuckDuckBot/i],
  ["YandexBot",          /YandexBot/i],
  ["Baiduspider",        /Baiduspider/i],
];

// Referer hosts that count as AI-engine traffic. Match on hostname only.
const AI_REFERER_HOSTS = new Set([
  "chat.openai.com",
  "chatgpt.com",
  "perplexity.ai",
  "gemini.google.com",
  "bard.google.com",
  "copilot.microsoft.com",
  "claude.ai",
  "poe.com",
  "you.com",
  "andisearch.com",
  "phind.com",
  "deepseek.com",
  "mistral.ai",
  "huggingface.co",
]);

function classifyBot(ua) {
  if (!ua) return null;
  for (const [name, pat] of AI_BOT_PATTERNS) {
    if (pat.test(ua)) return name;
  }
  return null;
}

function extractRefererHost(refererHeader, selfHost) {
  if (!refererHeader) return null;
  try {
    const h = new URL(refererHeader).hostname.toLowerCase().replace(/^www\./, "");
    if (!h) return null;
    if (h === selfHost || h.endsWith("." + selfHost)) return null;
    return h;
  } catch (_) {
    return null;
  }
}

export function maybeLogTraffic(request, env, ctx, url) {
  if (!env.DB || !ctx) return;
  // Only HTML pages
  const path = url.pathname;
  if (
    path.startsWith("/assets/") ||
    path.startsWith("/api/") ||
    path.startsWith("/admin") ||
    path.startsWith("/cdn-cgi/") ||
    path === "/favicon.svg" ||
    path === "/robots.txt" ||
    path === "/sitemap.xml" ||
    path === "/llms.txt" ||
    path.endsWith(".webp") || path.endsWith(".png") || path.endsWith(".jpg") ||
    path.endsWith(".css") || path.endsWith(".js") || path.endsWith(".svg") ||
    path.endsWith(".txt") || path.endsWith(".xml") || path.endsWith(".ico")
  ) return;

  const ua = request.headers.get("user-agent") || "";
  const ref = request.headers.get("referer") || "";
  const bot = classifyBot(ua);
  const refererHost = extractRefererHost(ref, "lakesidethreadz.com");

  // Only log when there's something interesting to log
  if (!bot && !refererHost) return;

  // If referer is a known AI engine, upgrade signal visibility
  const isAiReferer = refererHost && AI_REFERER_HOSTS.has(refererHost);

  // Cloudflare provides country in request.cf
  const country = (request.cf && request.cf.country) || null;

  ctx.waitUntil(
    (async () => {
      try {
        await env.DB.exec(TRAFFIC_SCHEMA.replace(/\n/g, " ")).catch(() => {});
        await env.DB.prepare(
          "INSERT INTO traffic_log (ts, path, bot, referer_host, country, user_agent) " +
          "VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(
          new Date().toISOString(),
          path,
          bot,
          refererHost,
          country,
          ua.slice(0, 500),
        ).run();
      } catch (e) {
        console.log("traffic_log insert failed:", e && e.message);
      }
    })()
  );
}

// ---------- /admin/traffic ----------

async function handleTrafficAdminPage(env) {
  if (!env.DB) {
    return htmlResponse(renderLayout("Traffic", `<p>DB not configured.</p>`));
  }
  await env.DB.exec(TRAFFIC_SCHEMA.replace(/\n/g, " ")).catch(() => {});

  // Last 7 days of each: AI bot crawls, external referrals, top pages
  const since = new Date(Date.now() - 7 * 86400000).toISOString();

  const [botSummary, refSummary, aiRefSummary, topPages, totals] = await Promise.all([
    env.DB.prepare(
      "SELECT bot, COUNT(*) AS n FROM traffic_log WHERE ts > ? AND bot IS NOT NULL GROUP BY bot ORDER BY n DESC"
    ).bind(since).all(),
    env.DB.prepare(
      "SELECT referer_host, COUNT(*) AS n FROM traffic_log WHERE ts > ? AND bot IS NULL AND referer_host IS NOT NULL GROUP BY referer_host ORDER BY n DESC LIMIT 25"
    ).bind(since).all(),
    env.DB.prepare(
      "SELECT referer_host, COUNT(*) AS n FROM traffic_log WHERE ts > ? AND referer_host IN (" +
      Array.from(AI_REFERER_HOSTS).map((h) => `'${h}'`).join(",") +
      ") GROUP BY referer_host ORDER BY n DESC"
    ).bind(since).all(),
    env.DB.prepare(
      "SELECT path, COUNT(*) AS n FROM traffic_log WHERE ts > ? AND bot IS NOT NULL GROUP BY path ORDER BY n DESC LIMIT 15"
    ).bind(since).all(),
    env.DB.prepare(
      "SELECT " +
      "(SELECT COUNT(*) FROM traffic_log WHERE ts > ? AND bot IS NOT NULL) AS crawls, " +
      "(SELECT COUNT(*) FROM traffic_log WHERE ts > ? AND bot IS NULL AND referer_host IS NOT NULL) AS referrals, " +
      "(SELECT COUNT(DISTINCT path) FROM traffic_log WHERE ts > ? AND bot IS NOT NULL) AS unique_pages_crawled, " +
      "(SELECT COUNT(*) FROM traffic_log) AS all_time"
    ).bind(since, since, since).first(),
  ]);

  const row = (label, n) => `
    <tr><td>${esc(label)}</td><td style="text-align:right;font-variant-numeric:tabular-nums;">${n.toLocaleString()}</td></tr>`;

  const body = `
    <p><a href="/admin">&larr; All leads</a></p>
    <h1>Traffic — last 7 days</h1>
    <p style="color:var(--muted);">
      Server-side log of AI bot crawls + external referrals.
      Updated live per request (fire-and-forget).
    </p>

    <div class="detail">
      <h2>Summary</h2>
      <table class="admin-table" style="max-width:500px;">
        <tbody>
          ${row("AI/search bot crawl hits", totals.crawls || 0)}
          ${row("External referrals", totals.referrals || 0)}
          ${row("Unique pages crawled by bots", totals.unique_pages_crawled || 0)}
          ${row("All-time logged events", totals.all_time || 0)}
        </tbody>
      </table>

      <h2>AI bot crawls by bot (last 7d)</h2>
      ${botSummary.results?.length ? `
        <table class="admin-table" style="max-width:500px;">
          <thead><tr><th>Bot</th><th style="text-align:right;">Hits</th></tr></thead>
          <tbody>${botSummary.results.map((r) => row(r.bot, r.n)).join("")}</tbody>
        </table>` : `<p class="empty">No bot crawls yet. Logging just started — check back in a day.</p>`}

      <h2>AI engine referrals (clicks from ChatGPT/Perplexity/Gemini/etc.)</h2>
      ${aiRefSummary.results?.length ? `
        <table class="admin-table" style="max-width:500px;">
          <thead><tr><th>AI engine</th><th style="text-align:right;">Clicks</th></tr></thead>
          <tbody>${aiRefSummary.results.map((r) => row(r.referer_host, r.n)).join("")}</tbody>
        </table>` : `<p class="empty">No AI referral clicks logged yet.</p>`}

      <h2>All external referrals (last 7d, top 25)</h2>
      ${refSummary.results?.length ? `
        <table class="admin-table" style="max-width:600px;">
          <thead><tr><th>Source</th><th style="text-align:right;">Visits</th></tr></thead>
          <tbody>${refSummary.results.map((r) => row(r.referer_host, r.n)).join("")}</tbody>
        </table>` : `<p class="empty">No external referrals logged yet.</p>`}

      <h2>Top pages crawled by bots (last 7d)</h2>
      ${topPages.results?.length ? `
        <table class="admin-table">
          <thead><tr><th>Path</th><th style="text-align:right;">Bot hits</th></tr></thead>
          <tbody>${topPages.results.map((r) => `<tr><td><code>${esc(r.path)}</code></td><td style="text-align:right;font-variant-numeric:tabular-nums;">${r.n.toLocaleString()}</td></tr>`).join("")}</tbody>
        </table>` : `<p class="empty">No bot crawls yet.</p>`}
    </div>
  `;
  return htmlResponse(renderLayout("Traffic — Lakeside Admin", body));
}

// ---------- /api/case-study.json: ai_crawls section ----------
// Called from handleCaseStudyJson to mix traffic data into the JSON.

async function caseStudyTrafficSection(env) {
  try {
    await env.DB.exec(TRAFFIC_SCHEMA.replace(/\n/g, " ")).catch(() => {});
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const [bots, refs, total] = await Promise.all([
      env.DB.prepare("SELECT bot, COUNT(*) AS n FROM traffic_log WHERE ts > ? AND bot IS NOT NULL GROUP BY bot ORDER BY n DESC").bind(since).all(),
      env.DB.prepare(
        "SELECT referer_host, COUNT(*) AS n FROM traffic_log WHERE ts > ? AND referer_host IN (" +
        Array.from(AI_REFERER_HOSTS).map((h) => `'${h}'`).join(",") +
        ") GROUP BY referer_host ORDER BY n DESC"
      ).bind(since).all(),
      env.DB.prepare(
        "SELECT COUNT(*) AS crawls, COUNT(DISTINCT path) AS pages FROM traffic_log WHERE ts > ? AND bot IS NOT NULL"
      ).bind(since).first(),
    ]);
    return {
      window_days: 7,
      bot_crawls: total?.crawls || 0,
      pages_crawled: total?.pages || 0,
      by_bot: (bots.results || []).map((r) => ({ bot: r.bot, hits: r.n })),
      ai_engine_referrals: (refs.results || []).map((r) => ({ engine: r.referer_host, clicks: r.n })),
      source: "Cloudflare Worker traffic_log",
    };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}
