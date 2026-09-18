// ============================================================================
// B2B uniform outreach engine — Cloudflare Worker + KV + Resend.
//
// Ported from deuceswildpokertx-mirror/site/functions/api/outreach.js (2026-07).
// Same architecture: 3-touch cold sequence with weekday-only sends, engagement
// auto-enrolls into a monthly seasonal newsletter, one-click unsub, CAN-SPAM
// compliant headers + footer.
//
// Pitch: custom embroidered/DTF uniform program for local East-TX businesses.
//   Touch 1: intro + soft pitch to a decision-maker
//   Touch 2: short follow-up with concrete offer
//   Touch 3: last note — no pressure, keeps the door open
//
// Storage: STATUS KV namespace, keys prefixed "outreach:" / "newsletter:".
//   outreach:prospect:<id>  -> {email,name,org,category,city,status,touches:[{n,ts}],engaged?,engagedAt?,added}
//   outreach:suppress:<email lowercased> -> reason ("unsub"|"bounce"|"complaint")
//   outreach:log:<YYYY-MM-DD> -> {sent:n}
//   newsletter:sub:<email> -> {added,source,name,org}
//   newsletter:content:<YYYY-MM> -> {subject, text}
//   newsletter:sent:<YYYY-MM> -> {sent, skipped, ts}
//
// Sending: Resend API. Deliverability guardrails:
//   DAILY_CAP (default 10), cron only Tue-Fri, 3-touch max, suppression checked
//   before every send, List-Unsubscribe header + CAN-SPAM footer every email.
//
// CTA: /quote (existing 8-step calculator) + phone.
// ============================================================================

// From = the owner's real name — 2-3× higher open + reply rate on cold vs a
// generic business-name From. Reply-to defaults to the same address so replies
// land in Kristen's Gmail (mobile push notifications = free SMS-equivalent).
const FROM = 'Kristen Coats <hello@lakesidethreadz.com>';
const SITE = 'https://lakesidethreadz.com';
const PHONE_DISPLAY = '(346) 988-5449';
// CAN-SPAM footer requires a valid physical postal address. Shop street is
// NOT public on the site (owner preference); it appears only in email footers.
const ADDRESS_STREET = 'Twin Creeks Dr';
const ADDRESS_LINE   = 'Lakeside Ink & Threadz · Twin Creeks Dr · Livingston, TX 77351';
// Days to wait after the previous touch before the next one goes out.
const TOUCH_GAP_DAYS = [0, 4, 5]; // touch1 immediately, touch2 +4d, touch3 +5d after that

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const authed = (url, env) =>
  env.OUTREACH_KEY && url.searchParams.get('key') === env.OUTREACH_KEY;

// Convert a plain-text email body into a minimal HTML equivalent.
// Purpose: Resend can only inject open-pixel + click-tracking wrappers into
// HTML parts. Sending text-only kills engagement events (no opens/clicks →
// no auto-newsletter enrollment loop). Every send therefore includes both
// a text and an html part with the same content.
function textToHtml(text) {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Linkify http/https URLs. Trailing sentence punctuation (,.;:!?)`") is NOT
  // part of the URL and must sit OUTSIDE the anchor — otherwise the recipient
  // clicks and hits /quote, or /quote. and gets a 404. Trim it off.
  html = html.replace(/(https?:\/\/[^\s<]+)/g, (m) => {
    const trail = m.match(/[.,;:!?)"'\]]+$/);
    if (trail) {
      const url = m.slice(0, -trail[0].length);
      return `<a href="${url}" style="color:#001E78">${url}</a>${trail[0]}`;
    }
    return `<a href="${m}" style="color:#001E78">${m}</a>`;
  });
  // Linkify (346) 988-5449 style phone numbers
  html = html.replace(/\((\d{3})\)\s*(\d{3})-(\d{4})/g,
    '<a href="tel:+1$1$2$3" style="color:#001E78">($1) $2-$3</a>');
  // Paragraph breaks (double-newline) + soft breaks (single-newline)
  html = html.split(/\n\n+/).map(p => `<p style="margin:0 0 1em">${p.replace(/\n/g, '<br>')}</p>`).join('');
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#222;max-width:600px">${html}</div>`;
}

// ---------------------------------------------------------------------------
// Email templates — Kristen's voice (warm, plain-spoken), tightened for cold
// touch #1 (~100 words), category-personalized hook per ICP.
// ---------------------------------------------------------------------------
function pickHook(category) {
  const c = (category || '').toLowerCase();
  // Medical / healthcare
  if (c.includes('doctor') || c.includes('physician') || c.includes('dental') || c.includes('orthodont')
      || c.includes('chiropract') || c.includes('veterinar') || c.includes('medical') || c.includes('optomet')
      || c.includes('physical therapy') || c.includes('urgent care') || c.includes('clinic') || c.includes('nurse')) {
    return "Matching embroidered polos or scrubs make a small office feel intentional — patients notice, staff feels like a team, and it's clear at a glance who works there.";
  }
  // Sports teams / schools / booster clubs
  if (c.includes('sport') || c.includes('team') || c.includes('school') || c.includes('booster')
      || c.includes('coach') || c.includes('athlet') || c.includes('league') || c.includes('gym')
      || c.includes('fitness') || c.includes('crossfit') || c.includes('martial') || c.includes('dance')) {
    return "Matching team shirts, hats, or warmups turn a group of players into a team — and give parents (and the photographer) something clean to focus on at every game.";
  }
  // Church / ministry
  if (c.includes('church') || c.includes('ministry') || c.includes('religious') || c.includes('faith')) {
    return "Matching shirts for VBS, mission trips, or staff make a Sunday feel intentional — kids and volunteers spot each other in a crowd, and you've got something to hand out for years.";
  }
  // Marina / lake / fishing
  if (c.includes('marina') || c.includes('boat') || c.includes('lake') || c.includes('fish') || c.includes('dock')) {
    return "On Lake Livingston, matching PFG shirts or embroidered hats set your team apart from the weekend crowd — customers know immediately who works there.";
  }
  // Trades / construction
  if (c.includes('hvac') || c.includes('heating') || c.includes('air condition') || c.includes('plumb')
      || c.includes('electric') || c.includes('roof') || c.includes('landscap') || c.includes('lawn')
      || c.includes('construct') || c.includes('build') || c.includes('concrete') || c.includes('remodel')
      || c.includes('excavat') || c.includes('pest')) {
    return "When your crew shows up in matching branded gear, customers notice — it's the small thing that quietly says 'this is a real business, not a guy with a truck.'";
  }
  // Restaurants / hospitality
  if (c.includes('restaurant') || c.includes('bar') || c.includes('cafe') || c.includes('coffee')
      || c.includes('food') || c.includes('caterer') || c.includes('event')) {
    return "A branded polo or apron on every server does more brand work than an Instagram post — customers notice, and the staff feels like a team.";
  }
  // Real estate / professional
  if (c.includes('real estate') || c.includes('realtor') || c.includes('property') || c.includes('insurance')
      || c.includes('law') || c.includes('attorney') || c.includes('accountant') || c.includes('cpa')) {
    return "A branded polo at every open house, closing, or client meeting turns your team into a walking advertisement — clients remember the agent who showed up looking sharp.";
  }
  // Fallback — small biz / retail / anything else
  return "Matching branded apparel on your team quietly reinforces your brand every day, on every job — and it's cheaper per piece than you'd think.";
}

function renderTouch(n, p, unsubUrl) {
  // School districts get a dedicated warm-intro sequence — permission for
  // logo/mark use is already in place with each district's comms office, so
  // the touch shows them the landing page + invites intros to boosters/ADs.
  if ((p.category || '').toLowerCase() === 'school-district') {
    return renderSchoolTouch(n, p, unsubUrl);
  }
  const org = p.org || 'your team';
  const first = (p.name || '').split(' ')[0] || 'there';
  const hook = pickHook(p.category);

  const bodies = {
    1: {
      subject: `Quick hello from Lakeside Ink & Threadz`,
      text:
`Hi ${first},

I'm Kristen Coats, owner of Lakeside Ink & Threadz — a small custom embroidery and DTF printing shop right here in Onalaska. We help local businesses, offices, teams, and organizations with custom apparel and branded gifts.

${hook}

If ${org} could use custom polos, hats, work shirts, team apparel, or personalized gifts, I'd love to send a free digital proof of what your logo would look like on a real piece. No minimums, quick turnaround, and every project gets the same attention whether it's one shirt or a hundred.

Reply here with a rough idea and I'll get you a real price — usually same day. Or run a 60-second quote at ${SITE}/quote, or call/text me at ${PHONE_DISPLAY}.

Kristen
Lakeside Ink & Threadz`,
    },
    2: {
      subject: `Re: Quick hello from Lakeside Ink & Threadz`,
      text:
`Hi ${first},

Circling back — I know inboxes get busy. Short version of what we do:

- Custom embroidery, DTF printing, personalized gifts
- No minimums (one piece or 500)
- Free digital proof of your logo before anything gets made
- 5-10 business day turnaround (rush available if you're up against a deadline)

If ${org} is even thinking about branded polos, work shirts, team apparel, event/uniform gear, or a one-off personalized piece — reply here or text ${PHONE_DISPLAY} and I'll walk you through what actually fits.

Instant estimate anytime at ${SITE}/quote.

Kristen`,
    },
    3: {
      subject: `Last note from Kristen at Lakeside`,
      text:
`Hi ${first},

Last one from me — no hard feelings if this isn't the right time. Whenever ${org} does need custom apparel, embroidered gifts, or a small uniform program, we're right here in Onalaska and happy to help.

${SITE}/quote for an instant price, or text me at ${PHONE_DISPLAY}.

Kristen
Lakeside Ink & Threadz`,
    },
  };
  const b = bodies[n];
  // Text footer keeps the raw URL (plaintext clients need it visible).
  // HTML footer renders "Unsubscribe" as a friendly anchor.
  const footerText = `

—
${ADDRESS_LINE}
Don't want these? Unsubscribe: ${unsubUrl}`;
  const text = b.text + footerText;
  let html = textToHtml(text);
  // Replace the linkified full URL in the footer with a friendly "Unsubscribe" link.
  html = html.replace(
    /Don(&#39;|')t want these\? Unsubscribe: <a[^>]+>[^<]+<\/a>/,
    `<a href="${unsubUrl}" style="color:#7a7a7a;text-decoration:underline">Unsubscribe from these emails</a>`,
  );
  return { subject: b.subject, text, html };
}

// ---------------------------------------------------------------------------
// School-district specific touch sequence
// ---------------------------------------------------------------------------
// Sent to superintendents, comms directors, ADs, band directors, principals
// at districts where Kristen has already confirmed logo-use permission with
// the comms office. Tone is warm-intro (not cold pitch) and points to the
// school's dedicated /schools/<slug>/ landing page.
//
// Required prospect fields for schools:
//   category: 'school-district'
//   landing_page: '/schools/<slug>/' (rendered as https://SITE + landing_page)
//   org: full district name (e.g., 'Livingston ISD')
//   mascot: singular mascot noun ('lion', 'hornet', ...) — used in copy
//   mascot_plural: display name ('Lions', 'Hornets', ...)
function renderSchoolTouch(n, p, unsubUrl) {
  const first = (p.name || '').split(' ')[0] || 'there';
  const org = p.org || 'your district';
  const mascotPlural = p.mascot_plural || 'team';
  const landingUrl = p.landing_page ? `${SITE}${p.landing_page}` : `${SITE}/schools/`;

  const bodies = {
    1: {
      subject: `${mascotPlural} spirit-wear preview — Lakeside Ink & Threadz`,
      text:
`Hi ${first},

Kristen Coats here at Lakeside Ink & Threadz in Livingston. Following up on the ${org} logo-use conversation — I put together a page you can look at any time to see what ${mascotPlural} gear looks like on real product:

${landingUrl}

Trucker hats, tees, hoodies, polos, dad hats, beanies — all shown embroidered with the ${org} mark you approved. Nothing is ordered from that page; it's a visual so you can see the range before any decisions.

If you know the athletic booster club, band boosters, PTA, or the AD/band director would like a quote for a spirit-wear run this season, I'd love an intro (or feel free to forward this along). I write every quote by hand, usually same day, no minimums.

Kristen
Lakeside Ink & Threadz`,
    },
    2: {
      subject: `Re: ${mascotPlural} spirit-wear preview`,
      text:
`Hi ${first},

Circling back on the ${mascotPlural} preview page: ${landingUrl}

Short version — if any of these come up this year, we're set up to help:
- Coach/staff polos with the ${org} mark
- Booster-club fundraiser stores (trucker hats + tees are the fast movers)
- Band, FFA, Project Grad, or spirit-week merch
- One-off staff gifts (embroidered beanies, cuffed pullovers)

Reply here or text ${PHONE_DISPLAY} — happy to send a mockup for anything specific, no obligation.

Kristen
Lakeside Ink & Threadz`,
    },
    3: {
      subject: `Last note — ${mascotPlural} gear whenever you're ready`,
      text:
`Hi ${first},

Last one from me — no hard feelings if there's no fit right now. The ${mascotPlural} preview page stays live at ${landingUrl} anytime a booster or coach asks about spirit-wear.

Whenever ${org} does need custom gear, we're right here in Livingston. Text ${PHONE_DISPLAY} or ${SITE}/quote — real quote by hand, usually same day.

Kristen
Lakeside Ink & Threadz`,
    },
  };
  const b = bodies[n] || bodies[1];
  const footerText = `

—
${ADDRESS_LINE}
Don't want these? Unsubscribe: ${unsubUrl}`;
  const text = b.text + footerText;
  let html = textToHtml(text);
  html = html.replace(
    /Don(&#39;|')t want these\? Unsubscribe: <a[^>]+>[^<]+<\/a>/,
    `<a href="${unsubUrl}" style="color:#7a7a7a;text-decoration:underline">Unsubscribe from these emails</a>`,
  );
  return { subject: b.subject, text, html };
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------
// Cloudflare Workers caps subrequests per invocation (50 on free, 1000 on paid).
// Since dashboard + cron both listProspects, we cap concurrent reads and expose
// a `maxReads` guard. Set to Infinity for cron (which can afford to burn more
// budget), lower for dashboard rendering.
async function listProspects(env, opts = {}) {
  const maxReads = opts.maxReads ?? 20; // dashboard shares budget with several
                                        // other prefix listings — 20 is safe.
  const out = [];
  let cursor;
  let totalKeys = 0;
  let capped = false;
  outer: do {
    const res = await env.STATUS.list({ prefix: 'outreach:prospect:', cursor });
    totalKeys += res.keys.length;
    // Batch-read this page's values in parallel with a hard cap.
    const budgetLeft = maxReads - out.length;
    if (budgetLeft <= 0) { capped = true; break outer; }
    const slice = res.keys.slice(0, budgetLeft);
    const values = await Promise.all(slice.map(k => env.STATUS.get(k.name, 'json')));
    for (let i = 0; i < slice.length; i++) {
      if (values[i]) out.push({ _key: slice[i].name, ...values[i] });
    }
    if (res.keys.length > budgetLeft) { capped = true; break outer; }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  out._totalKeys = totalKeys;
  out._capped = capped;
  return out;
}

const suppressed = (env, email) => env.STATUS.get('outreach:suppress:' + email.toLowerCase());

// ---------------------------------------------------------------------------
// The nightly sender — invoked from worker.js scheduled().
// ---------------------------------------------------------------------------
export async function runOutreach(env) {
  if (!env.RESEND_API_KEY || env.RESEND_API_KEY.startsWith('REPLACE')) {
    return { ok: false, error: 'RESEND_API_KEY not configured' };
  }
  const cap = parseInt(env.DAILY_CAP || '10', 10);
  const today = new Date().toISOString().slice(0, 10);
  const log = (await env.STATUS.get('outreach:log:' + today, 'json')) || { sent: 0 };
  if (log.sent >= cap) return { ok: true, sent: 0, note: 'daily cap reached' };

  // Cron gets a higher read budget than dashboard — we need to iterate all
  // prospects to find sendable ones. Paid Workers allow 1000 subrequests; free
  // caps at 50 (in which case only the first ~45 prospects ever get contacted
  // on this run — cron re-runs daily so we still make progress, just slowly).
  const prospects = await listProspects(env, { maxReads: 200 });
  const now = Date.now();
  let sent = 0;
  const results = [];

  for (const p of prospects) {
    if (log.sent + sent >= cap) break;
    if (p.status !== 'active') continue;
    if (!p.email || !p.email.includes('@')) continue;
    if (await suppressed(env, p.email)) continue;

    const touches = p.touches || [];
    const nextN = touches.length + 1;
    if (nextN > 3) continue;
    const gapMs = TOUCH_GAP_DAYS[nextN - 1] * 86400 * 1000;
    const lastTs = touches.length ? touches[touches.length - 1].ts : p.added || 0;
    if (touches.length && now - lastTs < gapMs) continue;

    const unsubUrl = `${SITE}/api/outreach/unsub?e=${btoa(p.email.toLowerCase())}`;
    const msg = renderTouch(nextN, p, unsubUrl);

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [p.email],
        reply_to: env.OUTREACH_REPLY_TO || undefined,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,     // required for Resend open/click tracking
        headers: {
          // Two URIs: mailto (Apple Mail's native unsub pill requires this)
          // + https one-click (Gmail/Outlook use this once reputation lands).
          'List-Unsubscribe': `<mailto:hello@lakesidethreadz.com?subject=unsubscribe>, <${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    });

    if (r.ok) {
      touches.push({ n: nextN, ts: now });
      const status = nextN >= 3 ? 'done' : 'active';
      const { _key, ...rest } = p;
      await env.STATUS.put(_key, JSON.stringify({ ...rest, touches, status }));
      sent++;
      results.push({ email: p.email, touch: nextN });
    } else {
      const err = await r.text().catch(() => '');
      results.push({ email: p.email, error: err.slice(0, 120) });
      if (r.status === 422 || r.status === 400) {
        // hard reject — suppress so we never retry a bad address
        await env.STATUS.put('outreach:suppress:' + p.email.toLowerCase(), 'bounce');
      }
    }
  }

  await env.STATUS.put('outreach:log:' + today, JSON.stringify({ sent: log.sent + sent }));
  return { ok: true, sent, results };
}

// ---------------------------------------------------------------------------
// HTTP handlers (wired in worker.js)
// ---------------------------------------------------------------------------

// POST /api/outreach/prospects?key=…  body: {prospects:[{email,name,org,category,city}]}
export async function prospectsPost({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.prospects)) return json({ error: 'prospects[] required' }, 400);
  let added = 0, skipped = 0;
  for (const p of body.prospects) {
    if (!p.email || !p.email.includes('@')) { skipped++; continue; }
    const id = p.email.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const key = 'outreach:prospect:' + id;
    if (await env.STATUS.get(key)) { skipped++; continue; } // no dupes
    await env.STATUS.put(key, JSON.stringify({
      email: p.email.trim(), name: p.name || '', org: p.org || '', category: p.category || '',
      city: p.city || '', lane: p.lane || '', sub_type: p.sub_type || '', source_url: p.source_url || '',
      // Schools lane extras: which /schools/<slug>/ page to link + mascot noun for copy.
      landing_page: p.landing_page || '', mascot: p.mascot || '', mascot_plural: p.mascot_plural || '',
      status: 'active', touches: [], added: Date.now(),
    }));
    added++;
  }
  return json({ ok: true, added, skipped });
}

// GET /api/outreach/stats?key=…
export async function statsGet({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  try {
  const prospects = await listProspects(env);
  const by = (f) => prospects.reduce((a, p) => ((a[f(p)] = (a[f(p)] || 0) + 1), a), {});
  const today = new Date().toISOString().slice(0, 10);
  const log = (await env.STATUS.get('outreach:log:' + today, 'json')) || { sent: 0 };
  return json({
    total: prospects._totalKeys || prospects.length,
    shown: prospects.length,
    capped: !!prospects._capped,
    by_status: by((p) => p.status),
    by_touches: by((p) => (p.touches || []).length),
    sent_today: log.sent,
  });
  } catch (e) {
    return json({ error: 'stats threw', message: String(e && (e.message || e)).slice(0, 500), stack: String(e && e.stack || '').slice(0, 1500) }, 500);
  }
}

// GET /api/outreach/run?key=…  (manual trigger, same as cron)
export async function runGet({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  return json(await runOutreach(env));
}

// GET /api/outreach/unsub?e=<b64 email>  (public — one-click, no confirmation step)
export async function unsubGet({ request, env }) {
  const url = new URL(request.url);
  let email = '';
  try { email = atob(url.searchParams.get('e') || '').toLowerCase(); } catch (e) { /* fall through */ }
  if (email && email.includes('@')) {
    await env.STATUS.put('outreach:suppress:' + email, 'unsub');
    await env.STATUS.delete('newsletter:sub:' + email);
    const id = email.replace(/[^a-z0-9]/g, '-');
    const key = 'outreach:prospect:' + id;
    const p = await env.STATUS.get(key, 'json');
    if (p) await env.STATUS.put(key, JSON.stringify({ ...p, status: 'unsubscribed' }));
  }
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title><body style="font-family:sans-serif;background:#001E78;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center;padding:2rem"><h1 style="color:#F09600">You're unsubscribed.</h1><p>No more emails from Lakeside Ink &amp; Threadz.</p><p style="opacity:.7;font-size:.9rem;margin-top:2rem">If this was a mistake, email hello@lakesidethreadz.com and we'll fix it.</p></div>`,
    { headers: { 'Content-Type': 'text/html' } },
  );
}

// POST /api/outreach/webhook?key=…  (Resend events webhook)
// bounces/complaints -> suppress; opens/clicks -> mark engaged + auto-subscribe
// to the seasonal newsletter (newsletter:sub:<email>).
export async function webhookPost({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  const evt = await request.json().catch(() => null);
  const type = evt && evt.type;
  const email = ((evt && evt.data && evt.data.to && evt.data.to[0]) || '').toLowerCase();
  if (!email) return json({ ok: true });

  if (type === 'email.bounced' || type === 'email.complained') {
    await env.STATUS.put('outreach:suppress:' + email,
      type === 'email.bounced' ? 'bounce' : 'complaint');
    await env.STATUS.delete('newsletter:sub:' + email);
  }

  if (type === 'email.opened' || type === 'email.clicked') {
    if (!(await suppressed(env, email))) {
      const signal = type === 'email.clicked' ? 'click' : 'open';
      const id = email.replace(/[^a-z0-9]/g, '-');
      const pKey = 'outreach:prospect:' + id;
      const p = await env.STATUS.get(pKey, 'json');
      if (p && !p.engaged) await env.STATUS.put(pKey, JSON.stringify({ ...p, engaged: signal, engagedAt: Date.now() }));
      const sKey = 'newsletter:sub:' + email;
      const existing = await env.STATUS.get(sKey, 'json');
      if (!existing || (existing.source === 'open' && signal === 'click')) {
        await env.STATUS.put(sKey, JSON.stringify({ added: Date.now(), source: signal, name: (p && p.name) || '', org: (p && p.org) || '' }));
      }
    }
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Monthly seasonal newsletter — auto-sent to engaged prospects.
// Content is set per-month via contentPost (newsletter:content:<YYYY-MM>);
// if no issue was drafted, a seasonal-fallback template is used based on month.
// ---------------------------------------------------------------------------
function fallbackIssue(monthYYYYMM) {
  // Month 1-12; picks a seasonal focus with an evergreen tail so we're never
  // sending a totally-generic email even if the current issue wasn't drafted.
  const month = parseInt(monthYYYYMM.split('-')[1], 10);
  const seasons = {
    1: { subj: 'Uniform refresh for the new year?', body:
`January is when the smart operators quietly redo their team's look for the year:

• Refresh embroidered polos, work shirts, or hats before the busy season
• Add new hires to the standard uniform program
• Restock branded totes for events, trade shows, and giveaways

Reply or run a quick estimate at ${SITE}/quote — takes under a minute.` },
    2: { subj: 'Spring tournament + event apparel', body:
`Bass and crappie tournament season is warming up on Lake Livingston, and spring event calendars fill up fast. Now's the time to order:

• Tournament team kits with sponsor patches
• Spring festival, farmers market, and outdoor event tees
• Fresh business polos for the busy season

Quick quote: ${SITE}/quote` },
    3: { subj: 'Spring uniform + team apparel', body:
`Spring is when service crews swap out worn winter gear. If you're ordering fresh polos, hats, or work shirts, get in front of the rush:

• Restock existing uniform programs
• Add rain jackets and lightweight polos for warmer weather
• Team logos on new employees' first-day kits

${SITE}/quote — 60 seconds for a real number.` },
    4: { subj: 'Wedding + graduation season is here', body:
`April kicks off wedding and graduation season. We've got you covered:

• Bridal-party robes and monogrammed totes
• Groomsmen polos and custom Koozies
• Class shirts, senior-week tees, and grad-party gifts

${SITE}/quote for a fast estimate.` },
    5: { subj: 'VBS + summer camp shirts', body:
`Vacation Bible School and summer camps kick off in June and July — May is the right month to lock in your shirt order:

• VBS shirts for kids + volunteers
• Camp counselor polos and staff hats
• Ministry team gear for mission trips

Order 3 weeks before your event for a stress-free timeline. Rush available at +25%.

${SITE}/quote` },
    6: { subj: 'Summer tournament + lake apparel', body:
`Fishing tournaments, lake festivals, and summer events are in full swing. We're shipping:

• Tournament team kits (Columbia PFG, Huk, AFTCO) with sponsor patches
• Lake business branded apparel (marinas, guides, dock builders)
• Summer event polos and tees

${SITE}/quote for a fast estimate.` },
    7: { subj: 'Back-to-school + fall sports prep', body:
`It's not too early to think about fall:

• Back-to-school team shirts and coach polos
• Fall sports uniforms (order 4 weeks before season)
• Business uniform refresh before Q4

Get ahead of the fall rush: ${SITE}/quote` },
    8: { subj: 'Fall sports uniforms — last call', body:
`Fall football, volleyball, and cross-country seasons start in a few weeks. If you're a team or coach still needing:

• Custom team uniforms with player numbers ($3/pc)
• Coach polos and staff hats
• Booster club fan gear

Order this week to guarantee delivery before Week 1. ${SITE}/quote` },
    9: { subj: 'Company holiday gifts (yes, already)', body:
`September is when smart businesses start their holiday gifting order — good vendors book up by mid-November:

• Client thank-you gifts (monogrammed totes, custom Koozies)
• Employee holiday gift bundles (embroidered jackets, gift-boxed apparel)
• Custom promo items for holiday parties

${SITE}/quote — early birds get their pick of blank styles.` },
    10: { subj: 'Holiday embroidery + branded gifts', body:
`October = last comfortable window for holiday orders. Coming up:

• Custom company Christmas gifts for staff and clients
• Church holiday event apparel (Christmas, Advent, Living Nativity)
• Winter uniform additions — jackets, beanies, long-sleeve tees

${SITE}/quote before the rush.` },
    11: { subj: 'Deadline: December orders', body:
`If you need embroidered or DTF-printed apparel in your hands before Christmas, the order needs to be in by early December. Slots go fast this month:

• Company gifts for the holiday party
• Church volunteer appreciation
• Family-branded holiday shirts

Text ${PHONE_DISPLAY} or fire up ${SITE}/quote to lock in a slot.` },
    12: { subj: 'Ordering for the new year?', body:
`January is uniform-refresh season. Getting your quote in the last week of December means production starts on day one and you have your team looking sharp before the busy season.

• Full uniform program setups (one-time $45 digitizing, then one-text reorders)
• New employee gear kits
• Fresh branded merch for Q1 events

${SITE}/quote` },
  }[month] || seasons[1];
  return { subject: seasons.subj, text: seasons.body + `\n\nOr call/text ${PHONE_DISPLAY} — I usually pick up.\n\nKristen\nLakeside Ink & Threadz` };
}

export async function runNewsletter(env) {
  if (!env.RESEND_API_KEY || env.RESEND_API_KEY.startsWith('REPLACE')) {
    return { ok: false, error: 'RESEND_API_KEY not configured' };
  }
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  if (await env.STATUS.get('newsletter:sent:' + month)) {
    return { ok: true, sent: 0, note: 'already sent this month' };
  }
  const issue = (await env.STATUS.get('newsletter:content:' + month, 'json')) || fallbackIssue(month);

  const subs = [];
  let cursor;
  do {
    const res = await env.STATUS.list({ prefix: 'newsletter:sub:', cursor });
    for (const k of res.keys) subs.push(k.name.slice('newsletter:sub:'.length));
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  let sent = 0, skipped = 0;
  for (const email of subs) {
    if (await suppressed(env, email)) { skipped++; continue; }
    const unsubUrl = `${SITE}/api/outreach/unsub?e=${btoa(email)}`;
    const bodyText = `${issue.text}

—
${ADDRESS_LINE}
Unsubscribe: ${unsubUrl}`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        reply_to: env.OUTREACH_REPLY_TO || undefined,
        subject: issue.subject,
        text: bodyText,
        html: textToHtml(bodyText),
        headers: {
          // Two URIs: mailto (Apple Mail's native unsub pill requires this)
          // + https one-click (Gmail/Outlook use this once reputation lands).
          'List-Unsubscribe': `<mailto:hello@lakesidethreadz.com?subject=unsubscribe>, <${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    });
    if (r.ok) sent++;
  }
  await env.STATUS.put('newsletter:sent:' + month, JSON.stringify({ sent, skipped, ts: Date.now() }));
  return { ok: true, sent, skipped, subscribers: subs.length };
}

// POST /api/newsletter/content?key=…  body: {subject, text, month?} (month defaults to current)
export async function newsletterContentPost({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  const b = await request.json().catch(() => null);
  if (!b || !b.subject || !b.text) return json({ error: 'subject + text required' }, 400);
  const month = b.month || new Date().toISOString().slice(0, 7);
  await env.STATUS.put('newsletter:content:' + month, JSON.stringify({ subject: b.subject, text: b.text }));
  return json({ ok: true, month });
}

// GET /api/newsletter/stats?key=…
export async function newsletterStatsGet({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  const subs = [];
  let cursor;
  do {
    const res = await env.STATUS.list({ prefix: 'newsletter:sub:', cursor });
    for (const k of res.keys) subs.push(k.name.slice('newsletter:sub:'.length));
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  const month = new Date().toISOString().slice(0, 7);
  return json({
    subscribers: subs.length,
    list: subs,
    sent_this_month: await env.STATUS.get('newsletter:sent:' + month, 'json'),
    content_ready: !!(await env.STATUS.get('newsletter:content:' + month)),
  });
}

// GET /api/newsletter/run?key=…  (manual trigger)
export async function newsletterRunGet({ request, env }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  return json(await runNewsletter(env));
}

// ---------------------------------------------------------------------------
// Client-shareable dashboard — READ-ONLY view of outreach progress.
// Gated by DASHBOARD_KEY (separate from OUTREACH_KEY) so Aaron can safely
// share the dashboard URL with the client without exposing write access.
// URL: /dashboard?key=<DASHBOARD_KEY>
// ---------------------------------------------------------------------------
const dashAuthed = (url, env) =>
  env.DASHBOARD_KEY && url.searchParams.get('key') === env.DASHBOARD_KEY;

export async function dashboardGet({ request, env }) {
  try {
    return await dashboardGetInner({ request, env });
  } catch (e) {
    const msg = (e && (e.stack || e.message)) || String(e);
    return new Response(
      `<pre style="font:12px/1.4 monospace;padding:20px;color:#7f1d1d;background:#fee2e2">dashboard error:\n${msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').slice(0,2000)}</pre>`,
      { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

async function dashboardGetInner({ request, env }) {
  const url = new URL(request.url);
  // Accept either DASHBOARD_KEY or OUTREACH_KEY (owner + operator both have access)
  if (!dashAuthed(url, env) && !authed(url, env)) {
    return new Response(RENDER_LOGIN_HTML, {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  if (!env.STATUS) {
    return new Response('<pre>KV binding STATUS not configured.</pre>', {
      status: 500, headers: { 'Content-Type': 'text/html' },
    });
  }

  // Compute all the numbers from KV. Capped read to stay under CF subrequest
  // limit. Prospect counts stay accurate (from _totalKeys), only the
  // per-prospect detail (categories, touch buckets) is truncated when capped.
  const prospects = await listProspects(env);
  const today = new Date().toISOString().slice(0, 10);

  const totalProspects = prospects._totalKeys || prospects.length;
  const prospectsShown = prospects.length;
  const prospectsCapped = !!prospects._capped;
  const byStatus = prospects.reduce((a, p) => { a[p.status || 'unknown'] = (a[p.status || 'unknown'] || 0) + 1; return a; }, {});
  const byTouches = prospects.reduce((a, p) => { const n = (p.touches || []).length; a[n] = (a[n] || 0) + 1; return a; }, {});
  const byCategory = prospects.reduce((a, p) => { const c = (p.category || 'uncategorized').slice(0, 30); a[c] = (a[c] || 0) + 1; return a; }, {});
  const byLane     = prospects.reduce((a, p) => { const l = (p.lane || '?').toUpperCase(); a[l] = (a[l] || 0) + 1; return a; }, {});
  const byCity     = prospects.reduce((a, p) => { const c = (p.city || 'unknown').slice(0, 30); a[c] = (a[c] || 0) + 1; return a; }, {});
  const engagedCount = prospects.filter(p => p.engaged).length;

  // Send activity — sum the daily logs. Only read the most recent 30 days
  // worth of keys to stay under the CF subrequest limit (dashboard makes
  // many other KV calls in the same invocation).
  const dailyLogs = {};
  {
    const logRes = await env.STATUS.list({ prefix: 'outreach:log:' });
    const keys = logRes.keys
      .map(k => k.name)
      .sort()
      .slice(-30);
    const values = await Promise.all(keys.map(k => env.STATUS.get(k, 'json')));
    for (let i = 0; i < keys.length; i++) {
      const day = keys[i].slice('outreach:log:'.length);
      const v = values[i];
      if (v) dailyLogs[day] = v.sent || 0;
    }
  }
  const sortedDays = Object.keys(dailyLogs).sort();
  const last30 = sortedDays.slice(-30);
  const sentToday = dailyLogs[today] || 0;
  const sentThisWeek = (() => {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setUTCDate(now.getUTCDate() - now.getUTCDay());
    const startISO = startOfWeek.toISOString().slice(0, 10);
    return sortedDays.filter(d => d >= startISO).reduce((s, d) => s + dailyLogs[d], 0);
  })();
  const sentThisMonth = (() => {
    const month = today.slice(0, 7);
    return sortedDays.filter(d => d.startsWith(month)).reduce((s, d) => s + dailyLogs[d], 0);
  })();
  const sentAllTime = sortedDays.reduce((s, d) => s + dailyLogs[d], 0);

  // Newsletter subs
  const newsletterSubs = [];
  {
    let cursor;
    do {
      const res = await env.STATUS.list({ prefix: 'newsletter:sub:', cursor });
      for (const k of res.keys) newsletterSubs.push(k.name.slice('newsletter:sub:'.length));
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  }
  const monthKey = today.slice(0, 7);
  const newsletterSent = await env.STATUS.get('newsletter:sent:' + monthKey, 'json');
  const newsletterReady = !!(await env.STATUS.get('newsletter:content:' + monthKey));

  // Recent activity — last N sends. Derive from prospect.touches[] timestamps.
  const recent = [];
  for (const p of prospects) {
    for (const t of (p.touches || [])) {
      recent.push({ email: p.email, org: p.org || '(no org)', touch: t.n, ts: t.ts, engaged: p.engaged, status: p.status });
    }
  }
  recent.sort((a, b) => b.ts - a.ts);
  const recentTop = recent.slice(0, 20);

  // Suppressions
  let suppressCount = 0;
  {
    let cursor;
    do {
      const res = await env.STATUS.list({ prefix: 'outreach:suppress:', cursor });
      suppressCount += res.keys.length;
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  }

  // Form submissions (contact / quote / rich-quote). Keys are timestamped so
  // sorting by key name (desc) gives newest first — we only fetch the top 10
  // full records to keep subrequest count down.
  const submissions = [];
  let submissionsTotal = 0;
  {
    const res = await env.STATUS.list({ prefix: 'submissions:' });
    submissionsTotal = res.keys.length;
    const newest = res.keys.map(k => k.name).sort().reverse().slice(0, 10);
    const values = await Promise.all(newest.map(k => env.STATUS.get(k, 'json')));
    for (const v of values) if (v) submissions.push(v);
  }
  submissions.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const submissionsRecent = submissions;
  const submissions7d = submissions.filter(s => s.ts > Date.now() - 7 * 86400 * 1000).length;

  // Blog posts — parse from sitemap.xml (auto-updated by enhance.py).
  const blogPosts = [];
  try {
    const smRes = await env.ASSETS.fetch(new Request('https://lakesidethreadz.com/sitemap.xml'));
    if (smRes.ok) {
      const smText = await smRes.text();
      // Simple regex parse — <url><loc>...</loc><lastmod>...</lastmod></url>.
      const urlRe = /<url>([\s\S]*?)<\/url>/g;
      let m;
      while ((m = urlRe.exec(smText)) !== null) {
        const loc = /<loc>([^<]+)<\/loc>/.exec(m[1])?.[1] || '';
        const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(m[1])?.[1] || '';
        if (loc.includes('/blog/') && !loc.match(/\/blog\/(?:[^\/]+\/)?$/)) {
          // Skip /blog/ listing + /blog/<category>/ listing; keep only posts.
          blogPosts.push({ url: loc, lastmod });
        }
      }
    }
  } catch (e) { /* sitemap unreachable — leave empty */ }
  blogPosts.sort((a, b) => b.lastmod.localeCompare(a.lastmod));

  const stats = {
    totalProspects, byStatus, byTouches, byCategory, byLane, byCity, engagedCount,
    sentToday, sentThisWeek, sentThisMonth, sentAllTime,
    last30, dailyLogs, dailyCap: parseInt(env.DAILY_CAP || '10', 10),
    newsletterSubs: newsletterSubs.length, newsletterSentThisMonth: newsletterSent,
    newsletterReady, monthKey,
    recent: recentTop, suppressCount,
    submissionsTotal, submissions7d, submissionsRecent,
    blogPosts,
  };
  return new Response(renderDashboard(stats), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ---------- Rendering helpers (inline HTML/CSS — self-contained page) ------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtTs(ts) {
  const d = new Date(ts);
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
function bar(v, max, color) {
  const pct = max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0;
  return `<div style="background:${color};height:10px;width:${pct}%;border-radius:3px;min-width:2px"></div>`;
}
function tile(label, value, sub = '') {
  return `<div style="background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 8px rgba(0,15,90,0.06);border:1px solid #eef">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#001E78;opacity:.7;font-weight:600;margin-bottom:6px">${esc(label)}</div>
    <div style="font-size:36px;line-height:1;color:#001E78;font-weight:700">${esc(value)}</div>
    ${sub ? `<div style="font-size:12px;color:#666;margin-top:6px">${esc(sub)}</div>` : ''}
  </div>`;
}
function renderDashboard(s) {
  const asOf = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const statusBars = Object.entries(s.byStatus).map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0">${esc(k)}</td><td style="padding:6px 0;font-weight:600;text-align:right;width:60px">${v}</td><td style="padding:6px 0 6px 12px;width:180px">${bar(v, s.totalProspects, '#001E78')}</td></tr>`
  ).join('');
  const touchBars = [0, 1, 2, 3].map(n => {
    const v = s.byTouches[n] || 0;
    const label = n === 0 ? 'Not yet touched' : `Touched ${n}×`;
    return `<tr><td style="padding:6px 12px 6px 0">${label}</td><td style="padding:6px 0;font-weight:600;text-align:right;width:60px">${v}</td><td style="padding:6px 0 6px 12px;width:180px">${bar(v, s.totalProspects, '#F09600')}</td></tr>`;
  }).join('');
  const catRows = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0">${esc(k || '(none)')}</td><td style="padding:6px 0;font-weight:600;text-align:right;width:60px">${v}</td><td style="padding:6px 0 6px 12px;width:180px">${bar(v, Math.max(...Object.values(s.byCategory)), '#E10078')}</td></tr>`
  ).join('');
  const LANE_LABEL = { A: 'Chambers', B: 'Medical/dental', C: 'Sports/schools', D: 'Marinas + direct-B2B', E: 'Churches', F: 'Guides + outfitters', G: 'RV parks + campgrounds', '?': 'Unlabeled' };
  const laneMax = Math.max(1, ...Object.values(s.byLane || {}));
  const laneRows = Object.entries(s.byLane || {}).sort((a, b) => (a[0] === '?' ? 1 : b[0] === '?' ? -1 : a[0].localeCompare(b[0]))).map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0"><b style="color:#001E78">${esc(k)}</b> &nbsp;<span style="color:#666">${esc(LANE_LABEL[k] || '')}</span></td><td style="padding:6px 0;font-weight:600;text-align:right;width:60px">${v}</td><td style="padding:6px 0 6px 12px;width:180px">${bar(v, laneMax, '#001E78')}</td></tr>`
  ).join('');
  const cityMax = Math.max(1, ...Object.values(s.byCity || {}));
  const cityRows = Object.entries(s.byCity || {}).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0">${esc(k || '(none)')}</td><td style="padding:6px 0;font-weight:600;text-align:right;width:60px">${v}</td><td style="padding:6px 0 6px 12px;width:180px">${bar(v, cityMax, '#15803D')}</td></tr>`
  ).join('');
  const maxSend = Math.max(1, ...s.last30.map(d => s.dailyLogs[d] || 0));
  const send30 = s.last30.map(d => {
    const v = s.dailyLogs[d] || 0;
    const pct = Math.round((v / maxSend) * 100);
    return `<div title="${d}: ${v} sends" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:70px"><div style="background:#001E78;height:${pct}%;min-height:${v>0?2:0}px;border-radius:2px"></div></div>`;
  }).join('');
  const recentRows = s.recent.length ? s.recent.map(r =>
    `<tr>
      <td style="padding:8px 12px 8px 0;color:#666;white-space:nowrap;font-family:monospace;font-size:12px">${esc(fmtTs(r.ts))}</td>
      <td style="padding:8px 12px 8px 0"><div style="font-weight:600;color:#001E78">${esc(r.org)}</div><div style="font-size:12px;color:#666">${esc(r.email)}</div></td>
      <td style="padding:8px 12px 8px 0;text-align:center;font-weight:600">Touch ${r.touch}</td>
      <td style="padding:8px 0">${r.engaged ? `<span style="background:#dcfce7;color:#14532d;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600">${esc(r.engaged)}</span>` : ''}</td>
    </tr>`
  ).join('') : `<tr><td colspan="4" style="padding:16px;text-align:center;color:#888;font-style:italic">No sends yet — waiting for the first cron run or prospect upload.</td></tr>`;

  return `<!doctype html><html lang="en"><head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <meta http-equiv="refresh" content="60">
    <title>Outreach Dashboard · Lakeside Ink &amp; Threadz</title>
    <style>
      *{box-sizing:border-box}
      body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F8F9FE;color:#222;line-height:1.5}
      .wrap{max-width:1200px;margin:0 auto;padding:32px 24px}
      h1{font-size:28px;margin:0 0 4px;color:#001E78}
      .sub{color:#666;font-size:14px;margin-bottom:32px}
      .grid{display:grid;gap:16px;margin-bottom:32px}
      .tiles-4{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
      .cols-2{grid-template-columns:1fr 1fr}
      @media (max-width:800px){.cols-2{grid-template-columns:1fr}}
      .card{background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 8px rgba(0,15,90,0.06);border:1px solid #eef}
      .card h2{margin:0 0 16px;font-size:16px;color:#001E78;text-transform:uppercase;letter-spacing:.05em}
      table{width:100%;border-collapse:collapse;font-size:14px}
      table th{text-align:left;padding:8px 12px 8px 0;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#888;border-bottom:1px solid #eef;font-weight:600}
      .send30{display:flex;gap:3px;align-items:flex-end;padding:8px 0}
    </style>
  </head><body>
    <div class="wrap">
      <h1>Outreach Dashboard</h1>
      <p class="sub">Lakeside Ink &amp; Threadz · B2B cold-email + monthly newsletter · <strong>as of ${esc(asOf)}</strong> · auto-refreshes every 60s</p>

      <div class="grid tiles-4">
        ${tile('Total prospects', s.totalProspects, `${s.byStatus.active || 0} active · ${s.byStatus.done || 0} completed · ${s.byStatus.unsubscribed || 0} unsub`)}
        ${tile('Sent today', s.sentToday, `Daily cap ${s.dailyCap}`)}
        ${tile('This week', s.sentThisWeek, 'Since Sunday')}
        ${tile('This month', s.sentThisMonth, esc(s.monthKey))}
        ${tile('All-time sends', s.sentAllTime, 'Every email since launch')}
        ${tile('Engaged prospects', s.engagedCount, 'Opened or clicked at least once')}
        ${tile('Newsletter subs', s.newsletterSubs, s.newsletterReady ? `${s.monthKey} draft ready` : `${s.monthKey} fallback will send`)}
        ${tile('Suppressed', s.suppressCount, 'Bounces + complaints + unsub — never re-sent')}
      </div>

      <div class="grid cols-2">
        <div class="card">
          <h2>Prospect status</h2>
          <table><tbody>${statusBars || '<tr><td colspan="3" style="padding:16px;text-align:center;color:#888">No prospects yet.</td></tr>'}</tbody></table>
        </div>
        <div class="card">
          <h2>Touch progression</h2>
          <table><tbody>${touchBars}</tbody></table>
        </div>
      </div>

      <div class="grid cols-2">
        <div class="card">
          <h2>By discovery lane</h2>
          <table><tbody>${laneRows || '<tr><td colspan="3" style="padding:16px;text-align:center;color:#888">No prospects yet.</td></tr>'}</tbody></table>
        </div>
        <div class="card">
          <h2>By city</h2>
          <table><tbody>${cityRows || '<tr><td colspan="3" style="padding:16px;text-align:center;color:#888">No prospects yet.</td></tr>'}</tbody></table>
        </div>
      </div>

      <div class="grid cols-2">
        <div class="card">
          <h2>Top categories</h2>
          <table><tbody>${catRows || '<tr><td colspan="3" style="padding:16px;text-align:center;color:#888">No prospects yet.</td></tr>'}</tbody></table>
        </div>
        <div class="card">
          <h2>Last 30 days of sends</h2>
          <div class="send30">${send30 || '<div style="color:#888;padding:16px">No sends yet.</div>'}</div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#888;margin-top:4px"><span>${s.last30[0] || ''}</span><span>${s.last30[s.last30.length - 1] || ''}</span></div>
        </div>
      </div>

      <div class="card">
        <h2>Recent activity</h2>
        <table>
          <thead><tr><th>When</th><th>Prospect</th><th style="text-align:center">Touch</th><th>Engagement</th></tr></thead>
          <tbody>${recentRows}</tbody>
        </table>
      </div>

      <div class="grid2">
        <div class="card">
          <h2>Form submissions</h2>
          <div style="display:flex;gap:12px;margin-bottom:16px">
            ${tile('Total', s.submissionsTotal || 0, 'all time')}
            ${tile('Last 7d', s.submissions7d || 0, 'contact + quote')}
          </div>
          <table>
            <thead><tr><th>When</th><th>Kind</th><th>From</th><th>Detail</th></tr></thead>
            <tbody>${submissionRows(s.submissionsRecent || [])}</tbody>
          </table>
        </div>
        <div class="card">
          <h2>Blog posts</h2>
          <div style="display:flex;gap:12px;margin-bottom:16px">
            ${tile('Published', (s.blogPosts || []).length, 'in sitemap')}
            ${tile('Latest', latestBlogDate(s.blogPosts), '')}
          </div>
          <table>
            <thead><tr><th>Published</th><th>Post</th></tr></thead>
            <tbody>${blogRows(s.blogPosts || [])}</tbody>
          </table>
        </div>
      </div>

      <p style="margin-top:32px;text-align:center;color:#888;font-size:12px">Internal dashboard · not indexed · read-only · powered by Cloudflare Workers + KV</p>
    </div>
  </body></html>`;
}

function submissionRows(subs) {
  if (!subs.length) return `<tr><td colspan="4" style="padding:16px;text-align:center;color:#888">No submissions yet.</td></tr>`;
  return subs.map(s => {
    const detail = s.kind === 'rich-quote'
      ? `${esc(s.product || '—')} × ${esc(s.quantity || '?')} (est $${esc(s.estimate || '?')})`
      : `${esc(s.service || '—')}`;
    return `<tr>
      <td style="color:#666;font-size:12px">${esc(fmtTs(s.ts))}</td>
      <td><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:${s.kind==='rich-quote'?'#fef3c7':s.kind==='quote'?'#dbeafe':'#e0e7ff'};color:#001E78">${esc(s.kind)}</span></td>
      <td>${esc(s.name || '—')}<br><span style="color:#888;font-size:11px">${esc(s.email || '')}</span></td>
      <td style="color:#444;font-size:12px">${detail}</td>
    </tr>`;
  }).join('');
}

function blogRows(posts) {
  if (!posts.length) return `<tr><td colspan="2" style="padding:16px;text-align:center;color:#888">No posts published yet.</td></tr>`;
  return posts.slice(0, 20).map(p => {
    const slug = (p.url.match(/\/blog\/([^\/]+)\/([^\/]+)\/?$/) || []).slice(1);
    const label = slug.length === 2 ? `${slug[0]} · ${slug[1].replace(/-/g, ' ')}` : p.url;
    return `<tr>
      <td style="color:#666;font-size:12px;white-space:nowrap">${esc((p.lastmod || '').slice(0, 10))}</td>
      <td><a href="${esc(p.url)}" target="_blank" style="color:#001E78;text-decoration:none;font-weight:500">${esc(label)}</a></td>
    </tr>`;
  }).join('');
}

function latestBlogDate(posts) {
  if (!posts || !posts.length) return '—';
  return (posts[0].lastmod || '').slice(0, 10) || '—';
}

// POST /api/outreach/test-blast?key=…
// body: { emails:[], name?, org?, category? }
// Sends all 3 outreach touches to every email in the list, 60s between each
// individual send. Subject prefixed with "[Test: Day 0/4/9]". Bypasses KV.
export async function testBlastPost({ request, env, ctx }) {
  const url = new URL(request.url);
  if (!authed(url, env)) return json({ error: 'Unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.emails) || !body.emails.length) {
    return json({ error: 'emails[] required' }, 400);
  }
  if (!env.RESEND_API_KEY) return json({ error: 'RESEND_API_KEY not set' }, 503);
  const emails = body.emails.map(e => String(e).trim()).filter(e => e.includes('@'));
  const p = {
    email: '',
    name: body.name || 'Aaron',
    org: body.org || 'your team',
    category: body.category || 'professional-services',
    // Extras used by the schools warm-intro sequence — pass them through so
    // the test blast renders identically to a real school-district send.
    landing_page: body.landing_page || '',
    mascot: body.mascot || '',
    mascot_plural: body.mascot_plural || '',
  };
  const DAY_LABELS = [0, 4, 9];
  // Fire all touches for all recipients IN PARALLEL. No sleep between sends,
  // no waitUntil budget concerns — Resend returns in ~500ms per call, so
  // even 30 sends complete in about 1s. Await the whole batch so the curl
  // response reports which touches actually made it through.
  const jobs = [];
  for (let touchIdx = 0; touchIdx < 3; touchIdx++) {
    for (const email of emails) {
      const unsubUrl = `${SITE}/api/outreach/unsub?e=${btoa(email.toLowerCase())}`;
      const msg = renderTouch(touchIdx + 1, { ...p, email }, unsubUrl);
      msg.subject = `[Test: Day ${DAY_LABELS[touchIdx]}] ${msg.subject}`;
      jobs.push(
        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM,
            to: [email],
            subject: msg.subject,
            text: msg.text,
            html: msg.html,
            headers: {
              'List-Unsubscribe': `<${unsubUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }),
        })
          .then(async r => ({ email, touch: touchIdx + 1, status: r.status, body: r.ok ? null : (await r.text()).slice(0, 300) }))
          .catch(e => ({ email, touch: touchIdx + 1, status: 0, body: String(e).slice(0, 300) })),
      );
    }
  }
  const results = await Promise.all(jobs);
  const sent = results.filter(r => r.status >= 200 && r.status < 300).length;
  const failed = results.filter(r => !(r.status >= 200 && r.status < 300));
  return json({ ok: failed.length === 0, sent, failed_count: failed.length, failed, recipients: emails });
}

const RENDER_LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard · Access required</title><style>body{margin:0;font-family:-apple-system,sans-serif;background:#001E78;color:#fff;display:grid;place-items:center;min-height:100vh}form{background:#fff;color:#222;padding:32px;border-radius:14px;max-width:400px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.3)}h1{margin:0 0 8px;color:#001E78;font-size:22px}p{color:#666;font-size:14px;margin:0 0 20px}input{width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;font-size:15px;margin-bottom:12px;font-family:monospace}button{width:100%;padding:12px;background:linear-gradient(90deg,#F09600,#E10078);color:#fff;border:0;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer}</style></head><body><form onsubmit="event.preventDefault();window.location.href='/dashboard?key='+encodeURIComponent(this.k.value)"><h1>Dashboard access</h1><p>Paste your dashboard key to view outreach progress.</p><input name="k" placeholder="Dashboard key" required autofocus><button type="submit">View dashboard</button></form></body></html>`;
