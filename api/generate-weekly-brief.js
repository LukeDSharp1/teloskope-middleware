// api/generate-weekly-brief.js
// Shopify (online) + Lightspeed (in-store) + Xero (cash balance) -> Claude -> ElevenLabs -> Vercel Blob -> Bubble -> Twilio
// Cron fires Monday 11pm UTC (Tuesday 9am AEST / 10am AEDT) — reports on prior Mon-Sun week

import Anthropic from "@anthropic-ai/sdk";
import { put } from "@vercel/blob";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = "YCxeyFA0G7yTk6Wuv2oq"; // Matt Washer
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const BUBBLE_BASE_URL = "https://teloskope.bubbleapps.io/version-test/api/1.1";
const BUBBLE_API_KEY = process.env.BUBBLE_API_KEY; // Bubble Data API key for writing refreshed tokens

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    shopify_shop_domain,
    shopify_access_token,
    // Lightspeed (optional — in-store only)
    lightspeed_access_token,
    lightspeed_refresh_token,
    lightspeed_domain_prefix,   // e.g. "developerdemoe9yr66"
    lightspeed_connection_id,   // Bubble record ID for saving refreshed token
    // Xero (optional — cash balance)
    xero_access_token,
    xero_refresh_token,
    xero_tenant_id,
    xero_connection_id,         // Bubble record ID for saving refreshed token
    // User / delivery
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

  // Test mode — returns mock response for Bubble API Connector initialisation
  if (shopify_shop_domain === "test.myshopify.com") {
    return res.status(200).json({
      success: true,
      brief_id: "test_brief_id",
      brief_url: "https://teloskope.bubbleapps.io/version-test/brief/test",
      audio_url: "https://example.com/test-audio.mp3",
      week_end: "2026-03-08",
      sms_sent_to: "+61400000000",
    });
  }

  try {

    // ─── DATE CALCULATIONS (Mon–Sun, prior week) ─────────────────────────────
    // Cron fires Monday ~9am AEST. "Yesterday" = Sunday = end of prior week.

    // All dates calculated in Sydney time (GMT+10 store timezone)
    // Sydney is AEDT (UTC+11) Oct-Apr, AEST (UTC+10) Apr-Oct
    // We use Intl to get the correct offset for any given date
    const fmtIso = (d) => d.toISOString();

    // Get Sydney UTC offset in minutes for a given UTC date
    const getSydneyOffsetMs = (utcDate) => {
      const utcStr = utcDate.toLocaleString("en-US", { timeZone: "Australia/Sydney" });
      const sydneyDate = new Date(utcStr + " UTC");
      return sydneyDate - utcDate; // positive = ahead of UTC
    };

    // Convert a Sydney local date (year, month 0-indexed, day, hour, min, sec) to UTC Date
    const sydneyToUTC = (year, month, day, hour = 0, min = 0, sec = 0) => {
      // Approximate: create UTC date and adjust for Sydney offset
      const approx = new Date(Date.UTC(year, month, day, hour, min, sec));
      const offsetMs = getSydneyOffsetMs(approx);
      return new Date(approx.getTime() - offsetMs);
    };

    const now = new Date();

    // Get current date in Sydney
    const sydneyNowStr = now.toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
    const sydneyNow = new Date(sydneyNowStr);
    // Parse Sydney date parts
    const [dayPart, monthPart, yearPart] = sydneyNowStr.split(",")[0].split("/").map(Number);

    // Find last Sunday in Sydney time
    // today is Monday when cron fires
    const todaySydney = new Date(Date.UTC(yearPart, monthPart - 1, dayPart));
    const dowToday = todaySydney.getUTCDay(); // 1 = Monday
    const daysToSunday = dowToday === 0 ? 7 : dowToday;

    const weekEndDay = dayPart - daysToSunday;
    const weekEndDate = new Date(Date.UTC(yearPart, monthPart - 1, weekEndDay));
    const weekStartDate = new Date(Date.UTC(yearPart, monthPart - 1, weekEndDay - 6));

    // Convert to UTC API boundaries using Sydney timezone
    const weekEnd   = sydneyToUTC(weekEndDate.getUTCFullYear(), weekEndDate.getUTCMonth(), weekEndDate.getUTCDate(), 23, 59, 59);
    const weekStart = sydneyToUTC(weekStartDate.getUTCFullYear(), weekStartDate.getUTCMonth(), weekStartDate.getUTCDate(), 0, 0, 0);

    // PCW — same Mon-Sun calendar dates, last year
    const pcwStart = sydneyToUTC(weekStartDate.getUTCFullYear() - 1, weekStartDate.getUTCMonth(), weekStartDate.getUTCDate(), 0, 0, 0);
    const pcwEnd   = sydneyToUTC(weekEndDate.getUTCFullYear() - 1, weekEndDate.getUTCMonth(), weekEndDate.getUTCDate(), 23, 59, 59);

    // MTD — 1st of month through end of last Sunday, Sydney time
    const mtdStart = sydneyToUTC(weekEndDate.getUTCFullYear(), weekEndDate.getUTCMonth(), 1, 0, 0, 0);
    const mtdEnd   = new Date(weekEnd);

    // LY MTD — same calendar dates last year
    const lyMtdStart = sydneyToUTC(weekEndDate.getUTCFullYear() - 1, weekEndDate.getUTCMonth(), 1, 0, 0, 0);
    const lyMtdEnd   = sydneyToUTC(weekEndDate.getUTCFullYear() - 1, weekEndDate.getUTCMonth(), weekEndDate.getUTCDate(), 23, 59, 59);

    // FYTD — Australian Financial Year (1 July - 30 June)
    // If current month is before July, FY started last year; if July or after, FY started this year
    const weekEndYear = weekEndDate.getUTCFullYear();
    const weekEndMonth = weekEndDate.getUTCMonth(); // 0-indexed
    const fyStartYear = weekEndMonth >= 6 ? weekEndYear : weekEndYear - 1; // >= June (0-indexed = July)
    const ytdStart   = sydneyToUTC(fyStartYear, 6, 1, 0, 0, 0); // 1 July
    const lyYtdStart = sydneyToUTC(fyStartYear - 1, 6, 1, 0, 0, 0); // 1 July last FY
    const lyYtdEnd   = sydneyToUTC(fyStartYear - 1 + (weekEndMonth >= 6 ? 1 : 0), weekEndMonth, weekEndDate.getUTCDate(), 23, 59, 59);

    // Log for verification
    console.log("Sydney date ranges:", {
      week: weekStart.toISOString() + " to " + weekEnd.toISOString(),
      pcw:  pcwStart.toISOString()  + " to " + pcwEnd.toISOString(),
      mtd:  mtdStart.toISOString()  + " to " + mtdEnd.toISOString(),
      lyMtd: lyMtdStart.toISOString() + " to " + lyMtdEnd.toISOString(),
      ytd:  ytdStart.toISOString()  + " to " + weekEnd.toISOString(),
      lyYtd: lyYtdStart.toISOString() + " to " + lyYtdEnd.toISOString(),
    });

    const weekLabel = `week ending ${weekEnd.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}`;
    const monthLabel = weekEnd.toLocaleDateString("en-AU", { month: "long", year: "numeric" });

    // ─── SHOPIFY DATA ────────────────────────────────────────────────────────

    console.log("Fetching Shopify data...");

    const fetchAllOrders = async (start, end, fields = "total_price,created_at") => {
      let orders = [];
      let url = `https://${shopify_shop_domain}/admin/api/2024-01/orders.json?status=any&financial_status=paid,partially_refunded` +
        `&created_at_min=${encodeURIComponent(fmtIso(start))}` +
        `&created_at_max=${encodeURIComponent(fmtIso(end))}` +
        `&fields=${encodeURIComponent(fields)}&limit=250`;

      while (url) {
        const r = await fetch(url, { headers: { "X-Shopify-Access-Token": shopify_access_token } });
        if (!r.ok) throw new Error(`Shopify error ${r.status}: ${await r.text()}`);
        const data = await r.json();
        orders = orders.concat(data.orders || []);
        const link = r.headers.get("Link") || "";
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        url = next ? next[1] : null;
      }
      return orders;
    };

    const [
      weekOrders,
      pcwOrders,
      mtdOrders,
      lyMtdOrders,
      ytdOrders,
      lyYtdOrders,
      weekOrdersForProducts,
      weekOrdersForLocations,
    ] = await Promise.all([
      fetchAllOrders(weekStart, weekEnd),
      fetchAllOrders(pcwStart, pcwEnd),
      fetchAllOrders(mtdStart, mtdEnd, "total_price,created_at,customer"),
      fetchAllOrders(lyMtdStart, lyMtdEnd, "total_price,created_at,customer"),
      fetchAllOrders(ytdStart, mtdEnd),
      fetchAllOrders(lyYtdStart, lyYtdEnd),
      fetchAllOrders(weekStart, weekEnd, "line_items"),
      fetchAllOrders(weekStart, weekEnd, "shipping_address,billing_address"),
    ]);

    const sumRev = (orders) => orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
    const calcAov = (orders) => orders.length > 0 ? sumRev(orders) / orders.length : 0;

    const weekRev    = sumRev(weekOrders);
    const pcwRev     = sumRev(pcwOrders);
    const mtdRev     = sumRev(mtdOrders);
    const lyMtdRev   = sumRev(lyMtdOrders);
    const ytdRev     = sumRev(ytdOrders);
    const lyYtdRev   = sumRev(lyYtdOrders);
    const weekTx     = weekOrders.length;
    const pcwTx      = pcwOrders.length;
    const mtdTx      = mtdOrders.length;
    const lyMtdTx    = lyMtdOrders.length;
    const weekAov    = calcAov(weekOrders);
    const pcwAov     = calcAov(pcwOrders);

    // New vs returning customers MTD
    const countNewReturning = (orders) => {
      let newC = 0, ret = 0;
      for (const o of orders) {
        (o.customer?.orders_count ?? 1) <= 1 ? newC++ : ret++;
      }
      return { newC, ret };
    };
    const { newC: newMtd, ret: returningMtd } = countNewReturning(mtdOrders);
    const { newC: newLyMtd, ret: returningLyMtd } = countNewReturning(lyMtdOrders);

    // Top 5 products by units this week
    const productMap = {};
    for (const order of weekOrdersForProducts) {
      for (const item of order.line_items || []) {
        const key = item.product_id || item.title || "unknown";
        if (!productMap[key]) productMap[key] = { title: item.title || "Unknown", quantity: 0 };
        productMap[key].quantity += item.quantity || 0;
      }
    }
    const topProducts = Object.values(productMap)
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);

    // Locations: top 3 states, top 3 suburbs, international orders
    const totalLocOrders = weekOrdersForLocations.length;
    const stateCounts = {}, suburbCounts = {};
    let intlOrders = 0;

    for (const order of weekOrdersForLocations) {
      const addr = order.shipping_address || order.billing_address;
      const country = addr?.country_code || "AU";
      const state = addr?.province_code || addr?.province || "Unknown";
      const suburb = addr?.city || addr?.suburb || null;

      if (country !== "AU") {
        intlOrders++;
      } else {
        stateCounts[state] = (stateCounts[state] || 0) + 1;
        if (suburb) suburbCounts[suburb] = (suburbCounts[suburb] || 0) + 1;
      }
    }

    const topStates = Object.entries(stateCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([state, count]) => `${state} (${count})`);

    const topSuburbs = Object.entries(suburbCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([suburb, count]) => {
        const pct = totalLocOrders > 0 ? Math.round((count / totalLocOrders) * 100) : 0;
        return `${suburb} (${pct}%)`;
      });

    const intlSummary = intlOrders > 0
      ? `${intlOrders} international order${intlOrders > 1 ? "s" : ""} (${Math.round((intlOrders / totalLocOrders) * 100)}% of total)`
      : null;

    // ─── LIGHTSPEED IN-STORE DATA (optional) ─────────────────────────────────

    let lsWeekRev = 0, lsMtdRev = 0, lsLyMtdRev = 0;
    let lsWeekTx = 0, lsMtdTx = 0, lsLyMtdTx = 0;
    let hasLightspeed = false;

    if (lightspeed_access_token && lightspeed_domain_prefix) {
      console.log("Fetching Lightspeed data...");
      try {
        let lsToken = lightspeed_access_token;

        const fetchLsSales = async (token, start, end) => {
          let sales = [];
          let offset = 0;
          const limit = 100;
          const baseUrl = `https://${lightspeed_domain_prefix}.retail.lightspeed.app/api/1.0`;

          while (true) {
            const params = new URLSearchParams({
              "timeStamp": `><,${start.toISOString()},${end.toISOString()}`,
              "completed": "true",
              "limit": String(limit),
              "offset": String(offset),
            });
            const r = await fetch(`${baseUrl}/Sale.json?${params}`, {
              headers: { Authorization: `Bearer ${token}` },
            });

            // If 401, try token refresh once
            if (r.status === 401) return "UNAUTHORIZED";
            if (!r.ok) throw new Error(`Lightspeed error ${r.status}: ${await r.text()}`);

            const data = await r.json();
            const batch = data.Sale ? (Array.isArray(data.Sale) ? data.Sale : [data.Sale]) : [];
            // Filter to register/in-store sales only (exclude ecomm channel)
            const inStore = batch.filter(s => s.source !== "ecom" && s.source !== "webstore");
            sales = sales.concat(inStore);
            if (batch.length < limit) break;
            offset += limit;
          }
          return sales;
        };

        // Attempt fetch — if 401 refresh token and retry
        let [lsWeek, lsMtd, lsLyMtd] = await Promise.all([
          fetchLsSales(lsToken, weekStart, weekEnd),
          fetchLsSales(lsToken, mtdStart, mtdEnd),
          fetchLsSales(lsToken, lyMtdStart, lyMtdEnd),
        ]);

        if (lsWeek === "UNAUTHORIZED" && lightspeed_refresh_token) {
          console.log("Lightspeed token expired — refreshing...");
          lsToken = await refreshLightspeedToken(lightspeed_refresh_token, lightspeed_domain_prefix, lightspeed_connection_id);
          if (lsToken) {
            [lsWeek, lsMtd, lsLyMtd] = await Promise.all([
              fetchLsSales(lsToken, weekStart, weekEnd),
              fetchLsSales(lsToken, mtdStart, mtdEnd),
              fetchLsSales(lsToken, lyMtdStart, lyMtdEnd),
            ]);
          }
        }

        if (Array.isArray(lsWeek)) {
          const lsSumRev = (sales) => sales.reduce((s, sale) => s + parseFloat(sale.total || 0), 0);
          lsWeekRev  = lsSumRev(lsWeek);
          lsMtdRev   = lsSumRev(lsMtd);
          lsLyMtdRev = lsSumRev(lsLyMtd);
          lsWeekTx   = lsWeek.length;
          lsMtdTx    = lsMtd.length;
          lsLyMtdTx  = lsLyMtd.length;
          hasLightspeed = true;
          console.log("Lightspeed data fetched — in-store week rev:", lsWeekRev);
        }
      } catch (lsErr) {
        // Non-fatal — brief continues with Shopify only
        console.error("Lightspeed fetch failed (non-fatal):", lsErr.message);
      }
    }

    // ─── XERO CASH BALANCE (optional) ────────────────────────────────────────

    let xeroCashBalance = null;
    if (xero_access_token && xero_tenant_id) {
      console.log("Fetching Xero cash balance...");
      try {
        xeroCashBalance = await fetchXeroBankBalance(xero_access_token, xero_tenant_id);

        if (xeroCashBalance === "UNAUTHORIZED" && xero_refresh_token) {
          console.log("Xero token expired — refreshing...");
          const newXeroToken = await refreshXeroToken(xero_refresh_token, xero_connection_id);
          if (newXeroToken) {
            xeroCashBalance = await fetchXeroBankBalance(newXeroToken, xero_tenant_id);
          }
        }

        if (xeroCashBalance === "UNAUTHORIZED") xeroCashBalance = null;
        else console.log("Xero cash balance:", xeroCashBalance);
      } catch (xeroErr) {
        console.error("Xero fetch failed (non-fatal):", xeroErr.message);
        xeroCashBalance = null;
      }
    }

    // ─── COMBINED TOTALS ─────────────────────────────────────────────────────

    const totalWeekRev  = weekRev + lsWeekRev;
    const totalPcwRev   = pcwRev;  // no LY Lightspeed — Shopify PCW only for now
    const totalMtdRev   = mtdRev + lsMtdRev;
    const totalLyMtdRev = lyMtdRev + lsLyMtdRev;
    const totalMtdTx    = mtdTx + lsMtdTx;
    const totalLyMtdTx  = lyMtdTx + lsLyMtdTx;

    // ─── FORMAT HELPERS ───────────────────────────────────────────────────────

    const pct = (a, b) => b > 0 ? `${(((a - b) / b) * 100).toFixed(1)}%` : 'N/A';

    // For data sent to Claude — exact figures so Claude reasons correctly
    const fmtExact = (n) => n != null ? `${Math.round(n).toLocaleString('en-AU')}` : 'N/A';

    // For audio output — round to nearest K to avoid ElevenLabs gurgling over long numbers
    const fmtK = (n) => {
      if (n == null) return 'N/A';
      const rounded = Math.round(n);
      if (rounded >= 10000) return `around ${Math.round(rounded / 1000)}K dollars`;
      if (rounded >= 1000) return `around ${(rounded / 1000).toFixed(1)}K dollars`;
      return `${rounded} dollars`;
    };

    // ─── CLAUDE PROMPT ────────────────────────────────────────────────────────

    const channelNote = hasLightspeed
      ? 'Online (Shopify) + In-store (Lightspeed). Revenue figures are combined unless noted.'
      : 'Online only (Shopify). In-store data not available this week.';

    const lightspeedBlock = hasLightspeed ? `
IN-STORE (Lightspeed only, for context):
- This week in-store revenue: ${fmtExact(lsWeekRev)} | transactions: ${lsWeekTx}
- MTD in-store revenue: ${fmtExact(lsMtdRev)} vs LY: ${fmtExact(lsLyMtdRev)} (${pct(lsMtdRev, lsLyMtdRev)})
` : '';

    const xeroBlock = xeroCashBalance !== null ? `
CASH POSITION (Xero):
- Bank balance: ${fmtExact(xeroCashBalance)}
` : '';

    const locationsBlock = topStates.length > 0 ? `
CUSTOMER LOCATIONS (this week):
- Top states: ${topStates.join(', ')}
${topSuburbs.length > 0 ? `- Top suburbs: ${topSuburbs.join(', ')}` : ''}
${intlSummary ? `- International: ${intlSummary}` : ''}
` : '';

    // Australian FY label e.g. "FY2026 (Jul 25 - Jun 26)"
    const fyLabel = `FY${fyStartYear + 1} (Jul ${String(fyStartYear).slice(2)} – Jun ${String(fyStartYear + 1).slice(2)})`;

    const dataBlock = `
STORE: ${store_name}
PERIOD: ${weekLabel}
CHANNEL: ${channelNote}

REVENUE (combined online + in-store):
- This week: ${fmtExact(totalWeekRev)} vs same week last year: ${fmtExact(totalPcwRev)} (${pct(totalWeekRev, totalPcwRev)})
- MTD (${monthLabel}): ${fmtExact(totalMtdRev)} vs LY MTD: ${fmtExact(totalLyMtdRev)} (${pct(totalMtdRev, totalLyMtdRev)})
- FYTD (${fyLabel}): ${fmtExact(ytdRev)} vs LY FYTD: ${fmtExact(lyYtdRev)} (${pct(ytdRev, lyYtdRev)})
${xeroBlock}${lightspeedBlock}
TRANSACTIONS & AOV (combined):
- This week: ${weekTx + lsWeekTx} orders total (${weekTx} online, ${lsWeekTx} in-store)
- Online AOV this week: ${fmtExact(weekAov)} vs LY: ${fmtExact(pcwAov)} (${pct(weekAov, pcwAov)})
- MTD transactions: ${totalMtdTx} vs LY MTD: ${totalLyMtdTx} (${pct(totalMtdTx, totalLyMtdTx)})

TOP 5 PRODUCTS THIS WEEK (online, by units):
${topProducts.map((p, i) => `${i + 1}. ${p.title} — ${p.quantity} units`).join('\n')}

CUSTOMERS — ONLINE ONLY (MTD):
- New customers: ${newMtd} vs LY: ${newLyMtd} (${pct(newMtd, newLyMtd)})
- Returning customers: ${returningMtd} vs LY: ${returningLyMtd} (${pct(returningMtd, returningLyMtd)})

${locationsBlock}`;

    const systemPrompt = `You are Teloskope, a smart weekly business advisor for independent retail store owners.
You write a Monday morning brief that owners listen to as audio — so write for the ear, not the eye.

STRUCTURE — follow this exactly:

1. OPENING (2-3 sentences, flowing prose): Warm and direct. No greeting words like G'day, Hello, or Hi. Start with the store name or the key result. Call out the single most important number using rounded figures — say 'around 26K' not '26,432 dollars'. Set the tone.

2. DATA BULLETS: Present each section as tight bullet points — one punchy line each. Round all dollar figures and say them naturally for audio, e.g. 'around 26K', 'just over 140K', '445 dollars'. Use percentage variances for colour. Be factual and concise.

Sections to cover as bullets:
- Revenue: this week vs last year, MTD vs LY MTD, YTD vs LY YTD
${hasLightspeed ? '- In-store vs online split\n' : ''}- Transactions and AOV: MTD vs LY
- New vs returning customers: MTD, online only
- Top 5 products this week (name and units)
- Customer locations: top states
${xeroCashBalance !== null ? '- Cash position\n' : ''}
3. OPTIONS TO EXPLORE: End with exactly 3 options. Label each as 'Option 1:', 'Option 2:', 'Option 3:' on separate lines. Specific, grounded in the data, not generic.

TONE: Warm, direct, commercially sharp. Like a trusted advisor who respects the owner's time. Inclusive — this brief is for all owners regardless of background.`;

    const userPrompt = `Here is the data for ${store_name} for the ${weekLabel}.

${dataBlock}

Write the Teloskope Weekly Brief: opening prose (2-3 sentences, no greeting word), then bullet points by section, then 3 Options to Explore.`;

    console.log("Calling Claude...");

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const briefText = claudeResponse.content?.[0]?.text?.trim();
    if (!briefText) throw new Error("Claude returned empty brief text");
    console.log("Claude brief generated, chars:", briefText.length);

    // ─── ELEVENLABS ───────────────────────────────────────────────────────────

    console.log("Calling ElevenLabs...");
    const elResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: briefText,
          model_id: "eleven_turbo_v2_5",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );
    if (!elResponse.ok) throw new Error(`ElevenLabs error ${elResponse.status}: ${await elResponse.text()}`);

    const audioBuffer = Buffer.from(await elResponse.arrayBuffer());
    if (!audioBuffer || audioBuffer.length === 0) throw new Error("ElevenLabs returned empty audio");
    console.log("Audio generated, size:", audioBuffer.length, "bytes");

    // ─── UPLOAD TO VERCEL BLOB ────────────────────────────────────────────────

    console.log("Uploading audio to Vercel Blob...");
    const safeDate = weekEnd.toISOString().split("T")[0];
    const blob = await put(`teloskope-brief-${user_id}-${safeDate}.mp3`, audioBuffer, {
      access: "public",
      contentType: "audio/mpeg",
      addRandomSuffix: true,
    });
    const audioUrl = blob.url;
    console.log("Audio uploaded:", audioUrl);

    // ─── POST TO BUBBLE ───────────────────────────────────────────────────────

    console.log("Posting to Bubble...");
    const bubblePayload = {
      secret_key: bubble_secret_key,
      user_id,
      brief_text: briefText,
      audio_url: audioUrl,
      week_end_date: weekEnd.toISOString(),
      // Online (Shopify)
      shopify_week_revenue: Math.round(weekRev * 100) / 100,
      shopify_pcw_revenue: Math.round(pcwRev * 100) / 100,
      shopify_mtd_revenue: Math.round(mtdRev * 100) / 100,
      shopify_ly_mtd_revenue: Math.round(lyMtdRev * 100) / 100,
      shopify_ytd_revenue: Math.round(ytdRev * 100) / 100,
      shopify_ly_ytd_revenue: Math.round(lyYtdRev * 100) / 100,
      shopify_week_transactions: weekTx,
      shopify_mtd_transactions: mtdTx,
      shopify_week_aov: Math.round(weekAov * 100) / 100,
      // In-store (Lightspeed)
      lightspeed_week_revenue: Math.round(lsWeekRev * 100) / 100,
      lightspeed_mtd_revenue: Math.round(lsMtdRev * 100) / 100,
      lightspeed_ly_mtd_revenue: Math.round(lsLyMtdRev * 100) / 100,
      lightspeed_week_transactions: lsWeekTx,
      lightspeed_mtd_transactions: lsMtdTx,
      // Combined totals
      total_week_revenue: Math.round(totalWeekRev * 100) / 100,
      total_mtd_revenue: Math.round(totalMtdRev * 100) / 100,
      total_ly_mtd_revenue: Math.round(totalLyMtdRev * 100) / 100,
      total_mtd_transactions: totalMtdTx,
      // Customers
      new_customers_mtd: newMtd,
      returning_customers_mtd: returningMtd,
      new_customers_ly_mtd: newLyMtd,
      returning_customers_ly_mtd: returningLyMtd,
      // Products + locations
      top_products_json: JSON.stringify(topProducts),
      top_states_json: JSON.stringify(topStates),
      // Xero
      xero_cash_balance: xeroCashBalance,
    };

    const bubbleResponse = await fetch(`${BUBBLE_BASE_URL}/wf/ingest_weekly_brief`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bubblePayload),
    });
    if (!bubbleResponse.ok) throw new Error(`Bubble error ${bubbleResponse.status}: ${await bubbleResponse.text()}`);

    const bubbleData = await bubbleResponse.json();
    const briefId = bubbleData?.response?.brief_id;
    const briefUrl = briefId ? `${brief_page_base_url}${briefId}` : brief_page_base_url;

    // ─── TWILIO SMS ───────────────────────────────────────────────────────────

    console.log("Sending SMS...");
    const smsBody = `Good morning ${user_name || ""}! Your Teloskope Weekly Brief for the ${weekLabel} is ready. Listen here: ${briefUrl}`.trim();

    const twilioResponse = await fetch(
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
    if (!twilioResponse.ok) throw new Error(`Twilio error ${twilioResponse.status}: ${await twilioResponse.text()}`);
    console.log("SMS sent to", user_phone);

    return res.status(200).json({
      success: true,
      brief_id: briefId,
      brief_url: briefUrl,
      audio_url: audioUrl,
      week_end: safeDate,
      sms_sent_to: user_phone,
    });

  } catch (err) {
    console.error("generate-weekly-brief error:", err);
    return res.status(500).json({ error: err.message || "Unknown server error" });
  }
}

// ─── XERO HELPERS ─────────────────────────────────────────────────────────────

async function fetchXeroBankBalance(access_token, tenant_id) {
  // Use the Bank Summary report — Accounts endpoint doesn't return balances
  const r = await fetch("https://api.xero.com/api.xro/2.0/Reports/BankSummary", {
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Xero-tenant-id": tenant_id,
      Accept: "application/json",
    },
  });
  if (r.status === 401) return "UNAUTHORIZED";
  if (!r.ok) throw new Error(`Xero bank summary error: ${r.status} ${await r.text()}`);
  const data = await r.json();

  // BankSummary report rows: find the closing balance row
  // Structure: Reports[0].Rows -> find RowType=SummaryRow or Section with closing balance
  try {
    const report = data.Reports?.[0];
    const rows = report?.Rows || [];

    // Find the SummaryRow in any Section — it has the total closing balance
    // Structure: Rows[n].Rows[m] where RowType=SummaryRow
    // Cells: [Total, Opening Balance, Cash Received, Cash Spent, Closing Balance]
    for (const section of rows) {
      if (section.Rows) {
        for (const row of section.Rows) {
          if (row.RowType === 'SummaryRow' && row.Cells) {
            const closingBalance = row.Cells[4]?.Value;
            if (closingBalance != null) {
              const total = parseFloat(closingBalance.replace(/,/g, ''));
              console.log('Xero closing balance from SummaryRow:', total);
              return Math.round(total * 100) / 100;
            }
          }
        }
      }
    }

    console.log('Xero: no SummaryRow found, falling back to summing Row closing balances');
    let total = 0;
    for (const section of rows) {
      if (section.Rows) {
        for (const row of section.Rows) {
          if (row.RowType === 'Row' && row.Cells?.length >= 5) {
            const val = parseFloat(row.Cells[4]?.Value?.replace(/,/g, '') || '0');
            if (!isNaN(val)) total += val;
          }
        }
      }
    }
    console.log('Xero total from Row sum:', total);
    return Math.round(total * 100) / 100;
  } catch (parseErr) {
    console.error('Xero parse error:', parseErr.message, JSON.stringify(data).slice(0, 500));
    return null;
  }
}

async function refreshXeroToken(refresh_token, xero_connection_id) {
  const credentials = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString("base64");
  const r = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token }),
  });
  if (!r.ok) { console.error("Xero token refresh failed:", r.status); return null; }
  const data = await r.json();

  // Save refreshed tokens back to Bubble Xero Connection record
  if (xero_connection_id && process.env.BUBBLE_API_KEY) {
    try {
      await fetch(`https://teloskope.bubbleapps.io/version-test/api/1.1/obj/xero_connection/${xero_connection_id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          xero_access_token: data.access_token,
          xero_refresh_token: data.refresh_token,
        }),
      });
    } catch (e) { console.error("Failed to save Xero tokens to Bubble:", e.message); }
  }
  return data.access_token;
}

// ─── LIGHTSPEED HELPERS ───────────────────────────────────────────────────────

async function refreshLightspeedToken(refresh_token, domain_prefix, lightspeed_connection_id) {
  const credentials = Buffer.from(`${process.env.LIGHTSPEED_CLIENT_ID}:${process.env.LIGHTSPEED_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(`https://${domain_prefix}.retail.lightspeed.app/api/1.0/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token }),
  });
  if (!r.ok) { console.error("Lightspeed token refresh failed:", r.status); return null; }
  const data = await r.json();

  // Save refreshed tokens back to Bubble Lightspeed Connection record
  if (lightspeed_connection_id && process.env.BUBBLE_API_KEY) {
    try {
      await fetch(`https://teloskope.bubbleapps.io/version-test/api/1.1/obj/lightspeed_connection/${lightspeed_connection_id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          lightspeed_access_token: data.access_token,
          lightspeed_refresh_token: data.refresh_token,
        }),
      });
    } catch (e) { console.error("Failed to save Lightspeed tokens to Bubble:", e.message); }
  }
  return data.access_token;
}
