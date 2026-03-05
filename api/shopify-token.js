export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { shop, code } = req.body;

  if (!shop || !code) {
    return res.status(400).json({ error: 'Missing shop or code' });
  }

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: '89af44ea52b1c6d270f542638d21a8a0',
      client_secret: '32364f4ed380a1b99b7b2efbd4c3a03d',
      code
    })
  });

const data = await response.json();
  return res.status(200).json(data);
}
