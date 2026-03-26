// Vercel serverless function: fetch, parse, and return structured Spielplan data.
// Replaces the client-side HTML parsing + holiday fetching from spielplan-new.html.

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  const allowedHosts = ['www.mytischtennis.de', 'bttv.click-tt.de', 'click-tt.de'];
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const hostname = parsedUrl.hostname;
  if (!allowedHosts.some(h => hostname === h || hostname.endsWith('.' + h))) {
    return res.status(403).json({ error: 'URL not allowed' });
  }

  try {
    // 1. Fetch the Spielplan page HTML
    const html = await fetchHtml(url);

    // 2. Parse club info from URL
    const clubInfo = extractClubInfoFromUrl(url);

    // 3. Extract structured game data from the page
    let games = extractGamesFromHtmlTable(html, clubInfo);
    const rawSpielplanData = extractRawSpielplanData(html);
    if (games.length && rawSpielplanData) {
      enrichGamesWithLocation(games, rawSpielplanData);
    }
    if (!games.length) {
      const loaderData = extractLoaderData(html);
      games = extractGamesFromLoaderData(loaderData, clubInfo);
    }
    if (!games.length && rawSpielplanData) {
      const fallbackLoader = { 'routes/fallback/spielplan': { data: rawSpielplanData } };
      games = extractGamesFromLoaderData(fallbackLoader, clubInfo);
    }

    // 4. Pre-compute derived display fields (clubTeamName, colors, spielberichtUrl)
    enrichGamesWithComputedFields(games, clubInfo, url);

    // 5. Extract raw table HTML (with absolutized URLs) for client-side rendering
    const rawTableHtml = extractRawTableHtml(html, url);

    // 6. Fetch holidays and school breaks for the years covered by the games
    const years = getYearsFromGames(games);
    const [bankHolidays, schoolBreaks] = await Promise.all([
      fetchBankHolidays(years),
      fetchSchoolBreaks(years),
    ]);

    // 7. Return structured response
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({
      clubInfo,
      games,
      rawTableHtml,
      bankHolidays,
      schoolBreaks,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Spielplan', details: err.message });
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response.text();
}

// ─── Club / URL helpers ────────────────────────────────────────────────────────

function extractClubInfoFromUrl(url) {
  const match = String(url).match(/\/verein(?:e)?\/(\d+)\/([^/]+)/i);
  if (!match) return { clubId: '', clubName: '' };
  return {
    clubId: String(match[1] || ''),
    clubName: decodeURIComponent(match[2] || '').replace(/_/g, ' '),
  };
}

// ─── Date helpers ──────────────────────────────────────────────────────────────

function parseDateFromIsoOrGerman(value) {
  if (!value) return null;
  const german = String(value).match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (german) {
    let year = parseInt(german[3], 10);
    if (year < 100) year += 2000;
    const d = new Date(year, parseInt(german[2], 10) - 1, parseInt(german[1], 10));
    if (!isNaN(d.getTime())) return d;
  }
  const iso = new Date(value);
  if (!isNaN(iso.getTime())) return iso;
  return null;
}

function getDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getYearsFromGames(games) {
  const now = new Date().getFullYear();
  const years = new Set([now, now + 1]);
  games.forEach(g => { if (g.date) years.add(new Date(g.date).getFullYear()); });
  return Array.from(years);
}

// ─── Team / name helpers ───────────────────────────────────────────────────────

function normalizeTeamName(value) {
  return String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

function isLikelyLeagueCode(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (/^[A-ZÄÖÜ]{2,4}\s?[A-Z]$/i.test(t)) return true;
  if (/^[A-ZÄÖÜ]{1,4}\d{1,2}\s+[A-Z]$/i.test(t)) return true;
  if (/^[A-ZÄÖÜ]{2,5}\s+(?:MJ|U|J)\d{1,2}$/i.test(t)) return true;
  if (/^[A-ZÄÖÜ]{1,4}\d{1,2}\s+(?:MJ|U|J)\d{1,2}$/i.test(t)) return true;
  if (/^(?:[A-ZÄÖÜ][a-zäöüA-ZÄÖÜ]{0,3}\.?\s+)+[A-ZÄÖÜ]{1,4}(?:\s+(?:[A-ZÄÖÜ]{1,2}\d{1,2}|[A-Z]))?$/.test(t)
      && /\./.test(t)
      && !/\b(?:TSV|TTC|SC\s|SV\s|VfB|VfL|FC\s|BC\s|TuS|SpVgg|MTV|DJK|ASV)\b/i.test(t)) return true;
  return false;
}

function isPotentialTeamName(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/^\d+$/.test(t)) return false;
  if (/^\d{1,2}:\d{2}$/.test(t)) return false;
  if (/^\d{1,2}\s*:\s*\d{1,2}$/.test(t)) return false;
  if (/\d{1,2}\.\d{1,2}\.\d{2,4}/.test(t)) return false;
  if (isLikelyLeagueCode(t)) return false;
  if (!/[A-Za-zÄÖÜäöüß]/.test(t)) return false;
  return true;
}

function extractTeamSuffixIndex(teamName) {
  if (!teamName) return 0;
  const m = String(teamName).replace(/\u00A0/g, ' ').trim().match(/(?:\(|\s)([IVXLCDM]+)\)?\s*$/i);
  if (!m || !m[1]) return 0;
  const romanMap = { I:1,II:2,III:3,IV:4,V:5,VI:6,VII:7,VIII:8,IX:9,X:10,XI:11,XII:12,XIII:13,XIV:14,XV:15 };
  return romanMap[m[1].toUpperCase()] ? Math.max(0, romanMap[m[1].toUpperCase()] - 1) : 0;
}

function stripTeamSuffix(teamName) {
  return String(teamName || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s*(?:\(?([IVXLCDM]+|\d+)\)?)[\.\s]*$/i, '')
    .trim();
}

function shiftColorForYouth(color) {
  const m = String(color || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return color;
  const r = parseInt(m[1].slice(0,2), 16);
  const g = parseInt(m[1].slice(2,4), 16);
  const b = parseInt(m[1].slice(4,6), 16);
  const mix = v => Math.round(v + (255 - v) * 0.45);
  const toHex = v => mix(v).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function teamColorForName(teamName, clubInfo) {
  const palette = ['#996600','#000000','#27A914','#ff00ff','#ff0000','blue','#9b59b6','#3498db','#e67e22','#16a085','#e74c3c','#f39c12','#2ecc71','#1abc9c','#34495e','#9c88ff'];
  const baseClub = clubInfo?.clubName || '';
  const ageSuffixMatch = String(teamName || '').match(/\s+((?:MJ|U)\d+|D)$/i);
  let effectiveTeamName = teamName;
  let isYouthTeam = false;
  if (ageSuffixMatch) {
    effectiveTeamName = String(teamName).slice(0, -ageSuffixMatch[0].length).trim();
    isYouthTeam = /^(?:MJ|U)\d+$/i.test(ageSuffixMatch[1]);
  }

  if (baseClub) {
    const map = {};
    map[baseClub] = palette[0];
    const romans = ['II','III','IV','V','VI','VII','VIII','IX','X','XI','XII','XIII','XIV','XV'];
    romans.forEach((r, i) => { if (i + 1 < palette.length) map[`${baseClub} ${r}`] = palette[i + 1]; });

    const norm = s => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
    const tNorm = norm(effectiveTeamName);
    for (const k of Object.keys(map)) {
      if (k.trim() === effectiveTeamName.trim()) {
        return isYouthTeam ? shiftColorForYouth(map[k]) : map[k];
      }
    }
    const stripLegal = s => s.replace(/\s+(?:e\.?\s*v\.?|i\.?\s*g\.?)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
    let best = null, bestLen = 0;
    for (const k of Object.keys(map)) {
      const kn = norm(k);
      const kns = stripLegal(kn);
      if (kn && (tNorm.includes(kn) || tNorm.includes(kns)) && kn.length > bestLen) {
        best = k; bestLen = kn.length;
      }
    }
    if (best) {
      return isYouthTeam ? shiftColorForYouth(map[best]) : map[best];
    }
  }

  const normalizedClub = normalizeTeamName(clubInfo?.clubName || '');
  const normalizedBase = normalizeTeamName(stripTeamSuffix(teamName));
  const normalizedClubStripped = normalizedClub.replace(/\s+(?:e\.?\s*v\.?|i\.?\s*g\.?)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!normalizedClub || !normalizedBase || (!normalizedBase.includes(normalizedClub) && !normalizedBase.includes(normalizedClubStripped))) return null;
  return palette[extractTeamSuffixIndex(teamName) % palette.length];
}

function extractAgeCodeFromLeague(leagueShort) {
  if (!leagueShort) return null;
  const s = String(leagueShort).trim();
  if (/\bE\b/.test(s)) return null;
  if (/\bD\b/.test(s)) return 'D';
  if (/^JOL\b/i.test(s)) return 'U19';
  if (/^JBL\b/i.test(s)) return 'U19';
  const m = s.match(/\b((?:MJ|U)\d+)\b/i);
  if (m) return m[1].toUpperCase();
  return null;
}

// ─── HTML parsing (server-side via regex / string parsing, no DOM) ─────────────

// Minimal HTML-to-text and structure extraction using regex patterns.
// Note: Node.js doesn't have DOMParser, so we use a lightweight approach.

function findFirstMatchingBalancedObject(text, startIndex) {
  if (startIndex < 0 || startIndex >= text.length) return null;
  const firstBrace = text.indexOf('{', startIndex);
  if (firstBrace < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return text.slice(firstBrace, i + 1); }
  }
  return null;
}

function extractScriptContents(html) {
  const scripts = [];
  const re = /<script(?:\s[^>]*)?>([^<]*(?:(?!<\/script>)<[^<]*)*)<\/script>/gis;
  let m;
  while ((m = re.exec(html)) !== null) scripts.push(m[1]);
  return scripts;
}

// Extract the Spielplan <table> HTML and absolutize URLs (server-side, no DOM).
function extractRawTableHtml(html, baseUrl) {
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    const tableHtml = m[0];
    const lower = tableHtml.toLowerCase();
    if (!lower.includes('datum') || !lower.includes('zeit')) continue;

    // Absolutize href and src attributes
    let out = tableHtml
      .replace(/\shref="([^"]+)"/gi, (_, val) => {
        if (/^https?:\/\//i.test(val) || /^mailto:|^#/.test(val)) return ` href="${val}"`;
        try { return ` href="${new URL(val, baseUrl).href}"`; } catch { return ` href="${val}"`; }
      })
      .replace(/\ssrc="([^"]+)"/gi, (_, val) => {
        if (/^https?:\/\//i.test(val)) return ` src="${val}"`;
        try { return ` src="${new URL(val, baseUrl).href}"`; } catch { return ` src="${val}"`; }
      });

    // Add target="_blank" rel="noopener noreferrer" to all anchors
    out = out.replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" ');

    // Remove SVG <use> and <image> elements
    out = out.replace(/<use[^>]*\/?>|<use[^>]*>[\s\S]*?<\/use>/gi, '');
    out = out.replace(/<image[^>]*\/?>|<image[^>]*>[\s\S]*?<\/image>/gi, '');

    return out;
  }
  return null;
}

function extractLoaderData(html) {
  const scripts = extractScriptContents(html);
  for (const content of scripts) {
    if (!content.includes('loaderData') && !content.includes('__remixContext')) continue;
    const markers = ['"loaderData"', 'loaderData:', '__remixContext=', '__remixContext.r('];
    for (const marker of markers) {
      const idx = content.indexOf(marker);
      if (idx < 0) continue;
      const candidateJson = findFirstMatchingBalancedObject(content, idx);
      if (!candidateJson) continue;
      try {
        const parsed = JSON.parse(candidateJson);
        if (parsed?.loaderData) return parsed.loaderData;
        if (parsed?.state?.loaderData) return parsed.state.loaderData;
        if (parsed?.routes) {
          for (const routeVal of Object.values(parsed.routes || {})) {
            if (routeVal?.loaderData) return routeVal.loaderData;
          }
          return parsed;
        }
      } catch { /* continue */ }
    }
  }
  return null;
}

function extractRawSpielplanData(html) {
  const scripts = extractScriptContents(html);
  for (const content of scripts) {
    const lc = content.toLowerCase();
    if (!lc.includes('spielplan') || !lc.includes('"data"')) continue;
    const markerIdx = lc.indexOf('spielplan');
    const dataIdx = content.indexOf('"data"', markerIdx);
    if (dataIdx < 0) continue;
    const objectStart = content.indexOf('{', dataIdx);
    if (objectStart < 0) continue;
    const jsonMap = findFirstMatchingBalancedObject(content, objectStart);
    if (!jsonMap) continue;
    try {
      const parsed = JSON.parse(jsonMap);
      if (Object.keys(parsed || {}).some(k => /^\d{4}-\d{2}-\d{2}$/.test(k))) return parsed;
    } catch { /* continue */ }
  }
  return null;
}

// Extract plain text from an HTML cell (strip tags, collapse whitespace)
function cellText(html) {
  return (html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse the Spielplan HTML table using regex (no DOM required)
function extractGamesFromHtmlTable(html, clubInfo) {
  const games = [];

  // Find a <table> with Datum and Zeit headers
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRe.exec(html)) !== null) {
    const tableHtml = tableMatch[0];
    const headerText = tableHtml.toLowerCase();
    if (!headerText.includes('datum') || !headerText.includes('zeit')) continue;

    // Parse header columns
    const headerRowMatch = tableHtml.match(/<thead[\s\S]*?<\/thead>/i) || tableHtml.match(/<tr[\s\S]*?<\/tr>/i);
    const headerHtml = headerRowMatch ? headerRowMatch[0] : '';
    const thRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    const headers = [];
    let thm;
    while ((thm = thRe.exec(headerHtml)) !== null) headers.push(cellText(thm[1]).toLowerCase());

    const idx = {
      date: headers.findIndex(h => /datum/.test(h)),
      time: headers.findIndex(h => /zeit|uhr|beginn|uhrzeit/.test(h)),
      home: headers.findIndex(h => /heimmannschaft|heim(team)?/.test(h)),
      away: headers.findIndex(h => /gastmannschaft|gast(team)?/.test(h)),
      score: headers.findIndex(h => /spiele|ergebnis|spielstand|resultat/.test(h)),
      league: headers.findIndex(h => /liga|spielklasse|klasse|stufe|gruppen|gruppe/.test(h)),
      location: headers.findIndex(h => /^h$|ort|halle|spielort|location|stadion|austragungsort/.test(h)),
    };

    // Parse tbody rows
    const tbodyMatch = tableHtml.match(/<tbody[\s\S]*?<\/tbody>/i);
    const tbodyHtml = tbodyMatch ? tbodyMatch[0] : tableHtml;
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    const normalizedClub = normalizeTeamName(clubInfo.clubName || '');
    const normalizedClubStripped = normalizedClub.replace(/\s+e\.?\s*v\.?\s*$/i, '').replace(/\s+i\.?\s*g\.?\s*$/i, '').trim();
    const clubCandidates = [...new Set([normalizedClub, normalizedClubStripped].filter(Boolean))];

    while ((rowMatch = rowRe.exec(tbodyHtml)) !== null) {
      const rowHtml = rowMatch[0];
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cm;
      while ((cm = cellRe.exec(rowHtml)) !== null) cells.push(cm[1]);
      if (!cells.length) continue;

      const texts = cells.map(c => cellText(c));

      const dateText = idx.date >= 0 ? (texts[idx.date] || '') : (texts.find(t => /\d{1,2}\.\d{1,2}\.\d{2,4}/.test(t)) || '');
      const date = parseDateFromIsoOrGerman(dateText);
      if (!date) continue;

      const rawTimeText = idx.time >= 0 ? (texts[idx.time] || '') : (texts.find(t => /\d{1,2}:\d{2}/.test(t)) || '');
      const timeMatch = rawTimeText.match(/(\d{1,2}:\d{2})/);
      const formattedTime = timeMatch ? timeMatch[1] : '';

      let homeTeam = '', awayTeam = '';
      if (idx.home >= 0 && idx.away >= 0 && isPotentialTeamName(texts[idx.home]) && isPotentialTeamName(texts[idx.away])) {
        homeTeam = texts[idx.home];
        awayTeam = texts[idx.away];
      }

      // Fallback: extract team names from anchor hrefs in row
      // Also capture homeTeamUrl / awayTeamUrl while we're here
      let homeTeamUrl = '', awayTeamUrl = '';
      if (!homeTeam || !awayTeam || isLikelyLeagueCode(homeTeam) || isLikelyLeagueCode(awayTeam)) {
        const teamLinkRe = /href="([^"]*(?:\/mannschaft\/|\/verein\/)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        const teamLinks = [];
        let tlm;
        while ((tlm = teamLinkRe.exec(rowHtml)) !== null) {
          const name = cellText(tlm[2]);
          if (isPotentialTeamName(name) && !/spielbericht|nudokument/i.test(tlm[1])) teamLinks.push({ url: tlm[1], name });
        }
        if (teamLinks.length >= 2) {
          homeTeam = teamLinks[0].name; homeTeamUrl = teamLinks[0].url;
          awayTeam = teamLinks[1].name; awayTeamUrl = teamLinks[1].url;
        }
      }

      // If team names were already set from headers, still try to pick up URLs
      if (homeTeam && awayTeam && (!homeTeamUrl || !awayTeamUrl)) {
        const teamLinkRe2 = /href="([^"]*(?:\/mannschaft\/|\/verein\/)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        const urlLinks = [];
        let tlm2;
        while ((tlm2 = teamLinkRe2.exec(rowHtml)) !== null) {
          const name = cellText(tlm2[2]);
          if (isPotentialTeamName(name) && !/spielbericht|nudokument/i.test(tlm2[1])) urlLinks.push({ url: tlm2[1], name });
        }
        if (urlLinks.length >= 1 && !homeTeamUrl) homeTeamUrl = urlLinks[0].url;
        if (urlLinks.length >= 2 && !awayTeamUrl) awayTeamUrl = urlLinks[1].url;
      }

      // Fallback: extract team names from -vs- in spielbericht link
      if (!homeTeam || !awayTeam || isLikelyLeagueCode(homeTeam) || isLikelyLeagueCode(awayTeam)) {
        const vsMatch = rowHtml.match(/spielbericht\/[0-9]+\/([^/?#"]+)/i) || rowHtml.match(/nuDokument\/[0-9]+\/([^/?#"]+)/i);
        if (vsMatch) {
          const seg = decodeURIComponent(vsMatch[1]);
          if (/-vs-/i.test(seg)) {
            const parts = seg.split(/-vs-/i);
            const toName = s => String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
            if (parts.length >= 2) { homeTeam = toName(parts[0]); awayTeam = toName(parts[1]); }
          }
        }
      }

      if (!homeTeam || !awayTeam) continue;

      const isHomeClub = clubCandidates.some(c => normalizeTeamName(homeTeam).includes(c));
      const isAwayClub = clubCandidates.some(c => normalizeTeamName(awayTeam).includes(c));

      // Extract score
      let scoreLabel = '', scoreClass = 'empty';
      const scoreText = idx.score >= 0 ? texts[idx.score] : '';
      const scoreMatch = (scoreText || '').match(/^(\d{1,2})\s*:\s*(\d{1,2})$/) || (() => {
        // Fallback: scan all cells but skip time/date cells and clock-time values (HH:MM with 2-digit minute 00-59)
        for (let i = 0; i < texts.length; i++) {
          if (i === idx.time || i === idx.date) continue;
          const t = texts[i];
          // Clock times always have 2-digit minutes (e.g. "18:00", "09:30") — table scores rarely do
          if (/^\d{1,2}:\d{2}$/.test(t)) continue;
          const m = t.match(/^(\d{1,2})\s*:\s*(\d{1,2})$/);
          if (m) return m;
        }
        return null;
      })();
      if (scoreMatch) {
        const won = parseInt(scoreMatch[1], 10), lost = parseInt(scoreMatch[2], 10);
        scoreLabel = `${won}:${lost}`;
        if (won > lost) scoreClass = isHomeClub ? 'win' : 'loss';
        else if (won < lost) scoreClass = isHomeClub ? 'loss' : 'win';
        else scoreClass = 'draw';
      }

      // Extract links
      const pdfLinkMatch = rowHtml.match(/href="([^"]*(?:nuDokument|spielbericht)[^"]*)"/i);
      const pdfUrl = pdfLinkMatch ? pdfLinkMatch[1] : '';
      const spielberichtMatch = rowHtml.match(/href="([^"]*spielbericht[^"]*)"/i);
      const spielberichtUrl = spielberichtMatch ? spielberichtMatch[1] : '';

      // Extract meetingId and leagueId directly from spielbericht URL path
      // Pattern: .../ligen/{league}/gruppe/{leagueId}/spielbericht/{meetingId}/...
      const sbMeetingMatch = spielberichtUrl.match(/\/spielbericht\/(\d+)\//i);
      const sbLeagueMatch = spielberichtUrl.match(/\/gruppe\/(\d+)\//i);
      const extractedMeetingId = sbMeetingMatch ? sbMeetingMatch[1] : '';
      const extractedLeagueId = sbLeagueMatch ? sbLeagueMatch[1] : '';

      const leagueVal = idx.league >= 0 ? (texts[idx.league] || '') :
        (idx.location >= 0 && texts.length > idx.location + 1 ? (texts[idx.location + 1] || '') : '');
      const locationVal = idx.location >= 0 ? (texts[idx.location] || '') : '';

      // Also extract leagueName from spielbericht URL slug (e.g. .../ligen/Kreisliga_A/...)
      const sbLeagueNameMatch = spielberichtUrl.match(/\/ligen\/([^/]+)\//i);
      const extractedLeagueName = sbLeagueNameMatch
        ? decodeURIComponent(sbLeagueNameMatch[1]).replace(/_/g, ' ')
        : '';

      const homeTeamColor = teamColorForName(homeTeam, clubInfo) || '#153b6e';

      games.push({
        date: date.toISOString(),
        key: getDateKey(date),
        formattedDay: dateText,
        formattedTime,
        homeTeam,
        awayTeam,
        isHomeClub,
        isAwayClub,
        scoreLabel,
        scoreClass,
        pdfUrl,
        spielberichtUrl,
        leagueShort: leagueVal,
        leagueName: leagueVal || extractedLeagueName,
        location: locationVal,
        locationRaw: null,
        homeTeamId: '',
        awayTeamId: '',
        meetingId: extractedMeetingId,
        leagueId: extractedLeagueId,
        homeTeamUrl: homeTeamUrl || '',
        awayTeamUrl: awayTeamUrl || '',
        homeTeamColor,
        icon: isHomeClub ? '⌂' : (isAwayClub ? '✈' : '•'),
        opponent: isHomeClub ? awayTeam : (isAwayClub ? homeTeam : `${homeTeam} - ${awayTeam}`),
      });
    }

    if (games.length) break; // found the right table
  }

  games.sort((a, b) => new Date(a.date) - new Date(b.date));
  return games;
}

function extractGamesFromLoaderData(loaderData, clubInfo) {
  if (!loaderData || typeof loaderData !== 'object') return [];
  const routeKeys = Object.keys(loaderData);
  const spielplanKey = routeKeys.find(k => k.toLowerCase().includes('/spielplan'));
  const layoutKey = routeKeys.find(k => k.toLowerCase().includes('/_layout'));
  const layoutPayload = layoutKey ? loaderData[layoutKey] : null;
  const clubId = clubInfo.clubId || String(layoutPayload?.clubid || layoutPayload?.headData?.club_nr || '');
  const clubName = clubInfo.clubName || String(layoutPayload?.clubname || layoutPayload?.headData?.club_name || '');

  const rawSource = spielplanKey ? loaderData[spielplanKey] : null;
  const rawData = rawSource?.data || rawSource;
  if (!rawData || typeof rawData !== 'object') return [];

  const normalizedClub = normalizeTeamName(clubName);
  const normalizedClubStripped = normalizedClub.replace(/\s+e\.?\s*v\.?\s*$/i, '').replace(/\s+i\.?\s*g\.?\s*$/i, '').trim();
  const clubCandidates = [...new Set([normalizedClub, normalizedClubStripped].filter(Boolean))];

  const games = [];
  Object.entries(rawData).forEach(([dateKey, matches]) => {
    if (!Array.isArray(matches)) return;
    matches.forEach(match => {
      try {
        const date = parseDateFromIsoOrGerman(match.date || dateKey);
        if (!date) return;
        const homeTeam = String(match.team_home || '');
        const awayTeam = String(match.team_away || '');
        const homeClubId = String(match.team_home_club_id || '');
        const awayClubId = String(match.team_away_club_id || '');
        const isHomeClub = (clubId && homeClubId === clubId) || (!clubId && clubCandidates.some(c => normalizeTeamName(homeTeam).includes(c)));
        const isAwayClub = (clubId && awayClubId === clubId) || (!clubId && clubCandidates.some(c => normalizeTeamName(awayTeam).includes(c)));

        const won = parseInt(match.matches_won, 10);
        const lost = parseInt(match.matches_lost, 10);
        let scoreLabel = '', scoreClass = 'empty';
        if (!isNaN(won) && !isNaN(lost) && won + lost > 0) {
          scoreLabel = `${won}:${lost}`;
          if (won > lost) scoreClass = isHomeClub ? 'win' : 'loss';
          else if (won < lost) scoreClass = isHomeClub ? 'loss' : 'win';
          else scoreClass = 'draw';
        }

        const locationRaw = match.location || null;
        const location = locationRaw
          ? [locationRaw.label, locationRaw.street, locationRaw.zip, locationRaw.city].filter(Boolean).join(', ')
          : '';

        const homeTeamColor = teamColorForName(homeTeam, { clubId, clubName }) || '#153b6e';

        games.push({
          date: date.toISOString(),
          key: getDateKey(date),
          formattedDay: String(match.formattedDay || ''),
          formattedTime: String(match.formattedTime || ''),
          homeTeam,
          awayTeam,
          isHomeClub,
          isAwayClub,
          scoreLabel,
          scoreClass,
          pdfUrl: String(match.pdf_url || ''),
          spielberichtUrl: '',
          leagueShort: String(match.league_short_name || ''),
          leagueName: String(match.league_name || ''),
          meetingId: String(match.meeting_id || ''),
          leagueId: String(match.league_id || ''),
          location,
          locationRaw,
          homeTeamId: String(match.team_home_id || ''),
          awayTeamId: String(match.team_away_id || ''),
          homeTeamUrl: '',
          awayTeamUrl: '',
          homeTeamColor,
          live: Boolean(match.live),
          icon: isHomeClub ? '⌂' : (isAwayClub ? '✈' : '•'),
          opponent: isHomeClub ? awayTeam : (isAwayClub ? homeTeam : `${homeTeam} - ${awayTeam}`),
        });
      } catch { /* skip */ }
    });
  });

  games.sort((a, b) => new Date(a.date) - new Date(b.date));
  return games;
}

function enrichGamesWithLocation(games, rawData) {
  if (!rawData || !games.length || typeof rawData !== 'object') return;
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const byMeetingId = new Map();
  const byDateTeams = new Map();

  Object.entries(rawData).forEach(([dateKey, matches]) => {
    if (!Array.isArray(matches)) return;
    matches.forEach(match => {
      if (match.meeting_id) byMeetingId.set(String(match.meeting_id), match);
      byDateTeams.set(`${dateKey}|${norm(match.team_home)}|${norm(match.team_away)}`, match);
    });
  });

  games.forEach(game => {
    let match = null;
    // Try meeting_id from pdfUrl query param (meeting=NNN)
    if (game.pdfUrl) {
      const m = game.pdfUrl.match(/meeting=(\d+)/i);
      if (m) match = byMeetingId.get(m[1]) || null;
    }
    // Try meeting_id from spielberichtUrl path (.../spielbericht/NNN/...)
    if (!match && game.spielberichtUrl) {
      const m = game.spielberichtUrl.match(/\/spielbericht\/(\d+)\//i);
      if (m) match = byMeetingId.get(m[1]) || null;
      // Also store the meetingId directly from the URL if not yet set
      if (!match && m && !game.meetingId) game.meetingId = m[1];
    }
    // Fallback: match by date + team names
    if (!match && game.key) {
      match = byDateTeams.get(`${game.key}|${norm(game.homeTeam)}|${norm(game.awayTeam)}`) || null;
    }
    if (!match) return;
    if (!game.locationRaw && match.location && typeof match.location === 'object') {
      game.locationRaw = match.location;
      const parts = [match.location.label, match.location.street, match.location.zip, match.location.city].filter(Boolean);
      if (parts.length) game.location = parts.join(', ');
    }
    if (match.team_home_id) game.homeTeamId = String(match.team_home_id);
    if (match.team_away_id) game.awayTeamId = String(match.team_away_id);
    if (match.meeting_id && !game.meetingId) game.meetingId = String(match.meeting_id);
    if (match.league_id && !game.leagueId) game.leagueId = String(match.league_id);
    if (match.league_name && !game.leagueName) game.leagueName = String(match.league_name);
    if (match.live != null) game.live = Boolean(match.live);
  });
}

function teamSlug(name) {
  return encodeURIComponent(String(name || '').trim().replace(/\s+/g, '_'));
}

// Pre-compute all derived display/calendar fields on the server so the client
// receives ready-to-use data and doesn't need to repeat this logic.
function enrichGamesWithComputedFields(games, clubInfo, clubUrl) {
  const orgSeasonMatch = String(clubUrl || '').match(/\/click-tt\/([^/]+)\/([^/]+)\//);

  games.forEach(game => {
    // clubTeamName: the club's own team name, with age-category suffix for distinct calendar grouping
    const rawClubTeamName = game.isHomeClub ? game.homeTeam : (game.isAwayClub ? game.awayTeam : null);
    const ageCode = extractAgeCodeFromLeague(game.leagueShort);
    const clubTeamName = rawClubTeamName
      ? (ageCode ? `${rawClubTeamName} ${ageCode}` : rawClubTeamName)
      : null;
    game.clubTeamName = clubTeamName || null;

    // Team colors
    const clubTeamColor = clubTeamName ? (teamColorForName(clubTeamName, clubInfo) || game.homeTeamColor || '#153b6e') : null;
    game.clubTeamColor = clubTeamColor;
    game.eventColor = clubTeamColor || game.homeTeamColor || '#153b6e';
    game.eventBorderColor = game.isAwayClub ? '#9ca3af' : game.eventColor;

    // Pre-compute spielberichtUrl if not already set from HTML extraction
    if (!game.spielberichtUrl && game.leagueId && game.meetingId && game.leagueName && orgSeasonMatch) {
      const org        = orgSeasonMatch[1];
      const season     = orgSeasonMatch[2];
      const leagueSlug = encodeURIComponent(String(game.leagueName).replace(/\s+/g, '_'));
      const home       = teamSlug(game.homeTeam);
      const away       = teamSlug(game.awayTeam);
      game.spielberichtUrl = `https://www.mytischtennis.de/click-tt/${org}/${season}/ligen/${leagueSlug}/gruppe/${game.leagueId}/spielbericht/${game.meetingId}/${home}_-vs-${away}`;
    }
  });
}

async function fetchBankHolidays(years) {
  try {
    const apiUrl = `https://get.api-feiertage.de?years=${encodeURIComponent(years.join(','))}&states=by`;
    const resp = await fetch(apiUrl);
    if (!resp.ok) return {};
    const data = await resp.json();
    const raw = Array.isArray(data) ? data : (Array.isArray(data.feiertage) ? data.feiertage : []);
    const result = {};
    raw.forEach(h => {
      const dateStr = String(h.date || h.datum || '').trim();
      if (!dateStr) return;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return;
      result[getDateKey(d)] = { name: String(h.fname || h.name || h.localName || h.longName || '').trim() };
    });
    return result;
  } catch {
    return {};
  }
}

async function fetchSchoolBreaks(years) {
  // Returns: { [dateKey]: name }
  const result = {};
  for (const year of years) {
    try {
      let resp = null;
      try {
        resp = await fetch(`https://schulferien-api.de/api/v1/${year}/BY/`);
      } catch { resp = null; }

      if (!resp || resp.status === 429 || !resp.ok) {
        try {
          resp = await fetch(`https://ferien-api.de/api/v1/holidays/BY/${year}`);
        } catch { resp = null; }
      }

      if (!resp || !resp.ok) continue;
      const data = await resp.json();
      const list = Array.isArray(data) ? data : (Array.isArray(data.holidays) ? data.holidays : (Array.isArray(data.data) ? data.data : []));

      list.forEach(entry => {
        if (!entry) return;
        const start = entry.start || entry.from || entry.date || entry.begin || '';
        const end = entry.end || entry.to || entry.date || entry.finish || start;
        const name = entry.name || entry.holiday || entry.title || entry.label || entry.name_de || '';
        if (!start) return;
        const s = new Date(start), e = new Date(end || start);
        if (isNaN(s.getTime()) || isNaN(e.getTime())) return;
        for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
          result[getDateKey(d)] = capitalizeTitle(String(name));
        }
      });
    } catch { /* skip year */ }
  }
  return result;
}

function capitalizeTitle(text) {
  if (!text) return text;
  return String(text).split(/\s+/).map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(' ');
}
