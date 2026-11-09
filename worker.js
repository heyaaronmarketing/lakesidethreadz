// worker.js — Cloudflare Worker for lakesidethreadz.com
// Handles POST /api/contact and POST /api/quote (Resend email).
// Plus B2B outreach engine (see functions/api/outreach.js) — 3-touch cold
// sequence + monthly seasonal newsletter, cron-driven, KV-backed.
// Falls through to env.ASSETS.fetch for all static assets.
//
// Required env vars (Worker → Settings → Variables and Secrets):
//   RESEND_API_KEY  (secret, Resend API key — shared across all email paths)
//   OUTREACH_KEY    (secret, admin auth for outreach + newsletter endpoints)
// Optional vars (set in wrangler.jsonc → vars):
//   CONTACT_TO      — default: hello@lakesidethreadz.com
//   CONTACT_FROM    — default: noreply@lakesidethreadz.com
//   CONTACT_CC      — optional comma-separated CC list
//   DAILY_CAP       — max outreach sends per day (default 10)
//   OUTREACH_REPLY_TO — optional override for outreach Reply-To

import {
  runOutreach, prospectsPost, statsGet, runGet, unsubGet, webhookPost,
  runNewsletter, newsletterContentPost, newsletterStatsGet, newsletterRunGet,
  dashboardGet, testBlastPost,
} from "./functions/api/outreach.js";
import {
  handleCaseStudyJson, handleAdmin, runCaseStudyRefresh, maybeLogTraffic,
} from "./functions/api/case-study.js";

const SIMPLE_ENDPOINTS = new Set(["/api/contact", "/api/quote"]);
const RICH_QUOTE_ENDPOINT = "/api/submit-quote";

// 301 redirects for consolidated town service-area pages (retired 2026-08-16).
// See seo/keyword-research-2026-08-15.md — those 7 town pages had 0 search volume
// and now redirect to the consolidated Lake Livingston service-area page.
const LEGACY_REDIRECTS = {
  "/service-area/cleveland-tx/":   "/service-area/lake-livingston/",
  "/service-area/coldspring-tx/":  "/service-area/lake-livingston/",
  "/service-area/huntsville-tx/":  "/service-area/lake-livingston/",
  "/service-area/livingston-tx/":  "/service-area/lake-livingston/",
  "/service-area/onalaska-tx/":    "/service-area/lake-livingston/",
  "/service-area/splendora-tx/":   "/service-area/lake-livingston/",
  "/service-area/lufkin-tx/":      "/service-area/lake-livingston/",
};

// Outreach routes — most are admin-gated (?key=OUTREACH_KEY); /unsub is public
// per CAN-SPAM one-click-unsub requirement. /dashboard gated separately by
// DASHBOARD_KEY so the client can view stats without owning write access.
const OUTREACH_ROUTES = {
  "POST /api/outreach/prospects": prospectsPost,
  "GET /api/outreach/stats":      statsGet,
  "GET /api/outreach/run":        runGet,
  "GET /api/outreach/unsub":      unsubGet,
  "POST /api/outreach/webhook":   webhookPost,
  "POST /api/newsletter/content": newsletterContentPost,
  "GET /api/newsletter/stats":    newsletterStatsGet,
  "GET /api/newsletter/run":      newsletterRunGet,
  "GET /dashboard":               dashboardGet,
  "POST /api/outreach/test-blast": testBlastPost,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Fire-and-forget server-side traffic log for AI bot crawls + external
    // (AI engine / search engine) referrals. Skips static assets, /api/,
    // /admin/, /cdn-cgi/. Never blocks the response. See case-study.js.
    maybeLogTraffic(request, env, ctx, url);

    // Legacy town-page 301s — handle both with-slash and without-slash forms.
    const redirTarget = LEGACY_REDIRECTS[path] || LEGACY_REDIRECTS[path + "/"];
    if (redirTarget) {
      return new Response(null, { status: 301, headers: { Location: redirTarget } });
    }

    // Case-study pipeline — public feed + admin UI.
    if (path === "/api/case-study.json") {
      if (request.method === "GET") return handleCaseStudyJson(env);
      return new Response("Method not allowed", { status: 405 });
    }
    if (path === "/admin" || path.startsWith("/admin/")) {
      return handleAdmin(request, env, url);
    }

    // Edge geo lookup for the school-picker test on /shop/trucker-hat/.
    // Returns visitor's Cloudflare-detected city/region — no client permission
    // prompt required (unlike navigator.geolocation).
    if (path === "/api/geo" && request.method === "GET") {
      const cf = request.cf || {};
      return json({
        city: cf.city || null,
        region: cf.region || null,
        country: cf.country || null,
        latitude: cf.latitude || null,
        longitude: cf.longitude || null,
      }, 200);
    }

    if (SIMPLE_ENDPOINTS.has(path)) {
      if (request.method === "GET") return json({ ok: true, endpoint: path }, 200);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return await handleFormSubmit(request, env, path);
    }

    if (path === RICH_QUOTE_ENDPOINT) {
      if (request.method === "GET") return json({ ok: true, endpoint: path }, 200);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return await handleRichQuote(request, env);
    }

    const outreachHandler = OUTREACH_ROUTES[`${request.method} ${path}`];
    if (outreachHandler) return await outreachHandler({ request, env, ctx });

    // Trailing-slash normalization — 301 Permanent so Google consolidates
    // ranking signals. CF Workers Static Assets defaults to 307 which
    // Google treats as temporary → duplicate URLs rank separately.
    // GET/HEAD only, skip extensioned paths (foo.png, foo.xml, etc.).
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      !path.endsWith("/") &&
      !path.slice(path.lastIndexOf("/")).includes(".")
    ) {
      return Response.redirect(url.origin + path + "/" + url.search + url.hash, 301);
    }

    return env.ASSETS.fetch(request);
  },

  // Cron triggers (defined in wrangler.jsonc):
  //   "0 15 * * 2-5"  — Tue-Fri at 15:00 UTC (10am CT) → outreach batch (max DAILY_CAP)
  //   "0 16 1 * *"    — 1st of month, 16:00 UTC (11am CT) → seasonal newsletter
  //   "0 13 * * 1"    — Monday 13:00 UTC (7am CT) → case-study refresh (GSC + Bing + DataForSEO + IndexNow)
  async scheduled(event, env, ctx) {
    // Distinguish crons by cron string.
    if (event.cron === "0 16 1 * *") {
      ctx.waitUntil(runNewsletter(env));
    } else if (event.cron === "0 13 * * 1") {
      ctx.waitUntil(runCaseStudyRefresh(env, { source: "cron", trigger: event.cron }));
    } else {
      ctx.waitUntil(runOutreach(env));
    }
  },
};

async function handleFormSubmit(request, env, endpoint) {
  let body = {};
  const ct = request.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) {
      body = await request.json();
    } else {
      const form = await request.formData();
      for (const [k, v] of form.entries()) body[k] = v;
    }
  } catch (e) {
    return json({ error: "Bad request body" }, 400);
  }

  // Honeypot — drop silently if filled.
  if (body.website) return json({ ok: true }, 200);

  const name = (body.name || "").toString().trim();
  const email = (body.email || "").toString().trim();
  const phone = (body.phone || "").toString().trim();
  const service = (body.service || "").toString().trim();
  const message = (body.message || "").toString().trim();

  if (!name || !email || !message) {
    return json({ error: "Name, email, and message are required." }, 422);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "Please enter a valid email." }, 422);
  }

  if (!env.RESEND_API_KEY) {
    return json({ error: "Email is not configured yet." }, 503);
  }

  const which = endpoint === "/api/quote" ? "Quote request" : "Contact form";
  const to = (env.CONTACT_TO || "info@lakesidethreadz.com").split(",").map(s => s.trim()).filter(Boolean);
  const from = env.CONTACT_FROM || "noreply@lakesidethreadz.com";
  const cc = (env.CONTACT_CC || "").split(",").map(s => s.trim()).filter(Boolean);

  const subject = `[L.I.T.] ${which} from ${name}`;
  const text =
    `${which} via ${endpoint}\n\n` +
    `Name: ${name}\n` +
    `Email: ${email}\n` +
    `Phone: ${phone || "—"}\n` +
    `Service: ${service || "—"}\n\n` +
    `Message:\n${message}\n`;

  const payload = {
    from: `Lakeside Ink & Threadz <${from}>`,
    to,
    cc: cc.length ? cc : undefined,
    reply_to: email,
    subject,
    text,
  };

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const detail = await safeText(r);
      return json({ error: "Email send failed", detail }, 502);
    }
  } catch (e) {
    return json({ error: "Email send threw", detail: String(e) }, 502);
  }

  // Log submission to KV for dashboard visibility (1yr TTL).
  if (env.STATUS) {
    const rec = { ts: Date.now(), endpoint, kind: endpoint === "/api/quote" ? "quote" : "contact", name, email, phone, service, message: message.slice(0, 500) };
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await env.STATUS.put(`submissions:${id}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 365 });
  }

  return json({ ok: true }, 200);
}

async function handleRichQuote(request, env) {
  // Accepts the full calculator payload and formats it into a readable email.
  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }

  if (body && body.website) return json({ ok: true }, 200);

  const c = (body && body.contact) || {};
  const name = (c.firstName || "").toString().trim();
  const email = (c.email || "").toString().trim();
  const phone = (c.phone || "").toString().trim();
  const business = (c.businessName || "").toString().trim();
  if (!name || !email) return json({ error: "Name and email are required." }, 422);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Please enter a valid email." }, 422);

  const est = body.estimate || {};
  const addons = body.addons || {};
  const addonLines = [
    addons.individualNames && "Individual names (+$3/pc)",
    addons.rushOrder && "Rush order (+25%)",
    addons.logoDesign && "Logo design (+$149)",
  ].filter(Boolean).join(", ") || "—";
  const placements = Array.isArray(body.placements) && body.placements.length ? body.placements.join(", ") : "—";
  const logoLine = body.needsLogoDesign || addons.logoDesign
    ? "Design service requested"
    : body.skipLogo
      ? "Sending logo later"
      : body.logoFile
        ? `Uploaded: ${body.logoFile.name} (${formatBytes(body.logoFile.size)}) — customer will email the file separately`
        : "Not provided";

  const subject = `[L.I.T.] Quote request from ${name} — ${body.product || "?"} × ${body.quantity || "?"}`;
  const text =
    `New quote request via /api/submit-quote\n\n` +
    `=== Contact ===\n` +
    `Name:     ${name}\n` +
    `Email:    ${email}\n` +
    `Phone:    ${phone || "—"}\n` +
    `Business: ${business || "—"}\n\n` +
    `=== Order ===\n` +
    `Product:    ${body.product || "—"}\n` +
    `Quantity:   ${body.quantity || "—"}\n` +
    `Tier:       ${body.tier || "—"}\n` +
    `Color:      ${body.color || "—"}\n` +
    `Placement:  ${placements}\n` +
    `Logo:       ${logoLine}\n` +
    `Add-ons:    ${addonLines}\n\n` +
    `=== Estimate ===\n` +
    `Per piece:        $${num(est.perPiece)}\n` +
    `One-time fees:    $${num(est.oneTimeFees)}\n` +
    `Estimated total:  $${num(est.total)}\n`;

  if (!env.RESEND_API_KEY) return json({ error: "Email is not configured yet." }, 503);

  const to = (env.CONTACT_TO || "info@lakesidethreadz.com").split(",").map(s => s.trim()).filter(Boolean);
  const from = env.CONTACT_FROM || "noreply@lakesidethreadz.com";
  const cc = (env.CONTACT_CC || "").split(",").map(s => s.trim()).filter(Boolean);

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `Lakeside Ink & Threadz <${from}>`,
        to,
        cc: cc.length ? cc : undefined,
        reply_to: email,
        subject,
        text,
      }),
    });
    if (!r.ok) return json({ error: "Email send failed", detail: await safeText(r) }, 502);
  } catch (e) {
    return json({ error: "Email send threw", detail: String(e) }, 502);
  }
  if (env.STATUS) {
    const rec = { ts: Date.now(), endpoint: RICH_QUOTE_ENDPOINT, kind: "rich-quote", name, email, phone, business, product: body.product, quantity: body.quantity, estimate: est.total };
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await env.STATUS.put(`submissions:${id}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 365 });
  }
  return json({ ok: true }, 200);
}

function num(n) { return (typeof n === "number" ? n : 0).toFixed(2); }
function formatBytes(b) {
  if (typeof b !== "number") return "?";
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function safeText(r) {
  try { return await r.text(); } catch { return ""; }
}
