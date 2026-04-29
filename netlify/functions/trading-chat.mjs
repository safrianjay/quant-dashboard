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
- If a user asks an off-topic question (e.g., geography, politics, general trivia, personal advice, or non-crypto topics), respond ONLY with: 
  "I'm your Quantichy AI. I can only help with trading, markets, and crypto-related financial questions. What would you like to analyze?"

### RESPONSE STRUCTURE (STRICT ADHERENCE REQUIRED):
Do not use numbered lists. Use standard markdown H3 (###) for all section headers.

### INTRO
A 2-sentence punchy summary of the current tape based on the snapshot.

### THE NARRATIVE
A brief, engaging 'big picture' description outlining the overarching market narrative right now (e.g., summarizing institutional flows, macro events, or the broader technical context).

### THE SIGNAL
<div class="confidence-badge">Confidence: [X.X/10]</div>

| Action | Entry | Stop Loss | Targets (TP1, TP2, TP3) |
| :--- | :--- | :--- | :--- |
| [🟢 LONG / 🔴 SHORT] | <span class="signal-entry">$[Price]</span> | <span class="signal-sl">$[Price]</span> | <span class="signal-tp">$[TP1], $[TP2], $[TP3]</span> |

### KEY LEVELS FOR NEXT 60 MINS
| Level | Price | Why It Matters |
| :--- | :--- | :--- |
| [Resistance/Support] | $[Price] | [Brief reasoning] |
| ... | ... | ... |

### THE SETUP — [THEME]
Explain the current price action, focusing on specific **MSS (Market Structure Shift)** and **FVG (Fair Value Gap)** price levels (e.g., "MSS identified at $[Price]"). Discuss liquidity sweeps, divergence, or volume profiles in detail. Use bolding for all indicators and key price zones.

### VOLUME TELLS THE REAL STORY
A dedicated section on volume, sentiment, or index data (Fear & Greed).
[VISUAL_SIGNAL]

### BOTTOM LINE
Give actual, highly-actionable advice utilizing the current live price data. Do not use generic summaries. Instead, provide a highly specific plan modeled exactly after this example: "Don't chase the entry at **$76K** — wait for a sweep of **$74,500-$75,000**, which aligns with the Fib 50 and the 21-day EMA at **$71,433** is rising to meet it. That's the spot for a long with a stop below **$74K**. If BTC can't hold **$75K**, we're likely retesting **$70K**." Incorporate the actual current price into this thesis. Ensure all specific price levels are bolded.

### RULES:
- Use Markdown for all formatting. Use bolding liberally for prices and key terms.
- Tone: Professional, slightly aggressive, "no-noise" technical analysis.
- Always include the table and the Signal section.
- If the snapshot data is insufficient for a clear signal, provide a "WATCH" signal with clear triggers.
- NEVER give financial advice. Always include this exact short disclaimer at the very end: *for study purpose only manage your risk.*
- Current Asset: ${snapshot.symbol}
- Current Price: $${snapshot.price}
- Live Technical Indicators: 
  - RSI (14): ${snapshot.indicators?.rsi ? snapshot.indicators.rsi.toFixed(2) : 'N/A'}
  - EMA (5): $${snapshot.indicators?.ema5 ? snapshot.indicators.ema5.toFixed(2) : 'N/A'}
  - EMA (21): $${snapshot.indicators?.ema21 ? snapshot.indicators.ema21.toFixed(2) : 'N/A'}

Incorporate these specific indicator values into your analysis, especially in the 'THE SETUP' and 'BOTTOM LINE' sections, to prove you are analyzing real-time data.`;
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
  
  const offTopicKeywords = ["capital", "city", "recipe", "who is", "weather", "translate", "politics", "spain", "france", "germany", "usa", "president"];
  if (offTopicKeywords.some(word => p.includes(word))) {
    return "I'm your Quantichy AI. I can only help with trading, markets, and crypto-related financial questions. What would you like to analyze?";
  }

  const price = Number(snapshot.price);
  const change = Number(snapshot.change24hPct || 0);
  const direction = change > 0.25 ? "bullish" : change < -0.25 ? "bearish" : "neutral";
  const formattedPrice = price.toLocaleString("en-US", {
    minimumFractionDigits: price >= 1 ? 0 : 8,
    maximumFractionDigits: price >= 1 ? 2 : 8
  });

  // Handle "Risk Check" specifically in fallback
  if (p.includes("risk") || p.includes("checklist")) {
    return `### THE NARRATIVE
At the current **${snapshot.symbol}** price of **$${formattedPrice}**, the volatility is sitting at **${Math.abs(change).toFixed(2)}%**. Effective risk management is now the primary objective to preserve capital for the next expansion.

### RISK MANAGEMENT CHECKLIST
**1.** **Size for Survival:** Ensure your position size allows for a stop-loss at **$${(price * (direction === 'bullish' ? 0.98 : 1.02)).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })}** without risking more than 1-2% of total equity.
**2.** **Volatility Guard:** Use the ATR expansion as a guide. Don't use tight stops during this phase as liquidity sweeps are frequent.
**3.** **Liquidity Sweeps:** Watch the **$${(price * (direction === 'bullish' ? 0.995 : 1.005)).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })}** level; if we sweep this, reduce your leverage immediately.

### BOTTOM LINE
Don't overleverage at **$${formattedPrice}**. Focus on capital preservation until the higher-timeframe structure confirms the next trend. *for study purpose only manage your risk.*`;
  }

  // Handle "Invalidation" specifically in fallback
  if (p.includes("invalid")) {
    return `### THE NARRATIVE
The current market structure for **${snapshot.symbol}** at **$${formattedPrice}** is sensitive. We are tracking specific price thresholds where the current directional thesis is completely negated.

### INVALIDATION POINTS
- **Directional Breach:** Price closes a 15m candle below **$${(price * (direction === 'bullish' ? 0.99 : 1.01)).toLocaleString('en-US', { maximumFractionDigits: price >= 1 ? 2 : 8 })}**.
- **Structure Shift:** Failure to reclaim **$${(price * (direction === 'bullish' ? 1.005 : 0.995)).toLocaleString('en-US', { maximumFractionDigits: price >= 1 ? 2 : 8 })}** within the next 4-hour window.
- **Volume Climax:** A massive sell-side spike at current support levels would signal a total trend breakdown.

### BOTTOM LINE
Maintain a neutral stance if **$${(price * (direction === 'bullish' ? 0.995 : 1.005)).toLocaleString('en-US', { maximumFractionDigits: price >= 1 ? 2 : 8 })}** is lost on high volume. Re-evaluate the bias only after a clean sweep. *for study purpose only manage your risk.*`;
  }

  // Detect if user is asking about a different coin than the current snapshot
  const symbols = ["btc", "eth", "sol", "bnb", "xrp", "ada", "doge", "pepe", "shib", "matic", "dot", "link"];
  const mentionedCoin = symbols.find(s => p.includes(s) && !snapshot.symbol.toLowerCase().includes(s));
  
  if (mentionedCoin) {
    return `I am currently analyzing the live **${snapshot.symbol}** tape. To get a precision scalp analysis for **${mentionedCoin.toUpperCase()}**, please switch to its dedicated dashboard so I can pull the correct live order book and volatility data for you.`;
  }

  // If it's a general question and not a "scalp" request, give a more natural answer
  if (!p.includes("scalp") && !p.includes("signal") && !p.includes("entry") && p.length > 20) {
    return `At the current **${snapshot.symbol}** price of **$${formattedPrice}**, we are seeing a ${direction} bias on the 24h tape. 

The market is currently positioning around key liquidity zones. If you're looking for a specific trade setup, try asking for a "Quick Scalp" or "Analyze Entry" to see the full technical breakdown.`;
  }

  const rsi = snapshot.indicators?.rsi || 50;
  const ema5 = snapshot.indicators?.ema5 || price;
  const trend = rsi > 60 ? "overbought" : rsi < 40 ? "oversold" : "neutral";
  const momentum = price > ema5 ? "bullish" : "bearish";

  const signal = direction === "bullish" ? "🟢 **BUY / LONG**" : direction === "bearish" ? "🔴 **SELL / SHORT**" : "🟡 **WATCH**";
  const signalEmoji = direction === "bullish" ? "🟢 LONG" : direction === "bearish" ? "🔴 SHORT" : "🟡 WATCH";

  return `### THE NARRATIVE
At the current **${snapshot.symbol}** price of **$${formattedPrice}**, the short-term tape is showing a **${momentum}** expansion with the RSI sitting at **${rsi.toFixed(1)}** (${trend}). We are seeing active liquidity absorption at these levels.

### THE SIGNAL
<div class="confidence-badge">Confidence: ${Math.min(8, 5 + Math.abs(change) / 2 + (trend !== 'neutral' ? 1 : 0)).toFixed(1)}/10</div>

| Action | Entry | Stop Loss | Targets (TP1, TP2, TP3) |
| :--- | :--- | :--- | :--- |
| ${signalEmoji} | <span class="signal-entry">$${formattedPrice}</span> | <span class="signal-sl">$${(price * (direction === "bullish" ? 0.992 : 1.008)).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })}</span> | <span class="signal-tp">$${(price * (direction === "bullish" ? 1.01 : 0.99)).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })}, $${(price * (direction === "bullish" ? 1.02 : 0.98)).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })}, $${(price * (direction === "bullish" ? 1.03 : 0.97)).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })}</span> |

### KEY LEVELS FOR NEXT 60 MINS
| Level | Price | Why It Matters |
| :--- | :--- | :--- |
| EMA 5 | $${ema5.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })} | Dynamic Trend Line |
| Resistance | $${(price * 1.005).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })} | Local range high |
| Support | $${(price * 0.995).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })} | Support cluster |

### THE SETUP — TECHNICAL DATA
Price action is currently reacting to the **EMA 5** at **$${ema5.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })}**. With an RSI of **${rsi.toFixed(1)}**, we expect ${rsi > 70 ? 'a cooling-off period' : rsi < 30 ? 'a mean-reversion bounce' : 'continued consolidation'} within the Fair Value Gap (FVG) between **$${(price * 0.999).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })}** and **$${(price * 1.001).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })}**.

### VOLUME TELLS THE REAL STORY
Current volume confirms ${momentum} dominance. The order book is showing a cluster of buy/sell interest around the current mark, suggesting institutional positioning is underway.

[VISUAL_SIGNAL]

### BOTTOM LINE
${rsi > 70 ? `Don't chase here. The RSI is at **${rsi.toFixed(1)}** (overbought). Wait for a dip to the EMA 5 at **$${ema5.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })}** before entering.` : rsi < 30 ? `The market is oversold at **${rsi.toFixed(1)}**. This is a prime spot for a mean-reversion scalp with a tight stop below **$${(price * 0.995).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })}**.` : `The trend is neutral but biased ${momentum}. Watch for a break of **$${(price * (momentum === 'bullish' ? 1.005 : 0.995)).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: price >= 1 ? 2 : 8 })}** to confirm the next expansion leg.`}

*for study purpose only manage your risk.*`;
}
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

  const lowerPrompt = body.prompt.trim().toLowerCase();
  const genericRefusal = "I'm your Quantichy AI. I can only help with trading, markets, and crypto-related financial questions. What would you like to analyze?";

  // --- HALA MADRID CHECK ---
  if (lowerPrompt === "hala madrid!" || lowerPrompt === "hala madrid") {
    const assistantMessage = {
      id: `msg_${crypto.randomUUID()}`,
      role: "assistant",
      content: "Vamos! Hala Madrid Y Nada Mas",
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
      usage: { inputTokens: 0, outputTokens: 0 },
      provider: "easter-egg"
    });
  }

  // --- OFF TOPIC / GIBBERISH GUARDRAIL ---
  // Detects random letter strings (no vowels and no spaces) or junk input
  const textNoSpace = lowerPrompt.replace(/\s/g, '');
  const isGibberish = textNoSpace.length > 4 && !/[aeiouy1-9]/.test(textNoSpace);
  const isJunkSymbols = lowerPrompt.length > 0 && lowerPrompt.length < 4 && !/[a-z0-9]/.test(lowerPrompt);
  
  if (isGibberish || isJunkSymbols) {
    const assistantMessage = {
      id: `msg_${crypto.randomUUID()}`,
      role: "assistant",
      content: genericRefusal,
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
      usage: { inputTokens: 0, outputTokens: 0 },
      provider: "guardrail"
    });
  }

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
 
