// api/cron-weekly-brief.js
// Vercel cron — fires Sunday 23:00 UTC = Monday 9am AEST / 10am AEDT
// Fetches each user's connections from Bubble at runtime, then triggers generate-weekly-brief

const BUBBLE_BASE_URL = "https://teloskope.bubbleapps.io/version-test/api/1.1";
const BUBBLE_API_KEY = process.env.BUBBLE_API_KEY;
const BASE_URL = "https://teloskope-middleware.vercel.app";

// ─── BETA USER ROSTER ─────────────────────────────────────────────────────────
// Add new beta users here. bubble_user_id drives all token lookups from Bubble.
// shopify_access_token can stay as env var OR be fetched from Bubble — both supported.

const BETA_USERS = [
  {
    bubble_user_id: "1768986756705x584281561342647000",
    user_name: "Alex",
    user_phone: "+61403924309",
    store_name: "Alex and Trahanas",
    brief_page_base_url: "https://teloskope.bubbleapps.io/version-test/brief/",
  },
];

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify this is a legitimate Vercel cron call
  const authHeader = req.headers["authorization"];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("Cron started — fetching user connections from Bubble...");

  const results = [];

  for (const user of BETA_USERS) {
    try {
      console.log(`Processing ${user.user_name}...`);

      // ── Fetch User record from Bubble ──────────────────────────────────────
      const userRecord = await fetchBubbleRecord("user", user.bubble_user_id);
      if (!userRecord) throw new Error(`User record not found in Bubble: ${user.bubble_user_id}`);

      const user_phone = userRecord.mobile_number || user.user_phone;

      // ── Fetch Shopify Connection ───────────────────────────────────────────
      const shopifyConnectionId = userRecord.shopify_connection;
      if (!shopifyConnectionId) throw new Error("No Shopify connection on user record");

      const shopifyConn = await fetchBubbleRecord("shopify_connection", shopifyConnectionId);
      if (!shopifyConn) throw new Error("Shopify connection record not found");

      const shopify_shop_domain = shopifyConn.shopify_shop_domain;
      const shopify_access_token = shopifyConn.shopify_access_token;

      // ── Fetch Lightspeed Connection (optional) ─────────────────────────────
      let lightspeed_access_token = null;
      let lightspeed_refresh_token = null;
      let lightspeed_domain_prefix = null;
      let lightspeed_connection_id = null;

      const lightspeedConnectionId = userRecord.lightspeed_connection;
      if (lightspeedConnectionId) {
        const lsConn = await fetchBubbleRecord("lightspeed_connection", lightspeedConnectionId);
        if (lsConn) {
          lightspeed_access_token  = lsConn.lightspeed_access_token;
          lightspeed_refresh_token = lsConn.lightspeed_refresh_token;
          lightspeed_domain_prefix = lsConn.lightspeed_domain_prefix;
          lightspeed_connection_id = lightspeedConnectionId;
        }
      }

      // ── Fetch Xero Connection (optional) ──────────────────────────────────
      let xero_access_token = null;
      let xero_refresh_token = null;
      let xero_tenant_id = null;
      let xero_connection_id = null;

      const xeroConnectionId = userRecord.xero_connection;
      if (xeroConnectionId) {
        const xeroConn = await fetchBubbleRecord("xero_connection", xeroConnectionId);
        if (xeroConn && xeroConn.xero_connected === "yes") {
          xero_access_token  = xeroConn.xero_access_token;
          xero_refresh_token = xeroConn.xero_refresh_token;
          xero_tenant_id     = xeroConn.xero_tenant_id;
          xero_connection_id = xeroConnectionId;
        }
      }

      // ── Call generate-weekly-brief ─────────────────────────────────────────
      const payload = {
        // Shopify
        shopify_shop_domain,
        shopify_access_token,
        // Lightspeed (omitted if not connected)
        ...(lightspeed_access_token && {
          lightspeed_access_token,
          lightspeed_refresh_token,
          lightspeed_domain_prefix,
          lightspeed_connection_id,
        }),
        // Xero (omitted if not connected)
        ...(xero_access_token && {
          xero_access_token,
          xero_refresh_token,
          xero_tenant_id,
          xero_connection_id,
        }),
        // User / delivery
        bubble_secret_key: process.env.BUBBLE_SECRET_KEY,
        user_id: user.bubble_user_id,
        user_name: user.user_name,
        user_phone,
        store_name: user.store_name,
        brief_page_base_url: user.brief_page_base_url,
      };

      const response = await fetch(`${BASE_URL}/api/generate-weekly-brief`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      results.push({ user: user.user_name, success: response.ok, data });
      console.log(`Brief for ${user.user_name}:`, response.ok ? "✅ success" : "❌ failed", data);

    } catch (err) {
      console.error(`Error for ${user.user_name}:`, err.message);
      results.push({ user: user.user_name, success: false, error: err.message });
    }
  }

  return res.status(200).json({ results });
}

// ─── BUBBLE DATA API HELPER ───────────────────────────────────────────────────
// Fetches a single record from Bubble's Data API by type + ID

async function fetchBubbleRecord(type, id) {
  const url = `${BUBBLE_BASE_URL}/obj/${type}/${id}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${BUBBLE_API_KEY}` },
  });
  if (!r.ok) {
    console.error(`Bubble fetch failed for ${type}/${id}: ${r.status}`);
    return null;
  }
  const data = await r.json();
  return data.response || null;
}
