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

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      conversationId,
      clientMessageId,
      prompt,
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
