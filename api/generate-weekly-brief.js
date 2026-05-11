// api/generate-weekly-brief.js
// Pulls Shopify + Xero (cash + bank txns) → classifies channel + ad spend → Claude → ElevenLabs → Bubble → Twilio SMS
// V1.1: adds bank-feed channel attribution (online/in-store/other) and ad spend detection from Xero bank descriptors.

import Anthropic from "@anthropic-ai/sdk";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = "YCxeyFA0G7yTk6Wuv2oq"; // Matt Washer
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BUBBLE_BASE_URL = "https://teloskope.bubbleapps.io/version-test/api/1.1";

// ─── DESCRIPTOR PATTERN LIBRARY ──────────────────────────────────────────────
// kind: 'online' | 'instore' | 'either' | 'ad_*'
// gst_inclusive: true → divide amount by 1.1 to get ex-GST revenue/spend
const PAYMENT_DESCRIPTORS = [
  // Online payment processors
  { name: "Shopify Payments", pattern: /SHOPIFY[\s-]/i,                               kind: "online",       gst_inclusive: true },
  { name: "Stripe",           pattern: /STRIPE[\s-]/i,                                kind: "online",       gst_inclusive: true },
  { name: "PayPal",           pattern: /PAYPAL/i,                                     kind: "online",       gst_inclusive: true },

  // BNPL — default to online (most BNPL revenue flows through ecommerce)
  { name: "Afterpay",         pattern: /Afterpay/i,                                   kind: "either",       gst_inclusive: true },
  { name: "Zip",              pattern: /\bZIP\s+PAY\b|\bZIPPAY\b/i,                   kind: "either",       gst_inclusive: true },
  { name: "Klarna",           pattern: /KLARNA/i,                                     kind: "either",       gst_inclusive: true },

  // In-store payment processors (refined further by shop_descriptor_pattern in classifier)
  { name: "Tyro (FLEXIPAY)",  pattern: /FLEXIPAY/i,                                   kind: "instore",      gst_inclusive: true },
  { name: "Square",           pattern: /\bSQ\s*\*/i,                                  kind: "instore",      gst_inclusive: true },
  { name: "EFTPOS",           pattern: /^EFTPOS\s/i,                                  kind: "instore",      gst_inclusive: true },

  // Ad platforms (debits)
  { name: "Meta Ads",         pattern: /FACEBK|FACEBOOK|fb\.me\/ads|META PLATFORMS/i, kind: "ad_meta",      gst_inclusive: true },
  { name: "Google Ads",       pattern: /GOOGLE.*ADS|GOOGLE\*ADS|ADWORDS/i,            kind: "ad_google",    gst_inclusive: true },
  { name: "Pinterest Ads",    pattern: /PINTEREST.*AD|PINTEREST\s+AD/i,               kind: "ad_pinterest", gst_inclusive: true },
  { name: "TikTok Ads",       pattern: /TIKTOK.*AD|BYTEDANCE/i,                       kind: "ad_tiktok",    gst_inclusive: true },
  { name: "LinkedIn Ads",     pattern: /LINKEDIN.*AD/i,                               kind: "ad_linkedin",  gst_inclusive: true },
];

const AD_KINDS = new Set(["ad_meta", "ad_google", "ad_pinterest", "ad_tiktok", "ad_linkedin"]);

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
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
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
        console.error("Xero token refresh failed — skipping cash balance");
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
    console.log("Xero cash balance result:", result);
    return result;
  } catch (err) {
    console.error("Xero fetch error:", err.message);
    return null;
  }
}

async function fetchXeroBankTransactions(start, end, xeroAccessToken, xeroTenantId, xeroRefreshToken, xeroConnectionId) {
  const fromIso = start.toISOString().split("T")[0]; // YYYY-MM-DD
  const toIso   = end.toISOString().split("T")[0];

  // Xero where-clause expects DateTime(YYYY, MM, DD) format (no zero-padding on month/day)
  const datePartsFrom = fromIso.split("-").map(Number);
  const datePartsTo   = toIso.split("-").map(Number);
  const where = encodeURIComponent(
    `Date >= DateTime(${datePartsFrom[0]}, ${datePartsFrom[1]}, ${datePartsFrom[2]}) AND Date <= DateTime(${datePartsTo[0]}, ${datePartsTo[1]}, ${datePartsTo[2]})`
  );

  const buildUrl = (page) => `https://api.xero.com/api.xro/2.0/BankTransactions?where=${where}&page=${page}`;

  const doFetch = async (token, url) => {
    return fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Xero-tenant-id": xeroTenantId,
        Accept: "application/json",
      },
    });
  };

  try {
    let activeToken = xeroAccessToken;
    let allTxns = [];
    let page = 1;
    let keepGoing = true;

    while (keepGoing) {
      let response = await doFetch(activeToken, buildUrl(page));

      if (response.status === 401 && xeroRefreshToken && xeroConnectionId) {
        console.log("Xero token expired during BankTransactions — refreshing...");
        const newToken = await refreshXeroToken(xeroRefreshToken, xeroConnectionId);
        if (!newToken) {
          console.error("Token refresh failed mid-fetch");
          return null;
        }
        activeToken = newToken;
        response = await doFetch(activeToken, buildUrl(page));
      }

      if (!response.ok) {
        console.error("Xero BankTransactions error:", response.status, await response.text());
        return null;
      }

      const data = await response.json();
      const batch = data?.BankTransactions || [];
      allTxns = allTxns.concat(batch);

      // Xero pages BankTransactions at 100 per page
      if (batch.length < 100) {
        keepGoing = false;
      } else {
        page += 1;
      }

      if (page > 20) {
        console.warn("BankTransactions paging hit 20 pages — bailing");
        break;
      }
    }

    console.log("Xero BankTransactions fetched:", allTxns.length);
    return allTxns;
  } catch (err) {
    console.error("BankTransactions fetch error:", err.message);
    return null;
  }
}

function classifyBankTransactions(transactions, shopDescriptor) {
  const result = {
    online_excl_gst:    0,
    instore_excl_gst:   0,
    other_excl_gst:     0,
    gst_collected:      0,

    ad_meta:       0,
    ad_google:     0,
    ad_pinterest:  0,
    ad_tiktok:     0,
    ad_linkedin:   0,
    ad_total:      0,

    matched_count:    0,
    unmatched_count:  0,
    unmatched_value:  0,
    unmatched_samples: [],
  };

  if (!Array.isArray(transactions)) return result;

  const shopPatternLower = (shopDescriptor || "").toLowerCase();

  for (const txn of transactions) {
    const desc = [
      txn.Reference,
      txn.Particulars,
      txn.Narration,
      txn.Description,
      txn.Contact?.Name,
    ].filter(Boolean).join(" ");

    const total = parseFloat(txn.Total || 0);
    const isCredit = txn.Type === "RECEIVE" || txn.Type === "RECEIVE-TRANSFER";
    const isDebit  = txn.Type === "SPEND"   || txn.Type === "SPEND-TRANSFER";

    let matched = false;

    for (const d of PAYMENT_DESCRIPTORS) {
      if (!d.pattern.test(desc)) continue;

      // Ad spend — debits only
      if (AD_KINDS.has(d.kind)) {
        if (isDebit) {
          const amount = d.gst_inclusive ? total / 1.1 : total;
          result[d.kind] += amount;
          result.ad_total += amount;
          matched = true;
        }
        break;
      }

      // Revenue — credits only
      if (!isCredit) {
        // a debit matching a revenue processor is probably a refund — track but don't bucket
        matched = true;
        break;
      }

      const amountExclGst = d.gst_inclusive ? total / 1.1 : total;
      const gstAmount     = d.gst_inclusive ? total - amountExclGst : 0;

      // Determine channel
      let channel = d.kind; // 'online' | 'instore' | 'either'

      if (channel === "instore") {
        if (shopPatternLower && desc.toLowerCase().includes(shopPatternLower)) {
          channel = "instore";
        } else if (!shopPatternLower) {
          // No shop pattern configured — accept the instore classification on faith
          channel = "instore";
        } else {
          // Pattern matched (e.g. FLEXIPAY) but address doesn't match user's shop
          // Probably another location or noise — bucket as other
          channel = "other";
        }
      } else if (channel === "either") {
        // BNPL fallback — attribute to online
        channel = "online";
      }

      if (channel === "online") {
        result.online_excl_gst += amountExclGst;
      } else if (channel === "instore") {
        result.instore_excl_gst += amountExclGst;
      } else {
        result.other_excl_gst += amountExclGst;
      }
      result.gst_collected += gstAmount;

      matched = true;
      break;
    }

    if (matched) {
      result.matched_count += 1;
    } else if (isCredit) {
      result.unmatched_count += 1;
      result.unmatched_value += total;
      if (result.unmatched_samples.length < 5) {
        result.unmatched_samples.push({ desc: desc.substring(0, 100), total });
      }
    }
  }

  return result;
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
    shop_descriptor_pattern,
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
    console.log("Shop descriptor pattern:", shop_descriptor_pattern || "(none)");

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
    console.log("PCW:    ", pS.toISOString(), "→", pE.toISOString());
    console.log("MTD:    ", mS.toISOString(), "→", mE.toISOString());
    console.log("LY MTD: ", lmS.toISOString(), "→", lmE.toISOString());
    console.log("YTD:    ", yS.toISOString(), "→", yE.toISOString());
    console.log("LY YTD: ", lyS.toISOString(), "→", lyE.toISOString());

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

    const sumRevenue = (orders) => orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
    const calcAov    = (orders) => orders.length > 0 ? sumRevenue(orders) / orders.length : 0;

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
          state,
          count,
          pct: total > 0 ? Math.round((count / total) * 100) : 0,
        }));
      return {
        topStates,
        ausCount,
        overseasCount,
        ausPct: total > 0 ? Math.round((ausCount / total) * 100) : 0,
        overseaPct: total > 0 ? Math.round((overseasCount / total) * 100) : 0,
        total,
      };
    };

    // ─── PARALLEL FETCH ───────────────────────────────────────────────────────

    console.log("Fetching Shopify data + Xero...");

    const MTD_FIELDS     = "total_price,created_at,customer";
    const PRE_MTD_FIELDS = "created_at,customer";

    const [
      weekOrders, pcwOrders,
      mtdOrders, lyMtdOrders,
      ytdOrders, lyYtdOrders,
      preMtdOrders, preLyMtdOrders,
      weekOrdersDetail,
      xeroCashBalance,
      bankTxnsWeek,
      bankTxnsMtd,
    ] = await Promise.all([
      fetchAllOrders(wS, wE),
      fetchAllOrders(pS, pE),
      fetchAllOrders(mS, mE, MTD_FIELDS),
      fetchAllOrders(lmS, lmE, MTD_FIELDS),
      fetchAllOrders(yS, yE),
      fetchAllOrders(lyS, lyE),
      fetchAllOrders(yS, new Date(mS.getTime() - 1), PRE_MTD_FIELDS),
      fetchAllOrders(lyS, new Date(lmS.getTime() - 1), PRE_MTD_FIELDS),
      fetchAllOrders(wS, wE, "line_items,shipping_address"),
      (xero_access_token && xero_tenant_id)
        ? fetchXeroCashBalance(xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id)
        : Promise.resolve(null),
      (xero_access_token && xero_tenant_id)
        ? fetchXeroBankTransactions(wS, wE, xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id)
        : Promise.resolve([]),
      (xero_access_token && xero_tenant_id)
        ? fetchXeroBankTransactions(mS, mE, xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id)
        : Promise.resolve([]),
    ]);

    console.log("Week orders:", weekOrders.length, "| Revenue:", sumRevenue(weekOrders).toFixed(2));
    console.log("PCW  orders:", pcwOrders.length,  "| Revenue:", sumRevenue(pcwOrders).toFixed(2));
    console.log("MTD  orders:", mtdOrders.length,  "| Revenue:", sumRevenue(mtdOrders).toFixed(2));
    console.log("LY MTD:     ", lyMtdOrders.length, "| Revenue:", sumRevenue(lyMtdOrders).toFixed(2));
    console.log("YTD  orders:", ytdOrders.length,  "| Revenue:", sumRevenue(ytdOrders).toFixed(2));
    console.log("LY YTD:     ", lyYtdOrders.length, "| Revenue:", sumRevenue(lyYtdOrders).toFixed(2));
    console.log("Pre-MTD orders:", preMtdOrders.length);
    console.log("Xero cash balance:", xeroCashBalance);

    // ─── CLASSIFY BANK TRANSACTIONS ──────────────────────────────────────────
    const weekBank = classifyBankTransactions(bankTxnsWeek, shop_descriptor_pattern);
    const mtdBank  = classifyBankTransactions(bankTxnsMtd,  shop_descriptor_pattern);

    console.log("Week bank classification:", {
      online: weekBank.online_excl_gst.toFixed(2),
      instore: weekBank.instore_excl_gst.toFixed(2),
      other: weekBank.other_excl_gst.toFixed(2),
      gst: weekBank.gst_collected.toFixed(2),
      matched: weekBank.matched_count,
      unmatched: weekBank.unmatched_count,
    });
    console.log("MTD ad spend:", {
      meta: mtdBank.ad_meta.toFixed(2),
      google: mtdBank.ad_google.toFixed(2),
      pinterest: mtdBank.ad_pinterest.toFixed(2),
      tiktok: mtdBank.ad_tiktok.toFixed(2),
      linkedin: mtdBank.ad_linkedin.toFixed(2),
      total: mtdBank.ad_total.toFixed(2),
    });
    if (weekBank.unmatched_samples.length > 0) {
      console.log("Unmatched credit samples (for pattern library expansion):");
      for (const s of weekBank.unmatched_samples) {
        console.log(`  $${s.total.toFixed(2)}: ${s.desc}`);
      }
    }

    const mtdBankRevenueTotal = mtdBank.online_excl_gst + mtdBank.instore_excl_gst + mtdBank.other_excl_gst;
    const mer = mtdBankRevenueTotal > 0 ? (mtdBank.ad_total / mtdBankRevenueTotal) : 0;
    console.log("MER MTD:", (mer * 100).toFixed(1) + "%");

    // ─── NEW VS RETURNING CUSTOMER LOGIC ─────────────────────────────────────
    const preMtdCustomerIds = new Set(
      preMtdOrders.filter(o => o.customer?.id).map(o => String(o.customer.id))
    );
    const preLyMtdCustomerIds = new Set(
      preLyMtdOrders.filter(o => o.customer?.id).map(o => String(o.customer.id))
    );

    const countNewRet = (orders, priorCustomerIds) => {
      let newC = 0, ret = 0;
      for (const o of orders) {
        if (!o.customer?.id) {
          newC++;
          continue;
        }
        priorCustomerIds.has(String(o.customer.id)) ? ret++ : newC++;
      }
      console.log(`countNewRet: new=${newC}, returning=${ret}, total=${orders.length}`);
      return { newC, ret };
    };

    // ─── CALCULATIONS ─────────────────────────────────────────────────────────

    const weekRev  = sumRevenue(weekOrders);
    const pcwRev   = sumRevenue(pcwOrders);
    const mtdRev   = sumRevenue(mtdOrders);
    const lyMtdRev = sumRevenue(lyMtdOrders);
    const ytdRev   = sumRevenue(ytdOrders);
    const lyYtdRev = sumRevenue(lyYtdOrders);
    const weekTx   = weekOrders.length;
    const pcwTx    = pcwOrders.length;
    const mtdTx    = mtdOrders.length;
    const lyMtdTx  = lyMtdOrders.length;
    const weekAov  = calcAov(weekOrders);
    const pcwAov   = calcAov(pcwOrders);

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

    const pct  = (a, b) => b > 0 ? `${(((a - b) / b) * 100).toFixed(1)}%` : "N/A";
    const fmt$ = (n) => `$${Math.round(n).toLocaleString()}`;
    const fmtPct = (n) => (n * 100).toFixed(1) + "%";

    const hasLyWeek = pcwRev > 0 || pcwTx > 0;
    const hasLyMtd  = lyMtdRev > 0 || lyMtdTx > 0;
    const hasLyYtd  = lyYtdRev > 0;

    const weekLabel  = `week ending ${fmtDate(weekEnd)}`;
    const monthLabel = fmtDate({ year: today.year, month: today.month, day: 1 }, { month: "long", year: "numeric" });
    const cashNote   = xeroCashBalance !== null && xeroCashBalance !== undefined
      ? fmt$(xeroCashBalance)
      : "not available";

    const firstName = (user_name || "").split(" ")[0] || user_name;

    // ─── CHANNEL ATTRIBUTION + AD SPEND BLOCKS FOR CLAUDE ────────────────────

    const channelBlock = (() => {
      const total = weekBank.online_excl_gst + weekBank.instore_excl_gst + weekBank.other_excl_gst;
      if (total === 0) {
        return "CHANNEL ATTRIBUTION (this week, from bank deposits ex-GST):\n- No bank deposits matched yet — Xero may still be syncing for this week";
      }
      const lines = [];
      lines.push(`CHANNEL ATTRIBUTION (this week, from bank deposits ex-GST):`);
      if (weekBank.online_excl_gst > 0)  lines.push(`- Online: ${fmt$(weekBank.online_excl_gst)} (${fmtPct(weekBank.online_excl_gst / total)})`);
      if (weekBank.instore_excl_gst > 0) lines.push(`- In-store: ${fmt$(weekBank.instore_excl_gst)} (${fmtPct(weekBank.instore_excl_gst / total)})`);
      if (weekBank.other_excl_gst > 0)   lines.push(`- Other / wholesale: ${fmt$(weekBank.other_excl_gst)} (${fmtPct(weekBank.other_excl_gst / total)})`);
      lines.push(`- Total bank deposits this week (ex-GST): ${fmt$(total)}`);
      lines.push(`- GST collected this week: ${fmt$(weekBank.gst_collected)}`);
      return lines.join("\n");
    })();

    const adSpendBlock = (() => {
      if (mtdBank.ad_total === 0) {
        return "MARKETING SPEND (MTD, from bank): None detected — either no ads running or platforms haven't billed yet this month";
      }
      const lines = [];
      lines.push(`MARKETING SPEND (MTD, from bank deposits ex-GST):`);
      if (mtdBank.ad_meta > 0)      lines.push(`- Meta (Facebook/Instagram): ${fmt$(mtdBank.ad_meta)}`);
      if (mtdBank.ad_google > 0)    lines.push(`- Google Ads: ${fmt$(mtdBank.ad_google)}`);
      if (mtdBank.ad_pinterest > 0) lines.push(`- Pinterest Ads: ${fmt$(mtdBank.ad_pinterest)}`);
      if (mtdBank.ad_tiktok > 0)    lines.push(`- TikTok Ads: ${fmt$(mtdBank.ad_tiktok)}`);
      if (mtdBank.ad_linkedin > 0)  lines.push(`- LinkedIn Ads: ${fmt$(mtdBank.ad_linkedin)}`);
      lines.push(`- Total ad spend MTD: ${fmt$(mtdBank.ad_total)}`);
      if (mtdBankRevenueTotal > 0) {
        lines.push(`- MTD revenue (bank, ex-GST): ${fmt$(mtdBankRevenueTotal)}`);
        lines.push(`- Marketing efficiency ratio: ${fmtPct(mer)} (every dollar of revenue cost ${(mer * 100).toFixed(0)} cents in advertising)`);
      }
      return lines.join("\n");
    })();

    // ─── CLAUDE PROMPT ────────────────────────────────────────────────────────

    const dataBlock = `
STORE: ${store_name}
OWNER FIRST NAME: ${firstName}
PERIOD: ${weekLabel}
CHANNEL: Online + In-store (where bank-detected)

WEEKLY PERFORMANCE (Shopify online):
- Revenue: ${fmt$(weekRev)} | ${weekTx} orders | AOV ${fmt$(weekAov)}
- Same week last year: ${hasLyWeek ? `${fmt$(pcwRev)}, ${pcwTx} orders, AOV ${fmt$(pcwAov)} (${pct(weekRev, pcwRev)} change)` : "not available — no online orders this week last year"}

CASH POSITION (Xero):
- Bank balance: ${cashNote}

${channelBlock}

${adSpendBlock}

MONTH TO DATE (${monthLabel}, Shopify):
- Revenue: ${fmt$(mtdRev)} | ${mtdTx} orders
- Last year MTD: ${hasLyMtd ? `${fmt$(lyMtdRev)}, ${lyMtdTx} orders (${pct(mtdRev, lyMtdRev)} change)` : "not available"}

YEAR TO DATE (Shopify):
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

The brief should take about 90 to 120 seconds to read aloud.
Always open with "Good morning [owner first name]." as the very first words. Then immediately lead with the headline revenue figure for the week in full words in the next sentence.
Cover, in this order: online revenue and year-on-year comparison, total bank deposits this week split by channel where available (online vs in-store vs other), cash position, marketing spend MTD and the marketing efficiency ratio if available, transactions and AOV, customer mix, where customers are from, top products, and what it all means together.
Treat the bank-deposit channel data as the cash-truth view — what actually came into the bank account this week, ex-GST. The Shopify figures are the order-level view. They will not match exactly because of payment processing delays — note this naturally if there's a meaningful gap.
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
    console.log("Brief starts with:", rawBriefText.substring(0, 80));
    console.log("Brief ends with:", rawBriefText.substring(rawBriefText.length - 80));

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

    const revItems = [
      `This week (Shopify): ${fmt$(weekRev)} — ${weekTx} orders, AOV ${fmt$(weekAov)}`,
      hasLyWeek
        ? `Same week last year: ${fmt$(pcwRev)}, ${pcwTx} orders (${pct(weekRev, pcwRev)} change)`
        : "Same week last year: not available — first year online",
      `${monthLabel} to date (Shopify): ${fmt$(mtdRev)} — ${mtdTx} orders`,
      hasLyMtd
        ? `Last year MTD: ${fmt$(lyMtdRev)} (${pct(mtdRev, lyMtdRev)} change)`
        : "Last year MTD: not available",
      `Year to date (Shopify): ${fmt$(ytdRev)}`,
      hasLyYtd
        ? `Last year YTD: ${fmt$(lyYtdRev)} (${pct(ytdRev, lyYtdRev)} change)`
        : "Last year YTD: not available — first year online",
    ];

    const channelItems = (() => {
      const total = weekBank.online_excl_gst + weekBank.instore_excl_gst + weekBank.other_excl_gst;
      if (total === 0) return ["No bank deposits matched this week"];
      const items = [];
      if (weekBank.online_excl_gst > 0)  items.push(`Online: ${fmt$(weekBank.online_excl_gst)} (${fmtPct(weekBank.online_excl_gst / total)})`);
      if (weekBank.instore_excl_gst > 0) items.push(`In-store: ${fmt$(weekBank.instore_excl_gst)} (${fmtPct(weekBank.instore_excl_gst / total)})`);
      if (weekBank.other_excl_gst > 0)   items.push(`Other / wholesale: ${fmt$(weekBank.other_excl_gst)} (${fmtPct(weekBank.other_excl_gst / total)})`);
      items.push(`Total bank deposits ex-GST: ${fmt$(total)}`);
      items.push(`GST collected: ${fmt$(weekBank.gst_collected)}`);
      return items;
    })();

    const adSpendItems = (() => {
      if (mtdBank.ad_total === 0) return ["No ad platform spend detected this month"];
      const items = [];
      if (mtdBank.ad_meta > 0)      items.push(`Meta: ${fmt$(mtdBank.ad_meta)}`);
      if (mtdBank.ad_google > 0)    items.push(`Google Ads: ${fmt$(mtdBank.ad_google)}`);
      if (mtdBank.ad_pinterest > 0) items.push(`Pinterest: ${fmt$(mtdBank.ad_pinterest)}`);
      if (mtdBank.ad_tiktok > 0)    items.push(`TikTok: ${fmt$(mtdBank.ad_tiktok)}`);
      if (mtdBank.ad_linkedin > 0)  items.push(`LinkedIn: ${fmt$(mtdBank.ad_linkedin)}`);
      items.push(`Total MTD ad spend: ${fmt$(mtdBank.ad_total)}`);
      if (mtdBankRevenueTotal > 0) {
        items.push(`MER: ${fmtPct(mer)} (advertising as % of bank revenue)`);
      }
      return items;
    })();

    const cashItems = [
      `Bank balance: ${cashNote}${xeroCashBalance !== null && xeroCashBalance !== undefined && xeroCashBalance <= 0 ? " — needs attention" : ""}`,
    ];

    const txItems = [
      `${weekTx} transactions this week${hasLyWeek ? `, vs ${pcwTx} last year` : ""}`,
      `Average order value: ${fmt$(weekAov)}${hasLyWeek ? ` vs ${fmt$(pcwAov)} last year` : ""}`,
      `${monthLabel} to date: ${mtdTx} transactions total`,
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
      section("Revenue (Shopify):", revItems),
      section("Channel Mix (Bank, this week ex-GST):", channelItems),
      section("Marketing Spend (MTD, ex-GST):", adSpendItems),
      section("Cash Position:", cashItems),
      section("Transactions and Average Order Value:", txItems),
      section("New vs Returning Customers:", custItems),
      section("Top 5 Products This Week:", prodItems),
      section("Customer Locations:", locItems),
      optionsHtml,
    ].join("\n");

    console.log("brief_text length:", briefText.length);
    console.log("brief_text preview:", briefText.substring(0, 200));

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
      total_week_revenue: Math.round(weekRev * 100) / 100,
      total_pcw_revenue: Math.round(pcwRev * 100) / 100,
      total_mtd_revenue: Math.round(mtdRev * 100) / 100,
      total_ly_mtd_revenue: Math.round(lyMtdRev * 100) / 100,
      shopify_ytd_revenue: Math.round(ytdRev * 100) / 100,
      shopify_ly_ytd_revenue: Math.round(lyYtdRev * 100) / 100,
      total_week_transactions: weekTx,
      total_mtd_transactions: mtdTx,
      total_week_aov: Math.round(weekAov * 100) / 100,
      new_customers_mtd: newMtd,
      returning_customers_mtd: retMtd,
      top_products_json: JSON.stringify(topProducts),
      xero_cash_balance: xeroCashBalance !== null ? Math.round(xeroCashBalance * 100) / 100 : null,

      // Bank-feed channel attribution (this week, ex-GST)
      revenue_online_excl_gst:     Math.round(weekBank.online_excl_gst * 100) / 100,
      revenue_instore_excl_gst:    Math.round(weekBank.instore_excl_gst * 100) / 100,
      revenue_other_excl_gst:      Math.round(weekBank.other_excl_gst * 100) / 100,
      revenue_total_bank_excl_gst: Math.round((weekBank.online_excl_gst + weekBank.instore_excl_gst + weekBank.other_excl_gst) * 100) / 100,
      gst_collected_estimate:      Math.round(weekBank.gst_collected * 100) / 100,

      // Ad spend (MTD, ex-GST)
      ad_spend_meta:      Math.round(mtdBank.ad_meta * 100) / 100,
      ad_spend_pinterest: Math.round(mtdBank.ad_pinterest * 100) / 100,
      ad_spend_google:    Math.round(mtdBank.ad_google * 100) / 100,
      ad_spend_other:     Math.round((mtdBank.ad_tiktok + mtdBank.ad_linkedin) * 100) / 100,
      ad_spend_total:     Math.round(mtdBank.ad_total * 100) / 100,
      marketing_efficiency_ratio: Math.round(mer * 10000) / 10000,

      // Diagnostics
      unmatched_transactions_count: weekBank.unmatched_count,
      unmatched_transactions_value: Math.round(weekBank.unmatched_value * 100) / 100,
    };

    console.log("Bubble payload brief_text length:", bubblePayload.brief_text.length);
    console.log("Audio URL being stored:", audioUrl);

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
