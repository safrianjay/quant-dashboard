import test from "node:test";
import assert from "node:assert/strict";
import { copyMarketSnapshot } from "../src/components/tradingChatUtils.mjs";

test("copyMarketSnapshot captures an immutable send-time price", () => {
  const market = {
    symbol: "BTC/USDT",
    price: 64512.34,
    quoteCurrency: "USDT",
    timestamp: "2026-04-28T10:15:31.123Z"
  };

  const snapshot = copyMarketSnapshot(market);
  market.price = 65000;

  assert.equal(snapshot.price, 64512.34);
  assert.equal(Object.isFrozen(snapshot), true);
});
