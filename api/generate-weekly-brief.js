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

  // Test mode — returns mock response for Bubble API Connector initialization
  if (shopify_shop_domain === "test.myshopify.com") {
    return res.status(200).json({
      success: true,
      brief_id: "test_brief_id",
      brief_url: "https://teloskope.bubbleapps.io/version-test/brief/test",
      audio_url: "https://api.elevenlabs.io/v1/history/test/audio",
      week_end: "2026-03-08",
      sms_sent_to: "+61400000000",
    });
  }

  try {

    // ─── DATE CALCULATIONS (Mon–Sun) ─────────────────────────────────────────

    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - daysFromMonday);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const pcwStart = new Date(weekStart);
    pcwStart.setFullYear(pcwStart.getFullYear() - 1);
    const pcwEnd = new Date(weekEnd);
    pcwEnd.setFullYear(pcwEnd.getFullYear() - 1);

    const mtdStart = new Date(now.getFullYear(), now.getMonth(), 1);
    mtdStart.setHours(0, 0, 0, 0);
    const mtdEnd = new Date(now);
    mtdEnd.setHours(23, 59, 59, 999);

    const lyMtdStart = new Date(mtdStart);
    lyMtdStart.setFullYear(lyMtdStart.getFullYear() - 1);
    const lyMtdEnd = new Date(mtdEnd);
    lyMtdEnd.setFullYear(lyMtdEnd.getFullYear() - 1);

    const ytdStart = new Date(now.getFullYear(), 0, 1);
    ytdStart.setHours(0, 0, 0, 0);

    const lyYtdStart = new Date(ytdStart);
    lyYtdStart.setFullYear(lyYtdStart.getFullYear() - 1);
    const lyYtdEnd = new Date(now);
    lyYtdEnd.setFullYear(lyYtdEnd.getFullYear() - 1);
    lyYtdEnd.setHours(23, 59, 59, 999);

    const fmt = (d) => d.toISOString();

    // ─── SHOPIFY HELPERS ──────────────────────────────────────────────────────

    const fetchAllOrders = async (start, end, fields = "total_price,created_at") => {
      let orders = [];
      let url = `https://${shopify_shop_domain}/admin/api/2024-01/orders.json?status=any&financial_status=paid&created_at_min=${fmt(start)}&created_at_max=${fmt(end)}&fields=${fields}&limit=250`;
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

    // ─── PARALLEL FETCH ───────────────────────────────────────────────────────

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
      fetchAllOrders(ytdStart, mtdEnd),
      fetchAllOrders(lyYtdStart, lyYtdEnd),
      fetchAllOrders(weekStart, weekEnd, "line_items"),
    ]);

    // ─── CALCULATIONS ─────────────────────────────────────────────────────────

    const weekRev = sumRevenue(weekOrders);
    const pcwRev = sumRevenue(pcwOrders);
    const mtdRev = sumRevenue(mtdOrders);
    const lyMtdRev = sumRevenue(lyMtdOrders);
    const ytdRev = sumRevenue(ytdOrders);
    const lyYtdRev = sumRevenue(lyYtdOrders);
    const weekTx = weekOrders.length;
    const pcwTx = pcwOrders.length;
    const mtdTx = mtdOrders.length;
    const lyMtdTx = lyMtdOrders.length;
    const weekAov = calcAov(weekOrders);
    const pcwAov = calcAov(pcwOrders);
    const { newC: newMtd, returning: returningMtd } = countNewReturning(mtdOrders);
    const { newC: newLyMtd, returning: returningLyMtd } = countNewReturning(lyMtdOrders);

    // Top 5 products
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

    const weekLabel = `week ending ${weekEnd.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}`;
    const monthLabel = now.toLocaleDateString("en-AU", { month: "long", year: "numeric" });

    // ─── CLAUDE PROMPT ────────────────────────────────────────────────────────

    const dataBlock = `
STORE: ${store_name}
PERIOD: ${weekLabel}
CHANNEL: Online only (Shopify)

REVENUE:
- This week: ${fmt$(weekRev)} vs same week last year: ${fmt$(pcwRev)} (${pct(weekRev, pcwRev)})
- MTD (${monthLabel}): ${fmt$(mtdRev)} vs LY MTD: ${fmt$(lyMtdRev)} (${pct(mtdRev, lyMtdRev)})
- YTD: ${fmt$(ytdRev)} vs LY YTD: ${fmt$(lyYtdRev)} (${pct(ytdRev, lyYtdRev)})

TRANSACTIONS & AOV:
- This week: ${weekTx} orders, AOV ${fmt$(weekAov)} vs LY: ${pcwTx} orders, AOV ${fmt$(pcwAov)}
- MTD: ${mtdTx} orders vs LY MTD: ${lyMtdTx} orders

CUSTOMERS (MTD):
- New customers: ${newMtd} vs LY: ${newLyMtd}
- Returning customers: ${returningMtd} vs LY: ${returningLyMtd}

TOP 5 PRODUCTS THIS WEEK:
${topProducts.map((p, i) => `${i + 1}. ${p.title} — ${p.quantity} units`).join("\n")}
`;

    const systemPrompt = `You are Teloskope, a smart weekly business advisor for independent retail store owners.
Your job is to write a warm, direct, insightful weekly brief that a store owner can listen to on a Monday morning.
Write in a conversational Australian tone — like a trusted business advisor, not a corporate report.
Be specific with numbers. Be honest about what looks good and what needs watching.
Never use bullet points or headers — write in flowing paragraphs only.
The brief should take about 90 seconds to read aloud.
End with exactly 3 "Options to Explore" — short, specific, actionable ideas based on the data.
Label them clearly as "Option 1:", "Option 2:", "Option 3:" on new lines.`;

    const userPrompt = `Here is the online sales data for ${store_name} for the ${weekLabel}.

${dataBlock}

Write the weekly Teloskope brief. Cover: revenue performance, transactions and AOV, new vs returning customer mix, top products, and what it all means together. Then give exactly 3 Options to Explore.`;

    console.log("Calling Claude...");
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const briefText = claudeResponse.content[0].text;
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
        },
        body: JSON.stringify({
          text: briefText,
          model_id: "eleven_turbo_v2_5",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!elResponse.ok) {
      throw new Error(`ElevenLabs error ${elResponse.status}: ${await elResponse.text()}`);
    }

    const historyItemId = elResponse.headers.get("history-item-id");
    const audioUrl = historyItemId
      ? `https://api.elevenlabs.io/v1/history/${historyItemId}/audio`
      : null;

    console.log("Audio generated, history item:", historyItemId);

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
    const briefId = bubbleData?.response?.brief_id;
    const briefUrl = briefId ? `${brief_page_base_url}${briefId}` : brief_page_base_url;

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
      brief_id: briefId,
      brief_url: briefUrl,
      audio_url: audioUrl,
      week_end: weekEnd.toISOString().split("T")[0],
      sms_sent_to: user_phone,
    });

  } catch (err) {
    console.error("generate-weekly-brief error:", err);
    return res.status(500).json({ error: err.message });
  }
}
