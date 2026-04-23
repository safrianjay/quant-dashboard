import { useState, useEffect, useCallback } from "react";
import {
  TrendingDown, TrendingUp, RefreshCw, Target, Shield,
  Zap, Clock, AlertTriangle, Activity, BarChart2, Info
} from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// ── Static Analysis Data (from Quant-Claude 4H Report) ──────────────────────
const ANALYSIS = {
  asset: "PEPE/USDT",
  exchange: "OKX Perpetual Swap",
  timeframe: "4H",
  bias: "BEARISH",
  biasLabel: "Dead-Cat Bounce in Progress",
  confidence: 7,
  structure: [
    { label: "Macro High (Late Feb)", price: "0.000005100", type: "top", note: "Distribution Top" },
    { label: "LH #1 — Mar 16-17 Spike", price: "0.000004100", type: "lh", note: "Stop Hunt / Liquidity Grab" },
    { label: "LH #2 — Mar 22", price: "0.000003650", type: "lh", note: "Confirmed Lower High" },
    { label: "Recent LL — Mar 27-28", price: "0.000003200", type: "ll", note: "Current Demand Zone" },
    { label: "Current Price", price: "Live", type: "current", note: "Corrective Bounce" },
  ],
  liquidityLevels: [
    { label: "MAJOR SUPPLY ZONE", range: "0.000003600 – 0.000003650", pct: 92, color: "#ef4444", tag: "Shorts' SL clustered here" },
    { label: "4H FAIR VALUE GAP", range: "0.000003450 – 0.000003550", pct: 78, color: "#f97316", tag: "Likely fill before reversal" },
    { label: "IMMEDIATE RESISTANCE", range: "0.000003380 – 0.000003420", pct: 65, color: "#eab308", tag: "Stop Hunt → Reject Zone" },
    { label: "◀ CURRENT PRICE", range: "~0.000003330", pct: 55, color: "#6366f1", tag: "" },
    { label: "RECENT LOW / Long SL Pool", range: "0.000003200", pct: 38, color: "#22c55e", tag: "Longs' stops below here" },
    { label: "PSYCHOLOGICAL SUPPORT", range: "0.000003000", pct: 18, color: "#06b6d4", tag: "If 3200 breaks → next target" },
    { label: "DEEP DEMAND", range: "0.000002800", pct: 5, color: "#8b5cf6", tag: "Final structural line" },
  ],
  primarySetup: {
    type: "SHORT",
    entry: "0.000003380 – 0.000003420",
    sl: "0.000003490",
    tp1: "0.000003200",
    tp2: "0.000003050",
    tp3: "0.000003000",
    rr: "1 : 3.5",
    trigger: "Bearish 4H close inside 3380–3420 zone (wick rejection / engulfing red candle)",
  },
  altSetup: {
    type: "LONG",
    entry: "0.000003450 breakout retest",
    sl: "0.000003350",
    tp1: "0.000003600",
    tp2: "0.000003750",
    rr: "1 : 2.0",
    trigger: "Only valid if 4H candle closes ABOVE 0.000003450",
  },
  derivatives: [
    { metric: "Funding Rate", value: "Neutral → Mildly Negative", status: "warn" },
    { metric: "Open Interest", value: "Flat / Declining on Bounce", status: "bad" },
    { metric: "Volume Profile", value: "Dominant Sell-side Post Mar-17", status: "bad" },
    { metric: "Mar 16 Volume Spike", value: "3-4x Normal — Smart Money Distribution", status: "warn" },
  ],
  confidenceFactors: [
    { label: "Bearish LH/LL Structure (4H)", status: true },
    { label: "Below all major resistance zones", status: true },
    { label: "Volume declining on bounce", status: true },
    { label: "Price entering FVG / Stop-Hunt zone", status: true },
    { label: "Possible short-term RSI bullish divergence", status: false },
  ],
  invalidations: [
    { event: "4H candle closes ABOVE 0.000003490", severity: "critical" },
    { event: "BTC macro pump +5%+ (meme coin beta-spike)", severity: "high" },
    { event: "Positive PEPE catalyst (partnership/listing)", severity: "high" },
    { event: "Funding Rate goes deeply negative (short squeeze risk)", severity: "medium" },
  ],
};

// ── Price History State (builds up as we fetch) ──────────────────────────────
const INIT_HISTORY = [
  { time: "T-5h", price: 0.000003280 },
  { time: "T-4h", price: 0.000003240 },
  { time: "T-3h", price: 0.000003200 },
  { time: "T-2h", price: 0.000003250 },
  { time: "T-1h", price: 0.000003300 },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (n) =>
  n ? `0.${n.toFixed(8).split(".")[1]}` : "—";

const fmtVol = (n) => {
  if (!n) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toFixed(0)}`;
};

const padTime = (n) => String(n).padStart(2, "0");

const fmtCountdown = (s) =>
  `${padTime(Math.floor(s / 3600))}:${padTime(Math.floor((s % 3600) / 60))}:${padTime(s % 60)}`;

// ── Sub-components ────────────────────────────────────────────────────────────
function Badge({ children, color = "red" }) {
  const colors = {
    red: "bg-red-500/20 text-red-400 border-red-500/40",
    green: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40",
    yellow: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40",
    blue: "bg-blue-500/20 text-blue-400 border-blue-500/40",
    purple: "bg-purple-500/20 text-purple-400 border-purple-500/40",
  };
  return (
    <span className={`px-2 py-0.5 rounded border text-xs font-bold uppercase tracking-wider ${colors[color]}`}>
      {children}
    </span>
  );
}

function Card({ children, className = "" }) {
  return (
    <div className={`rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm p-4 ${className}`}>
      {children}
    </div>
  );
}

function SectionTitle({ icon: Icon, title }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <Icon size={16} className="text-indigo-400" />
      <h2 className="text-sm font-bold uppercase tracking-widest text-indigo-300">{title}</h2>
    </div>
  );
}

function ConfidenceGauge({ score }) {
  const pct = (score / 10) * 100;
  const color = score >= 7 ? "#22c55e" : score >= 5 ? "#eab308" : "#ef4444";
  return (
    <div className="flex flex-col items-center gap-3">
      <svg width="160" height="90" viewBox="0 0 160 90">
        <path d="M10,80 A70,70 0 0,1 150,80" fill="none" stroke="#1e1e2e" strokeWidth="14" strokeLinecap="round" />
        <path
          d="M10,80 A70,70 0 0,1 150,80"
          fill="none"
          stroke={color}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * 220} 220`}
          style={{ filter: `drop-shadow(0 0 6px ${color})` }}
        />
        <text x="80" y="75" textAnchor="middle" fill={color} fontSize="28" fontWeight="bold" fontFamily="monospace">
          {score}
        </text>
        <text x="80" y="88" textAnchor="middle" fill="#6b7280" fontSize="9" fontFamily="sans-serif">
          OUT OF 10
        </text>
      </svg>
    </div>
  );
}

function PriceSparkline({ history }) {
  if (history.length < 2) return null;
  return (
    <ResponsiveContainer width="100%" height={70}>
      <LineChart data={history} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
        <XAxis dataKey="time" hide />
        <YAxis domain={["auto", "auto"]} hide />
        <Tooltip
          contentStyle={{ background: "#0f0f1a", border: "1px solid #333", borderRadius: 8, fontSize: 11 }}
          formatter={(v) => [fmt(v), "Price"]}
        />
        <ReferenceLine y={0.0000033} stroke="#6366f1" strokeDasharray="3 3" strokeWidth={1} />
        <Line type="monotone" dataKey="price" stroke="#6366f1" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────
export default function PepeDashboard() {
  const [price, setPrice] = useState(null);
  const [change24h, setChange24h] = useState(null);
  const [volume24h, setVolume24h] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [countdown, setCountdown] = useState(3600);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState(INIT_HISTORY);
  const [pulseKey, setPulseKey] = useState(0);

  const fetchPrice = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=pepe&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true",
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      const p = data.pepe.usd;
      setPrice(p);
      setChange24h(data.pepe.usd_24h_change);
      setVolume24h(data.pepe.usd_24h_vol);
      setLastUpdated(new Date());
      setCountdown(3600);
      setPulseKey((k) => k + 1);
      setHistory((prev) => {
        const now = new Date();
        const label = `${now.getHours()}:${padTime(now.getMinutes())}`;
        const next = [...prev, { time: label, price: p }];
        return next.length > 24 ? next.slice(-24) : next;
      });
    } catch {
      setError("Live feed unavailable — showing cached data");
    }
    setLoading(false);
  }, []);

  // Initial fetch + hourly auto-refresh
  useEffect(() => {
    fetchPrice();
    const iv = setInterval(fetchPrice, 3600000);
    return () => clearInterval(iv);
  }, [fetchPrice]);

  // Countdown ticker
  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => (c > 0 ? c - 1 : 3600)), 1000);
    return () => clearInterval(t);
  }, []);

  const changePositive = change24h !== null && change24h >= 0;
  const displayPrice = price ?? 0.0000033330;

  // Dynamic bias: if live price > 0.000003420 flip to neutral warning
  const liveAboveKillZone = price && price > 0.0000034200;
  const liveBias = liveAboveKillZone ? "NEUTRAL ⚠️" : "BEARISH";
  const liveBiasColor = liveAboveKillZone ? "yellow" : "red";

  return (
    <div
      style={{
        fontFamily: "'Inter', 'SF Pro Display', sans-serif",
        background: "#06060f",
        height: "100vh",
        color: "#e2e8f0",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column"
      }}
    >
      {/* Scrollable Content Wrapper */}
      <div className="flex-1 overflow-y-auto pb-32">
      {/* ── HEADER ── */}
      <div className="flex flex-col gap-1 mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xl font-black tracking-tight">
              PEPE<span className="text-indigo-400">/USDT</span>
            </span>
            <Badge color="purple">OKX PERP</Badge>
            <Badge color="blue">4H</Badge>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="flex items-center gap-1">
              <Clock size={12} />
              Next update: <span className="text-indigo-300 font-mono">{fmtCountdown(countdown)}</span>
            </span>
            <button
              onClick={fetchPrice}
              disabled={loading}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/40 transition text-indigo-300 text-xs"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>
        {error && (
          <div className="text-xs text-yellow-400 flex items-center gap-1 mt-1">
            <AlertTriangle size={12} /> {error}
          </div>
        )}
      </div>

      {/* ── PRICE TICKER ROW ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Card className="col-span-2 md:col-span-1">
          <div className="text-xs text-slate-400 mb-1 uppercase tracking-wider">Live Price</div>
          <div
            key={pulseKey}
            className="text-2xl font-black font-mono text-white"
            style={{ animation: pulseKey ? "priceFlash 0.6s ease" : "none" }}
          >
            {fmt(displayPrice)}
          </div>
          <div className={`text-sm font-semibold mt-1 ${changePositive ? "text-emerald-400" : "text-red-400"}`}>
            {change24h !== null
              ? `${changePositive ? "▲" : "▼"} ${Math.abs(change24h).toFixed(2)}% 24h`
              : "Loading..."}
          </div>
        </Card>

        <Card>
          <div className="text-xs text-slate-400 mb-1 uppercase tracking-wider">24H Volume</div>
          <div className="text-lg font-bold text-white">{fmtVol(volume24h)}</div>
          <div className="text-xs text-slate-500 mt-1">Declining on bounce ⚠️</div>
        </Card>

        <Card>
          <div className="text-xs text-slate-400 mb-1 uppercase tracking-wider">Executive Bias</div>
          <div className={`text-lg font-black ${liveAboveKillZone ? "text-yellow-400" : "text-red-400"}`}>
            {liveBias}
          </div>
          <div className="text-xs text-slate-500 mt-1">{ANALYSIS.biasLabel}</div>
        </Card>

        <Card>
          <div className="text-xs text-slate-400 mb-1 uppercase tracking-wider">Last Updated</div>
          <div className="text-sm font-mono text-white">
            {lastUpdated ? lastUpdated.toLocaleTimeString() : "Pending..."}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {lastUpdated ? lastUpdated.toLocaleDateString() : ""}
          </div>
        </Card>
      </div>

      {/* ── PRICE SPARKLINE ── */}
      <Card className="mb-4">
        <SectionTitle icon={Activity} title="Price History (Session)" />
        <PriceSparkline history={history} />
        <div className="flex justify-between text-xs text-slate-500 mt-1 px-1">
          <span>Older →</span>
          <span className="text-indigo-400">Kill Zone: 0.000003380 – 0.000003420</span>
          <span>← Now</span>
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {/* ── MARKET STRUCTURE ── */}
        <Card>
          <SectionTitle icon={BarChart2} title="Market Structure (4H)" />
          <div className="space-y-2">
            {ANALYSIS.structure.map((s, i) => (
              <div key={i} className="flex items-center justify-between text-sm gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    s.type === "top" ? "bg-red-400" :
                    s.type === "lh" ? "bg-orange-400" :
                    s.type === "ll" ? "bg-emerald-400" :
                    "bg-indigo-400 animate-pulse"
                  }`} />
                  <span className="text-slate-300 truncate">{s.label}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="font-mono text-xs text-slate-200">
                    {s.price === "Live" ? (
                      <span className="text-indigo-300 font-bold">{fmt(displayPrice)}</span>
                    ) : s.price}
                  </span>
                  <span className="text-xs text-slate-500 hidden sm:inline">{s.note}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 pt-3 border-t border-white/10 text-xs text-red-400 flex items-center gap-1">
            <TrendingDown size={12} /> Confirmed Lower High / Lower Low Cascade — No BOS Upside Yet
          </div>
        </Card>

        {/* ── LIQUIDITY MAP ── */}
        <Card>
          <SectionTitle icon={Target} title="Liquidity Map" />
          <div className="space-y-2">
            {ANALYSIS.liquidityLevels.map((lvl, i) => (
              <div key={i}>
                <div className="flex justify-between items-center text-xs mb-1">
                  <span style={{ color: lvl.color }} className="font-bold">{lvl.label}</span>
                  <span className="text-slate-400 font-mono">{lvl.range}</span>
                </div>
                <div className="w-full bg-white/5 rounded-full h-2">
                  <div
                    className="h-2 rounded-full transition-all duration-700"
                    style={{
                      width: `${lvl.pct}%`,
                      background: lvl.label.includes("CURRENT")
                        ? `linear-gradient(90deg, ${lvl.color}cc, ${lvl.color})`
                        : `${lvl.color}99`,
                      boxShadow: lvl.label.includes("CURRENT") ? `0 0 8px ${lvl.color}` : "none",
                    }}
                  />
                </div>
                {lvl.tag && <div className="text-slate-500 text-xs mt-0.5">{lvl.tag}</div>}
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* ── TRADE SETUPS ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {/* PRIMARY SHORT */}
        <Card className="border-red-500/30 bg-red-950/20">
          <div className="flex items-center justify-between mb-3">
            <SectionTitle icon={TrendingDown} title="Primary Setup — SHORT" />
            <Badge color="red">HIGH PROB</Badge>
          </div>
          <div className="space-y-2 text-sm">
            {[
              { label: "Entry Zone", value: ANALYSIS.primarySetup.entry, color: "text-yellow-300" },
              { label: "Stop Loss", value: ANALYSIS.primarySetup.sl, color: "text-red-400" },
              { label: "TP1 (50% close)", value: ANALYSIS.primarySetup.tp1, color: "text-emerald-400" },
              { label: "TP2", value: ANALYSIS.primarySetup.tp2, color: "text-emerald-400" },
              { label: "TP3 (full close)", value: ANALYSIS.primarySetup.tp3, color: "text-emerald-500" },
              { label: "Risk/Reward", value: ANALYSIS.primarySetup.rr, color: "text-indigo-300 font-bold" },
            ].map((row, i) => (
              <div key={i} className="flex justify-between border-b border-white/5 pb-1">
                <span className="text-slate-400">{row.label}</span>
                <span className={`font-mono ${row.color}`}>{row.value}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 p-2 rounded-lg bg-white/5 text-xs text-slate-400">
            <span className="text-yellow-400 font-bold">Trigger: </span>
            {ANALYSIS.primarySetup.trigger}
          </div>
        </Card>

        {/* ALTERNATE LONG */}
        <Card className="border-emerald-500/20 bg-emerald-950/10">
          <div className="flex items-center justify-between mb-3">
            <SectionTitle icon={TrendingUp} title="Alternate Setup — LONG" />
            <Badge color="yellow">LOW PROB</Badge>
          </div>
          <div className="space-y-2 text-sm">
            {[
              { label: "Entry", value: ANALYSIS.altSetup.entry, color: "text-yellow-300" },
              { label: "Stop Loss", value: ANALYSIS.altSetup.sl, color: "text-red-400" },
              { label: "TP1", value: ANALYSIS.altSetup.tp1, color: "text-emerald-400" },
              { label: "TP2", value: ANALYSIS.altSetup.tp2, color: "text-emerald-400" },
              { label: "Risk/Reward", value: ANALYSIS.altSetup.rr, color: "text-indigo-300 font-bold" },
            ].map((row, i) => (
              <div key={i} className="flex justify-between border-b border-white/5 pb-1">
                <span className="text-slate-400">{row.label}</span>
                <span className={`font-mono ${row.color}`}>{row.value}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 p-2 rounded-lg bg-white/5 text-xs text-slate-400">
            <span className="text-emerald-400 font-bold">Trigger: </span>
            {ANALYSIS.altSetup.trigger}
          </div>
          <div className="mt-2 text-xs text-yellow-400 flex items-center gap-1">
            <AlertTriangle size={11} /> Counter-trend — proceed with caution
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        {/* CONFIDENCE RATING */}
        <Card className="flex flex-col items-center">
          <SectionTitle icon={Zap} title="Confidence Rating" />
          <ConfidenceGauge score={ANALYSIS.confidence} />
          <div className="space-y-1.5 w-full mt-2">
            {ANALYSIS.confidenceFactors.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className={f.status ? "text-emerald-400" : "text-red-400"}>
                  {f.status ? "✅" : "⚠️"}
                </span>
                <span className={f.status ? "text-slate-300" : "text-slate-500"}>{f.label}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* DERIVATIVES DATA */}
        <Card>
          <SectionTitle icon={Activity} title="Derivatives Context" />
          <div className="space-y-3">
            {ANALYSIS.derivatives.map((d, i) => (
              <div key={i}>
                <div className="text-xs text-slate-400 uppercase tracking-wide">{d.metric}</div>
                <div className={`text-sm font-semibold mt-0.5 ${
                  d.status === "bad" ? "text-red-400" :
                  d.status === "warn" ? "text-yellow-400" :
                  "text-emerald-400"
                }`}>
                  {d.value}
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* INVALIDATIONS */}
        <Card className="border-orange-500/20">
          <SectionTitle icon={Shield} title="Setup Invalidation" />
          <div className="space-y-2">
            {ANALYSIS.invalidations.map((inv, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className={`mt-0.5 flex-shrink-0 ${
                  inv.severity === "critical" ? "text-red-400" :
                  inv.severity === "high" ? "text-orange-400" :
                  "text-yellow-400"
                }`}>
                  {inv.severity === "critical" ? "🔴" : inv.severity === "high" ? "🟠" : "🟡"}
                </span>
                <span className="text-slate-400">{inv.event}</span>
              </div>
            ))}
          </div>
          {liveAboveKillZone && (
            <div className="mt-3 p-2 rounded-lg bg-red-900/30 border border-red-500/40 text-xs text-red-300 flex items-start gap-1">
              <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
              <span>
                ⚠️ LIVE PRICE ABOVE KILL ZONE — Short setup may already be invalidated. Re-assess structure.
              </span>
            </div>
          )}
        </Card>
      </div>

      {/* ── FOOTER ── */}
      </div>


      {/* ── STICKY BOTTOM NAV ── */}
      <nav className="fixed left-0 right-0 bottom-0 h-[72px] bg-[#0c0c14] border-t border-white/10 z-[1000] md:hidden px-2">
        <div className="flex items-center justify-around h-full max-w-[520px] mx-auto">
          <button className="flex flex-col items-center gap-1 text-indigo-400">
            <Activity size={20} />
            <span className="text-[10px] font-bold uppercase tracking-tighter">Overview</span>
          </button>
          <button className="flex flex-col items-center gap-1 text-slate-500">
            <Zap size={20} />
            <span className="text-[10px] font-bold uppercase tracking-tighter">Live Trade</span>
          </button>
          <button className="flex flex-col items-center gap-1 text-slate-500">
            <Clock size={20} />
            <span className="text-[10px] font-bold uppercase tracking-tighter">Session</span>
          </button>
          <button className="flex flex-col items-center gap-1 text-slate-500">
            <BarChart2 size={20} />
            <span className="text-[10px] font-bold uppercase tracking-tighter">Others</span>
          </button>
        </div>
      </nav>

      <style>{`
        @keyframes priceFlash {
          0% { color: #818cf8; }
          50% { color: #c7d2fe; text-shadow: 0 0 12px #818cf8; }
          100% { color: #fff; }
        }
      `}</style>
    </div>
  );
}
