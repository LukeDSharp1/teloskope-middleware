// api/generate-options-response.js
// V1.0: Teloskope Options — conversational advisory endpoint.
// Pulls fresh Shopify + Xero + Meta data on session open.
// Maintains message history in browser state — full array sent each call.
// Returns HTML response + optional persist_insight JSON.
// End-of-session summariser triggered by session_end: true in request body.

import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BUBBLE_BASE_URL = "https://teloskope.bubbleapps.io/version-test/api/1.1";

// ─── DATE HELPERS (matches generate-weekly-brief.js) ─────────────────────────
const SHOP_OFFSET_MS = 10 * 60 * 60 * 1000;

function getShopDateParts(utcDate) {
  const d = new Date(utcDate.getTime() + SHOP_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    dayOfWeek: d.getUTCDay(),
  };
}

function shopMidnightUtc(year, month, day) {
  return new Date(Date.UTC(year, month, day, 0, 0, 0) - SHOP_OFFSET_MS);
}

function shopEndOfDayUtc(year, month, day) {
  return new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - SHOP_OFFSET_MS);
}

function shiftDays(d, days) {
  const s = new Date(Date.UTC(d.year, d.month, d.day + days));
  return { year: s.getUTCFullYear(), month: s.getUTCMonth(), day: s.getUTCDate() };
}

function shiftYear(d, years) {
  return { ...d, year: d.year + years };
}

function fmtDate(d, opts = { day: "numeric", month: "long", year: "numeric" }) {
  return new Date(Date.UTC(d.year, d.month, d.day)).toLocaleDateString("en-AU", opts);
}

const fmt$ = (n) => `$${Math.round(n).toLocaleString()}`;
const stripGst = (gross) => gross / 1.1;

// ─── XERO: LIVE BANK BALANCE ──────────────────────────────────────────────────
async function fetchXeroCashBalance(xeroAccessToken, xeroTenantId, xeroRefreshToken, xeroConnectionId) {
  const doFetch = async (token) => fetch(`https://api.xero.com/api.xro/2.0/Reports/BankSummary`, {
    headers: { Authorization: `Bearer ${token}`, "Xero-tenant-id": xeroTenantId, Accept: "application/json" },
  });

  try {
    let response = await doFetch(xeroAccessToken);
    if (response.status === 401 && xeroRefreshToken) {
      const newToken = await refreshXeroToken(xeroRefreshToken, xeroConnectionId);
      if (newToken) response = await doFetch(newToken);
      else return null;
    }
    if (!response.ok) return null;

    const data = await response.json();
    const report = data?.Reports?.[0];
    if (!report) return null;

    let closingColIndex = null;
    let total = 0;
    let foundAny = false;

    const processRows = (rows) => {
      for (const row of rows || []) {
        if (row.RowType === "Header") {
          const cells = row.Cells || [];
          for (let i = 0; i < cells.length; i++) {
            if ((cells[i]?.Value || "").toLowerCase().includes("closing")) {
              closingColIndex = i;
              break;
            }
          }
        }
        if (row.RowType === "Row" && closingColIndex !== null) {
          const val = parseFloat((row.Cells?.[closingColIndex]?.Value || "").replace(/,/g, ""));
          if (!isNaN(val)) { total += val; foundAny = true; }
        }
        if (row.Rows) processRows(row.Rows);
      }
    };

    processRows(report.Rows);
    return foundAny ? total : null;
  } catch (err) {
    console.error("Xero BankSummary error:", err.message);
    return null;
  }
}

// ─── XERO: REFRESH TOKEN ──────────────────────────────────────────────────────
async function refreshXeroToken(xeroRefreshToken, xeroConnectionId) {
  try {
    const credentials = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString("base64");
    const res = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${credentials}` },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: xeroRefreshToken }),
    });
    if (!res.ok) return null;
    const tokens = await res.json();
    const expiresAt = new Date(Date.now() + (tokens.expires_in - 120) * 1000).toISOString();
    await fetch(`${BUBBLE_BASE_URL}/obj/xero_connection/${xeroConnectionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.BUBBLE_API_KEY}` },
      body: JSON.stringify({ xero_access_token: tokens.access_token, xero_refresh_token: tokens.refresh_token, token_expires_at: expiresAt }),
    });
    return tokens.access_token;
  } catch (err) {
    console.error("Xero refresh error:", err.message);
    return null;
  }
}

// ─── XERO: P&L REVENUE ────────────────────────────────────────────────────────
async function fetchXeroRevenue(start, end, xeroAccessToken, xeroTenantId, xeroRefreshToken, xeroConnectionId) {
  const fromIso = start.toISOString().split("T")[0];
  const toIso = end.toISOString().split("T")[0];
  const doFetch = async (token) => fetch(
    `https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${fromIso}&toDate=${toIso}`,
    { headers: { Authorization: `Bearer ${token}`, "Xero-tenant-id": xeroTenantId, Accept: "application/json" } }
  );
  try {
    let response = await doFetch(xeroAccessToken);
    if (response.status === 401 && xeroRefreshToken) {
      const newToken = await refreshXeroToken(xeroRefreshToken, xeroConnectionId);
      if (newToken) response = await doFetch(newToken);
      else return null;
    }
    if (!response.ok) return null;
    const data = await response.json();
    const report = data?.Reports?.[0];
    if (!report) return null;
    let totalIncome = null;
    const search = (rows) => {
      for (const row of rows || []) {
        if (row.RowType === "Row" || row.RowType === "SummaryRow") {
          const label = (row.Cells?.[0]?.Value || "").toLowerCase().trim();
          const val = parseFloat((row.Cells?.[1]?.Value || "").replace(/,/g, ""));
          if (!isNaN(val) && (label === "total trading income" || label === "total income" || label === "total revenue") && totalIncome === null) {
            totalIncome = val;
            return;
          }
        }
        if (row.Rows) search(row.Rows);
      }
    };
    search(report.Rows);
    return totalIncome;
  } catch (err) {
    console.error("Xero P&L error:", err.message);
    return null;
  }
}

// ─── SHOPIFY: FETCH ORDERS ────────────────────────────────────────────────────
async function fetchAllOrders(shopDomain, accessToken, start, end, fields = "total_price,created_at,customer") {
  let orders = [];
  let url = `https://${shopDomain}/admin/api/2024-01/orders.json?status=any&financial_status=any&created_at_min=${start.toISOString()}&created_at_max=${end.toISOString()}&fields=${fields}&limit=250`;
  while (url) {
    const r = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
    if (!r.ok) throw new Error(`Shopify error ${r.status}`);
    const data = await r.json();
    orders = orders.concat(data.orders || []);
    const link = r.headers.get("Link");
    url = (link && link.includes('rel="next"'))
      ? (link.match(/<([^>]+)>;\s*rel="next"/) || [])[1] || null
      : null;
  }
  return orders;
}

// ─── META: AD INSIGHTS ────────────────────────────────────────────────────────
async function fetchMetaInsights(metaAccessToken, metaAdAccountId, datePreset) {
  if (!metaAccessToken || !metaAdAccountId) return null;
  try {
    const url = `https://graph.facebook.com/v25.0/${metaAdAccountId}/insights?fields=spend,impressions,clicks&date_preset=${datePreset}&level=account&access_token=${metaAccessToken}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const row = data?.data?.[0];
    if (!row) return { spend: 0, impressions: 0, clicks: 0 };
    return {
      spend: parseFloat(row.spend || 0),
      impressions: parseInt(row.impressions || 0),
      clicks: parseInt(row.clicks || 0),
    };
  } catch (err) {
    return null;
  }
}

// ─── FETCH ALL BUSINESS DATA ──────────────────────────────────────────────────
async function fetchBusinessData(params) {
  const {
    shopify_shop_domain, shopify_access_token,
    xero_access_token, xero_refresh_token, xero_tenant_id, xero_connection_id,
    meta_access_token, meta_ad_account_id,
  } = params;

  const nowUtc = new Date();
  const today = getShopDateParts(nowUtc);

  // Last 90 days for trend analysis
  const ninetyDaysAgo = shiftDays(today, -90);
  const thirtyDaysAgo = shiftDays(today, -30);

  // Current month
  const mtdStart = { year: today.year, month: today.month, day: 1 };
  const lyMtdStart = shiftYear(mtdStart, -1);
  const lyMtdEnd = shiftYear(today, -1);

  // Last 3 months for cash trend
  const m1Start = shiftDays(today, -90);
  const m1End = shiftDays(today, -61);
  const m2Start = shiftDays(today, -60);
  const m2End = shiftDays(today, -31);
  const m3Start = shiftDays(today, -30);
  const m3End = today;

  const todayUtc = shopEndOfDayUtc(today.year, today.month, today.day);
  const mtdStartUtc = shopMidnightUtc(mtdStart.year, mtdStart.month, mtdStart.day);
  const lyMtdStartUtc = shopMidnightUtc(lyMtdStart.year, lyMtdStart.month, lyMtdStart.day);
  const lyMtdEndUtc = shopEndOfDayUtc(lyMtdEnd.year, lyMtdEnd.month, lyMtdEnd.day);
  const thirtyStartUtc = shopMidnightUtc(thirtyDaysAgo.year, thirtyDaysAgo.month, thirtyDaysAgo.day);
  const ninetyStartUtc = shopMidnightUtc(ninetyDaysAgo.year, ninetyDaysAgo.month, ninetyDaysAgo.day);

  const xeroAvailable = !!(xero_access_token && xero_tenant_id);

  const [
    mtdOrders,
    lyMtdOrders,
    last30Orders,
    last90Orders,
    cashBalance,
    xeroMtdRevenue,
    xeroM1Revenue,
    xeroM2Revenue,
    xeroM3Revenue,
    metaLast30,
  ] = await Promise.all([
    fetchAllOrders(shopify_shop_domain, shopify_access_token, mtdStartUtc, todayUtc),
    fetchAllOrders(shopify_shop_domain, shopify_access_token, lyMtdStartUtc, lyMtdEndUtc),
    fetchAllOrders(shopify_shop_domain, shopify_access_token, thirtyStartUtc, todayUtc),
    fetchAllOrders(shopify_shop_domain, shopify_access_token, ninetyStartUtc, todayUtc),
    xeroAvailable ? fetchXeroCashBalance(xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id) : Promise.resolve(null),
    xeroAvailable ? fetchXeroRevenue(mtdStartUtc, todayUtc, xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id) : Promise.resolve(null),
    xeroAvailable ? fetchXeroRevenue(
      shopMidnightUtc(m1Start.year, m1Start.month, m1Start.day),
      shopEndOfDayUtc(m1End.year, m1End.month, m1End.day),
      xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id
    ) : Promise.resolve(null),
    xeroAvailable ? fetchXeroRevenue(
      shopMidnightUtc(m2Start.year, m2Start.month, m2Start.day),
      shopEndOfDayUtc(m2End.year, m2End.month, m2End.day),
      xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id
    ) : Promise.resolve(null),
    xeroAvailable ? fetchXeroRevenue(
      shopMidnightUtc(m3Start.year, m3Start.month, m3Start.day),
      shopEndOfDayUtc(m3End.year, m3End.month, m3End.day),
      xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id
    ) : Promise.resolve(null),
    fetchMetaInsights(meta_access_token, meta_ad_account_id, "last_30d"),
  ]);

  // Calculations
  const sumExGst = (orders) => stripGst(orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0));
  const mtdRevOnline = sumExGst(mtdOrders);
  const lyMtdRevOnline = sumExGst(lyMtdOrders);
  const last30Rev = sumExGst(last30Orders);
  const last90Rev = sumExGst(last90Orders);
  const mtdTx = mtdOrders.length;
  const last30Tx = last30Orders.length;
  const aov30 = last30Tx > 0 ? last30Rev / last30Tx : 0;

  // New vs returning (MTD)
  const priorIds = new Set(lyMtdOrders.filter(o => o.customer?.id).map(o => String(o.customer.id)));
  let newMtd = 0, retMtd = 0;
  for (const o of mtdOrders) {
    if (!o.customer?.id) { newMtd++; continue; }
    priorIds.has(String(o.customer.id)) ? retMtd++ : newMtd++;
  }

  const metaRoas = metaLast30 && metaLast30.spend > 0 ? (last30Rev / metaLast30.spend) : null;

  return {
    today,
    cashBalance,
    mtdRevOnline,
    lyMtdRevOnline,
    xeroMtdRevenue,
    xeroM1Revenue,
    xeroM2Revenue,
    xeroM3Revenue,
    last30Rev,
    last90Rev,
    mtdTx,
    last30Tx,
    aov30,
    newMtd,
    retMtd,
    metaLast30,
    metaRoas,
    mtdStart,
    m1Start, m1End,
    m2Start, m2End,
    m3Start, m3End,
  };
}

// ─── BUILD DATA CONTEXT STRING FOR CLAUDE ─────────────────────────────────────
function buildDataContext(data, storeName, firstName) {
  const {
    today, cashBalance,
    mtdRevOnline, lyMtdRevOnline, xeroMtdRevenue,
    xeroM1Revenue, xeroM2Revenue, xeroM3Revenue,
    last30Rev, last90Rev, mtdTx, last30Tx, aov30,
    newMtd, retMtd, metaLast30, metaRoas,
    mtdStart, m1Start, m1End, m2Start, m2End, m3Start, m3End,
  } = data;

  const pct = (a, b) => b > 0 ? `${(((a - b) / b) * 100).toFixed(1)}%` : "N/A";
  const fmtPeriod = (s, e) => `${fmtDate(s, { day: "numeric", month: "short" })} – ${fmtDate(e, { day: "numeric", month: "short" })}`;

  return `
BUSINESS: ${storeName}
OWNER: ${firstName}
DATA AS AT: ${fmtDate(today)}
ALL FIGURES EX-GST.

BUSINESS PROFILE:
- Description: ${business_description || "not provided"}
- Type: ${business_type || "not provided"}
- Supply chain: ${supply_chain || "not provided"}
- Invoice currency: ${invoice_currency || "AUD"}
- Business stage: ${business_stage || "not provided"}
- Owner's biggest challenge: ${owner_challenge || "not provided"}

LIVE BANK BALANCE (Xero bank feed):
${cashBalance !== null ? fmt$(cashBalance) : "Not available — Xero not connected"}

REVENUE TREND — last 3 periods (Xero P&L, ex-GST):
- ${fmtPeriod(m1Start, m1End)}: ${xeroM1Revenue !== null ? fmt$(xeroM1Revenue) : "N/A"}
- ${fmtPeriod(m2Start, m2End)}: ${xeroM2Revenue !== null ? fmt$(xeroM2Revenue) : "N/A"}
- ${fmtPeriod(m3Start, m3End)}: ${xeroM3Revenue !== null ? fmt$(xeroM3Revenue) : "N/A"}

MONTH TO DATE (Shopify online, ex-GST):
- Revenue: ${fmt$(mtdRevOnline)} | ${mtdTx} orders
- Last year same period: ${lyMtdRevOnline > 0 ? `${fmt$(lyMtdRevOnline)} (${pct(mtdRevOnline, lyMtdRevOnline)} change)` : "not available"}
- Total MTD (Xero reconciled): ${xeroMtdRevenue !== null ? fmt$(xeroMtdRevenue) : "not available"}

LAST 30 DAYS (Shopify online, ex-GST):
- Revenue: ${fmt$(last30Rev)} | ${last30Tx} orders | AOV: ${fmt$(aov30)}

CUSTOMER MIX (MTD):
- New customers: ${newMtd}
- Returning customers: ${retMtd}
- Returning rate: ${(newMtd + retMtd) > 0 ? Math.round((retMtd / (newMtd + retMtd)) * 100) : 0}%

META ADS (last 30 days):
${metaLast30 && metaLast30.spend > 0
  ? `- Spend: ${fmt$(metaLast30.spend)} | Impressions: ${metaLast30.impressions.toLocaleString()} | Clicks: ${metaLast30.clicks.toLocaleString()}
- Estimated ROAS (vs Shopify online revenue): ${metaRoas !== null ? metaRoas.toFixed(1) + "x" : "N/A"}
- CPM: ${metaLast30.impressions > 0 ? "$" + ((metaLast30.spend / metaLast30.impressions) * 1000).toFixed(2) : "N/A"} (AU retail benchmark: $15–35)
- CPC: ${metaLast30.clicks > 0 ? "$" + (metaLast30.spend / metaLast30.clicks).toFixed(2) : "N/A"} (AU retail benchmark: $1.50–3.00)`
  : "- No active campaigns or not connected"}
`.trim();
}

// ─── OPTIONS SYSTEM PROMPT ─────────────────────────────────────────────────────
const OPTIONS_SYSTEM_PROMPT = `You are the advisor inside Teloskope — a business tool built for retailers and product-based businesses. Your job is to help owners understand their business honestly and make better decisions, one conversation at a time.

You are not a chatbot. You are not a dashboard. You are the consultant they can't afford to hire — the one who has sat across the table from businesses like theirs, who knows what it actually feels like to watch cash disappear in a good month, who understands that the person reading this is probably wearing six hats and has three unanswered supplier emails sitting in their inbox right now.

You get it. You don't need to say you get it. Just act like it.

Running a small business is hard. Most fail. Not because the owners weren't smart or didn't work hard enough — but because the financial complexity is genuinely difficult, and most people get very little honest help navigating it. That's what Teloskope is for.

Your name within the product is simply Teloskope. Never refer to yourself as Claude or as an AI unless directly and sincerely asked.

---

WHO YOU ARE TALKING TO

Your user runs a retail or product-based business — physical, online, or both. Revenue size does not change the fundamentals.

They are smart. Do not talk down to them. But do not assume they know financial terminology without explanation. Define technical terms plainly in the same sentence, once, then move on.

The plain language test: if a busy person running a business would have to re-read your sentence, rewrite it.

---

YOUR NORTH STAR — HONEST ASSESSMENT, NOT OPTIMISM

Teloskope's purpose is honest clarity. That means helping owners understand what is actually possible — including when the answer is uncomfortable.

You will sometimes need to say: "You don't have sufficient margin or cash to chase growth right now — doing so will make things worse, not better."

Or: "The model works, but it needs more capital before it can scale. That's not a failure — it's just what the numbers say."

Never recommend a short-term fix without naming what it costs tomorrow. Every lever has a cost. Name it.

The four tensions you always hold in mind:
1. Margin vs volume — more sales at lower margin can destroy cash faster than fewer sales at full margin
2. Stock depth vs cash — clearing inventory sounds smart until you have nothing to sell next month
3. Paid spend vs brand — performance ads can hollow out next year's customer base
4. Owner draw vs business resilience — both are legitimate, your job is to make the tension visible

Always be thinking about people and capacity, brand and positioning, channel mix, and capital structure too.

---

WHAT TELOSKOPE IS — AND ISN'T

Before diving in, be clear about this when it's relevant:

Teloskope is a thinking partner, not an oracle. It can help the owner see their numbers clearly, run the implications of a decision before they make it, or think something through out loud. It cannot tell them what will definitely happen, or make the call for them — that's theirs.

---

SESSION OPENING

On the very first message (when message history is empty or contains only the system context), open with:

"Good to have you here. I've had a look at your numbers before we got started — [one plain-language observation about the most significant thing in the data, cash position or revenue trend]. We can go a few directions from here — dig into what's driving that, pressure-test something you're thinking about doing, or just think something through out loud. Where would you like to start?"

Do not use a generic greeting. Lead with something specific from the data.

---

THE THREE-PHASE SESSION STRUCTURE

Move through these naturally — do not announce the phases.

PHASE 1 — DIAGNOSIS
Understand where the business actually is. Lead with cash trend — not the absolute number alone but direction and what's driving it. Be honest including when the numbers say something the owner may not want to hear. This phase ends when the owner understands their current position clearly enough to ask "what do I do about it?" or "what if I tried X?"

PHASE 2 — SCENARIO
The owner proposes a move. Run the implication forward against their actual data.

Each scenario exchange:
1. Restate the proposed move plainly
2. State your assumptions explicitly — make them visible
3. Run the cash implication — 30, 60, 90 day horizon
4. Name the margin impact
5. Name the downside — always
6. Suggest a chart if the comparison would be clearer visually (see VISUALISATIONS)
7. Ask whether they want to test another variable or go deeper

Hold scenario history across the conversation. Reference prior scenarios explicitly: "In the first scenario we cut ad spend — cash improved but new customer acquisition was at risk. Adding the margin push on top, here's the combined picture."

Never model a scenario without stating assumptions. Never show an upside without the downside.

PHASE 3 — RECOMMENDATION
Synthesise a clear view. Not a list of options — a position. What would you do first, and why? What would you watch? One actionable next step before the next session.

---

THE FIVE ADVISORY PILLARS

1. Cash & Working Capital — anchor, always most honest starting point
2. People & Capacity — can't scale without capacity to deliver
3. Growth & Channel — growth is expensive, needs to be funded
4. Marketing & Brand — spend vs brand building, CAC sustainability
5. Retention & Loyalty — cheapest customer is the one you already have

---

VISUALISATIONS

When a comparison or trend would be clearer as a chart, generate it as inline HTML/SVG directly. Do not use JSON data blocks — render the chart as actual HTML that displays immediately.

Use this pattern for a bar chart:

<div style="margin:16px 0;font-family:Inter,-apple-system,sans-serif">
<p style="font-size:11px;font-weight:500;color:#888780;letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px">CHART TITLE HERE</p>
<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
  <span style="font-size:12px;color:#888780;width:90px;flex-shrink:0">Label 1</span>
  <div style="flex:1;height:24px;background:#F1EFE8;border-radius:4px;overflow:hidden">
    <div style="width:100%;height:100%;background:#378ADD;border-radius:4px"></div>
  </div>
  <span style="font-size:12px;font-weight:500;width:60px;text-align:right">$77K</span>
</div>
<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
  <span style="font-size:12px;color:#888780;width:90px;flex-shrink:0">Label 2</span>
  <div style="flex:1;height:24px;background:#F1EFE8;border-radius:4px;overflow:hidden">
    <div style="width:67%;height:100%;background:#B5D4F4;border-radius:4px"></div>
  </div>
  <span style="font-size:12px;font-weight:500;width:60px;text-align:right">$52K</span>
</div>
</div>

Rules for generating charts:
- Calculate bar widths as percentages — the largest value = 100%, others proportional
- Use #378ADD (blue) for current/positive bars, #B5D4F4 (light blue) for prior/neutral, #E8534A (red) for negative values
- Format values as $XK for thousands, $X for under 1000
- Always include the chart title in uppercase small caps style
- Mobile-first — bars should be readable on a 390px wide screen
- For scenario before/after: use a two-bar comparison with labels "Current" and "Scenario"

Always include a chart for: revenue trend (session open), scenario comparisons, before/after diagnostics.

---

BEHAVIOURAL RULES

- One question at a time. Always.
- Lead with the observation, not the question. You have the data — tell them what you see, then ask.
- Never recommend without naming the downside.
- Hold scenario history — reference prior scenarios explicitly.
- Make assumptions visible in every scenario.
- Don't catastrophise. Most cash problems are solvable.
- Don't lecture. Say it once, move on.
- Push back when it matters. Say so plainly, once, then respect their decision.
- Be honest about difficulty. Running a small business is hard. Many fail. Saying so is respectful.
- Professional advice contextually: when tax, debt, legal, or employment territory comes up, flag it specifically in the moment. Not as a footer — as a real recommendation.
- Never open a response with "I".
- Never say "great question", "certainly", or "absolutely".
- Never use exclamation marks.

---

WHAT YOU NEVER DO

- Never recommend debt without flagging full cost, risk, and whether margin can service it
- Never recommend cutting inventory without flagging stockout risk
- Never recommend scaling paid spend without confirming margin can support it
- Never make tax, legal, or structural recommendations — flag and refer
- Never pretend data is clear when it isn't
- Never make assumptions without stating them
- Never show an upside without the downside
- Never make the owner feel stupid or alone
- Never chase growth before foundations are in place without saying so

---

FORMATTING

Responses render as HTML in the Teloskope app.

- <p> for prose paragraphs
- <strong> for emphasis — sparingly
- <div class="insight-block"> for key observations to highlight
- <table class="data-table"> for side-by-side comparisons
- <div class="chart-data" data-type="..." data-label="..."> for charts — JSON array inside

Length: match the owner's pace. Opening diagnostic: substantive (200–300 words + chart). Subsequent exchanges: shorter. Scenario exchanges: always include a visual if the comparison warrants it.

Tone: warm but not soft. Direct but not blunt. Confident but not arrogant. Honest even when uncomfortable.

---

PERSISTING INSIGHTS

When the request includes "session_end": true, return ONLY a JSON object — no HTML:

{
  "persist_insight": {
    "insight_text": "Plain language observation about this business worth remembering next session",
    "category": "cash | people | growth | marketing | retention",
    "confidence": "high | medium | low"
  }
}

If no strong signal exists, return: {"persist_insight": null}`;

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    bubble_secret_key,
    // Auth & identity
    shopify_shop_domain,
    shopify_access_token,
    xero_access_token,
    xero_refresh_token,
    xero_tenant_id,
    xero_connection_id,
    meta_access_token,
    meta_ad_account_id,
    user_id,
    user_name,
    store_name,
    // Business profile
    business_description = "",
    business_type = "",
    supply_chain = "",
    invoice_currency = "",
    business_stage = "",
    owner_challenge = "",
    // Conversation
    messages = [],             // Legacy — kept for backwards compat
    conversation_log = "",     // Plain text conversation history — easier to build in Bubble
    user_message,              // Current user message (null on session open)
    prior_insights = [],       // Persisted insights from Bubble user_insights records
    // Control
    session_open = false,      // True on first load — triggers data fetch + opening message
    session_end = false,       // True when user ends session — triggers insight summariser
  } = req.body;

  if (!shopify_shop_domain || !shopify_access_token || !user_id || !bubble_secret_key) {
    console.log("400 — missing fields. Received:", JSON.stringify({
      shopify_shop_domain: shopify_shop_domain || "MISSING",
      shopify_access_token: shopify_access_token ? "present" : "MISSING",
      user_id: user_id || "MISSING",
      bubble_secret_key: bubble_secret_key ? "present" : "MISSING",
      session_open,
      session_end,
      messages_length: Array.isArray(messages) ? messages.length : typeof messages,
    }));
    return res.status(400).json({ error: "Missing required fields" });
  }

  const firstName = (user_name || "").split(" ")[0] || user_name;

  try {
    // Bubble sends arrays as strings — parse if needed
    const messagesParsed = typeof messages === "string" ? JSON.parse(messages || "[]") : (messages || []);
    const priorInsightsParsed = typeof prior_insights === "string" ? JSON.parse(prior_insights || "[]") : (prior_insights || []);
    const sessionOpenBool = session_open === true || session_open === "true";
    const sessionEndBool = session_end === true || session_end === "true";

    console.log("Options debug — session_open:", session_open, "| session_end:", session_end, "| conversation_log length:", (conversation_log || "").length, "| user_message:", user_message ? "present" : "empty");

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    // ─── SESSION END: INSIGHT SUMMARISER ─────────────────────────────────────
    if (sessionEndBool) {
      console.log("Options: session end — running insight summariser...");

      const conversationText = messagesParsed
        .map(m => `${m.role === "user" ? "Owner" : "Teloskope"}: ${m.content}`)
        .join("\n\n");

      const summariserResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: "You extract key business insights from advisor conversations to persist as memory for future sessions. Return only valid JSON, no other text.",
        messages: [{
          role: "user",
          content: `Review this Teloskope advisory conversation and identify the single most important observation about this business worth remembering for next session.

${conversationText}

Return this exact JSON format:
{
  "persist_insight": {
    "insight_text": "Plain language observation (max 150 words)",
    "category": "cash | people | growth | marketing | retention",
    "confidence": "high | medium | low"
  }
}

If there is no strong signal worth persisting, return: {"persist_insight": null}`
        }],
      });

      try {
        const raw = summariserResponse.content[0].text.trim();
        const parsed = JSON.parse(raw);

        // Write insight to Bubble if one exists
        if (parsed.persist_insight && user_id) {
          console.log("Options: writing insight to Bubble...");
          const bubbleRes = await fetch(`${BUBBLE_BASE_URL}/wf/ingest_options_insight`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              secret_key: bubble_secret_key,
              user_id,
              insight_text: parsed.persist_insight.insight_text,
              category: parsed.persist_insight.category,
              confidence: parsed.persist_insight.confidence,
            }),
          });
          if (bubbleRes.ok) {
            console.log("Options: insight saved to Bubble successfully");
          } else {
            console.error("Options: Bubble insight save failed:", await bubbleRes.text());
          }
        } else {
          console.log("Options: no insight to persist this session");
        }

        return res.status(200).json({ success: true, ...parsed });
      } catch {
        return res.status(200).json({ success: true, persist_insight: null });
      }
    }

    // ─── FETCH BUSINESS DATA ──────────────────────────────────────────────────
    console.log("Options: fetching business data...");
    const businessData = await fetchBusinessData({
      shopify_shop_domain, shopify_access_token,
      xero_access_token, xero_refresh_token, xero_tenant_id, xero_connection_id,
      meta_access_token, meta_ad_account_id,
    });

    const dataContext = buildDataContext(businessData, store_name, firstName);

    // ─── BUILD PRIOR INSIGHTS BLOCK ───────────────────────────────────────────
    const insightsBlock = priorInsightsParsed.length > 0
      ? `\nPRIOR OBSERVATIONS (from previous sessions):\n${priorInsightsParsed.map(i => `- [${i.category}] ${i.insight_text}`).join("\n")}`
      : "";

    // ─── BUILD MESSAGE ARRAY ──────────────────────────────────────────────────
    // System context injected as first user message (Anthropic pattern)
    const contextMessage = {
      role: "user",
      content: `Here is the current business data for this session:\n\n${dataContext}${insightsBlock}\n\nThis data is your briefing. You have read it before the session starts.`
    };

    const contextAck = {
      role: "assistant",
      content: "Understood — I've reviewed the business data and I'm ready."
    };

    let conversationMessages;

    if (sessionOpenBool || (!conversation_log && messagesParsed.length === 0)) {
      // Fresh session — inject context then ask Claude to open
      conversationMessages = [
        contextMessage,
        contextAck,
        { role: "user", content: "Please open the session." }
      ];
    } else {
      // Continuing session — strip HTML tags from conversation_log to get plain text history
      const plainHistory = (conversation_log || "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      // Build as proper alternating turns
      conversationMessages = [
        contextMessage,
        contextAck,
        {
          role: "user",
          content: plainHistory
            ? `This is a continuing session. Here is what has been discussed so far:\n\n${plainHistory}\n\nDo not re-introduce yourself. Continue directly from where the conversation left off.`
            : `This is a continuing session. The user has a new message.`
        },
        {
          role: "assistant",
          content: "Understood, continuing the conversation."
        },
        ...(user_message ? [{ role: "user", content: user_message }] : [])
      ];
    }

    // ─── CALL CLAUDE ──────────────────────────────────────────────────────────
    console.log("Options: calling Claude, messages in context:", conversationMessages.length);
    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: OPTIONS_SYSTEM_PROMPT,
      messages: conversationMessages,
    });

    const responseHtml = claudeResponse.content[0].text;
    console.log("Options: Claude response, chars:", responseHtml.length);

    // ─── RETURN ───────────────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      response_html: responseHtml,
      data_snapshot: {
        cash_balance: businessData.cashBalance,
        mtd_revenue_online: businessData.mtdRevOnline,
        xero_mtd_revenue: businessData.xeroMtdRevenue,
        last_30_revenue: businessData.last30Rev,
        meta_spend_30d: businessData.metaLast30?.spend ?? null,
      },
    });

  } catch (err) {
    console.error("generate-options-response error:", err);
    return res.status(500).json({ error: err.message });
  }
}
