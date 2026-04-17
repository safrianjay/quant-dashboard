const https = require('https');

/* In-memory cache — persists across warm Lambda invocations.
   Prevents multiple browser tabs / rapid retries from hitting CoinGecko. */
const _cache = {};
const CACHE_TTL = { market: 300000, chart: 3600000, coin: 900000, 'okx-tickers': 60000 };

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  let url;

  if (q.type === 'okx-tickers') {
    url = 'https://www.okx.com/api/v5/market/tickers?instType=SPOT';
  } else if (q.type === 'market') {
    url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(q.ids)}&sparkline=false`;
  } else if (q.type === 'chart') {
    url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(q.id)}/market_chart?vs_currency=usd&days=${q.days || 99}&interval=daily`;
  } else if (q.type === 'coin') {
    url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(q.id)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;
  } else {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid type' }) };
  }

  /* Return cached if fresh */
  const hit = _cache[url];
  const ttl = CACHE_TTL[q.type] || 600000;
  if (hit && Date.now() - hit.ts < ttl) {
    console.log('[cg] Cache hit:', q.type, q.id || '');
    return { statusCode: 200, headers: HEADERS, body: hit.body };
  }

  try {
    const res = await httpsGet(url);

    /* On 429 rate limit — serve stale cache if available, else return error */
    if (res.statusCode === 429) {
      console.warn('[cg] Rate limited (429) for', q.type, q.id || '');
      if (hit) {
        console.log('[cg] Serving stale cache');
        return { statusCode: 200, headers: HEADERS, body: hit.body };
      }
      return { statusCode: 429, headers: HEADERS, body: JSON.stringify({ error: 'Rate limited, try again later' }) };
    }

    if (res.statusCode === 200) {
      _cache[url] = { body: res.body, ts: Date.now() };
    }

    return { statusCode: res.statusCode, headers: HEADERS, body: res.body };

  } catch (e) {
    console.error('[cg] Error:', e.message);
    /* Serve stale on network error */
    if (hit) return { statusCode: 200, headers: HEADERS, body: hit.body };
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message }) };
  }
};
