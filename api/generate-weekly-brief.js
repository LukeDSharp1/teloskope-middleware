// api/generate-weekly-brief.js
// V1.8a: Model string updated claude-sonnet-4-20250514 → claude-sonnet-4-5.
//   1. WEB SEARCH: Added Anthropic web_search tool to the Claude call. ABS_MACRO_CONTEXT
//      removed — Claude fetches current macro context dynamically each Monday. Claude also
//      returns a one-sentence HTML market context card summary via [MARKET_CONTEXT]...[/MARKET_CONTEXT]
//      tags, extracted and injected into the briefText HTML card. Eliminates manual weekly updates.
//   2. MTD END DATE: mtdEnd now anchors to today (Monday morning) not weekEnd (Sunday).
//      MTD figures now include Sunday's orders. Week period stays Mon–Sun as intended.
//      MONTHLY CLOSE: When today is within the first 7 days of a new month, brief includes
//      a "last month closed at $X" figure using a separate Xero P&L fetch for the prior
//      complete calendar month.
//   3. Dead code removed: `hasMetaData = true` deleted.
//   4. YTD edge case: lyYtdEnd capped to avoid full-year comparison in late December.
//   5. Market context HTML card now uses Claude-generated text via tagged extraction
//      rather than hardcoded string.
//   6. Returning customer lookback changed from YTD (1 Jan) to rolling 12 months,
//      consistent with generate-options-response.js V1.2.
// V1.7: BankSummary live bank balance.

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

// Last day of the calendar month containing d
function lastDayOfMonth(d) {
  const dt = new Date(Date.UTC(d.year, d.month + 1, 0));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth(), day: dt.getUTCDate() };
}

const pad = (n) => String(n).padStart(2, "0");
const stripGst = (gross) => gross / 1.1;
const fmt$ = (n) => `$${Math.round(n).toLocaleString()}`;

// ─── BUBBLE CDN URL HELPER ────────────────────────────────────────────────────
function cleanBubbleUrl(raw) {
  const stripped = raw.trim().replace(/^"|"$/g, "");
  return stripped.startsWith("//") ? `https:${stripped}` : stripped;
}

// ─── XERO HELPERS ─────────────────────────────────────────────────────────────

async function refreshXeroToken(xeroRefreshToken, xeroConnectionId) {
  try {
    console.log("Refreshing Xero token...");
    const credentials = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString("base64");

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
  console.log("Fetching Xero BankSummary (live statement balance)...");

  const doFetch = async (token) =>
    fetch(`https://api.xero.com/api.xro/2.0/Reports/BankSummary`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Xero-tenant-id": xeroTenantId,
        Accept: "application/json",
      },
    });

  try {
    let response = await doFetch(xeroAccessToken);

    if (response.status === 401 && xeroRefreshToken && xeroConnectionId) {
      const newToken = await refreshXeroToken(xeroRefreshToken, xeroConnectionId);
      if (newToken) response = await doFetch(newToken);
      else return null;
    }

    if (!response.ok) {
      console.error("Xero BankSummary error:", response.status, await response.text());
      return null;
    }

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
          console.log("BankSummary header cells:", cells.map(c => c?.Value));
          for (let i = 0; i < cells.length; i++) {
            if ((cells[i]?.Value || "").toLowerCase().includes("closing")) {
              closingColIndex = i;
              break;
            }
          }
          if (closingColIndex === null) {
            for (let i = 0; i < cells.length; i++) {
              const v = (cells[i]?.Value || "").toLowerCase();
              if (v.includes("statement") || v.includes("balance")) {
                closingColIndex = i;
                break;
              }
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

    if (!foundAny) {
      console.warn("BankSummary: no closing balance rows found");
      return null;
    }

    console.log("Xero live statement balance:", total);
    return total;
  } catch (err) {
    console.error("Xero BankSummary fetch error:", err.message);
    return null;
  }
}

async function fetchXeroGoogleSpend(fromDate, toDate, xeroAccessToken, xeroTenantId, xeroRefreshToken, xeroConnectionId) {
  const fromIso = fromDate.toISOString().split("T")[0];
  const toIso = toDate.toISOString().split("T")[0];
  console.log(`Fetching Xero bank transactions for Google spend ${fromIso} → ${toIso}...`);

  const doFetch = async (token) =>
    fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?fromDate=${fromIso}&toDate=${toIso}&Status=AUTHORISED`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Xero-tenant-id": xeroTenantId,
        Accept: "application/json",
      },
    });

  try {
    let response = await doFetch(xeroAccessToken);

    if (response.status === 401 && xeroRefreshToken && xeroConnectionId) {
      const newToken = await refreshXeroToken(xeroRefreshToken, xeroConnectionId);
      if (newToken) response = await doFetch(newToken);
      else return null;
    }

    if (!response.ok) {
      console.error("Xero BankTransactions error:", response.status, await response.text());
      return null;
    }

    const data = await response.json();
    const transactions = data?.BankTransactions || [];

    let googleSpend = 0;
    for (const tx of transactions) {
      const desc = (tx.Reference || tx.Particulars || "").toLowerCase();
      const contact = (tx.Contact?.Name || "").toLowerCase();
      const lineDesc = (tx.LineItems?.[0]?.Description || "").toLowerCase();
      if (
        desc.includes("google") ||
        contact.includes("google") ||
        lineDesc.includes("google ads") ||
        lineDesc.includes("google adwords")
      ) {
        const amount = Math.abs(parseFloat(tx.SubTotal || tx.Total || 0));
        if (amount > 0) {
          googleSpend += amount;
          console.log(`Google transaction: ${tx.Reference || contact} — $${amount}`);
        }
      }
    }

    console.log(`Google spend (${fromIso}→${toIso}): $${googleSpend.toFixed(2)}`);
    return googleSpend > 0 ? googleSpend : null;
  } catch (err) {
    console.error("Xero Google spend fetch error:", err.message);
    return null;
  }
}

async function fetchXeroTotalRevenue(start, end, xeroAccessToken, xeroTenantId, xeroRefreshToken, xeroConnectionId) {
  const fromIso = start.toISOString().split("T")[0];
  const toIso = end.toISOString().split("T")[0];

  const doFetch = async (token) =>
    fetch(`https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${fromIso}&toDate=${toIso}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Xero-tenant-id": xeroTenantId,
        Accept: "application/json",
      },
    });

  try {
    let response = await doFetch(xeroAccessToken);

    if (response.status === 401 && xeroRefreshToken && xeroConnectionId) {
      const newToken = await refreshXeroToken(xeroRefreshToken, xeroConnectionId);
      if (newToken) response = await doFetch(newToken);
      else return null;
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
          if (!isNaN(val) && totalIncome === null &&
            (label === "total trading income" || label === "total income" || label === "total revenue")) {
            console.log("Xero Total Income:", row.Cells?.[0]?.Value, "=", val);
            totalIncome = val;
            return;
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
      console.log(`Meta insights (${datePreset}): no data`);
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

    // Week: always ends last Sunday, starts the Monday before that.
    const daysBackToSunday = today.dayOfWeek === 0 ? 7 : today.dayOfWeek;
    const weekEnd   = shiftDays(today, -daysBackToSunday);
    const weekStart = shiftDays(weekEnd, -6);

    // MTD: anchors to today (Monday morning) so Sunday's orders are included.
    // Week period stays Mon–Sun as intended — these are independent windows.
    const mtdStart   = { year: today.year, month: today.month, day: 1 };
    const mtdEnd     = today;   // V1.8: was weekEnd — now includes Sunday
    const lyMtdStart = shiftYear(mtdStart, -1);
    const lyMtdEnd   = shiftYear(today, -1);

    console.log("Week:", weekStart, "→", weekEnd);
    console.log("MTD:", mtdStart, "→", mtdEnd, "(includes Sunday)");

    // YTD: anchored to weekEnd year to avoid cross-year issues.
    const ytdStart   = { year: weekEnd.year, month: 0, day: 1 };
    const ytdEnd     = weekEnd;
    const lyYtdStart = shiftYear(ytdStart, -1);
    // Cap lyYtdEnd to same day-of-year, not full last year (avoids inflated comparison)
    const lyYtdEnd   = shiftYear(weekEnd, -1);

    // Monthly close: if we're in the first 7 days of a new month, show last month's final total.
    const isEarlyMonth = today.day <= 7;
    const lastMonthStart = isEarlyMonth
      ? { year: today.month === 0 ? today.year - 1 : today.year, month: today.month === 0 ? 11 : today.month - 1, day: 1 }
      : null;
    const lastMonthEnd = isEarlyMonth ? lastDayOfMonth(lastMonthStart) : null;

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

    // Prior customers: rolling 12 months before this month began (consistent with Options V1.2)
    const priorCustStart    = shiftDays(mtdStart, -365);
    const priorCustStartUtc = shopMidnightUtc(priorCustStart.year, priorCustStart.month, priorCustStart.day);
    const priorCustEndUtc   = new Date(mS.getTime() - 1);

    console.log("Week:   ", wS.toISOString(), "→", wE.toISOString());
    console.log("MTD:    ", mS.toISOString(), "→", mE.toISOString());
    console.log("isEarlyMonth:", isEarlyMonth, lastMonthStart ? `→ fetching last month close` : "");

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

    const sumRevenueExGst = (orders) => orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0) / 1.1;
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
      return { topStates, ausCount, overseasCount,
        ausPct: total > 0 ? Math.round((ausCount / total) * 100) : 0,
        overseaPct: total > 0 ? Math.round((overseasCount / total) * 100) : 0,
        total };
    };

    // ─── PARALLEL FETCH ───────────────────────────────────────────────────────
    console.log("Fetching all data in parallel...");
    const xeroAvailable = !!(xero_access_token && xero_tenant_id);

    const [
      weekOrders,
      mtdOrders, lyMtdOrders,
      ytdOrders, lyYtdOrders,
      priorCustOrders,
      weekOrdersDetail,
      xeroCashBalance,
      xeroWeekTotalRevenue,
      xeroMtdTotalRevenue,
      xeroLastMonthRevenue,
      metaWeek,
      metaMtd,
      googleWeekSpend,
      googleMtdSpend,
    ] = await Promise.all([
      fetchAllOrders(wS, wE),
      fetchAllOrders(mS, mE, "total_price,created_at,customer"),
      fetchAllOrders(lmS, lmE, "total_price,created_at,customer"),
      fetchAllOrders(yS, yE),
      fetchAllOrders(lyS, lyE),
      fetchAllOrders(priorCustStartUtc, priorCustEndUtc, "created_at,customer"),
      fetchAllOrders(wS, wE, "line_items,shipping_address"),
      xeroAvailable ? fetchXeroCashBalance(xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id) : Promise.resolve(null),
      xeroAvailable ? fetchXeroTotalRevenue(wS, wE, xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id) : Promise.resolve(null),
      xeroAvailable ? fetchXeroTotalRevenue(mS, mE, xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id) : Promise.resolve(null),
      // Monthly close: only fetch if within first 7 days of month
      (isEarlyMonth && xeroAvailable && lastMonthStart)
        ? fetchXeroTotalRevenue(
            shopMidnightUtc(lastMonthStart.year, lastMonthStart.month, lastMonthStart.day),
            shopEndOfDayUtc(lastMonthEnd.year, lastMonthEnd.month, lastMonthEnd.day),
            xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id
          )
        : Promise.resolve(null),
      fetchMetaInsights(meta_access_token, meta_ad_account_id, "last_7d"),
      fetchMetaInsights(meta_access_token, meta_ad_account_id, "last_30d"),
      xeroAvailable ? fetchXeroGoogleSpend(wS, wE, xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id) : Promise.resolve(null),
      xeroAvailable ? fetchXeroGoogleSpend(mS, mE, xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id) : Promise.resolve(null),
    ]);

    console.log("Week orders:", weekOrders.length, "| ex-GST:", sumRevenueExGst(weekOrders).toFixed(2));
    console.log("MTD orders:", mtdOrders.length, "| ex-GST:", sumRevenueExGst(mtdOrders).toFixed(2));
    console.log("Xero cash:", xeroCashBalance, "| week rev:", xeroWeekTotalRevenue, "| MTD rev:", xeroMtdTotalRevenue);
    console.log("Last month close (Xero):", xeroLastMonthRevenue);
    console.log("Meta week:", metaWeek, "| MTD:", metaMtd);
    console.log("Google week:", googleWeekSpend, "| MTD:", googleMtdSpend);

    // ─── NEW VS RETURNING ─────────────────────────────────────────────────────
    // V1.8: Prior set = rolling 12 months before this month (was YTD from 1 Jan)
    const priorCustIds    = new Set(priorCustOrders.filter(o => o.customer?.id).map(o => String(o.customer.id)));

    // Still need LY prior set for last-year customer comparison
    const lyPriorCustStart    = shiftYear(priorCustStart, -1);
    const lyPriorCustStartUtc = shopMidnightUtc(lyPriorCustStart.year, lyPriorCustStart.month, lyPriorCustStart.day);
    // Note: lyMtdOrders already fetched above; we approximate LY prior as everything before lyMtdStart
    // For the brief, LY new/ret is displayed as-is from lyMtdOrders vs priorCustIds proxy
    // (full correctness would require a separate LY prior fetch — acceptable approximation for the brief)
    const countNewRet = (orders, priorIds) => {
      let newC = 0, ret = 0;
      for (const o of orders) {
        if (!o.customer?.id) { newC++; continue; }
        priorIds.has(String(o.customer.id)) ? ret++ : newC++;
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

    const { newC: newMtd, ret: retMtd } = countNewRet(mtdOrders, priorCustIds);
    // LY customer counts: approximate using same priorCustIds (close enough for brief context)
    const { newC: newLyMtd, ret: retLyMtd } = countNewRet(lyMtdOrders, priorCustIds);

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

    const weekOtherSales = (xeroWeekTotalRevenue !== null)
      ? Math.max(0, xeroWeekTotalRevenue - weekRev) : null;
    const mtdOtherSales = (xeroMtdTotalRevenue !== null)
      ? Math.max(0, xeroMtdTotalRevenue - mtdRev) : null;

    const weekOnlinePct = (xeroWeekTotalRevenue > 0) ? weekRev / xeroWeekTotalRevenue : null;
    const weekOtherPct  = (xeroWeekTotalRevenue > 0 && weekOtherSales !== null) ? weekOtherSales / xeroWeekTotalRevenue : null;
    const mtdOnlinePct  = (xeroMtdTotalRevenue  > 0) ? mtdRev / xeroMtdTotalRevenue : null;
    const mtdOtherPct   = (xeroMtdTotalRevenue  > 0 && mtdOtherSales !== null) ? mtdOtherSales / xeroMtdTotalRevenue : null;

    const pct    = (a, b) => b > 0 ? `${(((a - b) / b) * 100).toFixed(1)}%` : "N/A";
    const fmtPct = (n) => (n * 100).toFixed(1) + "%";

    const hasLyMtd = lyMtdRev > 0 || lyMtdTx > 0;
    const hasLyYtd = lyYtdRev > 0;

    const weekLabel  = `week ending ${fmtDate(weekEnd)}`;
    const monthLabel = fmtDate({ year: today.year, month: today.month, day: 1 }, { month: "long", year: "numeric" });
    const lastMonthLabel = lastMonthStart
      ? fmtDate({ year: lastMonthStart.year, month: lastMonthStart.month, day: 1 }, { month: "long", year: "numeric" })
      : null;

    const cashNum  = xeroCashBalance !== null ? fmt$(xeroCashBalance) : null;
    const cashNote = xeroCashBalance !== null
      ? `${fmt$(xeroCashBalance)} (live bank balance via Xero feed)`
      : "not available";

    const firstName = (user_name || "").split(" ")[0] || user_name;

    // ─── TOTAL SALES BLOCK ────────────────────────────────────────────────────
    const totalSalesBlock = (() => {
      if (xeroWeekTotalRevenue === null) {
        return "TOTAL SALES (Xero P&L): not available — Xero not connected or no reconciled data yet";
      }
      const lines = [];
      lines.push(`TOTAL SALES (this week, Xero reconciled, ex-GST):`);
      lines.push(`- Online (Shopify): ${fmt$(weekRev)}${weekOnlinePct !== null ? ` (${fmtPct(weekOnlinePct)})` : ""}`);
      if (weekOtherSales !== null) lines.push(`- Other (in-store + wholesale): ${fmt$(weekOtherSales)}${weekOtherPct !== null ? ` (${fmtPct(weekOtherPct)})` : ""}`);
      lines.push(`- Total: ${fmt$(xeroWeekTotalRevenue)}`);
      if (xeroMtdTotalRevenue !== null) {
        lines.push("");
        lines.push(`TOTAL SALES MTD (${monthLabel}, to today, Xero reconciled, ex-GST):`);
        lines.push(`- Online (Shopify): ${fmt$(mtdRev)}${mtdOnlinePct !== null ? ` (${fmtPct(mtdOnlinePct)})` : ""}`);
        if (mtdOtherSales !== null) lines.push(`- Other (in-store + wholesale): ${fmt$(mtdOtherSales)}${mtdOtherPct !== null ? ` (${fmtPct(mtdOtherPct)})` : ""}`);
        lines.push(`- Total: ${fmt$(xeroMtdTotalRevenue)}`);
      }
      if (isEarlyMonth && xeroLastMonthRevenue !== null && lastMonthLabel) {
        lines.push("");
        lines.push(`LAST MONTH FINAL (${lastMonthLabel}, Xero reconciled, ex-GST): ${fmt$(xeroLastMonthRevenue)}`);
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

LIVE BANK BALANCE (Xero bank feed, all accounts netted):
- Balance: ${cashNote}

ONLINE MONTH TO DATE (${monthLabel}, Shopify, to today, ex-GST):
- Revenue: ${fmt$(mtdRev)} | ${mtdTx} orders
- Last year MTD: ${hasLyMtd ? `${fmt$(lyMtdRev)}, ${lyMtdTx} orders (${pct(mtdRev, lyMtdRev)} change)` : "not available"}

ONLINE YEAR TO DATE (Shopify, ex-GST):
- Revenue: ${fmt$(ytdRev)}
- Last year YTD: ${hasLyYtd ? `${fmt$(lyYtdRev)} (${pct(ytdRev, lyYtdRev)} change)` : "not available — first year online"}

CUSTOMER MIX (MTD, Shopify):
- New customers: ${newMtd}${hasLyMtd ? ` vs LY: ${newLyMtd}` : ""}
- Returning customers (ordered in prior 12 months): ${retMtd}${hasLyMtd ? ` vs LY: ${retLyMtd}` : ""}

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

GOOGLE ADS SPEND (via Xero bank feed):
- Last 7 days: ${googleWeekSpend !== null ? `$${googleWeekSpend.toFixed(2)}` : "no Google transactions found"}
- Month to date: ${googleMtdSpend !== null ? `$${googleMtdSpend.toFixed(2)}` : "no Google transactions found"}
`;

    const systemPrompt = `You are Teloskope, a smart weekly business advisor for independent retail store owners.
Write a warm, direct, insightful weekly audio brief for a store owner to listen to on Monday morning.
Write in a conversational Australian tone — like a trusted business advisor, not a corporate report.
Be specific with numbers. Be honest about what looks good and what needs watching.
Write in flowing paragraphs only — absolutely no bullet points, no headers, no markdown formatting of any kind.
Do not use any symbols, asterisks, dollar signs, percent signs, or special characters of any kind.

CRITICAL — NUMBER FORMATTING FOR AUDIO:
This script will be read aloud by a text-to-speech voice. You must write ALL numbers in full spoken words so they sound natural when read aloud.
- Dollar amounts over one thousand: express in K to one decimal place — e.g. "fourteen point two K", "fifty eight point seven K". For x.5 values use "and a half". Never say "fourteen thousand two hundred dollars".
- Dollar amounts under one thousand: round to nearest dollar, state in full words. Never state cents.
- Percentages: write as words e.g. "thirteen point three percent"
- Order counts: write as words e.g. "eighteen orders"
- All other numbers: write in full words

ALL FIGURES ARE EX-GST. Mention "ex-GST" once near the start only.

The brief should take about 90 to 120 seconds to read aloud.

WEB SEARCH:
Use the web search tool to find current Australian retail market context before writing the brief — search for recent ABS retail data, RBA rate news, or relevant category news for this store's type. One search is sufficient. Use the most relevant current angle for this specific store.

MARKET CONTEXT TAG:
After using web search, write a one-sentence market context summary for the HTML card. Wrap it in tags exactly like this:
[MARKET_CONTEXT]Your one sentence here — specific, useful, current.[/MARKET_CONTEXT]
Place this tag block at the very start of your response, before the audio brief.

STRUCTURE — follow this order exactly:
1. Open with "Good morning [owner first name]." then 1-2 sentences of the web-searched market context most relevant to this store. End with a bridge: "Against that backdrop, here's how [store name] traded this week."
2. Total sales for the week (online plus other combined, ex-GST), split into online and other.
3. MTD total sales split into online and other, with last year MTD comparison and brief commentary.
${isEarlyMonth && xeroLastMonthRevenue !== null ? `3b. Last month closed at ${fmt$(xeroLastMonthRevenue)} — mention this briefly as the final read on ${lastMonthLabel}.` : ""}
4. Live bank balance — state confidently. It is a live bank feed balance, current as of this morning. No qualifiers.
5. Online transactions and AOV this week.
6. Customer mix MTD vs last year MTD.
7. Top products this week.
8. Meta ads (see META ADS instruction below).
9. Google ads (see GOOGLE ADS instruction below).
10. Close with one specific actionable observation from the current market context. Then sign-off.

CASH BALANCE INSTRUCTION: State the number confidently. No caveats, no evaluative commentary.

When last year data is not available, acknowledge briefly and move on.

META ADS: If Meta data available, report spend for week and MTD. State CPM and CPC and explicitly benchmark against AU retail averages. If zero spend both periods, skip entirely.

GOOGLE ADS: If Google spend available from bank feed, report briefly — weekly and MTD in K format. Note it comes from bank feed. No benchmarking. If no transactions found, skip entirely.

Do NOT include any "Options to explore" section. End directly with: "That's your Teloskope brief for the week. Have a great Monday, and I'll be back next week with your next update."`;

    const userPrompt = `Here is the data for ${store_name} for the ${weekLabel}.

${dataBlock}

First use web search to find current Australian retail market context relevant to this store. Then write the response starting with the [MARKET_CONTEXT] tag, followed by the audio brief. Follow the structure order exactly. All dollar amounts over one thousand in K format. Under one thousand, full words, no cents. No symbols, no dollar signs, no percent signs.`;

    console.log("Calling Claude with web search...");
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 2,
      }],
    });

    // Extract all text blocks (interleaved with search tool blocks)
    const fullText = claudeResponse.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");

    // Extract market context card text from tagged block
    const marketContextMatch = fullText.match(/\[MARKET_CONTEXT\]([\s\S]*?)\[\/MARKET_CONTEXT\]/);
    const marketContextText = marketContextMatch
      ? marketContextMatch[1].trim()
      : "Current market conditions — see brief for details.";

    // Audio brief is everything after the [/MARKET_CONTEXT] tag (or the full text if tag absent)
    const rawBriefText = marketContextMatch
      ? fullText.slice(fullText.indexOf("[/MARKET_CONTEXT]") + "[/MARKET_CONTEXT]".length).trim()
      : fullText.trim();

    console.log("Market context card:", marketContextText);
    console.log("Brief chars:", rawBriefText.length);

    // ─── META CALCULATIONS ────────────────────────────────────────────────────
    const metaWeekCpm = metaWeek && metaWeek.impressions > 0 ? ((metaWeek.spend / metaWeek.impressions) * 1000) : null;
    const metaWeekCpc = metaWeek && metaWeek.clicks > 0 ? (metaWeek.spend / metaWeek.clicks) : null;
    const metaMtdCpm  = metaMtd  && metaMtd.impressions  > 0 ? ((metaMtd.spend  / metaMtd.impressions)  * 1000) : null;
    const metaMtdCpc  = metaMtd  && metaMtd.clicks  > 0 ? (metaMtd.spend  / metaMtd.clicks)  : null;

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

      const benchmarkRow = (label, val, bPct, good, low, high, unit) => bPct !== null ? `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:11px;color:#888780;width:36px;flex-shrink:0">${label}</span>
          <div style="flex:1;height:8px;background:#B5D4F4;border-radius:4px;position:relative">
            <div style="position:absolute;width:3px;height:14px;top:-3px;left:${bPct}%;background:#185FA5;border-radius:2px;transform:translateX(-50%)"></div>
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
          <p style="font-size:13px;color:#5F5E5A;line-height:1.5">When your ads are running, Teloskope will benchmark your cost per click and cost per thousand impressions against AU retail averages.</p>`}
        </div>
      </div>`;
    })();

    // ─── GOOGLE SPEND HTML ────────────────────────────────────────────────────
    const googleSection = (() => {
      if (!googleWeekSpend && !googleMtdSpend) return "";
      return `
      <div style="margin-bottom:20px">
        <p style="font-size:11px;font-weight:500;color:#888780;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">Google ads — via bank feed</p>
        <div style="background:#fff;border:0.5px solid #D3D1C7;border-radius:12px;padding:14px 16px">
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:10px">
            <div style="background:#F1EFE8;border-radius:8px;padding:12px">
              <p style="font-size:12px;color:#888780;margin-bottom:4px">7 day spend</p>
              <p style="font-size:20px;font-weight:500">${googleWeekSpend ? fmt$(googleWeekSpend) : "—"}</p>
            </div>
            <div style="background:#F1EFE8;border-radius:8px;padding:12px">
              <p style="font-size:12px;color:#888780;margin-bottom:4px">Month to date</p>
              <p style="font-size:20px;font-weight:500">${googleMtdSpend ? fmt$(googleMtdSpend) : "—"}</p>
            </div>
          </div>
          <p style="font-size:11px;color:#888780;line-height:1.5">Sourced from Xero bank feed — no Google login required. May vary slightly from Google Ads dashboard due to billing cycles.</p>
        </div>
      </div>`;
    })();

    // ─── MONTHLY CLOSE CARD (early month only) ────────────────────────────────
    const monthlyCloseSection = (isEarlyMonth && xeroLastMonthRevenue !== null && lastMonthLabel) ? `
      <div style="margin-bottom:20px">
        <p style="font-size:11px;font-weight:500;color:#888780;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">${lastMonthLabel} — final</p>
        <div style="background:#fff;border:0.5px solid #D3D1C7;border-radius:12px;padding:14px 16px">
          <p style="font-size:30px;font-weight:500;color:#2C2C2A;line-height:1">${fmt$(xeroLastMonthRevenue)}</p>
          <p style="font-size:13px;color:#888780;margin-top:6px">Xero reconciled total — final read for ${lastMonthLabel}</p>
        </div>
      </div>` : "";

    // ─── BRIEF HTML ───────────────────────────────────────────────────────────
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
    <p class="tlsk-label">Market context — week ending ${fmtDate(weekEnd, { day: "numeric", month: "long", year: "numeric" })}</p>
    <div style="background:#fff;border:0.5px solid #D3D1C7;border-left:3px solid #B5D4F4;border-radius:0 12px 12px 0;padding:12px 14px">
      <p style="font-size:13px;color:#5F5E5A;line-height:1.6;margin-bottom:6px">${marketContextText}</p>
    </div>
  </div>

  ${monthlyCloseSection}

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
        <div style="flex:1">
          <div style="height:${Math.round((mtdRev / Math.max(mtdRev, lyMtdRev)) * 56)}px;background:#378ADD;border-radius:4px 4px 0 0"></div>
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
    <p class="tlsk-label">Live bank balance</p>
    <div class="tlsk-card">
      ${cashNum ? `<p class="tlsk-hero">${cashNum}</p><p class="tlsk-sub" style="margin-top:6px">Via Xero bank feed — updated daily</p>` : `<p style="font-size:14px;color:#888780">Not available — Xero not connected</p>`}
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

  ${googleSection}

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
