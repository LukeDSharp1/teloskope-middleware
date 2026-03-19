// api/generate-weekly-brief.js
// Pulls Shopify + Xero → Claude → ElevenLabs → posts finished brief to Bubble → Twilio SMS
// V1 beta: Shopify (online) + Xero (cash position). Lightspeed (in-store) post app approval.

import Anthropic from "@anthropic-ai/sdk";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = "YCxeyFA0G7yTk6Wuv2oq"; // Matt Washer
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

// ─── CLEAN TEXT FOR ELEVENLABS ────────────────────────────────────────────────
// ElevenLabs reads $9227 naturally. Remove commas from currency, strip markdown,
// replace punctuation that causes gurgling.
function cleanForAudio(text) {
  return text
    .replace(/\$([0-9,]+)/g, (_, num) => `$${num.replace(/,/g, "")}`) // $9,227 → $9227
    .replace(/\*\*(.*?)\*\*/g, "$1")   // remove bold **
    .replace(/\*(.*?)\*/g, "$1")        // remove italic *
    .replace(/#{1,6}\s/g, "")           // remove markdown headers
    .replace(/\|/g, " and ")            // pipe → "and"
    .replace(/–|—/g, ", ")             // em/en dash → comma
    .replace(/%/g, " percent")          // % → "percent"
    .replace(/\n{2,}/g, " ")            // multiple newlines → space
    .replace(/\n/g, " ")                // single newlines → space
    .trim();
}

// ─── XERO HELPER ─────────────────────────────────────────────────────────────

async function fetchXeroCashBalance(xeroAccessToken, xeroTenantId) {
  try {
    const response = await fetch(
      "https://api.xero.com/api.xro/2.0/Reports/BalanceSheet",
      {
        headers: {
          Authorization: `Bearer ${xeroAccessToken}`,
          "Xero-tenant-id": xeroTenantId,
          Accept: "application/json",
        },
      }
    );

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

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    shopify_shop_domain,
    shopify_access_token,
    xero_access_token,
    xero_tenant_id,
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
      week_end: "2026-03-15",
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

    const sumRevenue  = (orders) => orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
    const calcAov     = (orders) => orders.length > 0 ? sumRevenue(orders) / orders.length : 0;
    const countNewRet = (orders) => {
      let newC = 0, ret = 0;
      for (const o of orders) (o.customer?.orders_count ?? 1) <= 1 ? newC++ : ret++;
      return { newC, ret };
    };

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

    const [
      weekOrders, pcwOrders,
      mtdOrders, lyMtdOrders,
      ytdOrders, lyYtdOrders,
      weekOrdersDetail,
      xeroCashBalance,
    ] = await Promise.all([
      fetchAllOrders(wS, wE),
      fetchAllOrders(pS, pE),
      fetchAllOrders(mS, mE, "total_price,created_at,customer"),
      fetchAllOrders(lmS, lmE, "total_price,created_at,customer"),
      fetchAllOrders(yS, yE),
      fetchAllOrders(lyS, lyE),
      fetchAllOrders(wS, wE, "line_items,shipping_address"),
      (xero_access_token && xero_tenant_id)
        ? fetchXeroCashBalance(xero_access_token, xero_tenant_id)
        : Promise.resolve(null),
    ]);

    console.log("Week orders:", weekOrders.length, "| Revenue:", sumRevenue(weekOrders).toFixed(2));
    console.log("PCW  orders:", pcwOrders.length,  "| Revenue:", sumRevenue(pcwOrders).toFixed(2));
    console.log("MTD  orders:", mtdOrders.length,  "| Revenue:", sumRevenue(mtdOrders).toFixed(2));
    console.log("LY MTD:     ", lyMtdOrders.length, "| Revenue:", sumRevenue(lyMtdOrders).toFixed(2));
    console.log("YTD  orders:", ytdOrders.length,  "| Revenue:", sumRevenue(ytdOrders).toFixed(2));
    console.log("LY YTD:     ", lyYtdOrders.length, "| Revenue:", sumRevenue(lyYtdOrders).toFixed(2));
    console.log("Xero cash balance:", xeroCashBalance);

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
    const { newC: newMtd, ret: retMtd }     = countNewRet(mtdOrders);
    const { newC: newLyMtd, ret: retLyMtd } = countNewRet(lyMtdOrders);

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

    const hasLyWeek = pcwRev > 0 || pcwTx > 0;
    const hasLyMtd  = lyMtdRev > 0 || lyMtdTx > 0;
    const hasLyYtd  = lyYtdRev > 0;

    const weekLabel  = `week ending ${fmtDate(weekEnd)}`;
    const monthLabel = fmtDate({ year: today.year, month: today.month, day: 1 }, { month: "long", year: "numeric" });
    const cashNote   = xeroCashBalance !== null && xeroCashBalance !== undefined
      ? fmt$(xeroCashBalance)
      : "not available";

    // First name only for the greeting
    const firstName = (user_name || "").split(" ")[0] || user_name;

    // ─── CLAUDE PROMPT ────────────────────────────────────────────────────────

    const dataBlock = `
STORE: ${store_name}
OWNER FIRST NAME: ${firstName}
PERIOD: ${weekLabel}
CHANNEL: Online only (Shopify)

WEEKLY PERFORMANCE:
- Revenue: ${fmt$(weekRev)} | ${weekTx} orders | AOV ${fmt$(weekAov)}
- Same week last year: ${hasLyWeek ? `${fmt$(pcwRev)}, ${pcwTx} orders, AOV ${fmt$(pcwAov)} (${pct(weekRev, pcwRev)} change)` : "not available — no online orders this week last year"}

CASH POSITION (Xero):
- Bank balance: ${cashNote}

MONTH TO DATE (${monthLabel}):
- Revenue: ${fmt$(mtdRev)} | ${mtdTx} orders
- Last year MTD: ${hasLyMtd ? `${fmt$(lyMtdRev)}, ${lyMtdTx} orders (${pct(mtdRev, lyMtdRev)} change)` : "not available"}

YEAR TO DATE:
- Revenue: ${fmt$(ytdRev)}
- Last year YTD: ${hasLyYtd ? `${fmt$(lyYtdRev)} (${pct(ytdRev, lyYtdRev)} change)` : "not available — first year online"}

CUSTOMER MIX (MTD):
- New: ${newMtd}${hasLyMtd ? ` (LY: ${newLyMtd})` : ""}
- Returning: ${retMtd}${hasLyMtd ? ` (LY: ${retLyMtd})` : ""}

CUSTOMER LOCATIONS (this week):
- Australia: ${locations.ausPct}% | Overseas: ${locations.overseaPct}%
${locations.topStates.map(s => `- ${s.state}: ${s.count} orders (${s.pct}%)`).join("\n")}

TOP 5 PRODUCTS THIS WEEK:
${topProducts.length > 0
  ? topProducts.map((p, i) => `${i + 1}. ${p.title} — ${p.quantity} units`).join("\n")
  : "No orders this week"}
`;

    const systemPrompt = `You are Teloskope, a smart weekly business advisor for independent retail store owners.
Write a warm, direct, insightful weekly audio brief for a store owner to listen to on Monday morning.
Write in a conversational Australian tone — like a trusted business advisor, not a corporate report.
Be specific with numbers. Be honest about what looks good and what needs watching.
Write in flowing paragraphs only — absolutely no bullet points, no headers, no markdown formatting of any kind.
Do not use asterisks, pound signs, or any special formatting characters.
The brief should take about 90 seconds to read aloud.
IMPORTANT: Always open with "Good morning [owner first name]." as the very first words — use the OWNER FIRST NAME from the data. Then immediately follow with the headline revenue figure for the week in the next sentence.
Cover: revenue and year-on-year comparison, cash position, transactions and AOV, customer mix, where customers are from, top products, and what it all means together.
When last year data is not available, acknowledge it briefly and move on.
End with exactly 3 options to explore. Label them clearly as "Option 1:", "Option 2:", "Option 3:" each on a new line, followed by the suggestion as plain prose.`;

    const userPrompt = `Here is the data for ${store_name} for the ${weekLabel}.\n\n${dataBlock}\n\nWrite the Teloskope weekly audio brief. Remember: plain flowing prose only, no markdown, no asterisks, no formatting characters. Start with "Good morning ${firstName}."`;

    console.log("Calling Claude...");
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const rawBriefText = claudeResponse.content[0].text;
    console.log("Claude brief generated, chars:", rawBriefText.length);
    console.log("Claude brief starts with:", rawBriefText.substring(0, 50));

    // Clean for ElevenLabs — no commas in numbers, no markdown, no gurgle chars
    const cleanAudioText = cleanForAudio(rawBriefText);
    console.log("Clean audio text starts with:", cleanAudioText.substring(0, 50));

    // ─── EXTRACT OPTIONS FROM CLAUDE OUTPUT ───────────────────────────────────

    const optionsMatch = rawBriefText.match(/(Option 1:[\s\S]*)/i);
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
            item
              .replace(/\*\*(.*?)\*\*/g, "$1")
              .replace(/Option ([123]):/i, '<strong style="color:#0205D3;">Option $1:</strong>')
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
      `This week: ${fmt$(weekRev)} — ${weekTx} orders, AOV ${fmt$(weekAov)}`,
      hasLyWeek
        ? `Same week last year: ${fmt$(pcwRev)}, ${pcwTx} orders (${pct(weekRev, pcwRev)} change)`
        : "Same week last year: not available — first year online",
      `${monthLabel} to date: ${fmt$(mtdRev)} — ${mtdTx} orders`,
      hasLyMtd
        ? `Last year MTD: ${fmt$(lyMtdRev)} (${pct(mtdRev, lyMtdRev)} change)`
        : "Last year MTD: not available",
      `Year to date: ${fmt$(ytdRev)}`,
      hasLyYtd
        ? `Last year YTD: ${fmt$(lyYtdRev)} (${pct(ytdRev, lyYtdRev)} change)`
        : "Last year YTD: not available — first year online",
    ];

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
      section("Revenue:", revItems),
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
          text: cleanAudioText,
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
        audioUrl = (await uploadRes.text()).trim();
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
    };

    console.log("Bubble payload brief_text length:", bubblePayload.brief_text.length);

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
