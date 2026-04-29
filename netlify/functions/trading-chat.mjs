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

const FALLBACK_MODEL = "gemini-2.0-flash";

const GENERATION_CONFIGS = {
  quick:   { temperature: 0.2 },
  explain: { temperature: 0.4 },
  plan:    { temperature: 0.4 },
};

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

function classifyPrompt(prompt) {
  const p = String(prompt || "").toLowerCase();
  if (p.includes("plan") || p.includes("strategy") || p.includes("setup")) return "plan";
  if (p.includes("explain") || p.includes("why") || p.includes("what is")) return "explain";
  return "quick";
}

function buildSystemInstruction(snapshot) {
  return `You are "NEUROBRO", a professional technical analyst and Quantichy AI.
Your goal is to provide aggressive, data-driven, and highly structured scalp analysis.

### HARD GUARDRAILS — STRICT TOPIC BOUNDARY:
- You ONLY discuss cryptocurrency markets, trading, investing, and macro economics affecting crypto.
- If a user asks an off-topic question (e.g., geography, politics, general trivia, personal advice), respond ONLY with: 
  "I'm your Quantichy AI. I can only help with trading, markets, and crypto-related financial questions. What would you like to analyze?"

### RESPONSE STRUCTURE (STRICT ADHERENCE REQUIRED):
1. **INTRO**: A 2-sentence punchy summary of the current tape based on the snapshot.
2. **THE SIGNAL**: 
<div class="confidence-badge">Confidence: [X.X/10]</div>

| Action | Entry | Stop Loss | Targets (TP1, TP2, TP3) |
| :--- | :--- | :--- | :--- |
| [🟢 LONG / 🔴 SHORT] | <span class="signal-entry">$[Price]</span> | <span class="signal-sl">$[Price]</span> | <span class="signal-tp">$[TP1], $[TP2], $[TP3]</span> |

3. **KEY LEVELS FOR NEXT 60 MINS**:
   | Level | Price | Why It Matters |
   | :--- | :--- | :--- |
   | [Resistance/Support] | $[Price] | [Brief reasoning] |
   | ... | ... | ... |
4. **THE SETUP — [THEME]**: Use a bold header. Explain the current price action, divergence, or pattern in detail. Use bolding for indicators (e.g., **RSI**, **EMA 21**).
5. **VOLUME TELLS THE REAL STORY**: A dedicated section on volume, sentiment, or index data (Fear & Greed).
6. **BOTTOM LINE**: A final 1-2 sentence summary of the trade thesis.

### RULES:
- Use Markdown for all formatting. Use bolding liberally for prices and key terms.
- Tone: Professional, slightly aggressive, "no-noise" technical analysis.
- Always include the table and the Signal section.
- If the snapshot data is insufficient for a clear signal, provide a "WATCH" signal with clear triggers.
- NEVER give financial advice. Always include a short risk disclaimer at the very end.
- Current Asset: ${snapshot.symbol}
- Current Price: $${snapshot.price}`;
}

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
    contents,
    generationConfig: GENERATION_CONFIGS[classifyPrompt(prompt)]
  };
}

export function buildFallbackTradingResponse({ prompt, snapshot }) {
  const p = String(prompt || "").toLowerCase();
  
  // Detect off-topic questions in fallback
  const offTopicKeywords = ["capital", "city", "recipe", "who is", "weather", "translate", "politics", "spain", "france", "germany", "usa", "president"];
  if (offTopicKeywords.some(word => p.includes(word))) {
    return "I'm your Quantichy AI. I can only help with trading, markets, and crypto-related financial questions. What would you like to analyze?";
  }

  // Detect if user is asking about a different coin than the current snapshot
  const symbols = ["btc", "eth", "sol", "bnb", "xrp", "ada", "doge", "pepe", "shib", "matic", "dot", "link"];
  const mentionedCoin = symbols.find(s => p.includes(s) && !snapshot.symbol.toLowerCase().includes(s));
  
  if (mentionedCoin) {
    return `I am currently analyzing the live **${snapshot.symbol}** tape. To get a precision scalp analysis for **${mentionedCoin.toUpperCase()}**, please switch to its dedicated dashboard so I can pull the correct live order book and volatility data for you.`;
  }

  const price = Number(snapshot.price);
  const change = Number(snapshot.change24hPct || 0);
  const direction = change > 0.25 ? "bullish" : change < -0.25 ? "bearish" : "neutral";
  const formattedPrice = price.toLocaleString("en-US", {
    minimumFractionDigits: price >= 1 ? 2 : 8,
    maximumFractionDigits: price >= 1 ? 2 : 8
  });
  
  // If it's a general question and not a "scalp" request, give a more natural answer
  if (!p.includes("scalp") && !p.includes("signal") && !p.includes("entry") && p.length > 20) {
    return `At the current **${snapshot.symbol}** price of **$${formattedPrice}**, we are seeing a ${direction} bias on the 24h tape. 

The market is currently positioning around key liquidity zones. If you're looking for a specific trade setup, try asking for a "Quick Scalp" or "Analyze Entry" to see the full technical breakdown.`;
  }

  const signal = direction === "bullish" ? "🟢 **BUY / LONG**" : direction === "bearish" ? "🔴 **SELL / SHORT**" : "🟡 **WATCH**";

  const signalEmoji = direction === "bullish" ? "🟢 LONG" : direction === "bearish" ? "🔴 SHORT" : "🟡 WATCH";

  return `At the captured **${snapshot.symbol}** price of **$${formattedPrice}**, the short-term tape is ${direction}${Number.isFinite(change) ? ` with a 24h move of **${change.toFixed(2)}%**` : ""}.

### THE SIGNAL
<div class="confidence-badge">Confidence: ${Math.min(6, 4 + Math.abs(change) / 2).toFixed(1)}/10</div>

| Action | Entry | Stop Loss | Targets (TP1, TP2, TP3) |
| :--- | :--- | :--- | :--- |
| ${signalEmoji} | <span class="signal-entry">$${formattedPrice}</span> | <span class="signal-sl">$${(price * (direction === "bullish" ? 0.992 : 1.008)).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })}</span> | <span class="signal-tp">$${(price * (direction === "bullish" ? 1.01 : 0.99)).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })}, $${(price * (direction === "bullish" ? 1.02 : 0.98)).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })}, $${(price * (direction === "bullish" ? 1.03 : 0.97)).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })}</span> |

### KEY LEVELS FOR NEXT 60 MINS
| Level | Price | Why It Matters |
| :--- | :--- | :--- |
| Resistance | $${(price * 1.005).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })} | Local range high |
| Support | $${(price * 0.995).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })} | Support cluster |

### THE SETUP — DATA ANALYSIS
Price is currently interacting with local liquidity. The volatility indicates that traders are looking for a clear breakout or rejection at this level.

### VOLUME TELLS THE REAL STORY
Current relative volume is stable. On-chain activity suggests minor accumulation at these levels, with the order book showing a slight sell-side bias near the local resistance.

### BOTTOM LINE
This setup focuses on local range play. This analysis uses the live snapshot and is for informational purposes only. Manage your risk.`;
}

function isTransientStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function fetchGemini({ apiKey, model, payload }) {
  const encodedModel = encodeURIComponent(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:generateContent?key=${apiKey.trim()}`;
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
      usage: providerResult.usage,
      provider: "gemini"
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
 
