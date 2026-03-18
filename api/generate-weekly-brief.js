// api/generate-weekly-brief.js
// Pulls Shopify → Claude → ElevenLabs → posts finished brief to Bubble → Twilio SMS
// V1 beta: Shopify (online) only. Lightspeed (in-store) to be added post Lightspeed app approval.

import Anthropic from "@anthropic-ai/sdk";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = "YCxeyFA0G7yTk6Wuv2oq"; // Matt Washer
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BUBBLE_BASE_URL = "https://teloskope.bubbleapps.io/version-test/api/1.1";

// ─── AEST/AEDT DATE HELPERS ───────────────────────────────────────────────────
// Vercel runs UTC. All date logic is anchored to Australia/Sydney so that
// Mon–Sun week boundaries match exactly what the store owner sees in Shopify.

// Returns {year, month (0-indexed), day, dayOfWeek (0=Sun..6=Sat)} in Sydney time
function getAestDateParts(utcDate) {
  const fmt = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
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

// Given an AEST {year, month (0-indexed), day}, return the UTC timestamp
// corresponding to midnight Sydney time on that date (handles DST automatically).
function aestMidnightToUtc(year, month, day) {
  // Construct ISO string without timezone, then interpret as Sydney local midnight
  const pad = (n) => String(n).padStart(2, "0");
  const localStr = `${year}-${pad(month + 1)}-${pad(day)}T00:00:00`;

  // Intl trick: find the UTC ms value where Sydney clock reads midnight on this date.
  // We do this by binary-searching, but a simpler approach: use the Date constructor
  // with a UTC guess and compare Sydney's reading of it.
  // Fastest reliable method: use the offset from a probe date.
  const probe = new Date(`${localStr}Z`); // treat as UTC — will be off by offset
  const sydFmt = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const probePartsRaw = sydFmt.formatToParts(probe);
  const getPart = (t) => parseInt(probePartsRaw.find(p => p.type === t).value);
  // Sydney's reading of the probe (which is actually UTC midnight)
  const sydHour = getPart("hour"); // hours ahead = Sydney UTC offset
  // Sydney is UTC+10 (AEST) or UTC+11 (AEDT). The probe is UTC midnight.
  // Sydney reads it as sydHour:00 on the same or next day.
  // To get UTC time of Sydney midnight: subtract sydHour hours from probe.
  // But if sydHour is 0, Sydney midnight IS UTC midnight (shouldn't happen for AU).
  const offsetMs = sydHour * 3600 * 1000;
  return new Date(probe.getTime() - offsetMs);
}

// End of day (23:59:59.999) Sydney time as UTC
function aestEndOfDayToUtc(year, month, day) {
  const midnight = aestMidnightToUtc(year, month, day);
  return new Date(midnight.getTime() + 24 * 3600 * 1000 - 1);
}

// Add/subtract days from an AEST date object, returns new AEST date object
function aestShiftDays(aestDate, days) {
  const d = new Date(Date.UTC(aestDate.year, aestDate.month, aestDate.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

// Shift year by n
function aestShiftYear(aestDate, years) {
  return { ...aestDate, year: aestDate.year + years };
}

// Format AEST date as human-readable AU string
function fmtAestDate(aestDate, opts = { day: "numeric", month: "long", year: "numeric" }) {
  return new Date(Date.UTC(aestDate.year, aestDate.month, aestDate.day))
    .toLocaleDateString("en-AU", opts);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    shopify_shop_domain,
    shopify_access_token,
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
    //
    // The cron fires Monday 8:50am AEST. In UTC this is Sunday night (~21:50 UTC).
    // Using new Date() directly and calling .getDate()-1 gives SATURDAY in UTC,
    // not Sunday — the entire week window shifts one day early.
    //
    // Fix: get today's date in Sydney timezone first, then compute all ranges from that.

    const nowUtc = new Date();
    const todayAest = getAestDateParts(nowUtc);

    console.log("UTC now:", nowUtc.toISOString());
    console.log("AEST today:", todayAest);

    // weekEnd = last Sunday in AEST (yesterday when running Monday)
    // dayOfWeek: Mon=1, so daysBackToSunday=1. Robust for any day in case of reruns.
    const daysBackToSunday = todayAest.dayOfWeek === 0 ? 7 : todayAest.dayOfWeek;
    const weekEndAest = aestShiftDays(todayAest, -daysBackToSunday);
    const weekStartAest = aestShiftDays(weekEndAest, -6); // Mon = Sun - 6

    // PCW = same Mon–Sun, one year prior
    const pcwEndAest = aestShiftYear(weekEndAest, -1);
    const pcwStartAest = aestShiftYear(weekStartAest, -1);

    // MTD = 1st of current AEST month → today
    const mtdStartAest = { year: todayAest.year, month: todayAest.month, day: 1 };
    const mtdEndAest = todayAest;
    const lyMtdStartAest = aestShiftYear(mtdStartAest, -1);
    const lyMtdEndAest = aestShiftYear(mtdEndAest, -1);

    // YTD = Jan 1 → today
    const ytdStartAest = { year: todayAest.year, month: 0, day: 1 };
    const ytdEndAest = todayAest;
    const lyYtdStartAest = aestShiftYear(ytdStartAest, -1);
    const lyYtdEndAest = aestShiftYear(ytdEndAest, -1);

    // Convert to UTC timestamps for Shopify API calls
    const weekStart   = aestMidnightToUtc(weekStartAest.year, weekStartAest.month, weekStartAest.day);
    const weekEnd     = aestEndOfDayToUtc(weekEndAest.year, weekEndAest.month, weekEndAest.day);
    const pcwStart    = aestMidnightToUtc(pcwStartAest.year, pcwStartAest.month, pcwStartAest.day);
    const pcwEnd      = aestEndOfDayToUtc(pcwEndAest.year, pcwEndAest.month, pcwEndAest.day);
    const mtdStart    = aestMidnightToUtc(mtdStartAest.year, mtdStartAest.month, mtdStartAest.day);
    const mtdEnd      = aestEndOfDayToUtc(mtdEndAest.year, mtdEndAest.month, mtdEndAest.day);
    const lyMtdStart  = aestMidnightToUtc(lyMtdStartAest.year, lyMtdStartAest.month, lyMtdStartAest.day);
    const lyMtdEnd    = aestEndOfDayToUtc(lyMtdEndAest.year, lyMtdEndAest.month, lyMtdEndAest.day);
    const ytdStart    = aestMidnightToUtc(ytdStartAest.year, ytdStartAest.month, ytdStartAest.day);
    const ytdEnd      = aestEndOfDayToUtc(ytdEndAest.year, ytdEndAest.month, ytdEndAest.day);
    const lyYtdStart  = aestMidnightToUtc(lyYtdStartAest.year, lyYtdStartAest.month, lyYtdStartAest.day);
    const lyYtdEnd    = aestEndOfDayToUtc(lyYtdEndAest.year, lyYtdEndAest.month, lyYtdEndAest.day);

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
        const r = await fetch(url, {
          headers: { "X-Shopify-Access-Token": shopify_access_token },
        });
        if (!r.ok) throw new Error(`Shopify error ${r.status}: ${await r.text()}`);
        const data = await r.json();
        orders = orders.concat(data.orders || []);
        const link = r.headers.get("Link");
        if (link && link.includes('rel="next"')) {
          const match = link.match(/<([^>]+)>;\s*rel="next"/);
          url = match ? match[1] : null;
        } else {
          url = null;
        }
      }
      return orders;
    };

    const sumRevenue = (orders) =>
      orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);

    const calcAov = (orders) =>
      orders.length > 0 ? sumRevenue(orders) / orders.length : 0;

    const countNewReturning = (orders) => {
      let newC = 0, returning = 0;
      for (const o of orders) {
        (o.customer?.orders_count ?? 1) <= 1 ? newC++ : returning++;
      }
      return { newC, returning };
    };

    // ─── PARALLEL SHOPIFY FETCH ───────────────────────────────────────────────

    console.log("Fetching Shopify data...");
    const [
      weekOrders,
      pcwOrders,
      mtdOrders,
      lyMtdOrders,
      ytdOrders,
      lyYtdOrders,
      weekOrdersForProducts,
    ] = await Promise.all([
      fetchAllOrders(weekStart, weekEnd),
      fetchAllOrders(pcwStart, pcwEnd),
      fetchAllOrders(mtdStart, mtdEnd, "total_price,created_at,customer"),
      fetchAllOrders(lyMtdStart, lyMtdEnd, "total_price,created_at,customer"),
      fetchAllOrders(ytdStart, ytdEnd),
      fetchAllOrders(lyYtdStart, lyYtdEnd),
      fetchAllOrders(weekStart, weekEnd, "line_items"),
    ]);

    console.log("Week orders:", weekOrders.length, "| Revenue:", sumRevenue(weekOrders).toFixed(2));
    console.log("PCW  orders:", pcwOrders.length,  "| Revenue:", sumRevenue(pcwOrders).toFixed(2));
    console.log("MTD  orders:", mtdOrders.length,  "| Revenue:", sumRevenue(mtdOrders).toFixed(2));
    console.log("LY MTD orders:", lyMtdOrders.length, "| Revenue:", sumRevenue(lyMtdOrders).toFixed(2));

    // ─── METRIC CALCULATIONS ──────────────────────────────────────────────────

    const weekRev = sumRevenue(weekOrders);
    const pcwRev  = sumRevenue(pcwOrders);
    const mtdRev  = sumRevenue(mtdOrders);
    const lyMtdRev = sumRevenue(lyMtdOrders);
    const ytdRev  = sumRevenue(ytdOrders);
    const lyYtdRev = sumRevenue(lyYtdOrders);
    const weekTx  = weekOrders.length;
    const pcwTx   = pcwOrders.length;
    const mtdTx   = mtdOrders.length;
    const lyMtdTx = lyMtdOrders.length;
    const weekAov = calcAov(weekOrders);
    const pcwAov  = calcAov(pcwOrders);
    const { newC: newMtd, returning: returningMtd } = countNewReturning(mtdOrders);
    const { newC: newLyMtd, returning: returningLyMtd } = countNewReturning(lyMtdOrders);

    // Top 5 products by units sold this week
    const productMap = {};
    for (const order of weekOrdersForProducts) {
      for (const item of order.line_items || []) {
        const key = item.product_id;
        if (!productMap[key]) productMap[key] = { title: item.title, quantity: 0 };
        productMap[key].quantity += item.quantity;
      }
    }
    const topProducts = Object.values(productMap)
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);

    const pct = (a, b) => b > 0 ? `${(((a - b) / b) * 100).toFixed(1)}%` : "N/A";
    const fmt$ = (n) => `$${Math.round(n).toLocaleString()}`;

    const hasLyWeek = pcwRev > 0 || pcwTx > 0;
    const hasLyMtd  = lyMtdRev > 0 || lyMtdTx > 0;
    const hasLyYtd  = lyYtdRev > 0;

    const lyWeekNote = hasLyWeek
      ? `${fmt$(pcwRev)} revenue | ${pcwTx} orders | AOV ${fmt$(pcwAov)} | change: ${pct(weekRev, pcwRev)}`
      : "not available — no online orders recorded this week last year";
    const lyMtdNote = hasLyMtd
      ? `${fmt$(lyMtdRev)} | ${lyMtdTx} orders | change: ${pct(mtdRev, lyMtdRev)}`
      : "not available — no online sales this month last year";
    const lyYtdNote = hasLyYtd
      ? `${fmt$(lyYtdRev)} | change: ${pct(ytdRev, lyYtdRev)}`
      : "not available — first year of online trading";

    const weekLabel = `week ending ${fmtAestDate(weekEndAest)}`;
    const monthLabel = fmtAestDate({ year: todayAest.year, month: todayAest.month, day: 1 }, { month: "long", year: "numeric" });

    // ─── CLAUDE PROMPT ────────────────────────────────────────────────────────

    const dataBlock = `
STORE: ${store_name}
PERIOD: ${weekLabel}
CHANNEL: Online only (Shopify)

WEEKLY PERFORMANCE:
- Revenue this week: ${fmt$(weekRev)}
- Orders: ${weekTx} | AOV: ${fmt$(weekAov)}
- Same week last year: ${lyWeekNote}

MONTH TO DATE (${monthLabel}):
- Revenue: ${fmt$(mtdRev)} | Orders: ${mtdTx}
- Last year MTD: ${lyMtdNote}

YEAR TO DATE:
- Revenue: ${fmt$(ytdRev)}
- Last year YTD: ${lyYtdNote}

CUSTOMER MIX (MTD):
- New customers: ${newMtd}${hasLyMtd ? ` vs LY: ${newLyMtd}` : ""}
- Returning customers: ${returningMtd}${hasLyMtd ? ` vs LY: ${returningLyMtd}` : ""}

TOP 5 PRODUCTS THIS WEEK (by units sold):
${topProducts.length > 0
  ? topProducts.map((p, i) => `${i + 1}. ${p.title} — ${p.quantity} units`).join("\n")
  : "No product orders recorded this week"}
`;

    const systemPrompt = `You are Teloskope, a smart weekly business advisor for independent retail store owners.
Your job is to write a warm, direct, insightful weekly brief that a store owner can listen to on a Monday morning.
Write in a conversational Australian tone — like a trusted business advisor, not a corporate report.
Be specific with numbers. Be honest about what looks good and what needs watching.
Never use bullet points or headers — write in flowing paragraphs only.
The brief should take about 90 seconds to read aloud.
IMPORTANT STRUCTURE: Always lead with the headline revenue number for the week (with $ sign) in the very first sentence. Make the cash figure the first thing the owner hears.
When last year data is marked as "not available", acknowledge this naturally and briefly — do not dwell on it.
End with exactly 3 "Options to Explore" — short, specific, actionable ideas based on the data.
Label them clearly as "Option 1:", "Option 2:", "Option 3:" on new lines.`;

    const userPrompt = `Here is the online sales data for ${store_name} for the ${weekLabel}.

${dataBlock}

Write the weekly Teloskope brief. Cover: revenue performance and year-on-year comparison, transactions and AOV, new vs returning customer mix, top products, and what it all means together. Then give exactly 3 Options to Explore.`;

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

    // Format as HTML for Bubble HTML element
    const briefText = rawBriefText
      .replace(/Option (1|2|3):/g, '<strong style="color:#0205D3;">Option $1:</strong>')
      .split(/\n\n+/)
      .map(para => para.trim())
      .filter(para => para.length > 0)
      .map(para => `<p style="margin-bottom:16px;line-height:1.6;">${para.replace(/\n/g, "<br>")}</p>`)
      .join("\n");

    // ─── ELEVENLABS TTS ───────────────────────────────────────────────────────

    // Send rawBriefText (no HTML tags) so voice reads clean prose
    console.log("Calling ElevenLabs...");
    const elResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: rawBriefText,
          model_id: "eleven_turbo_v2_5",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!elResponse.ok) {
      throw new Error(`ElevenLabs error ${elResponse.status}: ${await elResponse.text()}`);
    }

    const audioBuffer = await elResponse.arrayBuffer();
    const audioBlob = Buffer.from(audioBuffer);
    console.log("Audio generated, size:", audioBlob.length, "bytes");

    // ─── UPLOAD AUDIO TO BUBBLE FILE STORAGE ─────────────────────────────────

    console.log("Uploading audio to Bubble...");
    const pad = (n) => String(n).padStart(2, "0");
    const fileName = `teloskope-brief-${user_id}-${weekEndAest.year}-${pad(weekEndAest.month + 1)}-${pad(weekEndAest.day)}.mp3`;

    let audioUrl = null;
    try {
      const form = new FormData();
      form.append("filename", fileName);
      form.append("contents", new Blob([audioBlob], { type: "audio/mpeg" }), fileName);
      form.append("private", "false");

      const bubbleUploadResponse = await fetch(
        "https://teloskope.bubbleapps.io/version-test/fileupload",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`,
            // No Content-Type header — fetch sets multipart boundary automatically
          },
          body: form,
        }
      );

      if (bubbleUploadResponse.ok) {
        audioUrl = (await bubbleUploadResponse.text()).trim();
        console.log("Audio uploaded to Bubble CDN:", audioUrl);
      } else {
        const err = await bubbleUploadResponse.text();
        console.error("Bubble upload failed:", err);
        throw new Error(err);
      }
    } catch (uploadErr) {
      console.warn("Bubble upload failed, falling back to ElevenLabs URL:", uploadErr.message);
      const historyItemId = elResponse.headers.get("history-item-id");
      audioUrl = historyItemId
        ? `https://api.elevenlabs.io/v1/history/${historyItemId}/audio`
        : null;
      console.log("Fallback audio URL:", audioUrl);
    }

    // ─── POST BRIEF TO BUBBLE ─────────────────────────────────────────────────

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
      returning_customers_mtd: returningMtd,
      top_products_json: JSON.stringify(topProducts),
    };

    const bubbleResponse = await fetch(`${BUBBLE_BASE_URL}/wf/ingest_weekly_brief`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bubblePayload),
    });

    if (!bubbleResponse.ok) {
      throw new Error(`Bubble error ${bubbleResponse.status}: ${await bubbleResponse.text()}`);
    }

    const bubbleData = await bubbleResponse.json();
    const briefUrl = brief_page_base_url;

    // ─── TWILIO SMS ───────────────────────────────────────────────────────────

    console.log("Sending SMS...");
    const smsBody = `Good morning ${user_name}! Your Teloskope Weekly Brief for the ${weekLabel} is ready. Listen here: ${briefUrl}`;

    const twilioResponse = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: TWILIO_PHONE_NUMBER,
          To: user_phone,
          Body: smsBody,
        }),
      }
    );

    if (!twilioResponse.ok) {
      throw new Error(`Twilio error ${twilioResponse.status}: ${await twilioResponse.text()}`);
    }

    console.log("SMS sent to", user_phone);

    return res.status(200).json({
      success: true,
      brief_id: bubbleData?.response?.brief_id,
      brief_url: briefUrl,
      audio_url: audioUrl,
      week_end: `${weekEndAest.year}-${pad(weekEndAest.month + 1)}-${pad(weekEndAest.day)}`,
      sms_sent_to: user_phone,
    });

  } catch (err) {
    console.error("generate-weekly-brief error:", err);
    return res.status(500).json({ error: err.message });
  }
}
