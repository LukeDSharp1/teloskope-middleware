// api/generate-monthly-brief.js
// Pulls Xero P&L + Balance Sheet + Shopify inventory → Claude → Bubble
// Manually triggered from Bubble for now. Cron (17th of month) to be added later.

import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BUBBLE_BASE_URL = "https://teloskope.ai/version-test/api/1.1";

// ─── XERO TOKEN REFRESH (identical to weekly brief) ───────────────────────────

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
    await fetch(`${BUBBLE_BASE_URL}/obj/xero_connection/${xeroConnectionId}`, {
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
    });

    return tokens.access_token;
  } catch (err) {
    console.error("Xero refresh error:", err.message);
    return null;
  }
}

// ─── XERO API FETCH WITH AUTO-REFRESH ────────────────────────────────────────

async function xeroFetch(url, accessToken, tenantId, refreshToken, connectionId) {
  const doFetch = (token) =>
    fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Xero-tenant-id": tenantId,
        Accept: "application/json",
      },
    });

  let res = await doFetch(accessToken);

  if (res.status === 401 && refreshToken && connectionId) {
    console.log("Xero 401 — refreshing token...");
    const newToken = await refreshXeroToken(refreshToken, connectionId);
    if (newToken) {
      res = await doFetch(newToken);
    } else {
      throw new Error("Xero token refresh failed");
    }
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Xero API error ${res.status}: ${body}`);
  }

  return res.json();
}

// ─── XERO P&L PARSER ─────────────────────────────────────────────────────────
// Walks the nested Rows structure and extracts account values by partial name match.
// Returns a flat map of { normalisedLabel: value }

function parseXeroPL(report) {
  const accounts = {};

  const walkRows = (rows) => {
    for (const row of rows || []) {
      if ((row.RowType === "Row" || row.RowType === "SummaryRow") && row.Cells?.length >= 2) {
        const label = (row.Cells[0]?.Value || "").trim();
        const raw = (row.Cells[1]?.Value || "").replace(/,/g, "");
        const val = parseFloat(raw);
        if (label && !isNaN(val)) {
          accounts[label] = val;
        }
      }
      if (row.Rows) walkRows(row.Rows);
    }
  };

  walkRows(report?.Rows);
  return accounts;
}

// Find first account whose label contains any of the search terms (case-insensitive)
function findAccount(accounts, ...terms) {
  for (const [label, val] of Object.entries(accounts)) {
    const l = label.toLowerCase();
    if (terms.some(t => l.includes(t.toLowerCase()))) {
      return { label, val };
    }
  }
  return null;
}

// Sum all accounts whose labels contain any of the search terms
function sumAccounts(accounts, ...terms) {
  let total = 0;
  for (const [label, val] of Object.entries(accounts)) {
    const l = label.toLowerCase();
    if (terms.some(t => l.includes(t.toLowerCase()))) {
      total += val;
    }
  }
  return total;
}

// ─── XERO BALANCE SHEET PARSER ────────────────────────────────────────────────

function parseXeroBalanceSheet(report) {
  const values = {};

  const walkRows = (rows) => {
    for (const row of rows || []) {
      if ((row.RowType === "Row" || row.RowType === "SummaryRow") && row.Cells?.length >= 2) {
        const label = (row.Cells[0]?.Value || "").trim().toLowerCase();
        const raw = (row.Cells[1]?.Value || "").replace(/,/g, "");
        const val = parseFloat(raw);
        if (label && !isNaN(val)) {
          values[label] = val;
        }
      }
      if (row.Rows) walkRows(row.Rows);
    }
  };

  walkRows(report?.Rows);

  // Extract key figures
  let cashBalance = null;
  let accountsReceivable = null;
  let accountsPayable = null;

  for (const [label, val] of Object.entries(values)) {
    if (label.includes("total bank") && cashBalance === null) cashBalance = val;
    else if (label.includes("cash") && cashBalance === null) cashBalance = val;
    if (label.includes("accounts receivable") && accountsReceivable === null) accountsReceivable = val;
    if (label.includes("accounts payable") && accountsPayable === null) accountsPayable = val;
  }

  return { cashBalance, accountsReceivable, accountsPayable };
}

// ─── SHOPIFY INVENTORY ────────────────────────────────────────────────────────
// Pulls all inventory items and sums their value (quantity × cost)

async function fetchShopifyInventoryValue(shopDomain, accessToken) {
  try {
    let totalValue = 0;
    let totalUnits = 0;
    let url = `https://${shopDomain}/admin/api/2024-01/variants.json?fields=inventory_quantity,compare_at_price,price&limit=250`;

    while (url) {
      const res = await fetch(url, {
        headers: { "X-Shopify-Access-Token": accessToken },
      });
      if (!res.ok) throw new Error(`Shopify variants error ${res.status}`);
      const data = await res.json();
      for (const v of data.variants || []) {
        const qty = parseInt(v.inventory_quantity || 0);
        const cost = parseFloat(v.compare_at_price || v.price || 0);
        if (qty > 0) {
          totalValue += qty * cost;
          totalUnits += qty;
        }
      }
      const link = res.headers.get("Link");
      url = (link && link.includes('rel="next"'))
        ? (link.match(/<([^>]+)>;\s*rel="next"/) || [])[1] || null
        : null;
    }

    console.log(`Shopify inventory: ${totalUnits} units, estimated value $${totalValue.toFixed(2)}`);
    return { totalValue, totalUnits };
  } catch (err) {
    console.error("Shopify inventory fetch error:", err.message);
    return null;
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const fmt$ = (n) => n !== null && n !== undefined ? `$${Math.round(n).toLocaleString()}` : "not available";
const fmtPct = (n) => n !== null && n !== undefined ? `${n.toFixed(1)}%` : "N/A";
const pctOf = (val, base) => base > 0 ? (val / base) * 100 : null;
const pctChange = (a, b) => b > 0 ? `${(((a - b) / b) * 100).toFixed(1)}%` : "N/A";

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
    store_name,
    // Optional: override which month to generate for (defaults to prior month)
    // Format: "YYYY-MM" e.g. "2026-03"
    target_month,
  } = req.body;

  if (!xero_access_token || !xero_tenant_id || !user_id) {
    return res.status(400).json({ error: "Missing required fields: xero_access_token, xero_tenant_id, user_id" });
  }

  try {
    // ─── DATE CALCULATIONS ────────────────────────────────────────────────────
    // Default to prior complete month

    const now = new Date();
    let targetYear, targetMonth;

    if (target_month && /^\d{4}-\d{2}$/.test(target_month)) {
      [targetYear, targetMonth] = target_month.split("-").map(Number);
      targetMonth -= 1; // JS months are 0-indexed
    } else {
      const prior = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      targetYear = prior.getFullYear();
      targetMonth = prior.getMonth();
    }

    const fromDate = new Date(targetYear, targetMonth, 1);
    const toDate = new Date(targetYear, targetMonth + 1, 0); // last day of month

    const pad = (n) => String(n).padStart(2, "0");
    const fromStr = `${fromDate.getFullYear()}-${pad(fromDate.getMonth() + 1)}-01`;
    const toStr   = `${toDate.getFullYear()}-${pad(toDate.getMonth() + 1)}-${pad(toDate.getDate())}`;

    const monthLabel = fromDate.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
    console.log(`Generating monthly brief for: ${monthLabel} (${fromStr} → ${toStr})`);

    const firstName = (user_name || "").split(" ")[0] || user_name;

    // ─── XERO P&L ─────────────────────────────────────────────────────────────

    console.log("Fetching Xero P&L...");
    const plData = await xeroFetch(
      `https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${fromStr}&toDate=${toStr}&periods=1&timeframe=MONTH`,
      xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id
    );

    const plReport = plData?.Reports?.[0];
    const accounts = parseXeroPL(plReport);

    console.log("P&L accounts found:", Object.keys(accounts).length);
    console.log("P&L accounts:", JSON.stringify(accounts, null, 2));

    // ─── EXTRACT RELIABLE P&L FIELDS ──────────────────────────────────────────
    // Revenue — sum of all trading income lines except discounts
    const revenueAccounts = Object.entries(accounts)
      .filter(([label]) => {
        const l = label.toLowerCase();
        return (l.includes("sales") || l.includes("revenue") || l.includes("income"))
          && !l.includes("discount") && !l.includes("total");
      })
      .reduce((sum, [, val]) => sum + val, 0);

    const discounts = Math.abs(sumAccounts(accounts, "discount"));
    const netRevenue = revenueAccounts - discounts;

    // Reliable expense lines
    const advertising = sumAccounts(accounts, "advertising", "marketing");
    const freight     = sumAccounts(accounts, "freight", "courier", "shipping");
    const wages       = sumAccounts(accounts, "wages", "salaries", "superannuation", "payroll");
    const rent        = sumAccounts(accounts, "rent");
    const totalOpex   = findAccount(accounts, "total operating")?.val || null;

    // Ratios as % of net revenue
    const advPct      = pctOf(advertising, netRevenue);
    const freightPct  = pctOf(freight, netRevenue);

    console.log("--- Extracted P&L ---");
    console.log("Net Revenue:", netRevenue.toFixed(2));
    console.log("Discounts:", discounts.toFixed(2));
    console.log("Advertising:", advertising.toFixed(2), `(${fmtPct(advPct)} of rev)`);
    console.log("Freight:", freight.toFixed(2), `(${fmtPct(freightPct)} of rev)`);
    console.log("Wages + Super:", wages.toFixed(2));
    console.log("Rent:", rent.toFixed(2));
    console.log("Total Opex:", totalOpex);

    // ─── XERO BALANCE SHEET ───────────────────────────────────────────────────

    console.log("Fetching Xero Balance Sheet...");
    const bsData = await xeroFetch(
      `https://api.xero.com/api.xro/2.0/Reports/BalanceSheet?date=${toStr}`,
      xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id
    );

    const bsReport = bsData?.Reports?.[0];
    const { cashBalance, accountsReceivable, accountsPayable } = parseXeroBalanceSheet(bsReport);

    console.log("--- Balance Sheet ---");
    console.log("Cash:", cashBalance);
    console.log("AR:", accountsReceivable);
    console.log("AP:", accountsPayable);

    // ─── SHOPIFY INVENTORY ────────────────────────────────────────────────────

    let inventoryData = null;
    if (shopify_shop_domain && shopify_access_token) {
      console.log("Fetching Shopify inventory...");
      inventoryData = await fetchShopifyInventoryValue(shopify_shop_domain, shopify_access_token);
    }

    // ─── BUILD DATA BLOCK FOR CLAUDE ──────────────────────────────────────────

    const dataBlock = `
STORE: ${store_name}
PERIOD: ${monthLabel}

REVENUE:
- Net revenue: ${fmt$(netRevenue)}
- Discounts given: ${fmt$(discounts)} (${fmtPct(pctOf(discounts, netRevenue))} of revenue)

KEY EXPENSE RATIOS:
- Advertising: ${fmt$(advertising)} (${fmtPct(advPct)} of revenue)
- Freight & shipping: ${fmt$(freight)} (${fmtPct(freightPct)} of revenue)
- Wages & superannuation: ${fmt$(wages)}
- Rent: ${fmt$(rent)}
- Total operating expenses: ${totalOpex !== null ? fmt$(totalOpex) : "not available"}

NOTE: Gross profit and net profit figures are excluded this month as stock reconciliation in Xero is pending. These will be included once the bookkeeper confirms stock entries.

CASH POSITION (end of month):
- Bank balance: ${fmt$(cashBalance)}
- Accounts receivable: ${fmt$(accountsReceivable)}
- Accounts payable: ${fmt$(accountsPayable)}

INVENTORY (Shopify):
${inventoryData
  ? `- Current stock value (estimated): ${fmt$(inventoryData.totalValue)}
- Total units on hand: ${inventoryData.totalUnits}`
  : "- Not available"}
`;

    console.log("--- Data block for Claude ---");
    console.log(dataBlock);

    // ─── CLAUDE PROMPT ────────────────────────────────────────────────────────

    const systemPrompt = `You are Teloskope, a smart monthly business advisor for independent retail store owners.
Write a warm, direct, insightful monthly audio brief for a store owner.
Write in a conversational Australian tone — like a trusted business advisor, not a corporate report.
Be specific with numbers. Be honest about what looks good and what needs watching.
Write in flowing paragraphs only — absolutely no bullet points, no headers, no markdown formatting of any kind.
Do not use any symbols, asterisks, dollar signs, percent signs, or special characters of any kind.

CRITICAL — NUMBER FORMATTING FOR AUDIO:
This script will be read aloud by a text-to-speech voice. Write ALL numbers in full spoken words.
- Dollar amounts: "nine thousand two hundred dollars" not "$9,200"
- Percentages: "four point five percent" not "4.5%"
- All other numbers: write in full words

The brief should take about 90 seconds to read aloud.
Always open with "Good morning [owner first name], here is your Teloskope monthly brief for [month]." 
Cover: revenue, key expense ratios (advertising, freight, discounts), cash position, inventory, and what it all means.
Note clearly that gross profit and net profit are excluded pending stock reconciliation.
End with exactly 2 options to explore at a strategic level for the month ahead. Label them "Option 1:" and "Option 2:".
Close with: "That's your Teloskope monthly brief for [month]. I'll be back mid-month with your next update."`;

    const userPrompt = `Here is the data for ${store_name} for ${monthLabel}.

${dataBlock}

Write the Teloskope monthly audio brief. All numbers in full spoken words. No symbols. Open with "Good morning ${firstName}" and end with the monthly sign-off.`;

    console.log("Calling Claude...");
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const briefText = claudeResponse.content[0].text;
    console.log("Claude monthly brief generated, chars:", briefText.length);
    console.log("--- Monthly Brief ---");
    console.log(briefText);

    // ─── RETURN DATA (no Bubble write or SMS yet) ─────────────────────────────

    return res.status(200).json({
      success: true,
      month: monthLabel,
      data: {
        net_revenue: Math.round(netRevenue * 100) / 100,
        discounts: Math.round(discounts * 100) / 100,
        advertising: Math.round(advertising * 100) / 100,
        advertising_pct: advPct ? Math.round(advPct * 10) / 10 : null,
        freight: Math.round(freight * 100) / 100,
        freight_pct: freightPct ? Math.round(freightPct * 10) / 10 : null,
        wages: Math.round(wages * 100) / 100,
        rent: Math.round(rent * 100) / 100,
        total_opex: totalOpex ? Math.round(totalOpex * 100) / 100 : null,
        cash_balance: cashBalance ? Math.round(cashBalance * 100) / 100 : null,
        accounts_receivable: accountsReceivable ? Math.round(accountsReceivable * 100) / 100 : null,
        accounts_payable: accountsPayable ? Math.round(accountsPayable * 100) / 100 : null,
        inventory_value: inventoryData ? Math.round(inventoryData.totalValue * 100) / 100 : null,
        inventory_units: inventoryData?.totalUnits || null,
      },
      brief_text: briefText,
    });

  } catch (err) {
    console.error("generate-monthly-brief error:", err);
    return res.status(500).json({ error: err.message });
  }
}
