const https = require('https');

/* In-memory cache — persists across warm Lambda invocations.
   Prevents multiple browser tabs / rapid retries from hitting CoinGecko. */
const _cache = {};
const CACHE_TTL_BINANCE = 10000;  /* 10s for live prices */
const CACHE_TTL_CG      = 45000;  /* 45s for CoinGecko chart data */

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  let url, ttl;

  if (q.type === 'binance-ticker') {
    /* Batch ticker: symbols=["BTCUSDT","ETHUSDT",...] */
    url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(q.symbols)}`;
    ttl = CACHE_TTL_BINANCE;
  } else if (q.type === 'binance-single') {
    url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(q.symbol)}`;
    ttl = CACHE_TTL_BINANCE;
  } else if (q.type === 'chart') {
    url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(q.id)}/market_chart?vs_currency=usd&days=${q.days || 99}&interval=daily`;
    ttl = CACHE_TTL_CG;
  } else {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid type' }) };
  }

  const hit = _cache[url];
  if (hit && Date.now() - hit.ts < ttl) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: hit.body
    };
  }

  return new Promise((resolve) => {
    https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Quantichy/1.0' } }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) _cache[url] = { body, ts: Date.now() };
        resolve({
          statusCode: res.statusCode,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body
        });
      });
    }).on('error', (e) => {
      resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) });
    });
  });
};
