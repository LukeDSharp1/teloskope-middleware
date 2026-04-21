// api/meta-callback.js
// Meta OAuth callback — receives auth code, exchanges for tokens,
// discovers the user's primary ad account, saves everything to Bubble

const BUBBLE_BASE_URL = "https://teloskope.bubbleapps.io/version-test/api/1.1";
const REDIRECT_URI = "https://teloskope-middleware.vercel.app/api/meta-callback";
const BUBBLE_REDIRECT_SUCCESS = "https://teloskope.bubbleapps.io/version-test/settings?meta=connected";
const BUBBLE_REDIRECT_ERROR = "https://teloskope.bubbleapps.io/version-test/settings?meta=error";

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    console.error("Meta OAuth error:", error);
    return res.redirect(BUBBLE_REDIRECT_ERROR);
  }

  if (!code || !state) {
    return res.redirect(BUBBLE_REDIRECT_ERROR);
  }

  let bubble_user_id;
  try {
    const parsed = JSON.parse(decodeURIComponent(state));
    bubble_user_id = parsed.bubble_user_id;
  } catch (e) {
    console.error("Failed to parse state:", e);
    return res.redirect(BUBBLE_REDIRECT_ERROR);
  }

  const META_APP_ID = process.env.META_APP_ID;
  const META_APP_SECRET = process.env.META_APP_SECRET;

  try {
    // ── Step 1: Exchange code for short-lived access token ──────────────────
    console.log("Exchanging Meta auth code for token...");
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token` +
      `?client_id=${META_APP_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&client_secret=${META_APP_SECRET}` +
      `&code=${code}`
    );

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("Token exchange failed:", err);
      return res.redirect(BUBBLE_REDIRECT_ERROR);
    }

    const tokenData = await tokenRes.json();
    const shortLivedToken = tokenData.access_token;
    console.log("Short-lived token obtained");

    // ── Step 2: Exchange for long-lived token (60 days) ─────────────────────
    console.log("Exchanging for long-lived token...");
    const longTokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${META_APP_ID}` +
      `&client_secret=${META_APP_SECRET}` +
      `&fb_exchange_token=${shortLivedToken}`
    );

    if (!longTokenRes.ok) {
      const err = await longTokenRes.text();
      console.error("Long-lived token exchange failed:", err);
      return res.redirect(BUBBLE_REDIRECT_ERROR);
    }

    const longTokenData = await longTokenRes.json();
    const accessToken = longTokenData.access_token;
    const expiresIn = longTokenData.expires_in || 5184000; // 60 days default
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    console.log("Long-lived token obtained, expires:", expiresAt);

    // ── Step 3: Get user's Meta user ID ─────────────────────────────────────
    const meRes = await fetch(
      `https://graph.facebook.com/v19.0/me?access_token=${accessToken}`
    );
    const meData = await meRes.json();
    const metaUserId = meData.id;
    console.log("Meta user ID:", metaUserId);

    // ── Step 4: Discover ad accounts ────────────────────────────────────────
    console.log("Fetching ad accounts...");
    const adAccountsRes = await fetch(
      `https://graph.facebook.com/v19.0/me/adaccounts` +
      `?fields=id,name,currency,account_status` +
      `&access_token=${accessToken}`
    );

    if (!adAccountsRes.ok) {
      console.error("Failed to fetch ad accounts:", await adAccountsRes.text());
      return res.redirect(BUBBLE_REDIRECT_ERROR);
    }

    const adAccountsData = await adAccountsRes.json();
    const adAccounts = adAccountsData.data || [];
    console.log("Ad accounts found:", adAccounts.length);

    // Use the first active ad account
    const activeAccount = adAccounts.find(a => a.account_status === 1) || adAccounts[0];
    if (!activeAccount) {
      console.error("No ad accounts found for this user");
      return res.redirect(BUBBLE_REDIRECT_ERROR);
    }

    const adAccountId = activeAccount.id; // format: act_XXXXXXXXX
    console.log("Using ad account:", adAccountId, activeAccount.name);

    // ── Step 5: Save to Bubble ───────────────────────────────────────────────
    // First check if a meta_connection already exists for this user
    console.log("Saving Meta connection to Bubble...");

    const searchRes = await fetch(
      `${BUBBLE_BASE_URL}/obj/meta_connection?constraints=${encodeURIComponent(
        JSON.stringify([{ key: "user_id", constraint_type: "equals", value: bubble_user_id }])
      )}`,
      {
        headers: { Authorization: `Bearer ${process.env.BUBBLE_API_KEY}` },
      }
    );

    const searchData = await searchRes.json();
    const existingConnection = searchData?.response?.results?.[0];

    const connectionPayload = {
      user_id: bubble_user_id,
      meta_access_token: accessToken,
      meta_user_id: metaUserId,
      meta_ad_account_id: adAccountId,
      meta_ad_account_name: activeAccount.name,
      meta_connected: "yes",
      token_expires_at: expiresAt,
      all_ad_accounts_json: JSON.stringify(adAccounts),
    };

    if (existingConnection) {
      // Update existing connection
      const updateRes = await fetch(
        `${BUBBLE_BASE_URL}/obj/meta_connection/${existingConnection._id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`,
          },
          body: JSON.stringify(connectionPayload),
        }
      );
      console.log("Updated existing Meta connection:", updateRes.status);
    } else {
      // Create new connection
      const createRes = await fetch(`${BUBBLE_BASE_URL}/obj/meta_connection`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`,
        },
        body: JSON.stringify(connectionPayload),
      });
      const createData = await createRes.json();
      const newConnectionId = createData?.id;
      console.log("Created new Meta connection:", newConnectionId);

      // Link connection to user record
      if (newConnectionId) {
        await fetch(`${BUBBLE_BASE_URL}/obj/user/${bubble_user_id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`,
          },
          body: JSON.stringify({ meta_connection: newConnectionId }),
        });
        console.log("Linked Meta connection to user record");
      }
    }

    return res.redirect(BUBBLE_REDIRECT_SUCCESS);

  } catch (err) {
    console.error("Meta callback error:", err.message);
    return res.redirect(BUBBLE_REDIRECT_ERROR);
  }
}
