// api/generate-monthly-brief.js
// Pulls Xero P&L + Balance Sheet + Shopify inventory → Claude → ElevenLabs → Bubble → Twilio
// Manually triggered from Bubble. Cron (17th of month) to be added later.

import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = "YCxeyFA0G7yTk6Wuv2oq"; // Matt Washer
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const BUBBLE_BASE_URL = "https://teloskope.ai/version-test/api/1.1";

const pad = (n) => String(n).padStart(2, "0");
const fmt$ = (n) => n !== null && n !== undefined ? `$${Math.round(n).toLocaleString()}` : "not available";
const fmtPct = (n) => n !== null && n !== undefined ? `${n.toFixed(1)}%` : "N/A";
const pctOf = (val, base) => base > 0 ? (val / base) * 100 : null;

// ─── BUBBLE CDN URL HELPER ────────────────────────────────────────────────────

function cleanBubbleUrl(raw) {
  const stripped = raw.trim().replace(/^"|"$/g, "");
  return stripped.startsWith("//") ? `https:${stripped}` : stripped;
}

// ─── XERO TOKEN REFRESH ───────────────────────────────────────────────────────

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
  const allRows = {};

  const walkRows = (rows) => {
    for (const row of rows || []) {
      if ((row.RowType === "Row" || row.RowType === "SummaryRow") && row.Cells?.length >= 2) {
        const label = (row.Cells[0]?.Value || "").trim();
        const raw = (row.Cells[1]?.Value || "").replace(/,/g, "");
        const val = parseFloat(raw);
        if (label && !isNaN(val)) {
          allRows[label] = val;
        }
      }
      if (row.Rows) walkRows(row.Rows);
    }
  };

  walkRows(report?.Rows);
  console.log("Balance sheet rows:", JSON.stringify(allRows, null, 2));

  let cashBalance = null;
  let accountsReceivable = null;
  let accountsPayable = null;

  for (const [label, val] of Object.entries(allRows)) {
    const l = label.toLowerCase();
    if (l.includes("total bank") && cashBalance === null) cashBalance = val;
    else if (l.includes("cash") && !l.includes("total") && cashBalance === null) cashBalance = val;
    if ((l.includes("receivable") || l.includes("trade debtor")) && accountsReceivable === null) {
      accountsReceivable = Math.abs(val);
    }
    if ((l.includes("payable") || l.includes("trade creditor")) && accountsPayable === null) {
      accountsPayable = Math.abs(val);
    }
  }

  return { cashBalance, accountsReceivable, accountsPayable };
}

// ─── SHOPIFY INVENTORY (cost price via InventoryItems API) ────────────────────

async function fetchShopifyInventoryValue(shopDomain, accessToken) {
  try {
    let totalValue = 0;
    let totalUnits = 0;
    const costMap = {};

    // Step 1: Build cost price map from inventory items
    let itemsUrl = `https://${shopDomain}/admin/api/2024-01/inventory_items.json?limit=250`;
    while (itemsUrl) {
      const res = await fetch(itemsUrl, {
        headers: { "X-Shopify-Access-Token": accessToken },
      });
      if (!res.ok) throw new Error(`Shopify inventory_items error ${res.status}`);
      const data = await res.json();
      for (const item of data.inventory_items || []) {
        if (item.cost) costMap[item.id] = parseFloat(item.cost);
      }
      const link = res.headers.get("Link");
      itemsUrl = (link && link.includes('rel="next"'))
        ? (link.match(/<([^>]+)>;\s*rel="next"/) || [])[1] || null
        : null;
    }

    console.log(`Cost prices found for ${Object.keys(costMap).length} inventory items`);

    // Step 2: Get variant quantities and match to cost
    let variantsUrl = `https://${shopDomain}/admin/api/2024-01/variants.json?fields=inventory_item_id,inventory_quantity&limit=250`;
    while (variantsUrl) {
      const res = await fetch(variantsUrl, {
        headers: { "X-Shopify-Access-Token": accessToken },
      });
      if (!res.ok) throw new Error(`Shopify variants error ${res.status}`);
      const data = await res.json();
      for (const v of data.variants || []) {
        const qty = parseInt(v.inventory_quantity || 0);
        const cost = costMap[v.inventory_item_id] || 0;
        if (qty > 0) {
          totalUnits += qty;
          if (cost > 0) totalValue += qty * cost;
        }
      }
      const link = res.headers.get("Link");
      variantsUrl = (link && link.includes('rel="next"'))
        ? (link.match(/<([^>]+)>;\s*rel="next"/) || [])[1] || null
        : null;
    }

    console.log(`Shopify inventory: ${totalUnits} units, cost value $${totalValue.toFixed(2)}`);
    return { totalValue, totalUnits };
  } catch (err) {
    console.error("Shopify inventory fetch error:", err.message);
    return null;
  }
}

// ─── BUILD HTML DISPLAY BRIEF ─────────────────────────────────────────────────

function buildBriefHtml(d, monthLabel) {
  const li = (text) => `<li style="margin-bottom:6px;">${text}</li>`;
  const section = (title, items) =>
    `<p style="margin-bottom:8px;margin-top:16px;line-height:1.6;font-family:Inter,sans-serif;"><strong>${title}</strong></p>\n` +
    `<ul style="margin:0 0 8px 0;padding-left:20px;line-height:1.8;font-family:Inter,sans-serif;">\n` +
    items.map(li).join("\n") + `\n</ul>`;

  return [
    section("Revenue:", [
      `Net revenue: ${fmt$(d.netRevenue)}`,
      `Discounts given: ${fmt$(d.discounts)} (${fmtPct(pctOf(d.discounts, d.netRevenue))} of revenue)`,
    ]),
    section("Key Expense Ratios:", [
      `Advertising: ${fmt$(d.advertising)} (${fmtPct(d.advPct)} of revenue)`,
      `Freight & shipping: ${fmt$(d.freight)} (${fmtPct(d.freightPct)} of revenue)`,
      `Wages & superannuation: ${fmt$(d.wages)}`,
      `Rent: ${fmt$(d.rent)}`,
      `Total operating expenses: ${fmt$(d.totalOpex)}`,
    ]),
    section("Cash Position:", [
      `Bank balance: ${fmt$(d.cashBalance)}`,
      `Accounts receivable: ${fmt$(d.accountsReceivable)}`,
      `Accounts payable: ${d.accountsPayable !== null ? fmt$(d.accountsPayable) : "not available"}`,
    ]),
    section("Inventory (Shopify, at cost):", [
      d.inventoryValue ? `Stock value at cost: ${fmt$(d.inventoryValue)}` : "Stock value: not available",
      `Total units on hand: ${d.inventoryUnits || "not available"}`,
    ]),
    `<p style="margin-top:16px;font-size:12px;color:#888;font-family:Inter,sans-serif;">Note: Gross profit and net profit excluded pending Xero stock reconciliation.</p>`,
  ].join("\n");
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
    user_id,
    user_name,
    user_phone,
    store_name,
    target_month,
  } = req.body;

  if (!xero_access_token || !xero_tenant_id || !user_id) {
    return res.status(400).json({ error: "Missing required fields: xero_access_token, xero_tenant_id, user_id" });
  }

  try {
    // ─── DATE CALCULATIONS ────────────────────────────────────────────────────

    const now = new Date();
    let targetYear, targetMonth;

    if (target_month && /^\d{4}-\d{2}$/.test(target_month)) {
      [targetYear, targetMonth] = target_month.split("-").map(Number);
      targetMonth -= 1;
    } else {
      const prior = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      targetYear = prior.getFullYear();
      targetMonth = prior.getMonth();
    }

    const fromDate = new Date(targetYear, targetMonth, 1);
    const toDate = new Date(targetYear, targetMonth + 1, 0);
    const fromStr = `${fromDate.getFullYear()}-${pad(fromDate.getMonth() + 1)}-01`;
    const toStr = `${toDate.getFullYear()}-${pad(toDate.getMonth() + 1)}-${pad(toDate.getDate())}`;
    const monthLabel = fromDate.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
    const firstName = (user_name || "").split(" ")[0] || user_name;

    console.log(`Generating monthly brief for: ${monthLabel} (${fromStr} → ${toStr})`);

    // ─── PARALLEL FETCH ───────────────────────────────────────────────────────

    console.log("Fetching Xero P&L, Balance Sheet and Shopify inventory...");

    const [plData, bsData, inventoryData] = await Promise.all([
      xeroFetch(
        `https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${fromStr}&toDate=${toStr}&periods=1&timeframe=MONTH`,
        xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id
      ),
      xeroFetch(
        `https://api.xero.com/api.xro/2.0/Reports/BalanceSheet?date=${toStr}`,
        xero_access_token, xero_tenant_id, xero_refresh_token, xero_connection_id
      ),
      (shopify_shop_domain && shopify_access_token)
        ? fetchShopifyInventoryValue(shopify_shop_domain, shopify_access_token)
        : Promise.resolve(null),
    ]);

    // ─── PARSE P&L ────────────────────────────────────────────────────────────

    const accounts = parseXeroPL(plData?.Reports?.[0]);
    console.log("P&L accounts:", JSON.stringify(accounts, null, 2));

    const revenueRaw = Object.entries(accounts)
      .filter(([label]) => {
        const l = label.toLowerCase();
        return (l.includes("sales") || l.includes("revenue") || l.includes("income"))
          && !l.includes("discount") && !l.includes("total");
      })
      .reduce((sum, [, val]) => sum + val, 0);

    const discounts = Math.abs(sumAccounts(accounts, "discount"));
    const netRevenue = revenueRaw - discounts;
    const advertising = sumAccounts(accounts, "advertising", "marketing");
    const freight = sumAccounts(accounts, "freight", "courier", "shipping");
    const wages = sumAccounts(accounts, "wages", "salaries", "superannuation", "payroll");
    const rent = sumAccounts(accounts, "rent");
    const totalOpex = accounts["Total Operating Expenses"] || null;
    const advPct = pctOf(advertising, netRevenue);
    const freightPct = pctOf(freight, netRevenue);

    console.log("--- P&L ---");
    console.log("Net Revenue:", netRevenue.toFixed(2));
    console.log("Advertising:", advertising.toFixed(2), fmtPct(advPct));
    console.log("Freight:", freight.toFixed(2), fmtPct(freightPct));
    console.log("Wages:", wages.toFixed(2));
    console.log("Rent:", rent.toFixed(2));
    console.log("Total Opex:", totalOpex);

    // ─── PARSE BALANCE SHEET ──────────────────────────────────────────────────

    const { cashBalance, accountsReceivable, accountsPayable } = parseXeroBalanceSheet(bsData?.Reports?.[0]);

    console.log("--- Balance Sheet ---");
    console.log("Cash:", cashBalance);
    console.log("AR:", accountsReceivable);
    console.log("AP:", accountsPayable);
    console.log("--- Inventory ---");
    console.log(inventoryData);

    // ─── CLAUDE ───────────────────────────────────────────────────────────────

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

NOTE: Gross profit and net profit are excluded this month as stock reconciliation in Xero is pending.

CASH POSITION (end of month):
- Bank balance: ${fmt$(cashBalance)}
- Accounts receivable: ${fmt$(accountsReceivable)}
- Accounts payable: ${accountsPayable !== null ? fmt$(accountsPayable) : "not available"}

INVENTORY (Shopify, at cost):
${inventoryData
    ? `- Stock value at cost: ${fmt$(inventoryData.totalValue)}\n- Total units on hand: ${inventoryData.totalUnits}`
    : "- Not available"}
`;

    console.log("Calling Claude...");
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system: `You are Teloskope, a smart monthly business advisor for independent retail store owners.
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
Always open with "Good morning ${firstName}, here is your Teloskope monthly brief for ${monthLabel}."
Cover: revenue, key expense ratios (advertising, freight, discounts as % of revenue), cash position, inventory, and what it all means.
Note clearly that gross profit and net profit are excluded pending stock reconciliation.
End with exactly 2 options to explore at a strategic level for the month ahead. Label them "Option 1:" and "Option 2:" each on a new line.
Close with: "That's your Teloskope monthly brief for ${monthLabel}. I'll be back mid-month with your next update."`,
      messages: [{ role: "user", content: `Here is the data for ${store_name} for ${monthLabel}.\n\n${dataBlock}\n\nWrite the Teloskope monthly audio brief. All numbers in full spoken words. No symbols.` }],
    });

    const rawBriefText = claudeResponse.content[0].text;
    console.log("Claude brief generated, chars:", rawBriefText.length);

    // ─── BUILD HTML DISPLAY BRIEF ─────────────────────────────────────────────

    const briefHtml = buildBriefHtml({
      netRevenue, discounts, advertising, advPct, freight, freightPct,
      wages, rent, totalOpex, cashBalance, accountsReceivable, accountsPayable,
      inventoryValue: inventoryData?.totalValue || null,
      inventoryUnits: inventoryData?.totalUnits || null,
    }, monthLabel);

    // ─── ELEVENLABS ───────────────────────────────────────────────────────────

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
    console.log("Audio generated, bytes:", audioBlob.length);

    // ─── UPLOAD AUDIO TO BUBBLE CDN ───────────────────────────────────────────

    console.log("Uploading audio to Bubble CDN...");
    const runTs = Date.now();
    const fileName = `teloskope-monthly-${user_id}-${fromStr}-${runTs}.mp3`;
    let audioUrl = null;

    try {
      const form = new FormData();
      form.append("filename", fileName);
      form.append("contents", new Blob([audioBlob], { type: "audio/mpeg" }), fileName);
      form.append("private", "false");

      const uploadRes = await fetch("https://teloskope.ai/version-test/fileupload", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.BUBBLE_API_KEY}` },
        body: form,
      });

      if (uploadRes.ok) {
        audioUrl = cleanBubbleUrl(await uploadRes.text());
        console.log("Audio uploaded:", audioUrl);
      } else {
        throw new Error(await uploadRes.text());
      }
    } catch (uploadErr) {
      console.warn("Bubble upload failed, falling back to ElevenLabs URL:", uploadErr.message);
      const historyItemId = elResponse.headers.get("history-item-id");
      audioUrl = historyItemId ? `https://api.elevenlabs.io/v1/history/${historyItemId}/audio` : null;
    }

    // ─── WRITE TO BUBBLE ──────────────────────────────────────────────────────

    console.log("Writing to Bubble...");

    const bubblePayload = {
      user: user_id,
      month_label: monthLabel,
      month_end_date: toDate.toISOString(),
      brief_text: briefHtml,
      audio_url: audioUrl,
      xero_revenue: Math.round(netRevenue * 100) / 100,
      xero_discounts: Math.round(discounts * 100) / 100,
      xero_advertising: Math.round(advertising * 100) / 100,
      xero_advertising_pct: advPct ? Math.round(advPct * 10) / 10 : null,
      xero_freight: Math.round(freight * 100) / 100,
      xero_freight_pct: freightPct ? Math.round(freightPct * 10) / 10 : null,
      xero_wages: Math.round(wages * 100) / 100,
      xero_rent: Math.round(rent * 100) / 100,
      xero_total_opex: totalOpex ? Math.round(totalOpex * 100) / 100 : null,
      xero_cash_balance: cashBalance ? Math.round(cashBalance * 100) / 100 : null,
      xero_accounts_receivable: accountsReceivable ? Math.round(accountsReceivable * 100) / 100 : null,
      xero_accounts_payable: accountsPayable ? Math.round(accountsPayable * 100) / 100 : null,
      shopify_inventory_value: inventoryData ? Math.round(inventoryData.totalValue * 100) / 100 : null,
      shopify_inventory_units: inventoryData?.totalUnits || null,
    };

    const createRes = await fetch(`${BUBBLE_BASE_URL}/obj/monthlybrief`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`,
      },
      body: JSON.stringify(bubblePayload),
    });

    const createRaw = await createRes.text();
    console.log("Bubble create status:", createRes.status);
    console.log("Bubble create response:", createRaw);

    let briefId;
    try {
      briefId = JSON.parse(createRaw)?.id;
    } catch (e) {
      console.error("Failed to parse Bubble response:", e.message);
    }

    console.log("Monthly brief ID:", briefId);

    // ─── LINK TO USER RECORD ──────────────────────────────────────────────────

    if (briefId) {
      const linkRes = await fetch(`${BUBBLE_BASE_URL}/obj/user/${user_id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`,
        },
        body: JSON.stringify({ latest_monthly_brief: briefId }),
      });
      console.log("User link status:", linkRes.status);
    }

    // ─── TWILIO SMS ───────────────────────────────────────────────────────────

    if (user_phone && briefId) {
      console.log("Sending SMS...");
      const briefUrl = `https://teloskope.ai/version-test/monthlybrief/${briefId}`;
      const smsBody = `Good morning ${firstName}! Your Teloskope Monthly Brief for ${monthLabel} is ready. Listen here: ${briefUrl}`;

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

      if (!twilioRes.ok) {
        console.error("Twilio error:", twilioRes.status, await twilioRes.text());
      } else {
        console.log("SMS sent to", user_phone);
      }
    }

    // ─── RETURN ───────────────────────────────────────────────────────────────

    return res.status(200).json({
      success: true,
      brief_id: briefId,
      month: monthLabel,
      brief_url: briefId ? `https://teloskope.ai/version-test/monthlybrief/${briefId}` : null,
      audio_url: audioUrl,
      data: {
        net_revenue: Math.round(netRevenue * 100) / 100,
        advertising_pct: advPct ? Math.round(advPct * 10) / 10 : null,
        freight_pct: freightPct ? Math.round(freightPct * 10) / 10 : null,
        cash_balance: cashBalance,
        accounts_receivable: accountsReceivable,
        accounts_payable: accountsPayable,
        inventory_value: inventoryData?.totalValue || null,
        inventory_units: inventoryData?.totalUnits || null,
      },
    });

  } catch (err) {
    console.error("generate-monthly-brief error:", err);
    return res.status(500).json({ error: err.message });
  }
}
