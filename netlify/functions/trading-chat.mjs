const JSON_HEADERS = {
  "Content-Type": "application/json"
};

const MAX_PROMPT_LENGTH = 2000;
const MAX_HISTORY_MESSAGES = 40;
const RECENT_TURN_LIMIT = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 12;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_OUTPUT_TOKENS = 512;

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
    maximumFractionDigits: snapshot.price >= 1 ? 2 : 8
  });

  return [
    "You are an expert cryptocurrency trading assistant integrated into a live trading dashboard.",
    "Use the current immutable market snapshot as context, not as guaranteed exchange truth.",
    `Current snapshot: ${snapshot.symbol} ${snapshot.instrumentType || ""} at ${formattedPrice} ${snapshot.quoteCurrency}, captured at ${snapshot.timestamp}.`,
    "Be concise, professional, and directly actionable in 1-3 short paragraphs.",
    "Discuss risk, invalidation, and uncertainty. Do not present financial advice as certainty.",
    "Include a brief reminder that the user is responsible for trading decisions."
  ].join("\n");
}

function buildGeminiPayload({ prompt, history, snapshot }) {
  const context = buildConversationContext(history, snapshot);
  const contextText = [
    context.summary ? `Older conversation summary:\n${context.summary}` : "",
    context.recentMessages.length
      ? `Recent conversation:\n${context.recentMessages
          .map((message) => `${message.role}: ${message.content}`)
          .join("\n")}`
      : "",
    `Latest user prompt:\n${prompt}`
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    systemInstruction: {
      parts: [{ text: buildSystemInstruction(snapshot) }]
    },
    contents: [{ role: "user", parts: [{ text: contextText }] }],
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.4
    }
  };
}

function isTransientStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function fetchGemini({ apiKey, model, payload }) {
  const encodedModel = encodeURIComponent(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:generateContent`;
  let delay = 500;
  let lastError;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
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

  const apiKey = getEnv("GEMINI_API_KEY");
  if (!apiKey) {
    return json(500, { error: "Trading chat provider is not configured" });
  }

  const conversationId = body.conversationId || `conv_${crypto.randomUUID()}`;
  const model = getEnv("GEMINI_MODEL") || FALLBACK_MODEL;
  const providerPayload = buildGeminiPayload({
    prompt: body.prompt.trim(),
    history: body.history,
    snapshot: body.snapshot
  });
  const startedAt = Date.now();

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

    return json(502, {
      error: "The analysis engine is temporarily unavailable. Please try again shortly."
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
