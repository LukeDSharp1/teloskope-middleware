export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  const response = await fetch('https://cloud.lightspeedapp.com/oauth/access_token.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: 'UzALjuIjAcXN4GifhmSKmfzfM0mZN7oF',
      client_secret: 'arqOzZIbLysIYKEXtdqbShocamux1Chu',
      code,
      grant_type: 'authorization_code'
    })
  });

  const data = await response.json();
  return res.status(200).json(data);
}
