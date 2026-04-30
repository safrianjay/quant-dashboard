export async function sendTradingChatMessage({
  endpoint = "/api/trading-chat/messages",
  token,
  conversationId,
  clientMessageId,
  prompt,
  snapshot,
  history = [],
  signal
}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Updated system instruction with strict guardrails
  const systemInstruction = `You are an elite crypto trading assistant. You must ONLY answer questions related to cryptocurrency, trading strategies, technical analysis, and finance. If the user asks an open-ended question about anything else (e.g., coding, general knowledge, recipes, personal advice), you MUST politely refuse and state you only assist with crypto trading. Always use the provided Live Market Price context in your reasoning.`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      conversationId,
      clientMessageId,
      prompt: `${systemInstruction}\n${prompt}`, // Prepend system instruction to user prompt
      snapshot,
      history
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error || `Trading chat request failed with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.details = body.details;
    throw error;
  }

  return body;
}
