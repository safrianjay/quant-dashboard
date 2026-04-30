import tradingChat from "../netlify/functions/trading-chat.mjs";

async function callTradingChat(payload, id) {
  const req = new Request("https://localhost/api/trading-chat/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer test-${id}` },
    body: JSON.stringify(payload),
  });

  const context = {
    ip: "127.0.0.1",
    requestId: `test-${id}`,
    params: {}
  };

  const res = await tradingChat(req, context);
  const body = await res.json().catch(() => null);
  console.log("status:", res.status);
  console.log("provider:", body?.provider ?? "unknown");
  console.log("assistant:", body?.message?.content ?? "<no content>");
  console.log("---");
}

(async () => {
  const baseSnapshot = {
    symbol: "BTC",
    price: 73450.12,
    quoteCurrency: "USD",
    timestamp: new Date().toISOString(),
    change24hPct: 1.23,
    indicators: { rsi: 56.3, ema5: 73300.00, ema21: 72000.00 }
  };

  // Crypto prompt (realistic scalp request)
  await callTradingChat({
    clientMessageId: "msg-crypto-1",
    prompt: "Quick scalp for BTC: give entry, stop, and targets based on current price",
    snapshot: baseSnapshot,
    history: []
  }, "crypto-1");

  // Off-topic prompt (should trigger guardrail)
  await callTradingChat({
    clientMessageId: "msg-offtopic-1",
    prompt: "What's the capital of France?",
    snapshot: baseSnapshot,
    history: []
  }, "offtopic-1");
})();
