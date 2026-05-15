// api/generate-weekly-brief.js
// V1.3: Removed bank-feed channel attribution and ad spend detection (data not reliable enough).
//       Meta/Google ad spend will come from direct platform APIs when wired up.
// Pulls Shopify + Xero (cash + P&L total revenue) → Claude → ElevenLabs → Bubble → Twilio SMS.
// ALL figures ex-GST.

import Anthropic from "@anthropic-ai/sdk";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = "Zpq4UaaRVMryEw8KSTWI"; // New voice
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

// Fetch Xero P&L Total Trading Income (ex-GST) for a period
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

    // Xero P&L returns Total Trading Income (ex-GST) as a SummaryRow
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
    const pcwEnd    = shiftYear(weekEnd, -1);
    const pcwStart  = shiftYear(weekStart, -1);

    const mtdStart   = { year: today.year, month: today.month, day: 1 };
    const mtdEnd     = today;
    const lyMtdStart = shiftYear(mtdStart, -1);
    const lyMtdEnd   = shiftYear(mtdEnd, -1);

    const ytdStart   = { year: today.year, month: 0, day: 1 };
    const ytdEnd     = today;
    const lyYtdStart = shiftYear(ytdStart, -1);
    const lyYtdEnd   = shiftYear(ytdEnd, -1);

    const wS  = shopMidnightUtc(weekStart.year, weekStart.month, weekStart.day);
    const wE  = shopEndOfDayUtc(weekEnd.year, weekEnd.month, weekEnd.day);
    const pS  = shopMidnightUtc(pcwStart.year, pcwStart.month, pcwStart.day);
    const pE  = shopEndOfDayUtc(pcwEnd.year, pcwEnd.month, pcwEnd.day);
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

    // Shopify total_price is GROSS (inc. GST). All calculations below ex-GST.
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
      weekOrders, pcwOrders,
      mtdOrders, lyMtdOrders,
      ytdOrders, lyYtdOrders,
      preMtdOrders, preLyMtdOrders,
      weekOrdersDetail,
      xeroCashBalance,
      xeroWeekTotalRevenue,
      xeroMtdTotalRevenue,
    ] = await Promise.all([
      fetchAllOrders(wS, wE),
      fetchAllOrders(pS, pE),
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
    ]);

    console.log("Week orders:", weekOrders.length, "| Revenue ex-GST:", sumRevenueExGst(weekOrders).toFixed(2));
    console.log("MTD orders:", mtdOrders.length, "| Revenue ex-GST:", sumRevenueExGst(mtdOrders).toFixed(2));
    console.log("Xero reconciled bank position:", xeroCashBalance);
    console.log("Xero P&L week total (ex-GST):", xeroWeekTotalRevenue);
    console.log("Xero P&L MTD total (ex-GST):", xeroMtdTotalRevenue);

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
    const pcwRev   = sumRevenueExGst(pcwOrders);
    const mtdRev   = sumRevenueExGst(mtdOrders);
    const lyMtdRev = sumRevenueExGst(lyMtdOrders);
    const ytdRev   = sumRevenueExGst(ytdOrders);
    const lyYtdRev = sumRevenueExGst(lyYtdOrders);
    const weekTx   = weekOrders.length;
    const pcwTx    = pcwOrders.length;
    const mtdTx    = mtdOrders.length;
    const lyMtdTx  = lyMtdOrders.length;
    const weekAov  = calcAovExGst(weekOrders);
    const pcwAov   = calcAovExGst(pcwOrders);

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

    const pct  = (a, b) => b > 0 ? `${(((a - b) / b) * 100).toFixed(1)}%` : "N/A";
    const fmt$ = (n) => `$${Math.round(n).toLocaleString()}`;
    const fmtPct = (n) => (n * 100).toFixed(1) + "%";

    const hasLyWeek = pcwRev > 0 || pcwTx > 0;
    const hasLyMtd  = lyMtdRev > 0 || lyMtdTx > 0;
    const hasLyYtd  = lyYtdRev > 0;

    const weekLabel  = `week ending ${fmtDate(weekEnd)}`;
    const monthLabel = fmtDate({ year: today.year, month: today.month, day: 1 }, { month: "long", year: "numeric" });
    const cashNote   = xeroCashBalance !== null && xeroCashBalance !== undefined ? fmt$(xeroCashBalance) : "not available";

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
- Revenue: ${fmt$(weekRev)} | ${weekTx} orders | AOV ${fmt$(weekAov)}
- Same week last year: ${hasLyWeek ? `${fmt$(pcwRev)}, ${pcwTx} orders, AOV ${fmt$(pcwAov)} (${pct(weekRev, pcwRev)} change)` : "not available — no online orders this week last year"}

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
`;

    const systemPrompt = `You are Teloskope, a smart weekly business advisor for independent retail store owners.
Write a warm, direct, insightful weekly audio brief for a store owner to listen to on Monday morning.
Write in a conversational Australian tone — like a trusted business advisor, not a corporate report.
Be specific with numbers. Be honest about what looks good and what needs watching.
Write in flowing paragraphs only — absolutely no bullet points, no headers, no markdown formatting of any kind.
Do not use any symbols, asterisks, dollar signs, percent signs, or special characters of any kind.

CRITICAL — NUMBER FORMATTING FOR AUDIO:
This script will be read aloud by a text-to-speech voice. You must write ALL numbers in full spoken words so they sound natural when read aloud. Follow these rules strictly:
- Dollar amounts: write as words e.g. "nine thousand two hundred and twenty seven dollars" not "$9,227"
- Percentages: write as words e.g. "thirteen point three percent" not "13.3%"
- Order counts: write as words e.g. "eighteen orders" not "18 orders"
- AOV: write as words e.g. "five hundred and thirteen dollars" not "$513"
- All other numbers: write in full words

ALL FIGURES ARE EX-GST. You can mention "ex-GST" once near the start when introducing the headline revenue, but don't repeat it every sentence — once is enough.

The brief should take about 90 to 120 seconds to read aloud.

Always open with "Good morning [owner first name]." as the very first words. Then immediately lead with the headline TOTAL sales figure for the week (online plus other combined) in full words, noting it's ex-GST.

Cover, in this order: total sales for the week split into online and other (in-store plus wholesale combined), online performance and year-on-year comparison, MTD total sales split into online and other, reconciled bank position, transactions and AOV, customer mix, where customers are from, top products, and what it all means together.

The "Other" sales figure (in-store + wholesale) comes from Xero reconciled data minus Shopify, so it may lag by a few days depending on the bookkeeper's reconciliation pace. Treat this as the most accurate available picture without over-claiming precision.

When last year data is not available, acknowledge it briefly and move on.

End with exactly 3 options to explore. Label them clearly as "Option 1:", "Option 2:", "Option 3:" each on a new line, followed by the suggestion as plain prose.

After Option 3, close with this exact sign-off on a new line: "That's your Teloskope brief for the week. Have a great Monday, and I'll be back next week with your next update."`;

    const userPrompt = `Here is the data for ${store_name} for the ${weekLabel}.

${dataBlock}

Write the Teloskope weekly audio brief. Remember: all numbers must be written in full spoken words. No symbols, no dollar signs, no percent signs. Start with "Good morning ${firstName}." and end with the Teloskope sign-off.`;

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

    // ─── EXTRACT OPTIONS FROM CLAUDE OUTPUT (page display only) ──────────────
    const optionsMatch = rawBriefText.match(/(Option 1:[\s\S]*?)(?=That's your Teloskope|$)/i);
    let optionsHtml = "";
    if (optionsMatch) {
      const items = optionsMatch[1].trim()
        .split(/(?=Option [123]:)/i)
        .map(s => s.trim())
        .filter(Boolean);
      optionsHtml =
        `<p style="margin-bottom:8px;margin-top:16px;line-height:1.6;font-family:Inter,sans-serif;"><strong>Options to Explore:</strong></p>\n` +
        items.map(item =>
          `<p style="margin-bottom:12px;line-height:1.6;font-family:Inter,sans-serif;">${
            item.replace(/Option ([123]):/i, '<strong style="color:#0205D3;">Option $1:</strong>')
          }</p>`
        ).join("\n");
    }

    // ─── BUILD HTML BULLET SUMMARY (page display) ─────────────────────────────
    const li = (text) => `<li style="margin-bottom:6px;">${text}</li>`;
    const section = (title, items) =>
      `<p style="margin-bottom:8px;margin-top:16px;line-height:1.6;font-family:Inter,sans-serif;"><strong>${title}</strong></p>\n` +
      `<ul style="margin:0 0 8px 0;padding-left:20px;line-height:1.8;font-family:Inter,sans-serif;">\n` +
      items.map(li).join("\n") +
      `\n</ul>`;

    // Total sales section
    const totalSalesItems = (() => {
      if (xeroWeekTotalRevenue === null || xeroWeekTotalRevenue === undefined) {
        return ["Xero P&L not available — total sales view unavailable"];
      }
      const items = [];
      items.push(`This week (Xero, ex-GST): ${fmt$(xeroWeekTotalRevenue)} total`);
      items.push(`  · Online (Shopify): ${fmt$(weekRev)}${weekOnlinePct !== null ? ` (${fmtPct(weekOnlinePct)})` : ""}`);
      if (weekOtherSales !== null) {
        items.push(`  · Other (in-store + wholesale): ${fmt$(weekOtherSales)}${weekOtherPct !== null ? ` (${fmtPct(weekOtherPct)})` : ""}`);
      }
      if (xeroMtdTotalRevenue !== null && xeroMtdTotalRevenue !== undefined) {
        items.push(`${monthLabel} to date (Xero, ex-GST): ${fmt$(xeroMtdTotalRevenue)} total`);
        items.push(`  · Online (Shopify): ${fmt$(mtdRev)}${mtdOnlinePct !== null ? ` (${fmtPct(mtdOnlinePct)})` : ""}`);
        if (mtdOtherSales !== null) {
          items.push(`  · Other (in-store + wholesale): ${fmt$(mtdOtherSales)}${mtdOtherPct !== null ? ` (${fmtPct(mtdOtherPct)})` : ""}`);
        }
      }
      return items;
    })();

    const revItems = [
      `This week (Shopify, ex-GST): ${fmt$(weekRev)} — ${weekTx} orders, AOV ${fmt$(weekAov)}`,
      hasLyWeek
        ? `Same week last year: ${fmt$(pcwRev)}, ${pcwTx} orders (${pct(weekRev, pcwRev)} change)`
        : "Same week last year: not available — first year online",
      `${monthLabel} to date (Shopify, ex-GST): ${fmt$(mtdRev)} — ${mtdTx} orders`,
      hasLyMtd
        ? `Last year MTD: ${fmt$(lyMtdRev)} (${pct(mtdRev, lyMtdRev)} change)`
        : "Last year MTD: not available",
      `Year to date (Shopify, ex-GST): ${fmt$(ytdRev)}`,
      hasLyYtd
        ? `Last year YTD: ${fmt$(lyYtdRev)} (${pct(ytdRev, lyYtdRev)} change)`
        : "Last year YTD: not available — first year online",
    ];

    const cashItems = [
      `Reconciled bank position: ${cashNote}${xeroCashBalance !== null && xeroCashBalance !== undefined && xeroCashBalance <= 0 ? " — needs attention" : ""}`,
    ];

    const txItems = [
      `${weekTx} online transactions this week${hasLyWeek ? `, vs ${pcwTx} last year` : ""}`,
      `Average order value (ex-GST): ${fmt$(weekAov)}${hasLyWeek ? ` vs ${fmt$(pcwAov)} last year` : ""}`,
      `${monthLabel} to date: ${mtdTx} online transactions total`,
    ];

    const custItems = [
      `${newMtd} new customers this month${hasLyMtd ? ` vs ${newLyMtd} last year` : ""}`,
      `${retMtd} returning customers${hasLyMtd ? ` vs ${retLyMtd} last year` : ""}`,
    ];

    const prodItems = topProducts.length > 0
      ? topProducts.map(p => `${p.title} — ${p.quantity} units`)
      : ["No orders this week"];

    const locItems = locations.total > 0 ? [
      `Australia: ${locations.ausPct}% | Overseas: ${locations.overseaPct}%`,
      ...locations.topStates.map(s => `${s.state}: ${s.count} order${s.count !== 1 ? "s" : ""} (${s.pct}%)`),
    ] : ["No shipping data available"];

    const briefText = [
      section("Total Sales (Xero reconciled, ex-GST):", totalSalesItems),
      section("Online Revenue (Shopify, ex-GST):", revItems),
      section("Reconciled Bank Position:", cashItems),
      section("Online Transactions and AOV:", txItems),
      section("New vs Returning Customers (online):", custItems),
      section("Top 5 Products This Week (online):", prodItems),
      section("Customer Locations (online):", locItems),
      optionsHtml,
    ].join("\n");

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

      // Shopify (online-only) figures — ex-GST
      total_week_revenue:     Math.round(weekRev * 100) / 100,
      total_pcw_revenue:      Math.round(pcwRev * 100) / 100,
      total_mtd_revenue:      Math.round(mtdRev * 100) / 100,
      total_ly_mtd_revenue:   Math.round(lyMtdRev * 100) / 100,
      shopify_ytd_revenue:    Math.round(ytdRev * 100) / 100,
      shopify_ly_ytd_revenue: Math.round(lyYtdRev * 100) / 100,
      total_week_transactions: weekTx,
      total_mtd_transactions: mtdTx,
      total_week_aov:         Math.round(weekAov * 100) / 100,
      new_customers_mtd:      newMtd,
      returning_customers_mtd: retMtd,
      top_products_json:      JSON.stringify(topProducts),
      xero_cash_balance:      xeroCashBalance !== null ? Math.round(xeroCashBalance * 100) / 100 : null,

      // Xero P&L total sales split
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

    // ─── TWILIO SMS ───────────────────────────────────────────────────────────
    console.log("Sending SMS...");
    const smsBody = `Good morning ${firstName}! Your Teloskope Weekly Brief for the ${weekLabel} is ready. Listen here: ${brief_page_base_url}`;

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
      brief_url: brief_page_base_url,
      audio_url: audioUrl,
      week_end: `${weekEnd.year}-${pad(weekEnd.month + 1)}-${pad(weekEnd.day)}`,
      sms_sent_to: user_phone,
    });

  } catch (err) {
    console.error("generate-weekly-brief error:", err);
    return res.status(500).json({ error: err.message });
  }
}
