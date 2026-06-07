// api/generate-weekly-brief.js
// V1.6: Updated weekly market context for Italian import retailers (EOFY + Mediterranean freight + AUD/EUR).
//       Updated system prompt macro context instruction to reference weekly context block.
// V1.5: Added Meta Ads insights (weekly spend, impressions, clicks + MTD spend).
// V1.4: Removed PCW. Removed Options section. Added ABS macro context. Cash balance number only.
// Pulls Shopify + Xero (cash + P&L total revenue) + Meta Ads → Claude → ElevenLabs → Bubble → Twilio SMS.
// ALL figures ex-GST.

import Anthropic from "@anthropic-ai/sdk";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = "Zpq4UaaRVMryEw8KSTWI";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BUBBLE_BASE_URL = "https://teloskope.bubbleapps.io/version-test/api/1.1";

// ─── DATE HELPERS (fixed UTC+10 to match Shopify store timezone) ──────────────
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

const pad = (n) => String(n).padStart(2, "0");
const stripGst = (gross) => gross / 1.1;

// ─── BUBBLE CDN URL HELPER ────────────────────────────────────────────────────
function cleanBubbleUrl(raw) {
  const stripped = raw.trim().replace(/^"|"$/g, "");
  return stripped.startsWith("//") ? `https:${stripped}` : stripped;
}

// ─── WEEKLY MARKET CONTEXT (update each Monday) ───────────────────────────────
// V1.6: EOFY + Mediterranean freight context for Italian import retailers
// Next update due: week of 15 June 2026
const ABS_MACRO_CONTEXT = `
WEEKLY MARKET CONTEXT (week of 8 June 2026):

EOFY CONSUMER BEHAVIOUR:
- Two weeks out from 30 June. Discretionary spending on considered purchases — homewares, ceramics, gifting — typically softens in the final two weeks of the financial year as households focus on bills, tax returns, and super contributions.
- Opportunity: EOFY is also a clearance window. Consumers respond well to end-of-year promotions on considered items. Moving older inventory before new season stock arrives is worth considering.
- ABS April 2026 context: Furnishings and household equipment was essentially flat (-0.1%) in April. Annual spending still up 4.9% year on year despite the monthly dip.

MEDITERRANEAN FREIGHT & SUPPLY CHAIN (relevant to Italian importers):
- Red Sea disruptions continue to push Mediterranean cargo via Cape of Good Hope. Transit times to Australia from southern Italy are running 2-3 weeks longer than pre-2024 norms.
- Freight rates on Mediterranean-Australia routes remain elevated vs 2023 base. Next container quote from Italian suppliers is likely to reflect this — landed cost per piece warrants close attention.
- Hormuz situation has stabilised near-term but remains a watch item for energy and freight cost volatility through Q3 2026.

AUD/EUR:
- AUD has been soft against EUR over the past 12 months. Italian suppliers invoicing in EUR means landed cost in AUD is materially higher than 18 months ago. Worth factoring into margin review on next order.

ITALIAN PRODUCTION SEASONALITY:
- Southern Italian ceramic workshops typically slow through July-August (local summer). Retailers dependent on this supply chain should confirm next order timing now to avoid a stock gap in October-November.
`;

// ─── XERO HELPERS ─────────────────────────────────────────────────────────────

async function refreshXeroToken(xeroRefreshToken, xeroConnectionId) {
  try {
    console.log("Refreshing Xero token...");
    const clientId = process.env.XERO_CLIENT_ID;
    const clientSecret = process.env.XERO_CLIENT_SECRET;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const refreshRes = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: xeroRefreshToken,
      }),
    });

    if (!refreshRes.ok) {
      console.error("Xero token refresh failed:", refreshRes.status, await refreshRes.text());
      return null;
    }

    const tokens = await refreshRes.json();
    console.log("Xero token refreshed successfully");

    const expiresAt = new Date(Date.now() + (tokens.expires_in - 120) * 1000).toISOString();
    const bubblePatch = await fetch(
      `${BUBBLE_BASE_URL}/obj/xero_connection/${xeroConnectionId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`,
        },
        body: JSON.stringify({
          xero_access_token: tokens.access_token,
          xero_refresh_token: tokens.refresh_token,
          token_expires_at: expiresAt,
        }),
      }
    );

    if (!bubblePatch.ok) {
      console.error("Failed to save refreshed Xero token to Bubble:", await bubblePatch.text());
    } else {
      console.log("New Xero tokens saved to Bubble");
    }

    return tokens.access_token;
  } catch (err) {
    console.error("Xero refresh error:", err.message);
    return null;
  }
}

async function fetchXeroCashBalance(xeroAccessToken, xeroTenantId, xeroRefreshToken, xeroConnectionId) {
  const today = new Date().toISOString().split("T")[0];
  console.log("Fetching Xero BalanceSheet as at:", today);
  const doFetch = async (token) => {
    return fetch(`https://api.xero.com/api.xro/2.0/Reports/BalanceSheet?date=${today}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Xero-tenant-id": xeroTenantId,
        Accept: "application/json",
      },
    });
  };

  try {
    let response = await doFetch(xeroAccessToken);

    if (response.status === 401 && xeroRefreshToken && xeroConnectionId) {
      console.log("Xero token expired — refreshing...");
      const newToken = await refreshXeroToken(xeroRefreshToken, xeroConnectionId);
      if (newToken) {
        response = await doFetch(newToken);
      } else {
        return null;
      }
    }

    if (!response.ok) {
      console.error("Xero BalanceSheet error:", response.status, await response.text());
      return null;
    }

    const data = await response.json();
    const report = data?.Reports?.[0];
    if (!report) return null;

    let totalBank = null;
    let cashFallback = null;

    const searchRows = (rows) => {
      for (const row of rows || []) {
        if (row.RowType === "Row" || row.RowType === "SummaryRow") {
          const label = (row.Cells?.[0]?.Value || "").toLowerCase();
          const val = parseFloat((row.Cells?.[1]?.Value || "").replace(/,/g, ""));
          if (!isNaN(val)) {
            if (label.includes("total bank") && totalBank === null) {
              console.log("Xero Total Bank found:", row.Cells?.[0]?.Value, "=", val);
              totalBank = val;
            } else if (label.includes("cash") && cashFallback === null) {
              console.log("Xero cash fallback:", row.Cells?.[0]?.Value, "=", val);
              cashFallback = val;
            }
          }
        }
        if (row.Rows) searchRows(row.Rows);
      }
    };

    searchRows(report.Rows);
    const result = totalBank !== null ? totalBank : cashFallback;
    console.log("Xero reconciled bank position:", result);
    return result;
  } catch (err) {
    console.error("Xero fetch error:", err.message);
    return null;
  }
}

async function fetchXeroTotalRevenue(start, end, xeroAccessToken, xeroTenantId, xeroRefreshToken, xeroConnectionId) {
  const fromIso = start.toISOString().split("T")[0];
  const toIso   = end.toISOString().split("T")[0];

  const doFetch = async (token) => {
    return fetch(`https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${fromIso}&toDate=${toIso}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Xero-tenant-id": xeroTenantId,
        Accept: "application/json",
      },
    });
  };

  try {
    let response = await doFetch(xeroAccessToken);

    if (response.status === 401 && xeroRefreshToken && xeroConnectionId) {
      console.log("Xero token expired during P&L fetch — refreshing...");
      const newToken = await refreshXeroToken(xeroRefreshToken, xeroConnectionId);
      if (newToken) {
        response = await doFetch(newToken);
      } else {
        return null;
      }
    }

    if (!response.ok) {
      console.error("Xero P&L error:", response.status, await response.text());
      return null;
    }

    const data = await response.json();
    const report = data?.Reports?.[0];
    if (!report) return null;

    let totalIncome = null;
    const searchRows = (rows) => {
      for (const row of rows || []) {
        if (row.RowType === "Row" || row.RowType === "SummaryRow") {
          const label = (row.Cells?.[0]?.Value || "").toLowerCase().trim();
          const val = parseFloat((row.Cells?.[1]?.Value || "").replace(/,/g, ""));
          if (!isNaN(val)) {
            if ((label === "total trading income" || label === "total income" || label === "total revenue") && totalIncome === null) {
              console.log("Xero Total Income found:", row.Cells?.[0]?.Value, "=", val);
              totalIncome = val;
              return;
            }
          }
        }
        if (row.Rows) searchRows(row.Rows);
      }
    };
    searchRows(report.Rows);

    return totalIncome;
  } catch (err) {
    console.error("Xero P&L fetch error:", err.message);
    return null;
  }
}

// ─── META HELPERS ─────────────────────────────────────────────────────────────

async function fetchMetaInsights(metaAccessToken, metaAdAccountId, datePreset) {
  if (!metaAccessToken || !metaAdAccountId) return null;
  try {
    const url = `https://graph.facebook.com/v25.0/${metaAdAccountId}/insights?fields=spend,impressions,clicks&date_preset=${datePreset}&level=account&access_token=${metaAccessToken}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Meta API error (${datePreset}):`, res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const row = data?.data?.[0];
    if (!row) {
      console.log(`Meta insights (${datePreset}): no data returned (no spend in period)`);
      return { spend: 0, impressions: 0, clicks: 0 };
    }
    return {
      spend: parseFloat(row.spend || 0),
      impressions: parseInt(row.impressions || 0),
      clicks: parseInt(row.clicks || 0),
    };
  } catch (err) {
    console.error(`Meta fetch error (${datePreset}):`, err.message);
    return null;
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    shopify_shop_domain,
    shopify_access_token,
    xero_access_token,
    xero_refresh_token,
    xero_tenant_id,
    xero_connection_id,
    bubble_secret_key,
    user_id,
    user_name,
    user_phone,
    store_name,
    brief_page_base_url,
    meta_access_token,
    meta_ad_account_id,
  } = req.body;

  if (!shopify_shop_domain || !shopify_access_token || !bubble_secret_key || !user_id || !user_phone) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (shopify_shop_domain === "test.myshopify.com") {
    return res.status(200).json({
      success: true,
      brief_id: "test_brief_id",
      brief_url: "https://teloskope.bubbleapps.io/version-test/brief/test",
      audio_url: "https://api.elevenlabs.io/v1/history/test/audio",
      week_end: "2026-03-22",
      sms_sent_to: "+61400000000",
    });
  }

  try {
    // ─── DATE CALCULATIONS ────────────────────────────────────────────────────
    const nowUtc = new Date();
    const today = getShopDateParts(nowUtc);

    console.log("UTC now:", nowUtc.toISOString());
    console.log("Shop date (UTC+10):", today);

    const daysBackToSunday = today.dayOfWeek === 0 ? 7 : today.dayOfWeek;
    const weekEnd   = shiftDays(today, -daysBackToSunday);
    const weekStart = shiftDays(weekEnd, -6);

    const mtdStart   = { year: weekEnd.year, month: weekEnd.month, day: 1 };
    const mtdEnd     = weekEnd;
    const lyMtdStart = shiftYear(mtdStart, -1);
    const lyMtdEnd   = shiftYear(mtdEnd, -1);

    const ytdStart   = { year: weekEnd.year, month: 0, day: 1 };
    const ytdEnd     = weekEnd;
    const lyYtdStart = shiftYear(ytdStart, -1);
    const lyYtdEnd   = shiftYear(ytdEnd, -1);

    const wS  = shopMidnightUtc(weekStart.year, weekStart.month, weekStart.day);
    const wE  = shopEndOfDayUtc(weekEnd.year, weekEnd.month, weekEnd.day);
    const mS  = shopMidnightUtc(mtdStart.year, mtdStart.month, mtdStart.day);
    const mE  = shopEndOfDayUtc(mtdEnd.year, mtdEnd.month, mtdEnd.day);
    const lmS = shopMidnightUtc(lyMtdStart.year, lyMtdStart.month, lyMtdStart.day);
    const lmE = shopEndOfDayUtc(lyMtdEnd.year, lyMtdEnd.month, lyMtdEnd.day);
    const yS  = shopMidnightUtc(ytdStart.year, ytdStart.month, ytdStart.day);
    const yE  = shopEndOfDayUtc(ytdEnd.year, ytdEnd.month, ytdEnd.day);
    const lyS = shopMidnightUtc(lyYtdStart.year, lyYtdStart.month, lyYtdStart.day);
    const lyE = shopEndOfDayUtc(lyYtdEnd.year, lyYtdEnd.month, lyYtdEnd.day);

    console.log("Week:   ", wS.toISOString(), "→", wE.toISOString());
    console.log("MTD:    ", mS.toISOString(), "→", mE.toISOString());

    // ─── SHOPIFY HELPERS ──────────────────────────────────────────────────────
    const fetchAllOrders = async (start, end, fields = "total_price,created_at") => {
      let orders = [];
      let url = `https://${shopify_shop_domain}/admin/api/2024-01/orders.json?status=any&financial_status=any&created_at_min=${start.toISOString()}&created_at_max=${end.toISOString()}&fields=${fields}&limit=250`;
      while (url) {
        const r = await fetch(url, { headers: { "X-Shopify-Access-Token": shopify_access_token } });
        if (!r.ok) throw new Error(`Shopify error ${r.status}: ${await r.text()}`);
        const data = await r.json();
        orders = orders.concat(data.orders || []);
        const link = r.headers.get("Link");
        url = (link && link.includes('rel="next"'))
          ? (link.match(/<([^>]+)>;\s*rel="next"/) || [])[1] || null
          : null;
      }
      return orders;
    };

    const sumRevenueGross = (orders) => orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
    const sumRevenueExGst = (orders) => stripGst(sumRevenueGross(orders));
    const calcAovExGst    = (orders) => orders.length > 0 ? sumRevenueExGst(orders) / orders.length : 0;

    const calcLocations = (orders) => {
      const stateCounts = {};
      let ausCount = 0, overseasCount = 0;
      for (const o of orders) {
        const addr = o.shipping_address;
        if (!addr) continue;
        const country = (addr.country_code || "").toUpperCase();
        if (country === "AU" || country === "") {
          ausCount++;
          const state = (addr.province || addr.province_code || "Unknown").trim();
          stateCounts[state] = (stateCounts[state] || 0) + 1;
        } else {
          overseasCount++;
        }
      }
      const total = ausCount + overseasCount;
      const topStates = Object.entries(stateCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([state, count]) => ({
          state, count,
          pct: total > 0 ? Math.round((count / total) * 100) : 0,
        }));
      return {
        topStates, ausCount, overseasCount,
        ausPct: total > 0 ? Math.round((ausCount / total) * 100) : 0,
        overseaPct: total > 0 ? Math.round((overseasCount / total) * 100) : 0,
        total,
      };
    };

    // ─── PARALLEL FETCH ───────────────────────────────────────────────────────
    console.log("Fetching Shopify data + Xero...");
    const xeroAvailable = !!(xero_access_token && xero_tenant_id);

    const [
      weekOrders,
      mtdOrders, lyMtdOrders,
      ytdOrders, lyYtdOrders,
      preMtdOrders, preLyMtdOrders,
      weekOrdersDetail,
      xeroCashBalance,
      xeroWeekTotalRevenue,
      xeroMtdTotalRevenue,
      metaWeek,
      metaMtd,
    ] = await Promise.all([
      fetchAllOrders(wS, wE),
      fetchAllOrders(mS, mE, "total_price,created_at,customer"),
      fetchAllOrders(lmS, lmE, "total_price,created_at,customer"),
      fetchAllOrders(yS, yE),
      fetchAllOrders(lyS, lyE),
      fetchAllOrders(yS, new Date(mS.getTime() - 1), "created_at,customer"),
      fetchAllOrders(lyS, new Date(lmS.getTime() - 1), "created_at,customer"),
      fetchAllOrders(wS, wE, "line_items,shipping_address"),
      xeroAvailable ? fetchXeroCashBalance(xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id) : Promise.resolve(null),
      xeroAvailable ? fetchXeroTotalRevenue(wS, wE, xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id) : Promise.resolve(null),
      xeroAvailable ? fetchXeroTotalRevenue(mS, mE, xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id) : Promise.resolve(null),
      fetchMetaInsights(meta_access_token, meta_ad_account_id, "last_7d"),
      fetchMetaInsights(meta_access_token, meta_ad_account_id, "last_30d"),
    ]);

    console.log("Week orders:", weekOrders.length, "| Revenue ex-GST:", sumRevenueExGst(weekOrders).toFixed(2));
    console.log("MTD orders:", mtdOrders.length, "| Revenue ex-GST:", sumRevenueExGst(mtdOrders).toFixed(2));
    console.log("Xero reconciled bank position:", xeroCashBalance);
    console.log("Xero P&L week total (ex-GST):", xeroWeekTotalRevenue);
    console.log("Xero P&L MTD total (ex-GST):", xeroMtdTotalRevenue);
    console.log("Meta week insights:", metaWeek);
    console.log("Meta MTD insights:", metaMtd);

    // ─── NEW VS RETURNING CUSTOMER LOGIC ─────────────────────────────────────
    const preMtdCustomerIds = new Set(preMtdOrders.filter(o => o.customer?.id).map(o => String(o.customer.id)));
    const preLyMtdCustomerIds = new Set(preLyMtdOrders.filter(o => o.customer?.id).map(o => String(o.customer.id)));

    const countNewRet = (orders, priorCustomerIds) => {
      let newC = 0, ret = 0;
      for (const o of orders) {
        if (!o.customer?.id) { newC++; continue; }
        priorCustomerIds.has(String(o.customer.id)) ? ret++ : newC++;
      }
      return { newC, ret };
    };

    // ─── CALCULATIONS (ALL EX-GST) ────────────────────────────────────────────
    const weekRev  = sumRevenueExGst(weekOrders);
    const mtdRev   = sumRevenueExGst(mtdOrders);
    const lyMtdRev = sumRevenueExGst(lyMtdOrders);
    const ytdRev   = sumRevenueExGst(ytdOrders);
    const lyYtdRev = sumRevenueExGst(lyYtdOrders);
    const weekTx   = weekOrders.length;
    const mtdTx    = mtdOrders.length;
    const lyMtdTx  = lyMtdOrders.length;
    const weekAov  = calcAovExGst(weekOrders);

    const { newC: newMtd, ret: retMtd }     = countNewRet(mtdOrders, preMtdCustomerIds);
    const { newC: newLyMtd, ret: retLyMtd } = countNewRet(lyMtdOrders, preLyMtdCustomerIds);

    const productMap = {};
    for (const order of weekOrdersDetail) {
      for (const item of order.line_items || []) {
        const key = item.product_id;
        if (!productMap[key]) productMap[key] = { title: item.title, quantity: 0 };
        productMap[key].quantity += item.quantity;
      }
    }
    const topProducts = Object.values(productMap).sort((a, b) => b.quantity - a.quantity).slice(0, 5);
    const locations   = calcLocations(weekOrdersDetail);

    // ─── Total sales (Xero) vs Shopify split, both ex-GST ────────────────────
    const weekOtherSales = (xeroWeekTotalRevenue !== null && xeroWeekTotalRevenue !== undefined)
      ? Math.max(0, xeroWeekTotalRevenue - weekRev)
      : null;
    const mtdOtherSales = (xeroMtdTotalRevenue !== null && xeroMtdTotalRevenue !== undefined)
      ? Math.max(0, xeroMtdTotalRevenue - mtdRev)
      : null;

    const weekOnlinePct = (xeroWeekTotalRevenue && xeroWeekTotalRevenue > 0) ? weekRev / xeroWeekTotalRevenue : null;
    const weekOtherPct  = (xeroWeekTotalRevenue && xeroWeekTotalRevenue > 0 && weekOtherSales !== null) ? weekOtherSales / xeroWeekTotalRevenue : null;
    const mtdOnlinePct  = (xeroMtdTotalRevenue  && xeroMtdTotalRevenue  > 0) ? mtdRev / xeroMtdTotalRevenue : null;
    const mtdOtherPct   = (xeroMtdTotalRevenue  && xeroMtdTotalRevenue  > 0 && mtdOtherSales !== null) ? mtdOtherSales / xeroMtdTotalRevenue : null;

    console.log("Week split — Online:", weekRev.toFixed(2), "Other:", weekOtherSales, "Total:", xeroWeekTotalRevenue);
    console.log("MTD split — Online:", mtdRev.toFixed(2), "Other:", mtdOtherSales, "Total:", xeroMtdTotalRevenue);

    const pct    = (a, b) => b > 0 ? `${(((a - b) / b) * 100).toFixed(1)}%` : "N/A";
    const fmt$   = (n) => `$${Math.round(n).toLocaleString()}`;
    const fmtPct = (n) => (n * 100).toFixed(1) + "%";

    const hasLyMtd  = lyMtdRev > 0 || lyMtdTx > 0;
    const hasLyYtd  = lyYtdRev > 0;

    const weekLabel  = `week ending ${fmtDate(weekEnd)}`;
    const monthLabel = fmtDate({ year: weekEnd.year, month: weekEnd.month, day: 1 }, { month: "long", year: "numeric" });
    const cashNum  = xeroCashBalance !== null && xeroCashBalance !== undefined ? fmt$(xeroCashBalance) : null;
    const cashNote = xeroCashBalance !== null && xeroCashBalance !== undefined
      ? `${fmt$(xeroCashBalance)} at last reconciled date`
      : "not available";

    const firstName = (user_name || "").split(" ")[0] || user_name;

    // ─── TOTAL SALES BLOCK ────────────────────────────────────────────────────
    const totalSalesBlock = (() => {
      if (xeroWeekTotalRevenue === null || xeroWeekTotalRevenue === undefined) {
        return "TOTAL SALES (Xero P&L): not available — Xero not connected or no reconciled data yet";
      }
      const lines = [];
      lines.push(`TOTAL SALES (this week, Xero reconciled, ex-GST):`);
      lines.push(`- Online (Shopify): ${fmt$(weekRev)}${weekOnlinePct !== null ? ` (${fmtPct(weekOnlinePct)})` : ""}`);
      if (weekOtherSales !== null) {
        lines.push(`- Other (in-store + wholesale): ${fmt$(weekOtherSales)}${weekOtherPct !== null ? ` (${fmtPct(weekOtherPct)})` : ""}`);
      }
      lines.push(`- Total: ${fmt$(xeroWeekTotalRevenue)}`);
      if (xeroMtdTotalRevenue !== null && xeroMtdTotalRevenue !== undefined) {
        lines.push("");
        lines.push(`TOTAL SALES (MTD, Xero reconciled, ex-GST):`);
        lines.push(`- Online (Shopify): ${fmt$(mtdRev)}${mtdOnlinePct !== null ? ` (${fmtPct(mtdOnlinePct)})` : ""}`);
        if (mtdOtherSales !== null) {
          lines.push(`- Other (in-store + wholesale): ${fmt$(mtdOtherSales)}${mtdOtherPct !== null ? ` (${fmtPct(mtdOtherPct)})` : ""}`);
        }
        lines.push(`- Total: ${fmt$(xeroMtdTotalRevenue)}`);
      }
      return lines.join("\n");
    })();

    // ─── CLAUDE PROMPT ────────────────────────────────────────────────────────
    const dataBlock = `
STORE: ${store_name}
OWNER FIRST NAME: ${firstName}
PERIOD: ${weekLabel}
ALL FIGURES EX-GST UNLESS NOTED OTHERWISE.

${totalSalesBlock}

ONLINE PERFORMANCE (Shopify, ex-GST):
- Revenue this week: ${fmt$(weekRev)} | ${weekTx} orders | AOV ${fmt$(weekAov)}

RECONCILED BANK POSITION (Xero):
- Bank balance: ${cashNote}

ONLINE MONTH TO DATE (${monthLabel}, Shopify, ex-GST):
- Revenue: ${fmt$(mtdRev)} | ${mtdTx} orders
- Last year MTD: ${hasLyMtd ? `${fmt$(lyMtdRev)}, ${lyMtdTx} orders (${pct(mtdRev, lyMtdRev)} change)` : "not available"}

ONLINE YEAR TO DATE (Shopify, ex-GST):
- Revenue: ${fmt$(ytdRev)}
- Last year YTD: ${hasLyYtd ? `${fmt$(lyYtdRev)} (${pct(ytdRev, lyYtdRev)} change)` : "not available — first year online"}

CUSTOMER MIX (MTD, Shopify):
- New customers (first order this year): ${newMtd}${hasLyMtd ? ` vs LY: ${newLyMtd}` : ""}
- Returning customers (ordered before this month): ${retMtd}${hasLyMtd ? ` vs LY: ${retLyMtd}` : ""}

CUSTOMER LOCATIONS (this week, Shopify):
- Australia: ${locations.ausPct}% | Overseas: ${locations.overseaPct}%
${locations.topStates.map(s => `- ${s.state}: ${s.count} orders (${s.pct}%)`).join("\n")}

TOP 5 PRODUCTS THIS WEEK (Shopify):
${topProducts.length > 0
  ? topProducts.map((p, i) => `${i + 1}. ${p.title} — ${p.quantity} units`).join("\n")
  : "No orders this week"}

META ADS (last 7 days):
${metaWeek
  ? `- Spend: $${metaWeek.spend.toFixed(2)} | Impressions: ${metaWeek.impressions.toLocaleString()} | Clicks: ${metaWeek.clicks.toLocaleString()}
- CPM: $${metaWeek.impressions > 0 ? ((metaWeek.spend / metaWeek.impressions) * 1000).toFixed(2) : "N/A"} (AU retail benchmark: $15–35)
- CPC: $${metaWeek.clicks > 0 ? (metaWeek.spend / metaWeek.clicks).toFixed(2) : "N/A"} (AU retail benchmark: $1.50–3.00)`
  : "- Not connected or no data"}

META ADS (month to date):
${metaMtd
  ? `- Spend: $${metaMtd.spend.toFixed(2)} | Impressions: ${metaMtd.impressions.toLocaleString()} | Clicks: ${metaMtd.clicks.toLocaleString()}
- CPM: $${metaMtd.impressions > 0 ? ((metaMtd.spend / metaMtd.impressions) * 1000).toFixed(2) : "N/A"} (AU retail benchmark: $15–35)
- CPC: $${metaMtd.clicks > 0 ? (metaMtd.spend / metaMtd.clicks).toFixed(2) : "N/A"} (AU retail benchmark: $1.50–3.00)`
  : "- Not connected or no data"}

${ABS_MACRO_CONTEXT}
`;

    const systemPrompt = `You are Teloskope, a smart weekly business advisor for independent retail store owners.
Write a warm, direct, insightful weekly audio brief for a store owner to listen to on Monday morning.
Write in a conversational Australian tone — like a trusted business advisor, not a corporate report.
Be specific with numbers. Be honest about what looks good and what needs watching.
Write in flowing paragraphs only — absolutely no bullet points, no headers, no markdown formatting of any kind.
Do not use any symbols, asterisks, dollar signs, percent signs, or special characters of any kind.

CRITICAL — NUMBER FORMATTING FOR AUDIO:
This script will be read aloud by a text-to-speech voice. You must write ALL numbers in full spoken words so they sound natural when read aloud. Follow these rules strictly:
- Dollar amounts over one thousand: express in K to one decimal place — e.g. "fourteen point two K", "fifty eight point seven K". For x.5 values use "and a half" — e.g. "seventeen and a half K". Never say "fourteen thousand two hundred dollars".
- Dollar amounts under one thousand: round to nearest dollar, state in full words — e.g. "five hundred and sixty seven dollars". Never state cents.
- Percentages: write as words e.g. "thirteen point three percent" not "13.3%"
- Order counts: write as words e.g. "eighteen orders" not "18 orders"
- All other numbers: write in full words

ALL FIGURES ARE EX-GST. You can mention "ex-GST" once near the start, but don't repeat it every sentence.

The brief should take about 90 to 120 seconds to read aloud.

STRUCTURE — follow this order exactly:
1. Open with "Good morning [owner first name]." then immediately give 1-2 sentences of weekly market context from the WEEKLY MARKET CONTEXT block — pick the most relevant angle for this specific store (Italian importer, homewares/ceramics category, EOFY timing). Frame it as a consultant setting the scene — specific, useful, not alarming. End with a bridging sentence like "Against that backdrop, here's how [store name] traded this week."
2. Total sales for the week (online plus other combined, ex-GST), split into online and other.
3. MTD total sales split into online and other, with last year MTD comparison and brief commentary on the trend.
4. Reconciled bank balance — state the number and note it is at last reconciled date. No evaluative commentary whatsoever.
5. Online transactions and AOV this week.
6. Customer mix MTD vs last year MTD.
7. Top products this week.
8. Meta ads — see META ADS instruction below.
9. Close with one specific, actionable observation drawn from the weekly market context — something the owner can actually do or watch this week. Then sign-off.

CASH BALANCE INSTRUCTION: Simply state the bank balance figure and that it is at last reconciled date. Do not add any evaluative commentary — no "that's healthy", no "needs attention", no qualitative judgement of any kind.

The "Other" sales figure (in-store + wholesale) comes from Xero reconciled data minus Shopify. Treat as the most accurate available picture without over-claiming precision.

When last year data is not available, acknowledge it briefly and move on.

META ADS: If Meta data is available, report spend for the week and MTD. State the CPM and CPC figures and explicitly benchmark them against AU retail averages — e.g. "your cost per click this month was one dollar eleven, against an Australian retail benchmark of one dollar fifty to three dollars — well inside that range. Your cost per thousand impressions was twenty eight dollars, against a benchmark of fifteen to thirty five dollars — again solid." If no spend this week but MTD spend exists, note that briefly then give the MTD benchmark read. If zero spend across both periods, skip Meta entirely.

Do NOT include any "Options to explore" section. End directly with this sign-off on a new line: "That's your Teloskope brief for the week. Have a great Monday, and I'll be back next week with your next update."`;

    const userPrompt = `Here is the data for ${store_name} for the ${weekLabel}.

${dataBlock}

Write the Teloskope weekly audio brief. Follow the structure order exactly. Express all dollar amounts over one thousand in K format. Under one thousand, full words, no cents. No symbols, no dollar signs, no percent signs. Start with "Good morning ${firstName}." followed immediately by the most relevant weekly market context for this store. End with a specific actionable observation from the context block, then the Teloskope sign-off. Do not include Options.`;

    console.log("Calling Claude...");
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const rawBriefText = claudeResponse.content[0].text;
    console.log("Claude brief generated, chars:", rawBriefText.length);

    // ─── META CALCULATIONS ────────────────────────────────────────────────────
    const metaWeekCpm = metaWeek && metaWeek.impressions > 0 ? ((metaWeek.spend / metaWeek.impressions) * 1000) : null;
    const metaWeekCpc = metaWeek && metaWeek.clicks > 0 ? (metaWeek.spend / metaWeek.clicks) : null;
    const metaMtdCpm  = metaMtd  && metaMtd.impressions  > 0 ? ((metaMtd.spend  / metaMtd.impressions)  * 1000) : null;
    const metaMtdCpc  = metaMtd  && metaMtd.clicks  > 0 ? (metaMtd.spend  / metaMtd.clicks)  : null;

    const hasMetaData = true;

    // ─── STATE ABBREVIATION MAP ───────────────────────────────────────────────
    const stateAbbr = (name) => {
      const map = {
        "New South Wales": "NSW", "Victoria": "VIC", "Queensland": "QLD",
        "Western Australia": "WA", "South Australia": "SA", "Tasmania": "TAS",
        "Australian Capital Territory": "ACT", "Northern Territory": "NT",
        "NSW": "NSW", "VIC": "VIC", "QLD": "QLD", "WA": "WA",
        "SA": "SA", "TAS": "TAS", "ACT": "ACT", "NT": "NT",
      };
      return map[name] || name.substring(0, 3).toUpperCase();
    };

    // ─── TOP PRODUCTS BAR DATA ────────────────────────────────────────────────
    const maxQty = topProducts.length > 0 ? topProducts[0].quantity : 1;
    const prodBars = topProducts.slice(0, 5).map(p => {
      const pct = Math.round((p.quantity / maxQty) * 100);
      const shortTitle = p.title.length > 18 ? p.title.substring(0, 17) + "…" : p.title;
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:12px;color:#888780;width:100px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${shortTitle}</span>
        <div style="flex:1;height:20px;background:#F1EFE8;border-radius:4px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:#378ADD;border-radius:4px"></div>
        </div>
        <span style="font-size:12px;font-weight:500;width:32px;text-align:right;flex-shrink:0">${p.quantity}u</span>
      </div>`;
    }).join("");

    // ─── LOCATION BARS ────────────────────────────────────────────────────────
    const locBars = locations.topStates.slice(0, 3).map((s, i) => {
      const fills = ["#378ADD", "#85B7EB", "#B5D4F4"];
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:12px;color:#888780;width:36px;flex-shrink:0">${stateAbbr(s.state)}</span>
        <div style="flex:1;height:16px;background:#F1EFE8;border-radius:4px;overflow:hidden">
          <div style="width:${s.pct}%;height:100%;background:${fills[i]};border-radius:4px"></div>
        </div>
        <span style="font-size:12px;font-weight:500;width:28px;text-align:right;flex-shrink:0">${s.pct}%</span>
      </div>`;
    }).join("");

    // ─── MTD CHANGE COLOUR ────────────────────────────────────────────────────
    const mtdChange = hasLyMtd ? (((mtdRev - lyMtdRev) / lyMtdRev) * 100) : null;
    const mtdChangeStr = mtdChange !== null ? `${mtdChange > 0 ? "▲" : "▼"} ${Math.abs(mtdChange).toFixed(1)}% vs last year` : "";
    const mtdChangeColor = mtdChange !== null ? (mtdChange >= 0 ? "#0F6E56" : "#A32D2D") : "#888780";

    // ─── META BENCHMARK HTML ─────────────────────────────────────────────────
    const metaSection = (() => {
      const spend30 = metaMtd ? metaMtd.spend : 0;
      const spend7  = metaWeek ? metaWeek.spend : 0;
      const cpm = metaMtdCpm ?? metaWeekCpm;
      const cpc = metaMtdCpc ?? metaWeekCpc;
      const hasSpend = spend30 > 0 || spend7 > 0;

      const benchmarkRow = (label, val, pct, good, low, high, unit) => pct !== null ? `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:11px;color:#888780;width:36px;flex-shrink:0">${label}</span>
          <div style="flex:1;height:8px;background:#B5D4F4;border-radius:4px;position:relative">
            <div style="position:absolute;width:3px;height:14px;top:-3px;left:${pct}%;background:#185FA5;border-radius:2px;transform:translateX(-50%)"></div>
          </div>
          <span style="font-size:12px;font-weight:500;width:44px;text-align:right;flex-shrink:0">${unit}${val.toFixed(2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:#888780;margin-bottom:10px;padding-left:44px">
          <span>${unit}${low} ${good ? "✓ below benchmark" : "↑ above benchmark"}</span><span>${unit}${high}</span>
        </div>` : "";

      const cpcPct = cpc !== null ? Math.min(Math.max(((cpc - 1.5) / (3.0 - 1.5)) * 100, 0), 100) : null;
      const cpmPct = cpm !== null ? Math.min(Math.max(((cpm - 15)  / (35  - 15))  * 100, 0), 100) : null;
      const cpcGood = cpc !== null && cpc < 1.5;
      const cpmGood = cpm !== null && cpm < 28;

      return `
      <div style="margin-bottom:20px">
        <p style="font-size:11px;font-weight:500;color:#888780;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">Meta ads — last 30 days</p>
        <div style="background:#fff;border:0.5px solid #D3D1C7;border-radius:12px;padding:14px 16px">
          ${hasSpend ? `
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:12px">
            <div style="background:#F1EFE8;border-radius:8px;padding:12px">
              <p style="font-size:12px;color:#888780;margin-bottom:4px">30 day spend</p>
              <p style="font-size:20px;font-weight:500">$${Math.round(spend30 || spend7)}</p>
            </div>
            <div style="background:#F1EFE8;border-radius:8px;padding:12px">
              <p style="font-size:12px;color:#888780;margin-bottom:4px">Clicks</p>
              <p style="font-size:20px;font-weight:500">${((metaMtd ? metaMtd.clicks : 0) || (metaWeek ? metaWeek.clicks : 0)).toLocaleString()}</p>
            </div>
          </div>
          <p style="font-size:12px;color:#888780;margin-bottom:8px">vs AU retail benchmark</p>
          ${benchmarkRow("CPC", cpc, cpcPct, cpcGood, "1.50", "3.00", "$")}
          ${benchmarkRow("CPM", cpm, cpmPct, cpmGood, "15", "35", "$")}
          <div style="margin-top:8px">
            ${cpcGood ? `<span style="display:inline-block;font-size:11px;padding:3px 8px;border-radius:20px;margin-right:4px;background:#E1F5EE;color:#085041">CPC well below benchmark</span>` : ""}
            ${cpmGood ? `<span style="display:inline-block;font-size:11px;padding:3px 8px;border-radius:20px;background:#E1F5EE;color:#085041">CPM solid</span>` : ""}
          </div>` : `
          <p style="font-size:13px;color:#888780;margin-bottom:6px">No active campaigns in the last 30 days.</p>
          <p style="font-size:13px;color:#5F5E5A;line-height:1.5">When your ads are running, Teloskope will benchmark your cost per click and cost per thousand impressions against AU retail averages — so you always know if your spend is working.</p>`}
        </div>
      </div>`;
    })();

    // ─── VISUAL BRIEF HTML ────────────────────────────────────────────────────
    const briefText = `
<style>
.tlsk-page{font-family:Inter,-apple-system,sans-serif;padding:0;max-width:420px;margin:0 auto}
.tlsk-section{margin-bottom:20px}
.tlsk-label{font-size:11px;font-weight:500;color:#888780;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px}
.tlsk-card{background:#fff;border:0.5px solid #D3D1C7;border-radius:12px;padding:14px 16px;margin-bottom:10px}
.tlsk-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.tlsk-metric{background:#F1EFE8;border-radius:8px;padding:12px}
.tlsk-metric-label{font-size:12px;color:#888780;margin-bottom:4px}
.tlsk-metric-val{font-size:22px;font-weight:500;color:#2C2C2A;line-height:1}
.tlsk-hero{font-size:30px;font-weight:500;color:#2C2C2A;line-height:1}
.tlsk-sub{font-size:13px;color:#888780;margin-top:2px}
.tlsk-divider{height:0.5px;background:#D3D1C7;margin:10px 0}
</style>

<div class="tlsk-page">

  <div class="tlsk-section">
    <p class="tlsk-label">Market context — week of 8 June 2026</p>
    <div style="background:#fff;border:0.5px solid #D3D1C7;border-left:3px solid #B5D4F4;border-radius:0 12px 12px 0;padding:12px 14px">
      <p style="font-size:13px;color:#5F5E5A;line-height:1.6;margin-bottom:6px">Two weeks to EOFY — discretionary spending softens as households focus on tax. Mediterranean freight via Cape of Good Hope adding 2–3 weeks transit. AUD soft vs EUR — watch landed cost on next Italian order.</p>
    </div>
  </div>

  <div class="tlsk-section">
    <p class="tlsk-label">Total sales this week</p>
    <div class="tlsk-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
        <div>
          <p class="tlsk-hero">${xeroWeekTotalRevenue !== null ? fmt$(xeroWeekTotalRevenue) : fmt$(weekRev)}</p>
          <p class="tlsk-sub">Xero reconciled, ex-GST</p>
        </div>
        <span style="font-size:11px;padding:4px 10px;border-radius:20px;background:#E6F1FB;color:#0C447C">${weekLabel}</span>
      </div>
      <div class="tlsk-divider"></div>
      ${xeroWeekTotalRevenue !== null ? `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:12px;color:#888780;width:70px;flex-shrink:0">Online</span>
        <div style="flex:1;height:20px;background:#F1EFE8;border-radius:4px;overflow:hidden">
          <div style="width:${weekOnlinePct !== null ? Math.round(weekOnlinePct * 100) : 60}%;height:100%;background:#378ADD;border-radius:4px"></div>
        </div>
        <span style="font-size:12px;font-weight:500;width:60px;text-align:right;flex-shrink:0">${fmt$(weekRev)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:12px;color:#888780;width:70px;flex-shrink:0">In-store</span>
        <div style="flex:1;height:20px;background:#F1EFE8;border-radius:4px;overflow:hidden">
          <div style="width:${weekOtherPct !== null ? Math.round(weekOtherPct * 100) : 40}%;height:100%;background:#B5D4F4;border-radius:4px"></div>
        </div>
        <span style="font-size:12px;font-weight:500;width:60px;text-align:right;flex-shrink:0">${weekOtherSales !== null ? fmt$(weekOtherSales) : "—"}</span>
      </div>` : `<p style="font-size:13px;color:#888780">Xero not connected — showing online only</p>`}
    </div>
  </div>

  <div class="tlsk-section">
    <p class="tlsk-label">Month to date — ${monthLabel}</p>
    <div class="tlsk-grid2" style="margin-bottom:10px">
      <div class="tlsk-metric">
        <p class="tlsk-metric-label">Total sales</p>
        <p class="tlsk-metric-val">${xeroMtdTotalRevenue !== null ? fmt$(xeroMtdTotalRevenue) : fmt$(mtdRev)}</p>
        <p style="font-size:12px;margin-top:4px;color:#888780">Xero reconciled</p>
      </div>
      <div class="tlsk-metric">
        <p class="tlsk-metric-label">vs last year</p>
        <p class="tlsk-metric-val" style="color:${mtdChangeColor}">${mtdChange !== null ? `${mtdChange > 0 ? "+" : ""}${mtdChange.toFixed(1)}%` : "—"}</p>
        <p style="font-size:12px;margin-top:4px;color:${mtdChangeColor}">${mtdChangeStr}</p>
      </div>
    </div>
    ${hasLyMtd ? `
    <div class="tlsk-card" style="padding:12px 14px">
      <p style="font-size:12px;color:#888780;margin-bottom:10px">Online MTD vs last year (Shopify)</p>
      <div style="display:flex;gap:8px;align-items:flex-end;height:60px;margin-bottom:6px">
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
          <div style="width:100%;background:#378ADD;border-radius:4px 4px 0 0" style2="height:${Math.round((mtdRev / Math.max(mtdRev, lyMtdRev)) * 56)}px">
            <div style="height:${Math.round((mtdRev / Math.max(mtdRev, lyMtdRev)) * 56)}px;background:#378ADD;border-radius:4px 4px 0 0"></div>
          </div>
        </div>
        <div style="flex:1">
          <div style="height:${Math.round((lyMtdRev / Math.max(mtdRev, lyMtdRev)) * 56)}px;background:#B5D4F4;border-radius:4px 4px 0 0"></div>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <div style="flex:1;text-align:center">
          <p style="font-size:13px;font-weight:500;color:#2C2C2A">${fmt$(mtdRev)}</p>
          <p style="font-size:11px;color:#888780">This year</p>
        </div>
        <div style="flex:1;text-align:center">
          <p style="font-size:13px;font-weight:500;color:#2C2C2A">${fmt$(lyMtdRev)}</p>
          <p style="font-size:11px;color:#888780">Last year</p>
        </div>
      </div>
    </div>` : ""}
  </div>

  <div class="tlsk-section">
    <p class="tlsk-label">Reconciled cash</p>
    <div class="tlsk-card">
      ${cashNum ? `<p class="tlsk-hero">${cashNum}</p><p class="tlsk-sub" style="margin-top:6px">At last reconciled date</p>` : `<p style="font-size:14px;color:#888780">Not available — Xero not connected</p>`}
    </div>
  </div>

  <div class="tlsk-section">
    <p class="tlsk-label">Transactions &amp; AOV</p>
    <div class="tlsk-grid2">
      <div class="tlsk-metric">
        <p class="tlsk-metric-label">Orders this week</p>
        <p class="tlsk-metric-val">${weekTx}</p>
        <p style="font-size:12px;margin-top:4px;color:#888780">online</p>
      </div>
      <div class="tlsk-metric">
        <p class="tlsk-metric-label">Avg order value</p>
        <p class="tlsk-metric-val">${fmt$(weekAov)}</p>
        <p style="font-size:12px;margin-top:4px;color:#888780">ex-GST</p>
      </div>
    </div>
  </div>

  <div class="tlsk-section">
    <p class="tlsk-label">Customers — ${monthLabel}</p>
    <div class="tlsk-card" style="padding:12px 14px">
      <div style="display:flex;gap:12px;margin-bottom:12px">
        <div style="flex:1;text-align:center">
          <p style="font-size:28px;font-weight:500;color:#0F6E56">${newMtd}</p>
          <p style="font-size:11px;color:#888780">New</p>
          ${hasLyMtd ? `<p style="font-size:11px;color:${newMtd >= newLyMtd ? "#0F6E56" : "#A32D2D"}">${newMtd >= newLyMtd ? "▲" : "▼"} vs ${newLyMtd} LY</p>` : ""}
        </div>
        <div style="width:0.5px;background:#D3D1C7"></div>
        <div style="flex:1;text-align:center">
          <p style="font-size:28px;font-weight:500;color:${retMtd >= (hasLyMtd ? retLyMtd : retMtd) ? "#0F6E56" : "#A32D2D"}">${retMtd}</p>
          <p style="font-size:11px;color:#888780">Returning</p>
          ${hasLyMtd ? `<p style="font-size:11px;color:${retMtd >= retLyMtd ? "#0F6E56" : "#A32D2D"}">${retMtd >= retLyMtd ? "▲" : "▼"} vs ${retLyMtd} LY</p>` : ""}
        </div>
      </div>
      ${(newMtd + retMtd) > 0 ? `
      <div style="height:8px;background:#F1EFE8;border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${Math.round((newMtd / (newMtd + retMtd)) * 100)}%;background:#1D9E75;border-radius:4px"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#888780;margin-top:4px">
        <span>New ${Math.round((newMtd / (newMtd + retMtd)) * 100)}%</span>
        <span>Returning ${Math.round((retMtd / (newMtd + retMtd)) * 100)}%</span>
      </div>` : ""}
    </div>
  </div>

  <div class="tlsk-section">
    <p class="tlsk-label">Top products this week</p>
    <div class="tlsk-card" style="padding:12px 14px">
      ${topProducts.length > 0 ? prodBars : '<p style="font-size:13px;color:#888780">No orders this week</p>'}
    </div>
  </div>

  <div class="tlsk-section">
    <p class="tlsk-label">Customer locations</p>
    <div class="tlsk-card" style="padding:12px 14px">
      <div style="display:flex;justify-content:space-between;margin-bottom:10px">
        <span style="font-size:13px;color:#2C2C2A">Australia <strong>${locations.ausPct}%</strong></span>
        <span style="font-size:13px;color:#2C2C2A">Overseas <strong>${locations.overseaPct}%</strong></span>
      </div>
      ${locBars}
    </div>
  </div>

  ${metaSection}

</div>`;

    // ─── ELEVENLABS TTS ───────────────────────────────────────────────────────
    console.log("Calling ElevenLabs...");
    const elResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: rawBriefText,
          model_id: "eleven_turbo_v2_5",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!elResponse.ok) throw new Error(`ElevenLabs error ${elResponse.status}: ${await elResponse.text()}`);

    const audioBlob = Buffer.from(await elResponse.arrayBuffer());
    console.log("Audio generated, size:", audioBlob.length, "bytes");

    // ─── UPLOAD AUDIO TO BUBBLE CDN ───────────────────────────────────────────
    console.log("Uploading audio to Bubble...");
    const runTs = Date.now();
    const fileName = `teloskope-brief-${user_id}-${weekEnd.year}-${pad(weekEnd.month + 1)}-${pad(weekEnd.day)}-${runTs}.mp3`;
    let audioUrl = null;

    try {
      const form = new FormData();
      form.append("filename", fileName);
      form.append("contents", new Blob([audioBlob], { type: "audio/mpeg" }), fileName);
      form.append("private", "false");

      const uploadRes = await fetch("https://teloskope.bubbleapps.io/version-test/fileupload", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.BUBBLE_API_KEY}` },
        body: form,
      });

      if (uploadRes.ok) {
        audioUrl = cleanBubbleUrl(await uploadRes.text());
        console.log("Audio uploaded to Bubble CDN:", audioUrl);
      } else {
        throw new Error(await uploadRes.text());
      }
    } catch (uploadErr) {
      console.warn("Bubble upload failed, falling back to ElevenLabs URL:", uploadErr.message);
      const historyItemId = elResponse.headers.get("history-item-id");
      audioUrl = historyItemId ? `https://api.elevenlabs.io/v1/history/${historyItemId}/audio` : null;
    }

    // ─── POST TO BUBBLE ───────────────────────────────────────────────────────
    console.log("Posting to Bubble...");
    const bubblePayload = {
      secret_key: bubble_secret_key,
      user_id,
      brief_text: briefText,
      audio_url: audioUrl,
      week_end_date: wE.toISOString(),
      total_week_revenue:      Math.round(weekRev * 100) / 100,
      total_mtd_revenue:       Math.round(mtdRev * 100) / 100,
      total_ly_mtd_revenue:    Math.round(lyMtdRev * 100) / 100,
      shopify_ytd_revenue:     Math.round(ytdRev * 100) / 100,
      shopify_ly_ytd_revenue:  Math.round(lyYtdRev * 100) / 100,
      total_week_transactions: weekTx,
      total_mtd_transactions:  mtdTx,
      total_week_aov:          Math.round(weekAov * 100) / 100,
      new_customers_mtd:       newMtd,
      returning_customers_mtd: retMtd,
      top_products_json:       JSON.stringify(topProducts),
      xero_cash_balance:       xeroCashBalance !== null ? Math.round(xeroCashBalance * 100) / 100 : null,
      xero_week_total_revenue: xeroWeekTotalRevenue !== null ? Math.round(xeroWeekTotalRevenue * 100) / 100 : null,
      xero_mtd_total_revenue:  xeroMtdTotalRevenue  !== null ? Math.round(xeroMtdTotalRevenue  * 100) / 100 : null,
      other_sales_week:        weekOtherSales !== null ? Math.round(weekOtherSales * 100) / 100 : null,
      other_sales_mtd:         mtdOtherSales  !== null ? Math.round(mtdOtherSales  * 100) / 100 : null,
      online_pct_week:         weekOnlinePct !== null ? Math.round(weekOnlinePct * 10000) / 10000 : null,
      other_pct_week:          weekOtherPct  !== null ? Math.round(weekOtherPct  * 10000) / 10000 : null,
      online_pct_mtd:          mtdOnlinePct  !== null ? Math.round(mtdOnlinePct  * 10000) / 10000 : null,
      other_pct_mtd:           mtdOtherPct   !== null ? Math.round(mtdOtherPct   * 10000) / 10000 : null,
    };

    const bubbleRes = await fetch(`${BUBBLE_BASE_URL}/wf/ingest_weekly_brief`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bubblePayload),
    });

    if (!bubbleRes.ok) throw new Error(`Bubble error ${bubbleRes.status}: ${await bubbleRes.text()}`);
    const bubbleData = await bubbleRes.json();
    console.log("Bubble response:", JSON.stringify(bubbleData));

    const briefUniqueId = bubbleData?.response?.brief_id;
    const fullBriefUrl = briefUniqueId
      ? `${brief_page_base_url}${briefUniqueId}`
      : brief_page_base_url;
    console.log("Full brief URL:", fullBriefUrl);

    // ─── TWILIO SMS ───────────────────────────────────────────────────────────
    console.log("Sending SMS...");
    const smsBody = `Good morning ${firstName}! Your Teloskope Weekly Brief for the ${weekLabel} is ready. Listen here: ${fullBriefUrl}`;

    const twilioRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: TWILIO_PHONE_NUMBER, To: user_phone, Body: smsBody }),
      }
    );

    if (!twilioRes.ok) throw new Error(`Twilio error ${twilioRes.status}: ${await twilioRes.text()}`);
    console.log("SMS sent to", user_phone);

    return res.status(200).json({
      success: true,
      brief_id: bubbleData?.response?.brief_id,
      brief_url: fullBriefUrl,
      audio_url: audioUrl,
      week_end: `${weekEnd.year}-${pad(weekEnd.month + 1)}-${pad(weekEnd.day)}`,
      sms_sent_to: user_phone,
    });

  } catch (err) {
    console.error("generate-weekly-brief error:", err);
    return res.status(500).json({ error: err.message });
  }
}
