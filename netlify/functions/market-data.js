/**
 * Netlify Function: market-data
 * Uses Node 18+ native fetch — no external dependencies needed.
 * Proxies market data from Binance and CoinGecko to bypass browser-side CORS and rate limits.
 */
exports.handler = async (event) => {
  const { type, id } = event.queryStringParameters;

  try {
    // Mode 1: Batch prices for the entire dashboard (from Binance)
    if (type === 'prices') {
      const response = await fetch('https://api.binance.com/api/v3/ticker/24hr');
      if (!response.ok) throw new Error(`Binance API Error: ${response.status}`);
      
      const data = await response.json();
      
      // Filter for USDT pairs to keep payload lean
      const filtered = data.filter(i => i.symbol.endsWith('USDT'));
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filtered)
      };
    }

    // Mode 2: OHLC historical data (from CoinGecko)
    if (type === 'ohlc' && id) {
      const response = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=1`);
      if (!response.ok) throw new Error(`CoinGecko OHLC Error: ${response.status}`);
      
      const data = await response.json();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      };
    }

    // Mode 3: Detailed Coin Info (from CoinGecko)
    if (type === 'coin' && id) {
      const url = `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`CoinGecko Coin Error: ${response.status}`);
      
      const data = await response.json();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      };
    }

    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid type or missing parameters' })
    };

  } catch (error) {
    console.error('Market Data Proxy Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
