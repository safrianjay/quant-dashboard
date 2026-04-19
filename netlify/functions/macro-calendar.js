/**
 * Netlify Function: macro-calendar
 *
 * Returns the next ~12 macro/economic events that matter for crypto:
 * FOMC minutes, CPI, NFP, retail sales, ECB decisions, etc. Used by
 * the "Macro Risk Calendar" card on the Live Trade view.
 *
 * Data source: Trading Economics public "guest" endpoint
 *   https://api.tradingeconomics.com/calendar/country/...
 * Guest access is free, no signup required, but rate-limited and
 * returns a small slice. We cache for 1 hour in-memory and fall
 * back to stale cache on failure so a single TE outage doesn't
 * blank the UI. The frontend further degrades to a hard-coded
 * static list if this function returns 503.
 */

const https = require('https');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

/* ── 1-hour in-memory cache (survives across warm Lambda invocations) ── */
let _cache = null;
const CACHE_TTL = 60 * 60 * 1000;

/* Countries whose macro releases move crypto. EU + UK get included
   because ECB / BoE rate decisions reliably move BTC. */
const COUNTRIES = ['united states', 'euro area', 'united kingdom'];

/* TE importance: 1 = low, 2 = medium, 3 = high. We surface medium+ only. */
const IMPORTANCE_TO_RISK = { 3: 'high', 2: 'med', 1: 'low' };

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Quantichy/1.0' }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/* Render a TE date string as a compact, human-friendly label.
   "Apr 7 TODAY 12:30" / "Apr 8 TMRW 14:00" / "Apr 10 12:30". */
function formatEventTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const evDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const diffDays = Math.round((evDay - today) / 86400000);
  const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  /* Guard against TE's "00:00" placeholder for all-day events */
  const timeStr = time === '00:00' ? '' : ' ' + time;
  if (diffDays === 0) return `${monthDay} TODAY${timeStr}`;
  if (diffDays === 1) return `${monthDay} TMRW${timeStr}`;
  return `${monthDay}${timeStr}`;
}

/* TE returns a verbose row per event. Trim to what the card needs and
   build the descriptor sentence from forecast/previous when possible. */
function normaliseEvent(ev) {
  const risk = IMPORTANCE_TO_RISK[ev.Importance] || 'low';
  const unit = ev.Unit ? (ev.Unit.startsWith('%') ? ev.Unit : ' ' + ev.Unit) : '';
  let desc;
  if (ev.Forecast != null && ev.Forecast !== '') {
    const prev = (ev.Previous != null && ev.Previous !== '') ? `${ev.Previous}${unit}` : '—';
    desc = `Forecast ${ev.Forecast}${unit} · Prev ${prev}`;
  } else if (ev.Category) {
    desc = ev.Category;
  } else {
    desc = ev.Country || 'Economic release';
  }
  return {
    time: formatEventTime(ev.Date),
    iso: ev.Date,
    label: ev.Event,
    risk,
    desc,
    country: ev.Country
  };
}

async function fetchTradingEconomics() {
  /* Window: today → 14 days out. TE wants ISO date strings in the path. */
  const today = new Date();
  const future = new Date(Date.now() + 14 * 86400000);
  const d1 = today.toISOString().slice(0, 10);
  const d2 = future.toISOString().slice(0, 10);
  const countryPath = COUNTRIES.map(encodeURIComponent).join(',');
  const url = `https://api.tradingeconomics.com/calendar/country/${countryPath}/${d1}/${d2}?c=guest:guest&format=json`;

  const data = await httpsGet(url);
  if (!Array.isArray(data)) throw new Error('Unexpected response shape');

  return data
    .filter(ev => ev && ev.Date && ev.Event && (ev.Importance || 0) >= 2)
    .map(normaliseEvent)
    .filter(ev => ev.time)                        /* drop unparseable rows */
    .sort((a, b) => new Date(a.iso) - new Date(b.iso))
    .slice(0, 12);
}

exports.handler = async () => {
  /* Serve from cache if fresh */
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) {
    return { statusCode: 200, headers: HEADERS, body: _cache.body };
  }

  try {
    const events = await fetchTradingEconomics();
    const body = JSON.stringify({
      events,
      source: 'trading-economics',
      updatedAt: Date.now()
    });
    _cache = { body, ts: Date.now() };
    return { statusCode: 200, headers: HEADERS, body };
  } catch (err) {
    console.warn('[macro-calendar]', err.message);
    /* Stale cache wins over an outage; only 503 if we have nothing at all */
    if (_cache) return { statusCode: 200, headers: HEADERS, body: _cache.body };
    return {
      statusCode: 503,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message, fallback: 'static' })
    };
  }
};
