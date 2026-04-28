import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { copyMarketSnapshot } from "./tradingChatUtils.mjs";

const DEFAULT_QUICK_PROMPTS = [
  "Analyze current entry points based on the live price.",
  "What is Funding Rate and why does it matter right now?",
  "Give me a short risk-management checklist for this volatility."
];

const DEFAULT_MESSAGES = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "Hello. I am connected to your live market feed. Whenever you ask a question, I will analyze the exact price snapshot captured when you send it.",
    createdAt: new Date(0).toISOString()
  }
];
const MAX_PAYLOAD_HISTORY = 40;

function formatPrice(market) {
  const price = Number(market.price);
  const precision = Number.isInteger(market.pricePrecision)
    ? market.pricePrecision
    : price >= 1
      ? 2
      : 8;
  const prefix = ["USD", "USDT", "USDC"].includes(market.quoteCurrency) ? "$" : "";

  return `${prefix}${price.toLocaleString(
    "en-US",
    {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision
    }
  )}`;
}

const ChatHeader = memo(function ChatHeader({ market, disabled, onClear }) {
  const isUp = Number(market.change24hPct || 0) >= 0;
  const badgeClass = isUp
    ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
    : "border-rose-500/30 bg-rose-500/15 text-rose-300";

  return (
    <header className="flex items-center justify-between border-b border-slate-700 bg-slate-800 px-4 py-3">
      <div>
        <h2 className="text-sm font-bold text-slate-100">AI Trading Copilot</h2>
        <p className="text-xs text-slate-400">{market.symbol}</p>
      </div>
      <div className="flex items-center gap-2">
        <div className={`rounded border px-2 py-1 font-mono text-xs ${badgeClass}`}>
          Live: {formatPrice(market)}
        </div>
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear
          </button>
        ) : null}
      </div>
    </header>
  );
});

const MessageBubble = memo(function MessageBubble({
  message,
  onCopyMessage,
  onFeedback,
  onRetry
}) {
  const isUser = message.role === "user";
  const label = isUser ? "You" : "Copilot";
  const wrapperClass = isUser
    ? "ml-auto items-end"
    : "mr-auto items-start";
  const bubbleClass = isUser
    ? "rounded-2xl rounded-tr-none bg-indigo-600 text-white"
    : "rounded-2xl rounded-tl-none border border-slate-600 bg-slate-700 text-slate-100";

  return (
    <div className={`flex max-w-[85%] flex-col ${wrapperClass}`}>
      <span className="mb-1 px-1 text-xs text-slate-400">{label}</span>
      <div className={`whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed shadow-sm ${bubbleClass}`}>
        {message.content}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
        {message.snapshot ? (
          <span>Snapshot: {formatPrice(message.snapshot)}</span>
        ) : null}
        {message.status === "error" && onRetry ? (
          <button type="button" onClick={() => onRetry(message.id)} className="text-rose-300">
            Retry
          </button>
        ) : null}
        {onCopyMessage ? (
          <button type="button" onClick={() => onCopyMessage(message.id)}>
            Copy
          </button>
        ) : null}
        {onFeedback && !isUser ? (
          <>
            <button type="button" onClick={() => onFeedback(message.id, "up")}>
              Good
            </button>
            <button type="button" onClick={() => onFeedback(message.id, "down")}>
              Bad
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
});

const MessageList = memo(function MessageList({
  messages,
  maxVisibleMessages,
  isStreaming,
  onCopyMessage,
  onFeedback,
  onRetry
}) {
  const scrollRef = useRef(null);
  const shouldStickRef = useRef(true);
  const visibleMessages = useMemo(() => {
    if (!maxVisibleMessages || messages.length <= maxVisibleMessages) return messages;
    return messages.slice(-maxVisibleMessages);
  }, [maxVisibleMessages, messages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldStickRef.current = distanceFromBottom < 80;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !shouldStickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visibleMessages.length, isStreaming]);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 space-y-4 overflow-y-auto bg-slate-800/50 p-4"
    >
      {visibleMessages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          onCopyMessage={onCopyMessage}
          onFeedback={onFeedback}
          onRetry={onRetry}
        />
      ))}
      {isStreaming ? (
        <div className="mr-auto w-fit rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-400">
          Analyzing live data...
        </div>
      ) : null}
    </div>
  );
});

const QuickPrompts = memo(function QuickPrompts({ prompts, disabled, onSelect }) {
  if (!prompts.length) return null;

  return (
    <div className="flex gap-2 overflow-x-auto pb-3">
      {prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(prompt)}
          className="whitespace-nowrap rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-300 transition-colors hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {prompt}
        </button>
      ))}
    </div>
  );
});

const Composer = memo(function Composer({ disabled, isSending, onSubmit }) {
  const [draft, setDraft] = useState("");

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || disabled || isSending) return;
    setDraft("");
    onSubmit(text);
  }, [disabled, draft, isSending, onSubmit]);

  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
        disabled={disabled}
        placeholder="e.g. Is this a good entry?"
        className="min-w-0 flex-1 rounded-lg border border-slate-600 bg-slate-900 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 transition-all focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled || isSending}
        className="min-w-[80px] rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-900/20 transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSending ? "Sending" : "Send"}
      </button>
    </div>
  );
});

export default function AITradingChat({
  market,
  messages,
  initialMessages = DEFAULT_MESSAGES,
  disabled = false,
  isStreaming = false,
  quickPrompts = DEFAULT_QUICK_PROMPTS,
  maxVisibleMessages = 100,
  onSend,
  onRetry,
  onClear,
  onCopyMessage,
  onFeedback
}) {
  const isControlled = Array.isArray(messages);
  const [internalMessages, setInternalMessages] = useState(initialMessages);
  const [isSending, setIsSending] = useState(false);
  const latestMarketRef = useRef(market);
  const messagesRef = useRef(isControlled ? messages : internalMessages);

  useEffect(() => {
    latestMarketRef.current = market;
  }, [market]);

  const effectiveMessages = isControlled ? messages : internalMessages;

  useEffect(() => {
    messagesRef.current = effectiveMessages;
  }, [effectiveMessages]);

  const appendInternalMessage = useCallback((message) => {
    if (!isControlled) {
      setInternalMessages((prev) => [...prev, message]);
    }
  }, [isControlled]);

  const submitPrompt = useCallback(async (prompt) => {
    if (!prompt.trim() || !onSend) return;

    const snapshot = copyMarketSnapshot(latestMarketRef.current);
    const clientMessageId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    const userMessage = {
      id: clientMessageId,
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
      snapshot,
      status: "sending"
    };

    appendInternalMessage(userMessage);
    setIsSending(true);

    try {
      const result = await onSend({
        prompt,
        snapshot,
        history: messagesRef.current.slice(-MAX_PAYLOAD_HISTORY),
        clientMessageId
      });

      if (!isControlled) {
        setInternalMessages((prev) =>
          prev.map((message) =>
            message.id === clientMessageId ? { ...message, status: "sent" } : message
          )
        );
        if (result?.message) appendInternalMessage(result.message);
      }
    } catch (error) {
      console.error("[AITradingChat] send failed", error);
      if (!isControlled) {
        setInternalMessages((prev) =>
          prev.map((message) =>
            message.id === clientMessageId ? { ...message, status: "error" } : message
          )
        );
        appendInternalMessage({
          id: `error_${clientMessageId}`,
          role: "assistant",
          content:
            "The analysis engine is temporarily unavailable. Please try again shortly.",
          createdAt: new Date().toISOString(),
          status: "error"
        });
      }
    } finally {
      setIsSending(false);
    }
  }, [appendInternalMessage, isControlled, onSend]);

  return (
    <aside className="flex h-full min-h-[480px] w-full flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-800 text-slate-100 shadow-2xl">
      <ChatHeader market={market} disabled={disabled} onClear={onClear} />
      <MessageList
        messages={effectiveMessages}
        maxVisibleMessages={maxVisibleMessages}
        isStreaming={isStreaming || isSending}
        onCopyMessage={onCopyMessage}
        onFeedback={onFeedback}
        onRetry={onRetry}
      />
      <footer className="border-t border-slate-700 bg-slate-800 p-4">
        <QuickPrompts
          prompts={quickPrompts}
          disabled={disabled || isSending}
          onSelect={submitPrompt}
        />
        <Composer disabled={disabled} isSending={isSending} onSubmit={submitPrompt} />
        <p className="mt-2 text-center text-[10px] text-slate-500">
          AI answers use the immutable live price snapshot captured when you send.
        </p>
      </footer>
    </aside>
  );
}
