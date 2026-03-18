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

// ─── AEST/AEDT DATE HELPERS ───────────────────────────────────────────────────
// Vercel runs UTC. All date logic anchored to Australia/Sydney so Mon–Sun week
// boundaries match exactly what the store owner sees in Shopify.

function getAestDateParts(utcDate) {
  const fmt = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const parts = fmt.formatToParts(utcDate);
  const get = (type) => parts.find((p) => p.type === type).value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(get("year")),
    month: parseInt(get("month")) - 1,
    day: parseInt(get("day")),
    dayOfWeek: weekdayMap[get("weekday")],
  };
}

// Returns the UTC ms offset for Australia/Sydney on a given UTC date
// e.g. AEDT = +11h = 39600000ms, AEST = +10h = 36000000ms
function getSydneyOffsetMs(utcDate) {
  // Format the same instant in both UTC and Sydney, compare the hour difference
  const utcHour = utcDate.getUTCHours();
  const sydFmt = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "2-digit", hour12: false,
  });
  const sydHour = parseInt(sydFmt.formatToParts(utcDate).find(p => p.type === "hour").value);
  // Sydney is always ahead of UTC (UTC+10 or UTC+11)
  let diff = sydHour - utcHour;
  if (diff < 0) diff += 24;
  return diff * 3600 * 1000;
}

// Convert an AEST date {year, month (0-indexed), day} to UTC timestamp at Sydney midnight
function aestMidnightToUtc(year, month, day) {
  // Start with a UTC date at noon on that day (safely within the day regardless of DST)
  const noonUtc = new Date(Date.UTC(year, month, day, 12, 0, 0));
  const offsetMs = getSydneyOffsetMs(noonUtc);
  // Sydney midnight = UTC noon on same day, minus 12 hours, minus offset
  // More directly: Sydney midnight UTC = midnight_local - offset
  // = Date.UTC(y,m,d,0,0,0) - offset... but we must use the offset AT that moment.
  // Since DST transitions happen at 2am or 3am, noon is always stable.
  // Sydney midnight = noon UTC - 12h - offset + offset_correction
  // Simplest reliable method: construct as if UTC, then shift by offset
  const asIfUtc = new Date(Date.UTC(year, month, day, 0, 0, 0));
  // Get the Sydney offset at that approximate time
  const offsetAtMidnight = getSydneyOffsetMs(new Date(asIfUtc.getTime() - offsetMs + 12 * 3600000));
  return new Date(asIfUtc.getTime() - offsetAtMidnight);
}

// End of day (23:59:59.999) Sydney time as UTC
function aestEndOfDayToUtc(year, month, day) {
  return new Date(aestMidnightToUtc(year, month, day).getTime() + 24 * 3600 * 1000 - 1);
}

function aestShiftDays(aestDate, days) {
  const d = new Date(Date.UTC(aestDate.year, aestDate.month, aestDate.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

function aestShiftYear(aestDate, years) {
  return { ...aestDate, year: aestDate.year + years };
}

function fmtAestDate(aestDate, opts = { day: "numeric", month: "long", year: "numeric" }) {
  return new Date(Date.UTC(aestDate.year, aestDate.month, aestDate.day))
    .toLocaleDateString("en-AU", opts);
}

const pad = (n) => String(n).padStart(2, "0");

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
      const errText = await response.text();
      console.error("Xero BalanceSheet error:", response.status, errText);
      return null;
    }

    const data = await response.json();

    // Navigate the report rows to find "Cash And Cash Equivalents"
    // Structure: Reports[0].Rows → find RowType=Section with Title containing "Assets"
    // then drill into rows to find cash line
    const report = data?.Reports?.[0];
    if (!report) return null;

    let cashValue = null;

    for (const section of report.Rows || []) {
      if (section.RowType !== "Section") continue;
      for (const row of section.Rows || []) {
        // Row title or cells may contain "Cash"
        if (row.RowType === "Row") {
          const cells = row.Cells || [];
          const label = cells[0]?.Value || "";
          if (label.toLowerCase().includes("cash")) {
            // cells[1] is current period value
            const val = parseFloat(cells[1]?.Value?.replace(/,/g, "") || "");
            if (!isNaN(val)) {
              cashValue = val;
              console.log("Xero cash line found:", label, "=", val);
              break;
            }
          }
        }
        // Also check nested rows (some BS reports nest under a subsection)
        for (const subRow of row.Rows || []) {
          const cells = subRow.Cells || [];
          const label = cells[0]?.Value || "";
          if (label.toLowerCase().includes("cash")) {
            const val = parseFloat(cells[1]?.Value?.replace(/,/g, "") || "");
            if (!isNaN(val)) {
              cashValue = val;
              console.log("Xero cash line found (nested):", label, "=", val);
              break;
            }
          }
        }
        if (cashValue !== null) break;
      }
      if (cashValue !== null) break;
    }

    if (cashValue === null) {
      console.warn("Xero: could not locate cash line in BalanceSheet — dumping row titles for debug:");
      for (const section of report.Rows || []) {
        for (const row of section.Rows || []) {
          console.warn(" >", (row.Cells?.[0]?.Value || row.Title || "(no label)"));
          for (const sub of row.Rows || []) {
            console.warn("   >>", (sub.Cells?.[0]?.Value || "(no label)"));
          }
        }
      }
    }

    return cashValue;
  } catch (err) {
    console.error("Xero fetch failed:", err.message);
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

  // Test mode
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

    // ─── DATE CALCULATIONS (Mon–Sun, AEST/AEDT anchored) ─────────────────────

    const nowUtc = new Date();
    const todayAest = getAestDateParts(nowUtc);

    console.log("UTC now:", nowUtc.toISOString());
    console.log("AEST today:", todayAest);

    // weekEnd = last Sunday in AEST (yesterday when running Monday)
    const daysBackToSunday = todayAest.dayOfWeek === 0 ? 7 : todayAest.dayOfWeek;
    const weekEndAest   = aestShiftDays(todayAest, -daysBackToSunday);
    const weekStartAest = aestShiftDays(weekEndAest, -6);

    // PCW = same Mon–Sun, one year prior
    const pcwEndAest   = aestShiftYear(weekEndAest, -1);
    const pcwStartAest = aestShiftYear(weekStartAest, -1);

    // MTD
    const mtdStartAest   = { year: todayAest.year, month: todayAest.month, day: 1 };
    const mtdEndAest     = todayAest;
    const lyMtdStartAest = aestShiftYear(mtdStartAest, -1);
    const lyMtdEndAest   = aestShiftYear(mtdEndAest, -1);

    // YTD
    const ytdStartAest   = { year: todayAest.year, month: 0, day: 1 };
    const ytdEndAest     = todayAest;
    const lyYtdStartAest = aestShiftYear(ytdStartAest, -1);
    const lyYtdEndAest   = aestShiftYear(ytdEndAest, -1);

    // Convert to UTC for Shopify API
    const weekStart  = aestMidnightToUtc(weekStartAest.year, weekStartAest.month, weekStartAest.day);
    const weekEnd    = aestEndOfDayToUtc(weekEndAest.year, weekEndAest.month, weekEndAest.day);
    const pcwStart   = aestMidnightToUtc(pcwStartAest.year, pcwStartAest.month, pcwStartAest.day);
    const pcwEnd     = aestEndOfDayToUtc(pcwEndAest.year, pcwEndAest.month, pcwEndAest.day);
    const mtdStart   = aestMidnightToUtc(mtdStartAest.year, mtdStartAest.month, mtdStartAest.day);
    const mtdEnd     = aestEndOfDayToUtc(mtdEndAest.year, mtdEndAest.month, mtdEndAest.day);
    const lyMtdStart = aestMidnightToUtc(lyMtdStartAest.year, lyMtdStartAest.month, lyMtdStartAest.day);
    const lyMtdEnd   = aestEndOfDayToUtc(lyMtdEndAest.year, lyMtdEndAest.month, lyMtdEndAest.day);
    const ytdStart   = aestMidnightToUtc(ytdStartAest.year, ytdStartAest.month, ytdStartAest.day);
    const ytdEnd     = aestEndOfDayToUtc(ytdEndAest.year, ytdEndAest.month, ytdEndAest.day);
    const lyYtdStart = aestMidnightToUtc(lyYtdStartAest.year, lyYtdStartAest.month, lyYtdStartAest.day);
    const lyYtdEnd   = aestEndOfDayToUtc(lyYtdEndAest.year, lyYtdEndAest.month, lyYtdEndAest.day);

    console.log("Week:   ", weekStart.toISOString(), "→", weekEnd.toISOString());
    console.log("PCW:    ", pcwStart.toISOString(), "→", pcwEnd.toISOString());
    console.log("MTD:    ", mtdStart.toISOString(), "→", mtdEnd.toISOString());
    console.log("LY MTD: ", lyMtdStart.toISOString(), "→", lyMtdEnd.toISOString());
    console.log("YTD:    ", ytdStart.toISOString(), "→", ytdEnd.toISOString());
    console.log("LY YTD: ", lyYtdStart.toISOString(), "→", lyYtdEnd.toISOString());

    const fmt = (d) => d.toISOString();

    // ─── SHOPIFY HELPERS ──────────────────────────────────────────────────────

    const fetchAllOrders = async (start, end, fields = "total_price,created_at") => {
      let orders = [];
      let url = `https://${shopify_shop_domain}/admin/api/2024-01/orders.json?status=any&financial_status=any&created_at_min=${fmt(start)}&created_at_max=${fmt(end)}&fields=${fields}&limit=250`;
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

    const sumRevenue     = (orders) => orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
    const calcAov        = (orders) => orders.length > 0 ? sumRevenue(orders) / orders.length : 0;
    const countNewRet    = (orders) => {
      let newC = 0, ret = 0;
      for (const o of orders) (o.customer?.orders_count ?? 1) <= 1 ? newC++ : ret++;
      return { newC, ret };
    };

    // ─── PARALLEL FETCH: Shopify + Xero ──────────────────────────────────────

    console.log("Fetching Shopify data + Xero cash balance...");

    const [
      weekOrders, pcwOrders,
      mtdOrders, lyMtdOrders,
      ytdOrders, lyYtdOrders,
      weekOrdersForProducts,
      xeroCashBalance,
    ] = await Promise.all([
      fetchAllOrders(weekStart, weekEnd),
      fetchAllOrders(pcwStart, pcwEnd),
      fetchAllOrders(mtdStart, mtdEnd, "total_price,created_at,customer"),
      fetchAllOrders(lyMtdStart, lyMtdEnd, "total_price,created_at,customer"),
      fetchAllOrders(ytdStart, ytdEnd),
      fetchAllOrders(lyYtdStart, lyYtdEnd),
      fetchAllOrders(weekStart, weekEnd, "line_items"),
      (xero_access_token && xero_tenant_id)
        ? fetchXeroCashBalance(xero_access_token, xero_tenant_id)
        : Promise.resolve(null),
    ]);

    console.log("Week orders:", weekOrders.length, "| Revenue:", sumRevenue(weekOrders).toFixed(2));
    console.log("PCW  orders:", pcwOrders.length,  "| Revenue:", sumRevenue(pcwOrders).toFixed(2));
    console.log("MTD  orders:", mtdOrders.length,  "| Revenue:", sumRevenue(mtdOrders).toFixed(2));
    console.log("LY MTD orders:", lyMtdOrders.length, "| Revenue:", sumRevenue(lyMtdOrders).toFixed(2));
    console.log("Xero cash balance:", xeroCashBalance);

    // ─── METRIC CALCULATIONS ──────────────────────────────────────────────────

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
    const { newC: newMtd, ret: retMtd } = countNewRet(mtdOrders);
    const { newC: newLyMtd, ret: retLyMtd } = countNewRet(lyMtdOrders);

    // Top 5 products
    const productMap = {};
    for (const order of weekOrdersForProducts) {
      for (const item of order.line_items || []) {
        const key = item.product_id;
        if (!productMap[key]) productMap[key] = { title: item.title, quantity: 0 };
        productMap[key].quantity += item.quantity;
      }
    }
    const topProducts = Object.values(productMap).sort((a, b) => b.quantity - a.quantity).slice(0, 5);

    const pct  = (a, b) => b > 0 ? `${(((a - b) / b) * 100).toFixed(1)}%` : "N/A";
    const fmt$ = (n) => `$${Math.round(n).toLocaleString()}`;

    const hasLyWeek = pcwRev > 0 || pcwTx > 0;
    const hasLyMtd  = lyMtdRev > 0 || lyMtdTx > 0;
    const hasLyYtd  = lyYtdRev > 0;

    const weekLabel  = `week ending ${fmtAestDate(weekEndAest)}`;
    const monthLabel = fmtAestDate({ year: todayAest.year, month: todayAest.month, day: 1 }, { month: "long", year: "numeric" });

    const cashNote = xeroCashBalance !== null && xeroCashBalance !== undefined
      ? fmt$(xeroCashBalance)
      : "not available";

    // ─── BUILD BULLET SUMMARY (for Bubble page display) ───────────────────────
    // Sections: Revenue → Cash Position → Transactions & AOV →
    //           New vs Returning → Top 5 Products → Options to Explore

    const lyWeekBullet = hasLyWeek
      ? `Same week last year: ${fmt$(pcwRev)} revenue, ${pcwTx} orders (${pct(weekRev, pcwRev)} change)`
      : "Same week last year: not available — first year online";
    const lyMtdBullet = hasLyMtd
      ? `Last year MTD: ${fmt$(lyMtdRev)} (${pct(mtdRev, lyMtdRev)} change)`
      : "Last year MTD: not available";
    const lyYtdBullet = hasLyYtd
      ? `Last year YTD: ${fmt$(lyYtdRev)} (${pct(ytdRev, lyYtdRev)} change)`
      : "Last year YTD: not available — first year online";

    // This will be replaced with Claude's Options section after generation
    const SUMMARY_PLACEHOLDER = "%%OPTIONS%%";

    const bulletSummaryTop = `<p style="margin-bottom:12px;line-height:1.6;"><strong>Revenue:</strong></p>
<ul style="margin:0 0 16px 0;padding-left:20px;line-height:1.8;">
  <li>This week: ${fmt$(weekRev)}${weekTx > 0 ? ` (${weekTx} orders, AOV ${fmt$(weekAov)})` : " (no orders)"}</li>
  <li>${lyWeekBullet}</li>
  <li>${monthLabel} to date: ${fmt$(mtdRev)} — ${mtdTx} orders</li>
  <li>${lyMtdBullet}</li>
  <li>Year to date: ${fmt$(ytdRev)}</li>
  <li>${lyYtdBullet}</li>
</ul>

<p style="margin-bottom:12px;line-height:1.6;"><strong>Cash Position:</strong></p>
<ul style="margin:0 0 16px 0;padding-left:20px;line-height:1.8;">
  <li>Bank balance: ${cashNote}${xeroCashBalance !== null && xeroCashBalance !== undefined && xeroCashBalance <= 0 ? " — needs attention" : ""}</li>
</ul>

<p style="margin-bottom:12px;line-height:1.6;"><strong>Transactions and Average Order Value:</strong></p>
<ul style="margin:0 0 16px 0;padding-left:20px;line-height:1.8;">
  <li>${weekTx} transactions this week${hasLyWeek ? `, vs ${pcwTx} last year` : ""}</li>
  <li>Average order value: ${fmt$(weekAov)}${hasLyWeek ? ` vs ${fmt$(pcwAov)} last year` : ""}</li>
  <li>${monthLabel} to date: ${mtdTx} transactions total</li>
</ul>

<p style="margin-bottom:12px;line-height:1.6;"><strong>New vs Returning Customers:</strong></p>
<ul style="margin:0 0 16px 0;padding-left:20px;line-height:1.8;">
  <li>${newMtd} new customers this month${hasLyMtd ? ` vs ${newLyMtd} last year` : ""}</li>
  <li>${retMtd} returning customers${hasLyMtd ? ` vs ${retLyMtd} last year` : ""}</li>
</ul>

<p style="margin-bottom:12px;line-height:1.6;"><strong>Top 5 Products This Week:</strong></p>
<ul style="margin:0 0 16px 0;padding-left:20px;line-height:1.8;">
${topProducts.length > 0
  ? topProducts.map(p => `  <li>${p.title} — ${p.quantity} units</li>`).join("\n")
  : "  <li>No orders recorded this week</li>"}
</ul>

${SUMMARY_PLACEHOLDER}`;

    // ─── CLAUDE DATA BLOCK (for audio prose generation) ───────────────────────

    const dataBlock = `
STORE: ${store_name}
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

TOP 5 PRODUCTS THIS WEEK:
${topProducts.length > 0
  ? topProducts.map((p, i) => `${i + 1}. ${p.title} — ${p.quantity} units`).join("\n")
  : "No product orders this week"}
`;

    const systemPrompt = `You are Teloskope, a smart weekly business advisor for independent retail store owners.
Write a warm, direct, insightful weekly audio brief for a store owner to listen to on Monday morning.
Write in a conversational Australian tone — like a trusted business advisor, not a corporate report.
Be specific with numbers. Be honest about what looks good and what needs watching.
Write in flowing paragraphs only — no bullet points, no headers.
The brief should take about 90 seconds to read aloud.
Always lead with the headline revenue number (with $ sign) in the very first sentence.
Cover: revenue and year-on-year comparison, cash position, transactions and AOV, customer mix, top products, and what it all means.
When last year data is not available, acknowledge it briefly and move on.
End with exactly 3 "Options to Explore" labelled as "Option 1:", "Option 2:", "Option 3:" on new lines.`;

    const userPrompt = `Here is the data for ${store_name} for the ${weekLabel}.\n\n${dataBlock}\n\nWrite the Teloskope weekly audio brief.`;

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

    // ─── BUILD OPTIONS HTML FROM CLAUDE OUTPUT ────────────────────────────────
    // Extract the Options section from Claude's prose and convert to HTML bullets
    // for the page summary. The prose version goes to ElevenLabs as-is.

    const optionsMatch = rawBriefText.match(/(Option 1:[\s\S]*)/i);
    let optionsHtml = "";
    if (optionsMatch) {
      const optionsText = optionsMatch[1].trim();
      // Split into individual options and format as styled paragraphs
      const optionItems = optionsText
        .split(/(?=Option [123]:)/i)
        .map(s => s.trim())
        .filter(Boolean);

      optionsHtml = `<p style="margin-bottom:12px;line-height:1.6;"><strong>Options to Explore:</strong></p>\n` +
        optionItems.map(item =>
          `<p style="margin-bottom:12px;line-height:1.6;">${item.replace(/Option ([123]):/i, '<strong style="color:#0205D3;">Option $1:</strong>')}</p>`
        ).join("\n");
    }

    // Assemble final brief_text: bullet summary + Claude's options
    const briefText = bulletSummaryTop.replace(SUMMARY_PLACEHOLDER, optionsHtml);

    // ─── ELEVENLABS TTS (plain prose, no HTML) ────────────────────────────────

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
    const fileName = `teloskope-brief-${user_id}-${weekEndAest.year}-${pad(weekEndAest.month + 1)}-${pad(weekEndAest.day)}.mp3`;
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
      week_end_date: weekEnd.toISOString(),
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

    const bubbleRes = await fetch(`${BUBBLE_BASE_URL}/wf/ingest_weekly_brief`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bubblePayload),
    });

    if (!bubbleRes.ok) throw new Error(`Bubble error ${bubbleRes.status}: ${await bubbleRes.text()}`);

    const bubbleData = await bubbleRes.json();

    // ─── TWILIO SMS ───────────────────────────────────────────────────────────

    console.log("Sending SMS...");
    const smsBody = `Good morning ${user_name}! Your Teloskope Weekly Brief for the ${weekLabel} is ready. Listen here: ${brief_page_base_url}`;

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
      week_end: `${weekEndAest.year}-${pad(weekEndAest.month + 1)}-${pad(weekEndAest.day)}`,
      sms_sent_to: user_phone,
    });

  } catch (err) {
    console.error("generate-weekly-brief error:", err);
    return res.status(500).json({ error: err.message });
  }
}
