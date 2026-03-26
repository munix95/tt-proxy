const ALLOWED_ORIGINS = [
  'https://project-iw76s.vercel.app',
  'https://fc.great-site.net',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'null', // file:// local files — browsers send Origin: null for these
];

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
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
