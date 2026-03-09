// api/generate-weekly-brief.js
// Pulls Shopify + Lightspeed → Claude → ElevenLabs → posts finished brief to Bubble → Twilio SMS

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
    // Shopify
    shopify_shop_domain,
    shopify_access_token,
    // Lightspeed
    lightspeed_access_token,
    lightspeed_business_id,
    // Bubble
    bubble_secret_key,
    user_id,
    // User details
    user_name,        // e.g. "Alex"
    user_phone,       // e.g. "+61412345678"
    store_name,       // e.g. "Alex and Trahanas"
    brief_page_base_url, // e.g. "https://teloskope.bubbleapps.io/version-test/brief/"
  } = req.body;

  if (!shopify_shop_domain || !shopify_access_token || !lightspeed_access_token || !bubble_secret_key || !user_id || !user_phone) {
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

    // Current week Mon–Sun
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - daysFromMonday);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    // Prior comparable week (same Mon–Sun, last year)
    const pcwStart = new Date(weekStart);
    pcwStart.setFullYear(pcwStart.getFullYear() - 1);
    const pcwEnd = new Date(weekEnd);
    pcwEnd.setFullYear(pcwEnd.getFullYear() - 1);

    // MTD
    const mtdStart = new Date(now.getFullYear(), now.getMonth(), 1);
    mtdStart.setHours(0, 0, 0, 0);
    const mtdEnd = new Date(now);
    mtdEnd.setHours(23, 59, 59, 999);

    // LY MTD
    const lyMtdStart = new Date(mtdStart);
    lyMtdStart.setFullYear(lyMtdStart.getFullYear() - 1);
    const lyMtdEnd = new Date(mtdEnd);
    lyMtdEnd.setFullYear(lyMtdEnd.getFullYear() - 1);

    // YTD
    const ytdStart = new Date(now.getFullYear(), 0, 1);
    ytdStart.setHours(0, 0, 0, 0);

    // LY YTD
    const lyYtdStart = new Date(ytdStart);
    lyYtdStart.setFullYear(lyYtdStart.getFullYear() - 1);
    const lyYtdEnd = new Date(now);
    lyYtdEnd.setFullYear(lyYtdEnd.getFullYear() - 1);
    lyYtdEnd.setHours(23, 59, 59, 999);

    const fmt = (d) => d.toISOString();

    // ─── SHOPIFY HELPERS ─────────────────────────────────────────────────────

    const fetchAllShopifyOrders = async (start, end, fields = "total_price,created_at") => {
      let orders = [];
      let url = `https://${shopify_shop_domain}/admin/api/2024-01/orders.json?status=any&financial_status=paid&created_at_min=${fmt(start)}&created_at_max=${fmt(end)}&fields=${fields}&limit=250`;
      while (url) {
        const r = await fetch(url, {
          headers: { "X-Shopify-Access-Token": shopify_access_token },
        });
        if (!r.ok) throw new Error(`Shopify error ${r.status}`);
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

    // ─── LIGHTSPEED HELPERS ──────────────────────────────────────────────────

    const fetchLightspeedSales = async (start, end) => {
      // Lightspeed X-Series sales endpoint
      const url = `https://api.lightspeedhq.com/retail/2.0/${lightspeed_business_id}/sales?created_at_min=${fmt(start)}&created_at_max=${fmt(end)}&limit=250`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${lightspeed_access_token}` },
      });
      if (!r.ok) throw new Error(`Lightspeed error ${r.status}`);
      const data = await r.json();
      return data.data || [];
    };

    const sumLSSales = (sales) =>
      sales.reduce((s, sale) => s + parseFloat(sale.total_price || 0), 0);

    // ─── PARALLEL DATA FETCH ─────────────────────────────────────────────────

    console.log("Fetching all data sources in parallel...");

    const [
      shopifyWeekOrders,
      shopifyPcwOrders,
      shopifyMtdOrders,
      shopifyLyMtdOrders,
      shopifyYtdOrders,
      shopifyLyYtdOrders,
      shopifyWeekOrdersForProducts,
      lsWeekSales,
      lsPcwSales,
      lsMtdSales,
      lsLyMtdSales,
    ] = await Promise.all([
      fetchAllShopifyOrders(weekStart, weekEnd),
      fetchAllShopifyOrders(pcwStart, pcwEnd),
      fetchAllShopifyOrders(mtdStart, mtdEnd, "total_price,created_at,customer"),
      fetchAllShopifyOrders(lyMtdStart, lyMtdEnd, "total_price,created_at,customer"),
      fetchAllShopifyOrders(ytdStart, mtdEnd),
      fetchAllShopifyOrders(lyYtdStart, lyYtdEnd),
      fetchAllShopifyOrders(weekStart, weekEnd, "line_items"),
      fetchLightspeedSales(weekStart, weekEnd),
      fetchLightspeedSales(pcwStart, pcwEnd),
      fetchLightspeedSales(mtdStart, mtdEnd),
      fetchLightspeedSales(lyMtdStart, lyMtdEnd),
    ]);

    // ─── SHOPIFY CALCULATIONS ────────────────────────────────────────────────

    const shopifyWeekRev = sumRevenue(shopifyWeekOrders);
    const shopifyPcwRev = sumRevenue(shopifyPcwOrders);
    const shopifyMtdRev = sumRevenue(shopifyMtdOrders);
    const shopifyLyMtdRev = sumRevenue(shopifyLyMtdOrders);
    const shopifyYtdRev = sumRevenue(shopifyYtdOrders);
    const shopifyLyYtdRev = sumRevenue(shopifyLyYtdOrders);
    const shopifyWeekTx = shopifyWeekOrders.length;
    const shopifyMtdTx = shopifyMtdOrders.length;
    const shopifyLyMtdTx = shopifyLyMtdOrders.length;
    const shopifyWeekAov = calcAov(shopifyWeekOrders);
    const shopifyPcwAov = calcAov(shopifyPcwOrders);
    const { newC: newMtd, returning: returningMtd } = countNewReturning(shopifyMtdOrders);
    const { newC: newLyMtd, returning: returningLyMtd } = countNewReturning(shopifyLyMtdOrders);

    // Top 5 products
    const productMap = {};
    for (const order of shopifyWeekOrdersForProducts) {
      for (const item of order.line_items || []) {
        const key = item.product_id;
        if (!productMap[key]) productMap[key] = { title: item.title, quantity: 0 };
        productMap[key].quantity += item.quantity;
      }
    }
    const topProducts = Object.values(productMap)
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);

    // ─── LIGHTSPEED CALCULATIONS ─────────────────────────────────────────────

    const lsWeekRev = sumLSSales(lsWeekSales);
    const lsPcwRev = sumLSSales(lsPcwSales);
    const lsMtdRev = sumLSSales(lsMtdSales);
    const lsLyMtdRev = sumLSSales(lsLyMtdSales);
    const lsWeekTx = lsWeekSales.length;
    const lsMtdTx = lsMtdSales.length;
    const lsWeekAov = lsWeekTx > 0 ? lsWeekRev / lsWeekTx : 0;

    // ─── COMBINED TOTALS ─────────────────────────────────────────────────────

    const totalWeekRev = shopifyWeekRev + lsWeekRev;
    const totalPcwRev = shopifyPcwRev + lsPcwRev;
    const totalMtdRev = shopifyMtdRev + lsMtdRev;
    const totalLyMtdRev = shopifyLyMtdRev + lsLyMtdRev;
    const totalWeekTx = shopifyWeekTx + lsWeekTx;
    const totalMtdTx = shopifyMtdTx + lsMtdTx;
    const totalWeekAov = totalWeekTx > 0 ? totalWeekRev / totalWeekTx : 0;

    const pct = (a, b) => b > 0 ? (((a - b) / b) * 100).toFixed(1) : "N/A";
    const fmt$ = (n) => `$${Math.round(n).toLocaleString()}`;

    const weekLabel = `week ending ${weekEnd.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}`;
    const monthLabel = now.toLocaleDateString("en-AU", { month: "long", year: "numeric" });

    // ─── CLAUDE PROMPT ───────────────────────────────────────────────────────

    const dataBlock = `
STORE: ${store_name}
PERIOD: ${weekLabel}

COMBINED (Online + In-Store):
- This week revenue: ${fmt$(totalWeekRev)} vs same week last year: ${fmt$(totalPcwRev)} (${pct(totalWeekRev, totalPcwRev)}%)
- MTD revenue (${monthLabel}): ${fmt$(totalMtdRev)} vs LY MTD: ${fmt$(totalLyMtdRev)} (${pct(totalMtdRev, totalLyMtdRev)}%)
- This week transactions: ${totalWeekTx} vs same week LY: ${shopifyPcwOrders.length + lsPcwSales.length}
- MTD transactions: ${totalMtdTx} vs LY MTD: ${shopifyLyMtdTx + lsLyMtdSales.length}
- This week AOV: ${fmt$(totalWeekAov)}

ONLINE ONLY (Shopify):
- This week revenue: ${fmt$(shopifyWeekRev)} vs LY: ${fmt$(shopifyPcwRev)} (${pct(shopifyWeekRev, shopifyPcwRev)}%)
- MTD revenue: ${fmt$(shopifyMtdRev)} vs LY MTD: ${fmt$(shopifyLyMtdRev)} (${pct(shopifyMtdRev, shopifyLyMtdRev)}%)
- YTD revenue: ${fmt$(shopifyYtdRev)} vs LY YTD: ${fmt$(shopifyLyYtdRev)} (${pct(shopifyYtdRev, shopifyLyYtdRev)}%)
- This week AOV: ${fmt$(shopifyWeekAov)} vs LY: ${fmt$(shopifyPcwAov)}
- New customers MTD: ${newMtd}, Returning: ${returningMtd}
- LY new customers MTD: ${newLyMtd}, LY returning: ${returningLyMtd}
- Top 5 products this week: ${topProducts.map(p => `${p.title} (${p.quantity} units)`).join(", ")}

IN-STORE ONLY (Lightspeed):
- This week revenue: ${fmt$(lsWeekRev)} vs LY: ${fmt$(lsPcwRev)} (${pct(lsWeekRev, lsPcwRev)}%)
- MTD revenue: ${fmt$(lsMtdRev)} vs LY MTD: ${fmt$(lsLyMtdRev)} (${pct(lsMtdRev, lsLyMtdRev)}%)
- This week transactions: ${lsWeekTx}, AOV: ${fmt$(lsWeekAov)}
`;

    const systemPrompt = `You are Teloskope, a smart weekly business advisor for independent retail store owners. 
Your job is to write a warm, direct, insightful weekly brief that a store owner can listen to on a Monday morning.
Write in a conversational Australian tone — like a trusted business advisor, not a corporate report.
Be specific with numbers. Be honest about what looks good and what needs watching.
Never use bullet points or headers in your response — write in flowing paragraphs only.
The brief should take about 90 seconds to read aloud.
End with exactly 3 "Options to Explore" — short, specific, actionable ideas based on the data.`;

    const userPrompt = `Here is the sales data for ${store_name} for the ${weekLabel}.

${dataBlock}

Write the weekly Teloskope brief. Include:
1. An opening sentence naming the week and giving the headline number
2. A paragraph on revenue — this week vs last year, MTD, and what the trend suggests
3. A paragraph on transactions and AOV — what the volume and basket size tells us
4. A paragraph on online new vs returning customers — what it means for the business
5. The top selling products this week and what that tells us
6. Exactly 3 Options to Explore — label them clearly as "Option 1:", "Option 2:", "Option 3:"`;

    console.log("Calling Claude...");
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: userPrompt }],
      system: systemPrompt,
    });

    const briefText = claudeResponse.content[0].text;
    console.log("Claude brief generated, length:", briefText.length);

    // ─── ELEVENLABS ──────────────────────────────────────────────────────────

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
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!elResponse.ok) {
      const elError = await elResponse.text();
      throw new Error(`ElevenLabs error ${elResponse.status}: ${elError}`);
    }

    // ElevenLabs returns audio binary — we need to store it somewhere
    // For now we'll use ElevenLabs history URL after the call
    // Get the history item ID from the response header
    const historyItemId = elResponse.headers.get("history-item-id");
    const audioUrl = historyItemId
      ? `https://api.elevenlabs.io/v1/history/${historyItemId}/audio`
      : null;

    console.log("ElevenLabs audio generated, history item:", historyItemId);

    // ─── POST BRIEF TO BUBBLE ─────────────────────────────────────────────────

    console.log("Posting brief to Bubble...");
    const bubblePayload = {
      secret_key: bubble_secret_key,
      user_id,
      brief_text: briefText,
      audio_url: audioUrl,
      week_end_date: weekEnd.toISOString(),
      // Raw numbers for display
      total_week_revenue: Math.round(totalWeekRev * 100) / 100,
      total_pcw_revenue: Math.round(totalPcwRev * 100) / 100,
      total_mtd_revenue: Math.round(totalMtdRev * 100) / 100,
      total_ly_mtd_revenue: Math.round(totalLyMtdRev * 100) / 100,
      shopify_ytd_revenue: Math.round(shopifyYtdRev * 100) / 100,
      shopify_ly_ytd_revenue: Math.round(shopifyLyYtdRev * 100) / 100,
      total_week_transactions: totalWeekTx,
      total_mtd_transactions: totalMtdTx,
      total_week_aov: Math.round(totalWeekAov * 100) / 100,
      new_customers_mtd: newMtd,
      returning_customers_mtd: returningMtd,
      top_products_json: JSON.stringify(topProducts),
    };

    const bubbleResponse = await fetch(
      `${BUBBLE_BASE_URL}/wf/ingest_weekly_brief`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bubblePayload),
      }
    );

    if (!bubbleResponse.ok) {
      const bubbleError = await bubbleResponse.text();
      throw new Error(`Bubble ingest failed: ${bubbleResponse.status} — ${bubbleError}`);
    }

    const bubbleData = await bubbleResponse.json();
    const briefId = bubbleData?.response?.brief_id;
    const briefUrl = briefId
      ? `${brief_page_base_url}${briefId}`
      : brief_page_base_url;

    // ─── TWILIO SMS ───────────────────────────────────────────────────────────

    console.log("Sending SMS via Twilio...");
    const smsBody = `Good morning ${user_name}! Your Teloskope Weekly Brief for ${weekLabel} is ready. Listen here: ${briefUrl}`;

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
      const twilioError = await twilioResponse.text();
      throw new Error(`Twilio error ${twilioResponse.status}: ${twilioError}`);
    }

    console.log("SMS sent successfully");

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
