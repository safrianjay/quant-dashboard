import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConversationContext,
  checkRateLimit,
  default as tradingChat,
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

test("tradingChat returns a clear 503 when no provider key is configured", async () => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  const req = new Request("https://quantichy.test/api/trading-chat/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientMessageId: "msg_client_abc",
      prompt: "Is this a good entry?",
      snapshot,
      history: []
    })
  });

  const response = await tradingChat(req, { ip: "127.0.0.1", requestId: "test" });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.match(body.error, /GEMINI_API_KEY/);

  if (previous) process.env.GEMINI_API_KEY = previous;
});
