const JSON_HEADERS = {
  "Content-Type": "application/json"
};

const MAX_PROMPT_LENGTH = 2000;
const MAX_HISTORY_MESSAGES = 40;
const RECENT_TURN_LIMIT = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 12;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_OUTPUT_TOKENS = 1024;

const FALLBACK_MODEL = "gemini-2.5-flash";

function state() {
  if (!globalThis.__tradingChatState) {
    globalThis.__tradingChatState = {
      conversations: new Map(),
      rateLimits: new Map()
    };
  }
  return globalThis.__tradingChatState;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS
  });
}

function getEnv(name) {
  if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(name);
  return process.env[name];
}

function getProviderApiKey() {
  return (
    (getEnv("GEMINI_API_KEY") ||
     getEnv("GOOGLE_GENERATIVE_AI_API_KEY") ||
     getEnv("GOOGLE_API_KEY") ||
     "").trim()
  );
}

function getClientKey(req, context) {
  const auth = req.headers.get("authorization") || "";
  const userPart = auth.startsWith("Bearer ") ? auth.slice(7, 24) : "anonymous";
  return `${userPart}:${context.ip || "unknown"}`;
}

export function checkRateLimit(key, now = Date.now()) {
  const { rateLimits } = state();
  const existing = rateLimits.get(key);

  if (!existing || now - existing.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(key, { windowStart: now, count: 1 });
    return { allowed: true };
  }

  existing.count += 1;
  if (existing.count > RATE_LIMIT_MAX) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(
        (RATE_LIMIT_WINDOW_MS - (now - existing.windowStart)) / 1000
      )
    };
  }

  return { allowed: true };
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function validatePayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== "object") {
    return { ok: false, errors: ["Payload must be an object"] };
  }

  if (payload.conversationId != null && typeof payload.conversationId !== "string") {
    errors.push("conversationId must be a string when provided");
  }

  if (!payload.clientMessageId || typeof payload.clientMessageId !== "string") {
    errors.push("clientMessageId is required");
  }

  if (!payload.prompt || typeof payload.prompt !== "string") {
    errors.push("prompt is required");
  } else if (payload.prompt.length > MAX_PROMPT_LENGTH) {
    errors.push(`prompt must be ${MAX_PROMPT_LENGTH} characters or fewer`);
  }

  const snapshot = payload.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    errors.push("snapshot is required");
  } else {
    if (!snapshot.symbol || typeof snapshot.symbol !== "string") {
      errors.push("snapshot.symbol is required");
    }
    if (!isFiniteNumber(snapshot.price) || snapshot.price <= 0) {
      errors.push("snapshot.price must be a positive number");
    }
    if (!snapshot.quoteCurrency || typeof snapshot.quoteCurrency !== "string") {
      errors.push("snapshot.quoteCurrency is required");
    }
    if (!isIsoDate(snapshot.timestamp)) {
      errors.push("snapshot.timestamp must be an ISO timestamp");
    }
  }

  if (!Array.isArray(payload.history)) {
    errors.push("history must be an array");
  } else if (payload.history.length > MAX_HISTORY_MESSAGES) {
    errors.push(`history must contain ${MAX_HISTORY_MESSAGES} messages or fewer`);
  } else {
    for (const [index, message] of payload.history.entries()) {
      if (!message || typeof message !== "object") {
        errors.push(`history[${index}] must be an object`);
        continue;
      }
      if (!["user", "assistant", "system"].includes(message.role)) {
        errors.push(`history[${index}].role is invalid`);
      }
      if (typeof message.content !== "string") {
        errors.push(`history[${index}].content must be a string`);
      }
      if (!isIsoDate(message.createdAt)) {
        errors.push(`history[${index}].createdAt must be an ISO timestamp`);
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

function compactMessage(message) {
  return {
    role: message.role,
    content: String(message.content || "").slice(0, 1800),
    createdAt: message.createdAt,
    snapshot: message.snapshot
      ? {
          symbol: message.snapshot.symbol,
          price: message.snapshot.price,
          quoteCurrency: message.snapshot.quoteCurrency,
          timestamp: message.snapshot.timestamp
        }
      : undefined
  };
}

export function buildConversationContext(history, currentSnapshot) {
  const userAssistantHistory = history.filter((message) =>
    ["user", "assistant"].includes(message.role)
  );
  const recentMessages = userAssistantHistory
    .slice(-RECENT_TURN_LIMIT)
    .map(compactMessage);
  const olderMessages = userAssistantHistory.slice(0, -RECENT_TURN_LIMIT);
  const summary = olderMessages.length
    ? olderMessages
        .map((message) => `${message.role}: ${String(message.content || "").slice(0, 240)}`)
        .join("\n")
        .slice(-3000)
    : "";

  return {
    summary,
    recentMessages,
    currentSnapshot
  };
}

function buildSystemInstruction(snapshot) {
  const formattedPrice = Number(snapshot.price).toLocaleString("en-US", {
    minimumFractionDigits: snapshot.price >= 1 ? 2 : 8,
    maximumFractionDigits: snapshot.price >= 1 ? 2 : 8,
  });

  const changeStr =
    snapshot.change24hPct != null
      ? `${Number(snapshot.change24hPct) >= 0 ? "+" : ""}${Number(
          snapshot.change24hPct
        ).toFixed(2)}% 24h`
      : "24h change unavailable";

  const volumeStr =
    snapshot.volume24h != null
      ? `Volume : $${Number(snapshot.volume24h).toLocaleString("en-US", {
          maximumFractionDigits: 0,
        })}`
      : "";

  return `
You are Copilot, a professional crypto trading analyst embedded in the Quantichy trading dashboard.
You think like a senior derivatives trader with deep knowledge of technical analysis, market structure,
on-chain data interpretation, and risk management principles.

══ LIVE MARKET CONTEXT (injected at call time — treat as real-time) ══
Asset  : ${snapshot.symbol}${snapshot.instrumentType ? ` [${snapshot.instrumentType}]` : ""}
Price  : ${formattedPrice} ${snapshot.quoteCurrency}
Change : ${changeStr}
${volumeStr ? `${volumeStr}\n` : ""}Captured: ${snapshot.timestamp} (UTC)
Source : Quantichy Market Feed (CoinGecko / Kraken aggregated)
══════════════════════════════════════════════════════════════════════

══ BEHAVIORAL RULES ══

1. DYNAMIC & CONVERSATIONAL
   - Answer the user's SPECIFIC question directly. Do not recite a generic analysis
     template — reason through what the user actually asked.
   - Use the live price context above as ground truth for this turn.
   - If the conversation has prior messages, maintain continuity. Reference earlier
     points when relevant (e.g., "As we discussed, the $XX,XXX level...").

2. TRADING EXPERTISE
   You may freely discuss and reason about:
   - Technical analysis (MACD, RSI, Bollinger Bands, EMA/SMA crosses, divergences,
     candlestick patterns, volume profiles, order blocks, liquidity sweeps, etc.)
   - Market structure (higher highs/lows, break of structure, change of character)
   - Trade planning (entries, stop losses, take profits, R:R ratios, position sizing)
   - Risk management (invalidation levels, max drawdown, account percentage risk,
     scaling in/out, trailing stops)
   - Macro & sentiment context (funding rates, open interest, fear & greed, BTC dominance)
   - Crypto-specific concepts (halving cycles, on-chain metrics, exchange flows,
     derivatives basis, spot/perp premium)

3. HARD GUARDRAILS — STRICT TOPIC BOUNDARY
   You ONLY discuss cryptocurrency markets, trading, investing, and closely related
   financial concepts (e.g., macro economics as it affects crypto).
   If a user asks anything outside this scope — coding help, recipes, general trivia,
   medical advice, politics, creative writing, etc. — respond ONLY with:
   "I'm your crypto trading copilot. I can only help with trading, markets, and
   crypto-related financial questions. What would you like to analyze?"
   Do NOT attempt to answer the off-topic question, even partially.

4. NO FINANCIAL GUARANTEES
   - Never say "this will go up", "guaranteed profit", "can't lose", or any equivalent.
   - Always acknowledge uncertainty, market risk, and the possibility of being wrong.
   - End analytical responses with a brief disclaimer variant such as:
     "This is not financial advice — always manage your own risk."
   - Do NOT be preachy or repeat the disclaimer more than once per response.

5. OUTPUT FORMAT (optimized for chat UI)
   - Keep responses concise: 2-4 short paragraphs maximum for most answers.
   - Use bullet points (-) when listing levels, conditions, or checklist items.
     Never use more than 6 bullets in a row without a paragraph break.
   - Use plain numbers with $ for prices (e.g., "$83,450"). Never use markdown
     tables or code blocks — they do not render in this chat interface.
   - Bold and italic formatting are NOT available. Use ALL-CAPS sparingly for key levels.
   - If the question is simple and factual, answer in 1-2 sentences. Don't pad.

6. UNCERTAINTY & DATA HONESTY
   - The snapshot price may be up to 2 minutes old (cached feed). Acknowledge this
     when giving precise level-based advice: "Based on the $XX,XXX snapshot..."
   - If you lack enough context to answer confidently, ask a targeted follow-up
     question instead of guessing.
`.trim();
}

function classifyPrompt(prompt) {
  if (/(explain|what is|what are|how does|teach|define|describe)/i.test(prompt)) return "explain";
  if (/(full plan|full analysis|break down|walk me through|give me a plan)/i.test(prompt)) return "plan";
  return "quick";
}

const GENERATION_CONFIGS = {
  quick:   { maxOutputTokens: 450,  temperature: 0.35 },
  explain: { maxOutputTokens: 700,  temperature: 0.50 },
  plan:    { maxOutputTokens: 1024, temperature: 0.45 },
};

function buildGeminiPayload({ prompt, history, snapshot }) {
  const systemText = buildSystemInstruction(snapshot);
  
  // Exclude current prompt from history to ensure strict alternation
  const pastHistory = (history.length > 0 && history[history.length - 1].content === prompt)
    ? history.slice(0, -1)
    : history;

  const context = buildConversationContext(pastHistory, snapshot);
  const contents = [];

  // Inject older-conversation summary
  if (context.summary) {
    contents.push({
      role: "user",
      parts: [{ text: `[Older conversation summary]\n${context.summary}` }]
    });
    contents.push({
      role: "model",
      parts: [{ text: "Understood. I have context from our earlier conversation." }]
    });
  }

  // Add recent history
  for (const msg of context.recentMessages) {
    const role = msg.role === "assistant" ? "model" : "user";
    let text = String(msg.content || "");

    if (msg.role === "user" && msg.snapshot) {
      const snapPrice = Number(msg.snapshot.price).toLocaleString("en-US", {
        minimumFractionDigits: msg.snapshot.price >= 1 ? 2 : 8,
        maximumFractionDigits: msg.snapshot.price >= 1 ? 2 : 8,
      });
      text = `[Snapshot at time of question: ${msg.snapshot.symbol} @ $${snapPrice}]\n\n${text}`;
    }

    contents.push({ role, parts: [{ text }] });
  }

  // Current user turn
  const snapPrice = Number(snapshot.price).toLocaleString("en-US", {
    minimumFractionDigits: snapshot.price >= 1 ? 2 : 8,
    maximumFractionDigits: snapshot.price >= 1 ? 2 : 8,
  });
  contents.push({
    role: "user",
    parts: [{
      text: `[CURRENT LIVE SNAPSHOT — ${snapshot.symbol} @ $${snapPrice} — ${snapshot.timestamp}]\n\n${prompt}`
    }]
  });

  // PREPEND SYSTEM INSTRUCTION TO THE VERY FIRST TURN FOR BEST COMPATIBILITY
  if (contents.length > 0 && contents[0].parts && contents[0].parts[0]) {
    contents[0].parts[0].text = `[SYSTEM INSTRUCTIONS]\n${systemText}\n\n${contents[0].parts[0].text}`;
  }

  return {
    contents
  };
}

export function buildFallbackTradingResponse({ prompt, snapshot }) {
  const price = Number(snapshot.price);
  const change = Number(snapshot.change24hPct || 0);
  const direction = change > 0.25 ? "bullish" : change < -0.25 ? "bearish" : "neutral";
  const formattedPrice = price.toLocaleString("en-US", {
    minimumFractionDigits: price >= 1 ? 2 : 8,
    maximumFractionDigits: price >= 1 ? 2 : 8
  });
  const lowerPrompt = String(prompt || "").toLowerCase();
  const invalidationPct = Math.max(0.4, Math.min(2.5, Math.abs(change || 0.8)));
  const longInvalidation = price * (1 - invalidationPct / 100);
  const shortInvalidation = price * (1 + invalidationPct / 100);

  if (lowerPrompt.includes("invalidat")) {
    return [
      `At the captured ${snapshot.symbol} price of $${formattedPrice}, a long idea weakens if price loses roughly $${longInvalidation.toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })} without reclaiming quickly. A short idea weakens if price accepts above roughly $${shortInvalidation.toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })}.`,
      `Treat those as planning bands, not hard signals. Wait for candle close, volume confirmation, and define position size before entering.`
    ].join("\n\n");
  }

  if (lowerPrompt.includes("risk")) {
    return [
      `At $${formattedPrice}, keep risk fixed before choosing direction: define invalidation first, size the trade so a stop costs only a small preset account percentage, and avoid adding if price moves against the plan.`,
      `Because the current 24h change reads ${Number.isFinite(change) ? change.toFixed(2) : "0.00"}%, use smaller size if spreads or volatility expand. You are responsible for the final trading decision.`
    ].join("\n\n");
  }

  return [
    `At the captured ${snapshot.symbol} price of $${formattedPrice}, the short-term tape is ${direction}${Number.isFinite(change) ? ` with a 24h move of ${change.toFixed(2)}%` : ""}. For an entry, avoid chasing the middle of the move; prefer either a pullback that holds support for a long or a failed reclaim/rejection for a short.`,
    `A practical plan is to mark the nearest invalidation before entry, then only take the trade if reward is meaningfully larger than risk. This fallback analysis uses the live snapshot but is not financial advice.`
  ].join("\n\n");
}

function isTransientStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function fetchGemini({ apiKey, model, payload }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey.trim()}`;
  let delay = 500;
  let lastError;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(`Provider returned ${response.status}`);
        error.status = response.status;
        error.providerBody = result;
        throw error;
      }

      return {
        text:
          result.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || "")
            .join("")
            .trim() || "I could not generate an analysis from the current context.",
        usage: {
          inputTokens: result.usageMetadata?.promptTokenCount || null,
          outputTokens: result.usageMetadata?.candidatesTokenCount || null
        }
      };
    } catch (error) {
      lastError = error;
      if (attempt === 2 || (error.status && !isTransientStatus(error.status))) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function getConversation(conversationId) {
  return state().conversations.get(conversationId) || null;
}

function upsertConversation(conversationId, userMessage, assistantMessage) {
  const { conversations } = state();
  const existing = conversations.get(conversationId) || {
    id: conversationId,
    messages: [],
    createdAt: new Date().toISOString()
  };

  existing.messages = [...existing.messages, userMessage, assistantMessage].slice(-MAX_HISTORY_MESSAGES);
  existing.updatedAt = new Date().toISOString();
  conversations.set(conversationId, existing);
  return existing;
}

async function handlePost(req, context) {
  const authHeader = req.headers.get("authorization");
  const requireAuth = getEnv("TRADING_CHAT_REQUIRE_AUTH") === "true";
  if (requireAuth && !authHeader) {
    return json(401, { error: "Authentication required" });
  }

  const rateLimit = checkRateLimit(getClientKey(req, context));
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: {
        ...JSON_HEADERS,
        "Retry-After": String(rateLimit.retryAfterSeconds)
      }
    });
  }

  const body = await readJson(req);
  const validation = validatePayload(body);
  if (!validation.ok) {
    return json(400, { error: "Invalid trading chat payload", details: validation.errors });
  }

  const apiKey = getProviderApiKey();
  const conversationId = body.conversationId || `conv_${crypto.randomUUID()}`;
  const model = getEnv("GEMINI_MODEL") || FALLBACK_MODEL;
  const startedAt = Date.now();

  if (!apiKey) {
    const assistantMessage = {
      id: `msg_${crypto.randomUUID()}`,
      role: "assistant",
      content: buildFallbackTradingResponse({
        prompt: body.prompt.trim(),
        snapshot: body.snapshot
      }),
      createdAt: new Date().toISOString()
    };
    const userMessage = {
      id: body.clientMessageId,
      role: "user",
      content: body.prompt.trim(),
      createdAt: new Date().toISOString(),
      snapshot: body.snapshot
    };

    upsertConversation(conversationId, userMessage, assistantMessage);

    console.log("[trading-chat] fallback", {
      requestId: context.requestId,
      conversationId,
      latencyMs: Date.now() - startedAt
    });

    return json(200, {
      conversationId,
      message: assistantMessage,
      usage: { inputTokens: null, outputTokens: null },
      provider: "fallback",
      keyLength: apiKey.length
    });
  }

  const providerPayload = buildGeminiPayload({
    prompt: body.prompt.trim(),
    history: body.history,
    snapshot: body.snapshot
  });

  try {
    const providerResult = await fetchGemini({
      apiKey,
      model,
      payload: providerPayload
    });
    const assistantMessage = {
      id: `msg_${crypto.randomUUID()}`,
      role: "assistant",
      content: providerResult.text,
      createdAt: new Date().toISOString()
    };
    const userMessage = {
      id: body.clientMessageId,
      role: "user",
      content: body.prompt.trim(),
      createdAt: new Date().toISOString(),
      snapshot: body.snapshot
    };

    upsertConversation(conversationId, userMessage, assistantMessage);

    console.log("[trading-chat]", {
      requestId: context.requestId,
      conversationId,
      model,
      latencyMs: Date.now() - startedAt,
      inputTokens: providerResult.usage.inputTokens,
      outputTokens: providerResult.usage.outputTokens
    });

    return json(200, {
      conversationId,
      message: assistantMessage,
      usage: providerResult.usage
    });
  } catch (error) {
    console.error("[trading-chat] provider_error", {
      requestId: context.requestId,
      status: error.status || "unknown",
      latencyMs: Date.now() - startedAt,
      message: error.message
    });

    // Graceful degradation — return a useful fallback response instead of 502
    // so the user always gets an answer even when Gemini is unavailable/misconfigured.
    const fallbackContent = buildFallbackTradingResponse({
      prompt: body.prompt.trim(),
      snapshot: body.snapshot
    });
    const assistantMessage = {
      id: `msg_${crypto.randomUUID()}`,
      role: "assistant",
      content: fallbackContent,
      createdAt: new Date().toISOString()
    };
    const userMessage = {
      id: body.clientMessageId,
      role: "user",
      content: body.prompt.trim(),
      createdAt: new Date().toISOString(),
      snapshot: body.snapshot
    };
    upsertConversation(conversationId, userMessage, assistantMessage);

    return json(200, {
      conversationId,
      message: assistantMessage,
      usage: { inputTokens: null, outputTokens: null },
      provider: "fallback"
    });
  }
}

function handleGet(context) {
  const conversation = getConversation(context.params.id);
  if (!conversation) return json(404, { error: "Conversation not found" });
  return json(200, conversation);
}

function handleDelete(context) {
  const deleted = state().conversations.delete(context.params.id);
  return json(200, { deleted });
}

export default async function tradingChat(req, context) {
  if (req.method === "POST") return handlePost(req, context);

  if (context.params?.id) {
    if (req.method === "GET") return handleGet(context);
    if (req.method === "DELETE") return handleDelete(context);
  }

  return json(405, { error: "Method not allowed" });
}

export const config = {
  path: ["/api/trading-chat/messages", "/api/trading-chat/conversations/:id"]
};
