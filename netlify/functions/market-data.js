/**
 * Netlify Function: market-data
 * Prices: CoinGecko → Kraken fallback. 2-min in-memory cache.
 */
const https = require('https');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

/* ── In-memory cache (persists across warm invocations) ── */
const _cache = {};
const CACHE_TTL = 120000; /* 2 minutes */

function cached(key) {
  const hit = _cache[key];
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.body;
  return null;
}
function stale(key) {
  return _cache[key] ? _cache[key].body : null;
}
function store(key, body) {
  _cache[key] = { body, ts: Date.now() };
}

const COIN_MAP = [
  { cgId: 'bitcoin',       sym: 'BTC'  },
  { cgId: 'ethereum',      sym: 'ETH'  },
  { cgId: 'binancecoin',   sym: 'BNB'  },
  { cgId: 'solana',        sym: 'SOL'  },
  { cgId: 'ripple',        sym: 'XRP'  },
  { cgId: 'cardano',       sym: 'ADA'  },
  { cgId: 'dogecoin',      sym: 'DOGE' },
  { cgId: 'avalanche-2',   sym: 'AVAX' },
  { cgId: 'chainlink',     sym: 'LINK' },
  { cgId: 'polkadot',      sym: 'DOT'  },
  { cgId: 'matic-network', sym: 'MATIC'},
  { cgId: 'uniswap',       sym: 'UNI'  },
  { cgId: 'litecoin',      sym: 'LTC'  },
  { cgId: 'near',          sym: 'NEAR' },
  { cgId: 'aptos',         sym: 'APT'  },
  { cgId: 'sui',           sym: 'SUI'  },
  { cgId: 'rave-token',    sym: 'RAVE' },
];

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function transformCG(data) {
  return COIN_MAP.map(({ cgId, sym }) => {
    const d = data[cgId] || {};
    return {
      symbol: sym + 'USDT',
      lastPrice: (d.usd || 0).toString(),
      highPrice:  (d.usd_24h_high || d.usd || 0).toString(),
      lowPrice:   (d.usd_24h_low  || d.usd || 0).toString(),
      priceChangePercent: (d.usd_24h_change || 0).toFixed(4),
      quoteVolume: (d.usd_24h_vol || 0).toString()
    };
  });
}

async function fetchKraken() {
  const pairs = [
    ['XXBTZUSD','BTC'], ['XETHZUSD','ETH'], ['SOLUSDT','SOL'],
    ['XXRPZUSD','XRP'], ['ADAUSD','ADA'],   ['XDGUSD','DOGE'],
    ['AVAXUSD','AVAX'], ['LINKUSD','LINK'],  ['DOTUSD','DOT'],
    ['UNIUSD','UNI'],   ['LTCUSD','LTC'],    ['NEARUSD','NEAR'],
    ['APTUSD','APT'],   ['SUIUSD','SUI'],
  ];
  const json = await httpsGet(`https://api.kraken.com/0/public/Ticker?pair=${pairs.map(p=>p[0]).join(',')}`);
  if (json.error && json.error.length) throw new Error('Kraken: ' + json.error[0]);
  return pairs.map(([krakenPair, sym]) => {
    const key = Object.keys(json.result || {}).find(k => k.includes(krakenPair.slice(0,4))) || krakenPair;
    const t = (json.result || {})[key] || {};
    const last = parseFloat(t.c?.[0] || 0);
    const high = parseFloat(t.h?.[1] || 0);
    const low  = parseFloat(t.l?.[1] || 0);
    const open = parseFloat(t.o || last);
    const vol  = parseFloat(t.v?.[1] || 0);
    const chg  = open ? ((last - open) / open * 100) : 0;
    return {
      symbol: sym + 'USDT',
      lastPrice: last.toString(),
      highPrice: high.toString(),
      lowPrice:  low.toString(),
      priceChangePercent: chg.toFixed(4),
      quoteVolume: (last * vol).toString()
    };
  });
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const { type, id } = params;

  try {

    if (type === 'prices') {
      const cacheKey = 'prices';

      /* Return cached if fresh */
      const fresh = cached(cacheKey);
      if (fresh) {
        console.log('[market-data] Cache hit');
        return { statusCode: 200, headers: HEADERS, body: fresh };
      }

      /* Try CoinGecko */
      let result;
      try {
        const ids = COIN_MAP.map(c => c.cgId).join(',');
        const data = await httpsGet(
          `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_high_24h=true&include_low_24h=true`
        );
        result = JSON.stringify(transformCG(data));
        console.log('[market-data] CoinGecko OK');
      } catch (e) {
        console.warn('[market-data] CoinGecko failed:', e.message);
        /* On 429 — serve stale cache if available */
        if (e.message.includes('429')) {
          const old = stale(cacheKey);
          if (old) {
            console.log('[market-data] Serving stale cache on 429');
            return { statusCode: 200, headers: HEADERS, body: old };
          }
        }
        /* Try Kraken fallback */
        try {
          result = JSON.stringify(await fetchKraken());
          console.log('[market-data] Kraken OK');
        } catch (e2) {
          /* Last resort: stale cache */
          const old = stale(cacheKey);
          if (old) return { statusCode: 200, headers: HEADERS, body: old };
          throw e2;
        }
      }

      store(cacheKey, result);
      return { statusCode: 200, headers: HEADERS, body: result };
    }

    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid type' }) };

  } catch (err) {
    console.error('[market-data] Fatal error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
