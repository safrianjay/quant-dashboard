export function copyMarketSnapshot(market) {
  return Object.freeze({
    symbol: market.symbol,
    venue: market.venue,
    instrumentType: market.instrumentType,
    price: Number(market.price),
    quoteCurrency: market.quoteCurrency,
    pricePrecision: market.pricePrecision,
    change24hPct: market.change24hPct,
    volume24h: market.volume24h,
    openInterest: market.openInterest,
    fundingRate: market.fundingRate,
    timestamp: market.timestamp || new Date().toISOString()
  });
}
