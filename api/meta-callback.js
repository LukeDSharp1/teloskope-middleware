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
    console.error("Missing code or state:", { code: !!code, state: !!state });
    return res.redirect(BUBBLE_REDIRECT_ERROR);
  }

  let bubble_user_id;
  try {
    const parsed = JSON.parse(decodeURIComponent(state));
    bubble_user_id = parsed.bubble_user_id;
    console.log("Parsed bubble_user_id:", bubble_user_id);
  } catch (e) {
    console.error("Failed to parse state:", e);
    return res.redirect(BUBBLE_REDIRECT_ERROR);
  }

  const META_APP_ID = process.env.META_APP_ID;
  const META_APP_SECRET = process.env.META_APP_SECRET;

  try {
    // ── Step 1: Exchange code for short-lived access token ──────────────────
    console.log("Step 1: Exchanging Meta auth code for short-lived token...");
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token` +
      `?client_id=${META_APP_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&client_secret=${META_APP_SECRET}` +
      `&code=${code}`
    );

    const tokenRaw = await tokenRes.text();
    console.log("Token exchange response status:", tokenRes.status);
    console.log("Token exchange response body:", tokenRaw);

    if (!tokenRes.ok) {
      console.error("Token exchange failed");
      return res.redirect(BUBBLE_REDIRECT_ERROR);
    }

    const tokenData = JSON.parse(tokenRaw);
    const shortLivedToken = tokenData.access_token;
    console.log("Short-lived token obtained");

    // ── Step 2: Exchange for long-lived token (60 days) ─────────────────────
    console.log("Step 2: Exchanging for long-lived token...");
    const longTokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${META_APP_ID}` +
      `&client_secret=${META_APP_SECRET}` +
      `&fb_exchange_token=${shortLivedToken}`
    );

    const longTokenRaw = await longTokenRes.text();
    console.log("Long token exchange status:", longTokenRes.status);

    if (!longTokenRes.ok) {
      console.error("Long-lived token exchange failed:", longTokenRaw);
      return res.redirect(BUBBLE_REDIRECT_ERROR);
    }

    const longTokenData = JSON.parse(longTokenRaw);
    const accessToken = longTokenData.access_token;
    const expiresIn = longTokenData.expires_in || 5184000;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    console.log("Long-lived token obtained, expires:", expiresAt);

    // ── Step 3: Get Meta user ID ─────────────────────────────────────────────
    console.log("Step 3: Fetching Meta user ID...");
    const meRes = await fetch(
      `https://graph.facebook.com/v19.0/me?access_token=${accessToken}`
    );
    const meData = await meRes.json();
    console.log("Me response:", JSON.stringify(meData));
    const metaUserId = meData.id;

    // ── Step 4: Discover ad accounts (non-fatal) ────────────────────────────
    console.log("Step 4: Fetching ad accounts...");
    let adAccountId = "";
    let adAccountName = "";
    let allAdAccountsJson = "[]";

    try {
      const adAccountsRes = await fetch(
        `https://graph.facebook.com/v19.0/me/adaccounts` +
        `?fields=id,name,currency,account_status` +
        `&access_token=${accessToken}`
      );
      const adAccountsData = await adAccountsRes.json();
      console.log("Ad accounts response:", JSON.stringify(adAccountsData));

      const adAccounts = adAccountsData.data || [];
      console.log("Ad accounts found:", adAccounts.length);

      const activeAccount = adAccounts.find(a => a.account_status === 1) || adAccounts[0] || null;
      if (activeAccount) {
        adAccountId = activeAccount.id;
        adAccountName = activeAccount.name;
        console.log("Using ad account:", adAccountId, adAccountName);
      } else {
        console.warn("No ad accounts found — continuing without ad account");
      }
      allAdAccountsJson = JSON.stringify(adAccounts);
    } catch (e) {
      console.warn("Ad account fetch failed (non-fatal):", e.message);
    }

    // ── Step 5: Save to Bubble ───────────────────────────────────────────────
    console.log("Step 5: Saving Meta connection to Bubble...");

    // Check if connection already exists for this user
    const searchRes = await fetch(
      `${BUBBLE_BASE_URL}/obj/meta_connection?constraints=${encodeURIComponent(
        JSON.stringify([{ key: "user_id", constraint_type: "equals", value: bubble_user_id }])
      )}`,
      {
        headers: { Authorization: `Bearer ${process.env.BUBBLE_API_KEY}` },
      }
    );
    const searchData = await searchRes.json();
    console.log("Bubble search response:", JSON.stringify(searchData));
    const existingConnection = searchData?.response?.results?.[0];

    const connectionPayload = {
      user_id: bubble_user_id,
      meta_access_token: accessToken,
      meta_user_id: metaUserId,
      meta_ad_account_id: adAccountId,
      meta_ad_account_name: adAccountName,
      meta_connected: "yes",
      token_expires_at: expiresAt,
      all_ad_accounts_json: allAdAccountsJson,
    };

    if (existingConnection) {
      console.log("Updating existing connection:", existingConnection._id);
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
      console.log("Bubble update status:", updateRes.status);
      console.log("Bubble update response:", await updateRes.text());
    } else {
      console.log("Creating new Meta connection...");
      const createRes = await fetch(`${BUBBLE_BASE_URL}/obj/meta_connection`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`,
        },
        body: JSON.stringify(connectionPayload),
      });
      const createStatus = createRes.status;
      const createRaw = await createRes.text();
      console.log("Bubble create status:", createStatus);
      console.log("Bubble create raw response:", createRaw);

      let newConnectionId;
      try {
        const createData = JSON.parse(createRaw);
        newConnectionId = createData?.id;
      } catch (e) {
        console.error("Failed to parse Bubble create response:", e.message);
      }

      console.log("New connection ID:", newConnectionId);

      // ── Step 6: Link connection to user record ─────────────────────────────
      if (newConnectionId) {
        console.log("Step 6: Linking connection to user record...");
        const linkRes = await fetch(`${BUBBLE_BASE_URL}/obj/user/${bubble_user_id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`,
          },
          body: JSON.stringify({ meta_connection: newConnectionId }),
        });
        console.log("User link status:", linkRes.status);
        console.log("User link response:", await linkRes.text());
      } else {
        console.error("No connection ID returned — skipping user link");
      }
    }

    console.log("Meta OAuth flow complete — redirecting to success");
    return res.redirect(BUBBLE_REDIRECT_SUCCESS);

  } catch (err) {
    console.error("Meta callback unhandled error:", err.message);
    console.error(err.stack);
    return res.redirect(BUBBLE_REDIRECT_ERROR);
  }
}
