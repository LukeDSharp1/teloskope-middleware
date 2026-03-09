// api/cron-weekly-brief.js
// Vercel cron job — runs every Monday 8:50am AEST (Sunday 21:50 UTC)
// V1 beta: Shopify only. Add more users here as beta grows.

const BETA_USERS = [
  {
    user_id: "1768986756705x584281561342647000",
    user_name: "Alex",
    user_phone: "+61403924309",
    store_name: "Alex and Trahanas",
    shopify_shop_domain: "aleks-studio.myshopify.com",
    shopify_access_token: process.env.ALEX_SHOPIFY_ACCESS_TOKEN,
  },
];

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify this is coming from Vercel cron
  const authHeader = req.headers["authorization"];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const results = [];
  const baseUrl = "https://teloskope-middleware.vercel.app";

  for (const user of BETA_USERS) {
    try {
      console.log(`Triggering brief for ${user.user_name}...`);

      const response = await fetch(`${baseUrl}/api/generate-weekly-brief`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopify_shop_domain: user.shopify_shop_domain,
          shopify_access_token: user.shopify_access_token,
          bubble_secret_key: process.env.BUBBLE_SECRET_KEY,
          user_id: user.user_id,
          user_name: user.user_name,
          user_phone: user.user_phone,
          store_name: user.store_name,
          brief_page_base_url: "https://teloskope.bubbleapps.io/version-test/brief/",
        }),
      });

      const data = await response.json();
      results.push({ user: user.user_name, success: response.ok, data });
      console.log(`Brief for ${user.user_name}:`, data);

    } catch (err) {
      console.error(`Error for ${user.user_name}:`, err.message);
      results.push({ user: user.user_name, success: false, error: err.message });
    }
  }

  return res.status(200).json({ results });
}
