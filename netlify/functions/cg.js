const https = require('https');

/* In-memory cache — persists across warm Lambda invocations.
   Prevents multiple browser tabs / rapid retries from hitting CoinGecko. */
const _cache = {};
const CACHE_TTL = 45000; /* 45 seconds */

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  let url, ttl = CACHE_TTL; /* default 45s, overridden per type */

  if (q.type === 'okx-tickers') {
    /* All USDT spot tickers from OKX — filter client-side */
    url = 'https://www.okx.com/api/v5/market/tickers?instType=SPOT';
    ttl = 10000;
  } else if (q.type === 'market') {
    url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(q.ids)}&sparkline=false`;
  } else if (q.type === 'chart') {
    url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(q.id)}/market_chart?vs_currency=usd&days=${q.days || 99}&interval=daily`;
  } else if (q.type === 'coin') {
    url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(q.id)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;
  } else {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid type' }) };
  }

  const hit = _cache[url];
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
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
