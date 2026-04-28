import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConversationContext,
  checkRateLimit,
  validatePayload
} from "../netlify/functions/trading-chat.mjs";

const snapshot = {
  symbol: "BTC/USDT",
  instrumentType: "perpetual",
  price: 64512.34,
  quoteCurrency: "USDT",
  timestamp: "2026-04-28T10:15:31.123Z"
};

test("validatePayload accepts the production request shape", () => {
  const result = validatePayload({
    conversationId: "conv_123",
    clientMessageId: "msg_client_abc",
    prompt: "Is this a good entry?",
    snapshot,
    history: [
      {
        id: "msg_1",
        role: "user",
        content: "What is funding?",
        createdAt: "2026-04-28T10:10:00.000Z"
      }
    ]
  });

  assert.equal(result.ok, true);
});

test("validatePayload rejects missing symbol, invalid price, oversized prompt, and malformed history", () => {
  const result = validatePayload({
    clientMessageId: "msg_client_abc",
    prompt: "x".repeat(2001),
    snapshot: {
      price: -1,
      quoteCurrency: "USDT",
      timestamp: "not-a-date"
    },
    history: [{ role: "trader", content: 42, createdAt: "also-bad" }]
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /prompt/);
  assert.match(result.errors.join("\n"), /snapshot.symbol/);
  assert.match(result.errors.join("\n"), /snapshot.price/);
  assert.match(result.errors.join("\n"), /history\[0\]\.role/);
});

test("buildConversationContext keeps recent turns and never drops the current snapshot", () => {
  const history = Array.from({ length: 14 }, (_, index) => ({
    id: `msg_${index}`,
    role: index % 2 ? "assistant" : "user",
    content: `message ${index}`,
    createdAt: "2026-04-28T10:10:00.000Z"
  }));

  const context = buildConversationContext(history, snapshot);

  assert.equal(context.recentMessages.length, 10);
  assert.equal(context.currentSnapshot.price, 64512.34);
  assert.match(context.summary, /message 0/);
});

test("checkRateLimit returns 429-ready state after the configured burst", () => {
  const key = `test-${Date.now()}-${Math.random()}`;
  let result;

  for (let i = 0; i < 12; i += 1) {
    result = checkRateLimit(key, 1000);
    assert.equal(result.allowed, true);
  }

  result = checkRateLimit(key, 1000);
  assert.equal(result.allowed, false);
  assert.equal(result.retryAfterSeconds, 60);
});
