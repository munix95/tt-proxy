export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { query, page = 1, pagesize = 6 } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Missing query' });

  try {
    const body = new URLSearchParams({ query, page, pagesize }).toString();
    const response = await fetch('https://www.mytischtennis.de/api/search/clubs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
        'Origin': 'https://www.mytischtennis.de',
        'Referer': 'https://www.mytischtennis.de/',
      },
      body,
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
}
