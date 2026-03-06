export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code, domain_prefix } = req.body;
  if (!code || !domain_prefix) return res.status(400).json({ error: 'Missing code or domain_prefix' });

  const credentials = Buffer.from('UzALjuIjAcXN4GifhmSKmfzfM0mZN7oF:arqOzZIbLysIYKEXtdqbShocamux1Chu').toString('base64');

  const response = await fetch(`https://${domain_prefix}.retail.lightspeed.app/api/1.0/token`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`
    },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: 'https://teloskope.bubbleapps.io/version-test/api/1.1/wf/lightspeed_oauth_redirect'
    })
  });

  const data = await response.json();
  return res.status(200).json(data);
}
