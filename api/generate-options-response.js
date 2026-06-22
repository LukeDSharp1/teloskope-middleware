// api/generate-options-response.js
// V1.2a: Model string updated claude-sonnet-4-20250514 → claude-sonnet-4-5 (both main call and summariser).
//   - WEB SEARCH: Anthropic web_search tool added to the main Claude call (max_uses 3),
//     response extraction rewritten to concatenate text blocks (content is now interleaved
//     with server_tool_use / web_search_tool_result blocks — content[0].text would break),
//     system prompt given a WEB SEARCH section. Removes the manual macro-context update problem.
//   - DATA: revenue trend now uses last 3 COMPLETE calendar months (was rolling 30-day windows
//     mislabelled as months); trend labelled by month name; max_tokens raised 1500 -> 2000.
//   - RETURNING CUSTOMERS: "returning" now = ordered in the 12 months before this month began
//     (was: same 12-day window last year, which made almost everyone "new").
//   - SUMMARISER: session_end insight extraction now reads conversation_log (was reading the
//     legacy empty messages array, so it persisted nothing). Inert until End Session is wired
//     in Bubble — that workflow must pass conversation_log on the session_end call.
// V1.0: Teloskope Options — conversational advisory endpoint.

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

// First day of the calendar month that is `monthsBack` months before d's month.
function monthStart(d, monthsBack) {
  const dt = new Date(Date.UTC(d.year, d.month - monthsBack, 1));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth(), day: 1 };
}

// Last day of the calendar month that is `monthsBack` months before d's month.
// Day 0 of (month+1) resolves to the last day of `month` — handles year boundaries.
function monthEnd(d, monthsBack) {
  const dt = new Date(Date.UTC(d.year, d.month - monthsBack + 1, 0));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth(), day: dt.getUTCDate() };
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

  // Last 3 COMPLETE calendar months (current partial month handled by MTD separately)
  const m1Start = monthStart(today, 3);
  const m1End   = monthEnd(today, 3);
  const m2Start = monthStart(today, 2);
  const m2End   = monthEnd(today, 2);
  const m3Start = monthStart(today, 1);
  const m3End   = monthEnd(today, 1);

  const todayUtc = shopEndOfDayUtc(today.year, today.month, today.day);
  const mtdStartUtc = shopMidnightUtc(mtdStart.year, mtdStart.month, mtdStart.day);
  const lyMtdStartUtc = shopMidnightUtc(lyMtdStart.year, lyMtdStart.month, lyMtdStart.day);
  const lyMtdEndUtc = shopEndOfDayUtc(lyMtdEnd.year, lyMtdEnd.month, lyMtdEnd.day);
  const thirtyStartUtc = shopMidnightUtc(thirtyDaysAgo.year, thirtyDaysAgo.month, thirtyDaysAgo.day);
  const ninetyStartUtc = shopMidnightUtc(ninetyDaysAgo.year, ninetyDaysAgo.month, ninetyDaysAgo.day);

  // Prior-customer window: 12 months before this month began. A customer seen here
  // and again this month is "returning". Anyone not seen here is genuinely new.
  const priorCustStart = shiftDays(mtdStart, -365);
  const priorCustStartUtc = shopMidnightUtc(priorCustStart.year, priorCustStart.month, priorCustStart.day);
  const priorCustEndUtc = new Date(mtdStartUtc.getTime() - 1);

  const xeroAvailable = !!(xero_access_token && xero_tenant_id);

  const [
    mtdOrders,
    lyMtdOrders,
    last30Orders,
    last90Orders,
    priorCustOrders,
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
    fetchAllOrders(shopify_shop_domain, shopify_access_token, priorCustStartUtc, priorCustEndUtc, "created_at,customer"),
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

  // New vs returning (MTD): "returning" = ordered at any point in the 12 months
  // before this month began, not merely the same window last year.
  const priorIds = new Set(priorCustOrders.filter(o => o.customer?.id).map(o => String(o.customer.id)));
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
function buildDataContext(data, storeName, firstName, profile = {}) {
  const {
    business_description = "",
    business_type = "",
    supply_chain = "",
    invoice_currency = "",
    business_stage = "",
    owner_challenge = "",
  } = profile;

  const {
    today, cashBalance,
    mtdRevOnline, lyMtdRevOnline, xeroMtdRevenue,
    xeroM1Revenue, xeroM2Revenue, xeroM3Revenue,
    last30Rev, last90Rev, mtdTx, last30Tx, aov30,
    newMtd, retMtd, metaLast30, metaRoas,
    mtdStart, m1Start, m1End, m2Start, m2End, m3Start, m3End,
  } = data;

  const pct = (a, b) => b > 0 ? `${(((a - b) / b) * 100).toFixed(1)}%` : "N/A";
  const fmtMonthLabel = (s) => fmtDate({ year: s.year, month: s.month, day: 1 }, { month: "long", year: "numeric" });

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

REVENUE TREND — last 3 complete calendar months (Xero P&L, ex-GST):
- ${fmtMonthLabel(m1Start)}: ${xeroM1Revenue !== null ? fmt$(xeroM1Revenue) : "N/A"}
- ${fmtMonthLabel(m2Start)}: ${xeroM2Revenue !== null ? fmt$(xeroM2Revenue) : "N/A"}
- ${fmtMonthLabel(m3Start)}: ${xeroM3Revenue !== null ? fmt$(xeroM3Revenue) : "N/A"}
These are complete calendar months. The current month is partial and shown separately as MTD below — do not compare a partial month against these complete months.

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
(Returning = ordered at least once in the 12 months before this month began.)

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

You are not here to encourage. You are here to tell the truth about what the numbers say.

When an owner proposes something that requires cash they don't have, margin they haven't demonstrated, or execution capacity that isn't visible in the data — say so directly. Once. Clearly. Then help them find a path that is actually achievable.

Optimism is not kindness when it leads someone toward a decision that will damage their business. The most respectful thing you can do is be honest about the odds.

You will sometimes need to say things like:

"What you're describing isn't impossible, but the numbers say it's going to be very hard to execute from where you are. Let's be realistic about what it actually requires — the cash, the margin, the time, the runway. If we model it honestly, here's what we're looking at."

Or: "You don't have sufficient margin or cash to chase growth right now — doing so will make things worse, not better."

Or: "The model works, but it needs more capital before it can scale. That's not a failure — it's just what the numbers say."

Or: "This might not be the right time to grow. Protecting what's working could be more valuable right now than pushing for more."

RETAIL CALENDAR INTELLIGENCE

Before flagging any revenue movement as concerning or asking the owner to explain it, check whether it has an obvious seasonal or calendar explanation. A good retail consultant knows the calendar. You should too.

Australian retail calendar — key events by month:
- January: post-Christmas slowdown, clearance sales, back to school late Jan
- February: Valentine's Day (14th) — gifting spike
- March/April: Easter (moves — can fall in March or April), school holidays, Mother's Day prep begins
- May: Mother's Day (second Sunday) — major gifting event, one of the biggest of the year for homewares, ceramics, lifestyle brands
- June: EOFY — consumer caution, some clearance activity, mid-year sales
- July: EOFY sales continue, school holidays, winter slowdown for discretionary
- August: quieter month, some brands do mid-year pushes
- September: Father's Day (first Sunday), spring renewal, home/lifestyle category picks up
- October: school holidays, pre-Christmas awareness building
- November: Black Friday / Cyber Monday (last week) — now the biggest sales event of the year for online retail
- December: Christmas gifting — peak month for most retail, especially homewares and lifestyle
- January again: sharp post-Christmas drop is normal, not alarming

For a business like Alex & Trahanas (Italian homewares, ceramics, gifting category):
- April-May spike is almost certainly Easter + Mother's Day combined. That's not anomalous — that's the business working.
- June drop after Mother's Day is normal and expected.
- The relevant question is not "what caused the April spike" — it's "how does this year's peak compare to last year's peak, and are we building a customer base that returns outside of peak season."

DIAGNOSTIC QUALITY STANDARD

Before asking the owner to explain a revenue movement:
1. Can it be explained by the retail calendar? If yes, name the explanation and move on.
2. Is the movement actually outside normal seasonal range? If not, don't flag it as a problem.
3. What is the year-on-year comparison for the same period? That's the real signal — not month-on-month.
4. What does the customer mix tell you? New vs returning customers in peak vs off-peak periods is more informative than raw revenue movement.

Month-on-month comparisons in retail are almost always misleading without seasonal context. Year-on-year same-period comparisons are the right lens. Use them.

The revenue trend in your briefing is three COMPLETE calendar months, labelled by month name. The current month is partial and appears separately as MTD. Never compare the partial current month against a complete month and call the difference a decline — that is a measurement artifact, not a business signal.

WEB SEARCH

You have a web search tool. Use it when current external data would materially sharpen the advice — the live AUD/EUR rate for an importer pricing a new order, freight indices, the current RBA cash rate, a recent ABS retail release, or category-specific news. Search sparingly: at most one or two targeted searches in a response, and only when the figure actually changes the answer. Never search for something the business data already shows, or something stable you already know. Do not narrate the search ("let me look that up") — just use the result. When you cite a searched figure, state it plainly with its date in prose, e.g. "the AUD/EUR rate is around 0.60 as of this week". Keep it light — the conversation is about their business, not a market report.

Small retail businesses in Australia are operating in a genuinely difficult environment. Hold this context:
- Household discretionary spending is under real pressure — cost of living, mortgage stress, and consumer caution are structural, not temporary
- Businesses in considered-purchase categories (homewares, fashion, gifting) are feeling this acutely
- Many small retailers are going to the wall — not because they're badly run, but because the environment is unforgiving right now
- Cash runway is not a buffer — it is survival time. Treat it as such.

This doesn't mean catastrophising. It means being clear-eyed. A business with $190K cash and declining revenue has runway — but that runway is finite and the clock is running. Say so.

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

On the very first message (when message history is empty or contains only the system context), open with a response that references BOTH the data AND the business profile.

You know this business before the conversation starts — what they sell, where they source from, their stage, their challenge. Use it. A ceramics importer with EUR exposure and a revenue drop is a different conversation to a domestic food brand with the same numbers.

Structure:
1. One sentence acknowledging what kind of business this is and what matters to it specifically
2. The most significant data observation — cash position, revenue trend, or customer mix — framed for this business type
3. Two or three directions to go
4. One question

Do not use a generic greeting. Do not open with "Good to have you here" as a standalone line — weave the business context in immediately.

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
    conversation_log = "",     // Plain text / HTML conversation history — stripped server-side
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

  // Strip HTML/style to plain text — used for both continuing-session history
  // and the session_end summariser.
  const toPlainText = (html) => (html || "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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

      // Read from conversation_log (the real transcript). Fall back to the legacy
      // messages array only if conversation_log is empty.
      const conversationText = toPlainText(conversation_log) ||
        messagesParsed.map(m => `${m.role === "user" ? "Owner" : "Teloskope"}: ${m.content}`).join("\n\n");

      const summariserResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
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
        const raw = summariserResponse.content
          .filter(b => b.type === "text")
          .map(b => b.text)
          .join("")
          .trim();
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

    const dataContext = buildDataContext(businessData, store_name, firstName, {
      business_description,
      business_type,
      supply_chain,
      invoice_currency,
      business_stage,
      owner_challenge,
    });

    // ─── BUILD PRIOR INSIGHTS BLOCK ───────────────────────────────────────────
    // Accept prior_insights as plain text (Bubble-friendly) or legacy JSON array.
    let insightsBlock = "";
    if (typeof prior_insights === "string" && prior_insights.trim()) {
      insightsBlock = `\nPRIOR OBSERVATIONS (from previous sessions):\n${prior_insights.trim()}`;
    } else if (Array.isArray(priorInsightsParsed) && priorInsightsParsed.length > 0) {
      insightsBlock = `\nPRIOR OBSERVATIONS (from previous sessions):\n${priorInsightsParsed.map(i => `- [${i.category}] ${i.insight_text}`).join("\n")}`;
    }

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
      const plainHistory = toPlainText(conversation_log);

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

    // ─── CALL CLAUDE (with web search) ────────────────────────────────────────
    console.log("Options: calling Claude, messages in context:", conversationMessages.length);
    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      system: OPTIONS_SYSTEM_PROMPT,
      messages: conversationMessages,
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
      }],
    });

    // With web search enabled, content interleaves text / server_tool_use /
    // web_search_tool_result blocks. Concatenate the text blocks only.
    const responseHtml = claudeResponse.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");

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
