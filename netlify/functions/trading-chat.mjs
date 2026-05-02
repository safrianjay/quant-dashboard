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

// Default model. `flash-lite` has 2× the per-minute free-tier quota of `flash`
// (30 RPM vs 15 RPM) which matters for a multi-user dashboard. Override per
// deploy with the GEMINI_MODEL env var if you want full `flash` quality.
const FALLBACK_MODEL = "gemini-2.0-flash-lite";

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
Your goal is to provide aggressive, data-driven, and highly structured analysis for crypto traders.
You analyze the LIVE market snapshot provided and answer ANY trading, market, or crypto-related question with relevant insight.

### TOPIC SCOPE — CRYPTO & TRADING ANALYST:
You answer ANY question that relates to:
- Cryptocurrency markets, coins, tokens, blockchains, DeFi, NFTs, on-chain metrics
- Trading: technical analysis, entries, exits, stop loss, risk management, position sizing
- Investing strategy: long-term holds, portfolio allocation, DCA, hedging, comparisons between coins
- Market structure: liquidity, order books, volume, sentiment, narratives, sector rotation
- Macro economics affecting crypto: rates, inflation, ETF flows, regulatory news, Fed policy
- Coin fundamentals: tokenomics, use case, team, competitors, catalysts, roadmap
- General trading/finance education: indicators, candlestick patterns, RSI, EMA, MACD, Fibonacci, etc.
- Open-ended questions: "What coin should I watch?", "Is this a good entry?", "What's your outlook?", "Why is price moving?", "Tell me about ETH", "Compare BTC vs ETH", "Is now a good time to buy?", "What's bullish/bearish about X?"

### OFF-TOPIC HANDLING (only refuse for clearly non-finance topics):
ONLY refuse if the question is clearly about: cooking/recipes, weather, politics unrelated to markets, sports, geography trivia, celebrities, personal advice, coding help, etc.
For those, respond ONLY with:
"I'm your Quantichy AI. I can only help with trading, markets, and crypto-related financial questions. What would you like to analyze?"

When in doubt, ASSUME the question is crypto/trading-related and answer it. Never refuse a question that COULD reasonably be about markets.

### CRITICAL REQUIREMENT: ALWAYS INCLUDE [VISUAL_SIGNAL]
You MUST include the [VISUAL_SIGNAL] tag in EVERY response that contains trading analysis, signals, levels, or market structure commentary.
This tag triggers the technical analyst component showing SUPPORT, RESISTANCE, MOMENTUM, VOLATILITY cards.
For purely educational answers (e.g., "what is RSI?"), the tag is OPTIONAL — but for any answer that touches the live ${snapshot.symbol} tape, INCLUDE IT.

### HOW TO ANSWER OPEN-ENDED QUESTIONS:
- "What's the outlook for BTC?" → Full structured TA with snapshot data
- "Is now a good entry?" → Signal table with confidence + setup explanation
- "Tell me about Ethereum" → Brief fundamentals + current technical state + bias
- "What coin should I look at?" → Discuss the live ${snapshot.symbol} or recommend the user pivot to a specific dashboard
- "Why is the market dumping?" → Macro narrative + on-chain/structural reasoning
- "Should I take profit?" → Use the snapshot price + RSI/EMA + recent volatility to give a decisive answer
- "Compare X vs Y" → Side-by-side: structure, momentum, market cap, narrative
ALWAYS use REAL data from the snapshot. NEVER give generic template answers.

### RESPONSE STYLE — TWO MODES:

**MODE A — TRADE SIGNAL** (use when the user asks for entry, scalp, signal, setup, "should I buy/sell", "long or short"):
Use the full structured template below with all sections.

**MODE B — CONVERSATIONAL ANSWER** (use for everything else: outlook questions, fundamentals, comparisons, education, "tell me about X", "why is price moving", "thoughts on Y", general trading questions):
Write a natural, direct, analyst-style answer. Use markdown freely (### headers, **bold**, tables, bullet lists if helpful) but DO NOT force the rigid Signal table template. Length should match the question — a fundamentals question gets 2-4 paragraphs, a quick "what do you think" gets 1-2 paragraphs. Always ground the answer in the live ${snapshot.symbol} @ $${snapshot.price} snapshot when relevant. Append [VISUAL_SIGNAL] at the end if the answer touches the current tape's structure/levels; skip it for purely educational answers.

### MODE A TEMPLATE (only when giving a trade signal):
Do not use numbered lists. Use H3 (###) headers.

### INTRO
A 2-sentence punchy summary of the current tape based on the snapshot.

### THE NARRATIVE
A brief, engaging 'big picture' description outlining the overarching market narrative right now.

### THE SIGNAL
<div class="confidence-badge">Confidence: [X.X/10]</div>

| Action | Entry | Stop Loss | Targets (TP1, TP2, TP3) |
| :--- | :--- | :--- | :--- |
| [🟢 LONG / 🔴 SHORT] | <span class="signal-entry">$[Price]</span> | <span class="signal-sl">$[Price]</span> | <span class="signal-tp">$[TP1], $[TP2], $[TP3]</span> |

### KEY LEVELS FOR NEXT 60 MINS
| Level | Price | Why It Matters |
| :--- | :--- | :--- |
| Support/Resistance | $[Price] | [Brief reasoning] |

### THE SETUP — TECHNICAL ANALYSIS
Explain the current price action using specific MSS (Market Structure Shift) and FVG (Fair Value Gap) levels.
Use the actual snapshot price (${snapshot.symbol} @ $${snapshot.price}) in your analysis.

### VOLUME TELLS THE REAL STORY
A dedicated section on volume, sentiment, or index data.
[VISUAL_SIGNAL]

### BOTTOM LINE
Give highly-actionable advice using REAL snapshot price data.

### GLOBAL RULES:
- Always use actual prices from the snapshot when discussing the live tape: ${snapshot.symbol} @ $${snapshot.price}
- Tone: Professional analyst, direct, no fluff
- Disclaimer at end of any trade-signal answer: *for study purpose only manage your risk.*
- Current Asset: ${snapshot.symbol}
- Current Price: $${snapshot.price}
- RSI (14): ${snapshot.indicators?.rsi ? snapshot.indicators.rsi.toFixed(2) : 'N/A'}
- EMA (5): $${snapshot.indicators?.ema5 ? snapshot.indicators.ema5.toFixed(2) : 'N/A'}
- EMA (21): $${snapshot.indicators?.ema21 ? snapshot.indicators.ema21.toFixed(2) : 'N/A'}
- Quantichy QuantAnalyst bias (MUST AGREE WITH THIS): ${snapshot.quant?.bias || 'N/A'}${snapshot.quant?.confidence ? ` (confidence ${snapshot.quant.confidence}/10)` : ''}${snapshot.quant?.signal ? ` — ${snapshot.quant.signal}` : ''}
- DO NOT contradict the QuantAnalyst bias above. If it says BEARISH, do not recommend a long; if it says BULLISH, do not recommend a short. The on-page Session Timeline is showing this bias to the user, so your answer must match.
- DO NOT default to the trade-signal template for every question. Match the format to what the user actually asked.`;
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
  return {
    // Use explicit systemInstruction field so the provider reliably applies hard guardrails
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: GENERATION_CONFIGS[classifyPrompt(prompt)]
  };
}

export function buildFallbackTradingResponse({ prompt, snapshot }) {
  const p = String(prompt || "").toLowerCase();

  // Refuse only when the prompt is clearly off-topic AND has no crypto/trading hint.
  const cryptoHint = /(btc|bitcoin|eth|ethereum|sol|solana|crypto|coin|token|trade|trading|trader|chart|price|buy|sell|long|short|bull|bear|market|invest|portfolio|risk|signal|entry|exit|stop|target|fib|ema|rsi|macd|support|resistance|volume|momentum|liquidity|defi|nft|blockchain|altcoin|dump|pump|outlook|breakout|wick|candle|hodl)/i;
  const offTopicKeywords = ["recipe", "cook ", "weather", "translate", "joke", "poem", "soccer", "football team", "basketball", "movie ", "actor ", "song lyrics"];
  if (offTopicKeywords.some(word => p.includes(word)) && !cryptoHint.test(p)) {
    return "I'm your Quantichy AI. I can only help with trading, markets, and crypto-related financial questions. What would you like to analyze?";
  }

  const price = Number(snapshot.price);
  const change = Number(snapshot.change24hPct || 0);
  /* Prefer QuantAnalyst's bias (computed from MA stack) over the 24h price-change
     heuristic so the AI drawer agrees with the on-page Session Timeline / setups
     ladder. Fall back to the 24h-change heuristic when QuantAnalyst hasn't run. */
  const quantBias = String(snapshot.quant?.bias || "").toLowerCase();
  const direction =
    quantBias === "bullish" ? "bullish" :
    quantBias === "bearish" ? "bearish" :
    quantBias === "neutral" ? "neutral" :
    change > 0.25 ? "bullish" : change < -0.25 ? "bearish" : "neutral";
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
Maintain a neutral stance if **$${(price * (direction === 'bullish' ? 0.995 : 1.005)).toLocaleString('en-US', { maximumFractionDigits: price >= 1 ? 2 : 8 })}** is lost on high volume. If this level breaks decisively, the **long idea weakens** and you should reduce exposure; if the level holds and rejects, the **short idea weakens** and a long re-entry can be considered. Re-evaluate the bias only after a clean sweep. *for study purpose only manage your risk.*`;
  }

  // Detect if user is asking about a different coin than the current snapshot
  const symbols = ["btc", "eth", "sol", "bnb", "xrp", "ada", "doge", "pepe", "shib", "matic", "dot", "link"];
  const mentionedCoin = symbols.find(s => p.includes(s) && !snapshot.symbol.toLowerCase().includes(s));
  
  if (mentionedCoin) {
    return `I am currently analyzing the live **${snapshot.symbol}** tape. To get a precision scalp analysis for **${mentionedCoin.toUpperCase()}**, please switch to its dedicated dashboard so I can pull the correct live order book and volatility data for you.`;
  }

  // Detect prompts that are too vague to answer well from a static fallback
  // ("hmm", "where is the coin", "thoughts?"). For these, ask the user to be
  // specific instead of dumping the structured template — that's exactly what
  // the user complained about as "irrelevant template answer".
  const hasQuestionShape = /\b(why|how|what|when|should|can|is|are|will|does|do|tell|explain|compare|outlook|good|bad|bull|bear|long|short|buy|sell|enter|target|stop|risk)\b/i.test(p);
  const looksLikeRealQuestion = p.length >= 8 && (hasQuestionShape || /\?/.test(p) || cryptoHint.test(p));
  if (!looksLikeRealQuestion) {
    return `I want to give you a useful read on **${snapshot.symbol}** at **$${formattedPrice}**, but your question was a bit vague. Try one of:

- **"What's the outlook for ${snapshot.symbol}?"** — full technical read
- **"Should I long or short here?"** — directional bias with entry / stop
- **"Where's the support / resistance?"** — key levels
- **"Compare BTC vs ETH"** — relative analysis

Or tap **Analyze Entry**, **Invalidation**, or **Risk Check** below for a one-tap answer.`;
  }

  const fmt = (v) => v.toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 });
  const rsiVal = Number(snapshot.indicators?.rsi);
  const ema5Val = Number(snapshot.indicators?.ema5);
  const ema21Val = Number(snapshot.indicators?.ema21);
  const rsiText = Number.isFinite(rsiVal) ? rsiVal.toFixed(1) : "—";
  const ema5Txt = Number.isFinite(ema5Val) ? fmt(ema5Val) : "—";
  const ema21Txt = Number.isFinite(ema21Val) ? fmt(ema21Val) : "—";

  // Intent: support / resistance / key levels
  if (/\b(support|resistance|s\/r|key level|levels?)\b/i.test(p)) {
    const s1 = price * 0.995, s2 = price * 0.98, s3 = price * 0.96;
    const r1 = price * 1.005, r2 = price * 1.02, r3 = price * 1.04;
    return `### SUPPORT & RESISTANCE — ${snapshot.symbol} @ $${formattedPrice}

**Resistance (above):**
- **$${fmt(r1)}** — first reaction zone (intraday range high)
- **$${fmt(r2)}** — Fib 23.6% / range top — clean break opens expansion
- **$${fmt(r3)}** — major liquidity pool / swing high

**Support (below):**
- **$${fmt(s1)}** — short-term floor / EMA 5 zone (~$${ema5Txt})
- **$${fmt(s2)}** — Fib 61.8% / range bottom
- **$${fmt(s3)}** — major demand zone / swing low

**The read:** Hold above **$${fmt(s1)}** and dips are buyable. Loss of **$${fmt(s2)}** flips bias bearish. Reclaim of **$${fmt(r2)}** unlocks the next leg up. *for study purpose only manage your risk.*`;
  }

  // Intent: long or short / directional bias
  if (/\b(long or short|long\/short|direction|bias|which way|up or down)\b/i.test(p)) {
    const bias = ema5Val && ema21Val ? (ema5Val > ema21Val ? "long" : "short") : direction === "bullish" ? "long" : direction === "bearish" ? "short" : "neutral";
    const sl = bias === "long" ? price * 0.99 : price * 1.01;
    const tp = bias === "long" ? price * 1.02 : price * 0.98;
    return `### DIRECTIONAL BIAS — ${snapshot.symbol} @ $${formattedPrice}

**Bias: ${bias === "long" ? "🟢 LONG" : bias === "short" ? "🔴 SHORT" : "🟡 NEUTRAL"}**

**Why:** EMA5 ($${ema5Txt}) ${ema5Val > ema21Val ? ">" : "<"} EMA21 ($${ema21Txt}), RSI **${rsiText}**, 24h ${change >= 0 ? "+" : ""}${change.toFixed(2)}%.

${bias === "neutral"
  ? `Price is balanced — wait for a decisive break of **$${fmt(price * 1.005)}** (long trigger) or **$${fmt(price * 0.995)}** (short trigger).`
  : `**Entry:** $${formattedPrice}  ·  **Stop:** $${fmt(sl)}  ·  **Target:** $${fmt(tp)}`}

*for study purpose only manage your risk.*`;
  }

  // Open-ended crypto/trading question — give a structured analyst-style answer
  // grounded in the live snapshot rather than a one-liner stub.
  const isOpenEnded = !p.includes("scalp") && !p.includes("signal") && !p.includes("entry") && p.length > 12;
  if (isOpenEnded) {
    const trendBias = Number.isFinite(ema5Val) && Number.isFinite(ema21Val)
      ? (ema5Val > ema21Val ? "bullish trend stack (EMA5 > EMA21)" : "bearish trend stack (EMA5 < EMA21)")
      : `${direction} 24h bias`;
    return `### THE NARRATIVE
At **$${formattedPrice}**, **${snapshot.symbol}** is printing a ${trendBias}. The 24h move sits at **${change >= 0 ? "+" : ""}${change.toFixed(2)}%** with RSI at **${rsiText}** — ${rsiVal > 70 ? "stretched overbought, watch for mean-reversion" : rsiVal < 30 ? "deeply oversold, primed for a relief bounce" : "neutral momentum, waiting for direction"}.

### KEY LEVELS
| Level | Price | Why It Matters |
| :--- | :--- | :--- |
| EMA 5 | $${ema5Txt} | Short-term trend pivot |
| EMA 21 | $${ema21Txt} | Mid-term trend bias |
| Range high | $${(price * 1.01).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })} | Liquidity above |
| Range low | $${(price * 0.99).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })} | Liquidity below |

### THE READ
${direction === "bullish"
  ? `Buyers are in control on the 24h tape. As long as price holds above **$${(price * 0.995).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })}**, dips are buyable into the EMA 5. A clean break of **$${(price * 1.01).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })}** opens the next expansion leg.`
  : direction === "bearish"
  ? `Sellers are pressing the tape. Below **$${(price * 1.005).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })}**, rips are sell-the-bounce. Loss of **$${(price * 0.99).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })}** unlocks the next leg down.`
  : `The tape is balanced. Wait for a decisive break of either **$${(price * 1.005).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })}** or **$${(price * 0.995).toLocaleString("en-US", { maximumFractionDigits: price >= 1 ? 2 : 8 })}** before committing size.`}

[VISUAL_SIGNAL]

### BOTTOM LINE
Bias is ${direction}. Watch RSI **${rsiText}** and the EMA 5/21 stack for confirmation before sizing up. *for study purpose only manage your risk.*`;
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

function isTransientStatus(status) {
  // 429 is intentionally NOT included — retrying on rate-limit just burns more
  // quota. Fail fast and surface the quota error to the user.
  return status === 408 || status === 409 || status === 425 || status >= 500;
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

  // --- OFF TOPIC / GIBBERISH / TOO-SHORT GUARDRAIL ---
  const textNoSpace = lowerPrompt.replace(/\s/g, '');
  const knownTickers = /^(btc|eth|sol|bnb|xrp|ada|doge|pepe|shib|matic|dot|link|avax|trx|ltc|atom|near|apt|arb|op|sui|inj|tia|sei)$/i;

  // Single-char or 2-char inputs that aren't known tickers — clearly not a question.
  const isTooShort = lowerPrompt.length > 0 && lowerPrompt.length < 3 && !knownTickers.test(lowerPrompt);
  // Random consonant clusters with no vowels/digits (e.g. "qwrtgz")
  const isGibberish = textNoSpace.length > 4 && !/[aeiouy0-9]/.test(textNoSpace);
  // Pure punctuation/symbol noise (e.g. "...", "??", "!!")
  const isJunkSymbols = lowerPrompt.length > 0 && lowerPrompt.length < 6 && !/[a-z0-9]/.test(lowerPrompt);

  // Refuse exact-match off-topic single words.
  const offTopicExact = new Set([
    "weather", "recipe", "cook", "cooking", "movie", "actor", "song", "music",
    "book", "author", "capital", "city", "country", "president", "politics",
    "football", "basketball", "soccer", "joke", "poem"
  ]);
  const isOffTopicWord = offTopicExact.has(lowerPrompt);

  if (isTooShort || isGibberish || isJunkSymbols || isOffTopicWord) {
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

    // Post-process provider output. Only substitute when the model truly failed
    // (empty / placeholder error). Trust real refusals and real answers as-is so
    // the user sees the model's actual response, not a structured template.
    let providerText = String(providerResult.text || "").trim();
    const trulyBroken =
      providerText.length < 30 ||
      /^I could not generate/i.test(providerText) ||
      /could not generate an analysis from the current context/i.test(providerText);

    if (trulyBroken) {
      providerText = buildFallbackTradingResponse({ prompt: body.prompt.trim(), snapshot: body.snapshot });
    }

    // Only inject [VISUAL_SIGNAL] when the response is clearly a full trade-signal
    // template (has THE SIGNAL or BOTTOM LINE sections). Conversational answers
    // about outlook/fundamentals/education should not be forced to show the cards.
    if (providerText && !providerText.includes('[VISUAL_SIGNAL]') && !providerText.includes("I'm your Quantichy AI")) {
      const isFullSignalTemplate = /### THE SIGNAL|### BOTTOM LINE/i.test(providerText);
      if (isFullSignalTemplate) {
        providerText = providerText.replace(/(\n### BOTTOM LINE)/i, '\n[VISUAL_SIGNAL]\n\n### BOTTOM LINE');
      }
    }

    const assistantMessage = {
      id: `msg_${crypto.randomUUID()}`,
      role: "assistant",
      content: providerText,
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
      message: error.message,
      providerBody: error.providerBody
    });

    // Always return the structured analyst fallback — never expose
    // provider-side errors (429 quota, 403 key) to the end user. The
    // failure mode is still visible in the function logs and via the
    // [ai-entry] provider diagnostic in the browser console.
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
      provider: "fallback-error",
      debugStatus: error.status || "unknown",
      debugMessage: error.message
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
 
