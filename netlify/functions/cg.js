const https = require('https');

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  let cgUrl;

  if (q.type === 'market') {
    cgUrl = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(q.ids)}&sparkline=false`;
  } else if (q.type === 'chart') {
    cgUrl = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(q.id)}/market_chart?vs_currency=usd&days=${q.days || 99}&interval=daily`;
  } else {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid type' }) };
  }

  return new Promise((resolve) => {
    https.get(cgUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'Quantichy/1.0' } }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=30'
          },
          body
        });
      });
    }).on('error', (e) => {
      resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) });
    });
  });
};
