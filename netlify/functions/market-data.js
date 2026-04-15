/**
 * Netlify Function: market-data
 * Uses Node 18+ native fetch — no external dependencies needed.
 * Proxies market data from Binance and CoinGecko to bypass browser-side CORS and rate limits.
 */
exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const { type, id } = params;

  try {
    // Mode 1: Batch prices for the entire dashboard (from CoinGecko)
    if (type === 'prices') {
      console.log('[market-data] Fetching prices from CoinGecko...');
      // Get top 100 cryptos with prices - CoinGecko doesn't block Netlify IPs
      const response = await fetch(
        'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false',
        {
          headers: {
            'User-Agent': 'Quantichy-Dashboard/1.0'
          }
        }
      );
      console.log('[market-data] CoinGecko response status:', response.status);

      if (!response.ok) throw new Error(`CoinGecko API Error: ${response.status}`);

      const data = await response.json();
      console.log('[market-data] Got', data.length, 'coins from CoinGecko');

      // Transform CoinGecko format to match dashboard expectations (Binance-like format)
      const transformed = data.map(coin => ({
        symbol: (coin.symbol || '').toUpperCase() + 'USDT',
        name: coin.name,
        lastPrice: coin.current_price ? coin.current_price.toString() : '0',
        highPrice: coin.high_24h ? coin.high_24h.toString() : '0',
        lowPrice: coin.low_24h ? coin.low_24h.toString() : '0',
        priceChangePercent: (coin.price_change_percentage_24h || 0).toString(),
        quoteVolume: coin.total_volume ? coin.total_volume.toString() : '0'
      }));

      console.log('[market-data] Transformed to', transformed.length, 'coins');

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify(transformed)
      };
    }

    // Mode 2: OHLC historical data (from CoinGecko)
    if (type === 'ohlc' && id) {
      const response = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=1`, {
        headers: { 'User-Agent': 'Quantichy-Dashboard/1.0' }
      });
      if (!response.ok) throw new Error(`CoinGecko OHLC Error: ${response.status}`);
      
      const data = await response.json();
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify(data)
      };
    }

    // Mode 3: Detailed Coin Info (from CoinGecko)
    if (type === 'coin' && id) {
      const url = `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Quantichy-Dashboard/1.0' }
      });
      if (!response.ok) throw new Error(`CoinGecko Coin Error: ${response.status}`);
      
      const data = await response.json();
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify(data)
      };
    }

    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: 'Invalid type or missing parameters' })
    };

  } catch (error) {
    console.error('Market Data Proxy Error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: error.message })
    };
  }
};
