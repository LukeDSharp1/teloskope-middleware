// api/meta-auth.js
// Redirects user to Meta OAuth consent screen
// Called from Bubble Settings page "Meta: Connect" button

export default function handler(req, res) {
  const { bubble_user_id } = req.query;

  if (!bubble_user_id) {
    return res.status(400).json({ error: "Missing bubble_user_id" });
  }

  const META_APP_ID = process.env.META_APP_ID;
  const REDIRECT_URI = "https://teloskope-middleware.vercel.app/api/meta-callback";

  // Scopes needed:
  // ads_read — read ad performance data
  // ads_management — read ad account info
  // business_management — discover ad accounts
  const scopes = [
    "ads_read",
    "ads_management",
    "business_management",
  ].join(",");

  // State carries the bubble_user_id so we know who to save tokens for after callback
  const state = encodeURIComponent(JSON.stringify({ bubble_user_id }));

  const authUrl =
    `https://www.facebook.com/v19.0/dialog/oauth` +
    `?client_id=${META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${scopes}` +
    `&state=${state}` +
    `&response_type=code`;

  return res.redirect(authUrl);
}
