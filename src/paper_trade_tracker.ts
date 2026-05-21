// src/paper_trade_tracker.ts
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PAPER_TRADES_FILE = path.resolve(__dirname, "../data/paper_trades.json");
const STATS_FILE = path.resolve(__dirname, "../data/paper_trade_stats.json");
const POLL_INTERVAL_MS = 60_000;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MS_72H = 72 * 60 * 60 * 1000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- Types ---

interface TpLevel {
  multiple: number;
  pct: number;
  hit: boolean;
  hit_at: string | null;
}

interface PaperTrade {
  id: string;
  mint_address: string;
  chain: string;
  entry_price_sol: number | null;
  size_sol: number;
  entered_at: string;
  status: "OPEN" | "CLOSED";
  t1_channel: string;
  t2_channel: string;
  hours_between_calls: number;
  pct_of_way_to_peak: number;
  tp_levels: TpLevel[];
  stop_loss_pct: number;
  stop_hit: boolean;
  stop_hit_at: string | null;
  closed_at: string | null;
  realized_multiple: number | null;
  realized_sol: number | null;
  notes: string;
}

interface PaperTradeStats {
  last_updated: string;
  last_daily_summary_sent_date: string | null;
  total_trades: number;
  open_trades: number;
  closed_trades: number;
  win_rate_2x: number;
  win_rate_5x: number;
  total_invested_sol: number;
  total_returned_sol: number;
  total_pnl_sol: number;
  avg_multiple: number;
  best_trade_multiple: number;
  worst_trade_multiple: number;
}

// --- Logging ---

function log(...args: any[]) {
  console.log("[PAPER-TRACKER]", ...args);
}

// --- File I/O ---

function loadTrades(): PaperTrade[] {
  try {
    if (!fs.existsSync(PAPER_TRADES_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(PAPER_TRADES_FILE, "utf8"));
    return Array.isArray(raw.trades) ? raw.trades : [];
  } catch (e) {
    log("Failed to load paper_trades.json:", e);
    return [];
  }
}

function saveTrades(trades: PaperTrade[]) {
  try {
    fs.writeFileSync(PAPER_TRADES_FILE, JSON.stringify({ trades }, null, 2));
  } catch (e) {
    log("Failed to save paper_trades.json:", e);
  }
}

function loadStats(): PaperTradeStats {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    }
  } catch {}
  return {
    last_updated: new Date().toISOString(),
    last_daily_summary_sent_date: null,
    total_trades: 0,
    open_trades: 0,
    closed_trades: 0,
    win_rate_2x: 0,
    win_rate_5x: 0,
    total_invested_sol: 0,
    total_returned_sol: 0,
    total_pnl_sol: 0,
    avg_multiple: 0,
    best_trade_multiple: 0,
    worst_trade_multiple: 0,
  };
}

function saveStats(stats: PaperTradeStats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) {
    log("Failed to save paper_trade_stats.json:", e);
  }
}

// --- Telegram ---

async function sendTelegram(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          disable_web_page_preview: true,
        }),
      }
    );
    if (!res.ok) {
      log("Telegram send failed:", res.status, await res.text());
    }
  } catch (e) {
    log("Telegram error:", e);
  }
}

// --- Jupiter price ---

async function getCurrentPrice(mint: string): Promise<number | null> {
  try {
    const url = new URL("/swap/v1/quote", "https://lite-api.jup.ag");
    url.searchParams.set("inputMint", SOL_MINT);
    url.searchParams.set("outputMint", mint);
    url.searchParams.set("amount", "1000000000");
    url.searchParams.set("slippageBps", "500");

    const res = await fetch(url.toString());
    if (!res.ok) return null;

    const quote = (await res.json()) as any;
    const outAmount = Number(quote.outAmount);
    if (!outAmount || outAmount === 0) return null;

    return 1 / (outAmount / 1e9);
  } catch {
    return null;
  }
}

// --- Realized SOL ---

function computeRealizedSol(trade: PaperTrade, currentMultiple: number): number {
  if (trade.stop_hit) {
    return trade.size_sol * currentMultiple;
  }

  let realized = 0;
  let soldPct = 0;

  for (const tp of trade.tp_levels) {
    if (tp.hit) {
      realized += trade.size_sol * tp.pct * tp.multiple;
      soldPct += tp.pct;
    }
  }

  // remaining position (including 10% moonshot) exits at current price
  const remaining = 1 - soldPct;
  if (remaining > 0) {
    realized += trade.size_sol * remaining * currentMultiple;
  }

  return realized;
}

// --- Stats ---

function computeStats(trades: PaperTrade[], prevStats: PaperTradeStats): PaperTradeStats {
  const closed = trades.filter((t) => t.status === "CLOSED");
  const open = trades.filter((t) => t.status === "OPEN");
  const closedCount = closed.length;

  const hit2x = closed.filter((t) => t.tp_levels.some((tp) => tp.multiple === 2.0 && tp.hit)).length;
  const hit5x = closed.filter((t) => t.tp_levels.some((tp) => tp.multiple === 5.0 && tp.hit)).length;

  const totalInvested = closed.reduce((sum, t) => sum + t.size_sol, 0);
  const totalReturned = closed.reduce((sum, t) => sum + (t.realized_sol ?? 0), 0);

  const multiples = closed.map((t) => t.realized_multiple ?? 0).filter((m) => m > 0);
  const avgMultiple =
    multiples.length > 0 ? multiples.reduce((a, b) => a + b, 0) / multiples.length : 0;
  const bestMultiple = multiples.length > 0 ? Math.max(...multiples) : 0;
  const worstMultiple = multiples.length > 0 ? Math.min(...multiples) : 0;

  return {
    last_updated: new Date().toISOString(),
    last_daily_summary_sent_date: prevStats.last_daily_summary_sent_date,
    total_trades: trades.length,
    open_trades: open.length,
    closed_trades: closedCount,
    win_rate_2x: closedCount > 0 ? hit2x / closedCount : 0,
    win_rate_5x: closedCount > 0 ? hit5x / closedCount : 0,
    total_invested_sol: totalInvested,
    total_returned_sol: totalReturned,
    total_pnl_sol: totalReturned - totalInvested,
    avg_multiple: avgMultiple,
    best_trade_multiple: bestMultiple,
    worst_trade_multiple: worstMultiple,
  };
}

// --- Daily summary ---

function shouldSendDailySummary(stats: PaperTradeStats): boolean {
  const now = new Date();
  if (now.getUTCHours() < 9) return false;
  const today = now.toISOString().slice(0, 10);
  return stats.last_daily_summary_sent_date !== today;
}

async function sendDailySummary(
  trades: PaperTrade[],
  stats: PaperTradeStats
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const closedToday = trades.filter((t) => t.closed_at?.startsWith(today)).length;
  const overallMultiple =
    stats.total_invested_sol > 0
      ? stats.total_returned_sol / stats.total_invested_sol
      : 0;
  const pnlSign = stats.total_pnl_sol >= 0 ? "+" : "";

  await sendTelegram(
    [
      "📊 PAPER TRADE DAILY SUMMARY",
      "",
      `Open positions: ${stats.open_trades}`,
      `Closed today: ${closedToday}`,
      "",
      "Performance (all time):",
      `- Total trades: ${stats.total_trades}`,
      `- Win rate (2x+): ${(stats.win_rate_2x * 100).toFixed(1)}%`,
      `- Total invested: ${stats.total_invested_sol.toFixed(4)} SOL`,
      `- Total returned: ${stats.total_returned_sol.toFixed(4)} SOL`,
      `- Net P&L: ${pnlSign}${stats.total_pnl_sol.toFixed(4)} SOL (${overallMultiple.toFixed(2)}x overall)`,
      `- Best trade: ${stats.best_trade_multiple.toFixed(2)}x`,
      `- Worst trade: ${stats.worst_trade_multiple.toFixed(2)}x`,
    ].join("\n")
  );

  stats.last_daily_summary_sent_date = today;
}

// --- Trade processing ---

async function processOpenTrade(trade: PaperTrade): Promise<void> {
  if (trade.status !== "OPEN") return;
  if (trade.entry_price_sol === null || trade.entry_price_sol === 0) return;

  const currentPrice = await getCurrentPrice(trade.mint_address);
  if (currentPrice === null) return;

  const currentMultiple = currentPrice / trade.entry_price_sol;
  const now = new Date().toISOString();
  const mintShort = trade.mint_address.slice(0, 8);

  // Check TP levels in order
  for (const tp of trade.tp_levels) {
    if (tp.hit) continue;
    if (currentMultiple >= tp.multiple) {
      tp.hit = true;
      tp.hit_at = now;

      const proceeds = trade.size_sol * tp.pct * tp.multiple;
      await sendTelegram(
        [
          "📄 PAPER TP HIT",
          "",
          `Token: ${mintShort}...`,
          `Level: ${tp.multiple}x ✓`,
          `Current: ${currentMultiple.toFixed(2)}x from entry`,
          `Simulated proceeds: ~${proceeds.toFixed(4)} SOL`,
        ].join("\n")
      );
    }
  }

  // Check stop loss
  if (!trade.stop_hit && currentMultiple <= 1 - trade.stop_loss_pct) {
    trade.stop_hit = true;
    trade.stop_hit_at = now;

    const downPct = (1 - currentMultiple) * 100;
    const simLoss = trade.size_sol - trade.size_sol * currentMultiple;

    await sendTelegram(
      [
        "📄 PAPER STOP LOSS",
        "",
        `Token: ${mintShort}...`,
        `Down ${downPct.toFixed(1)}% from entry`,
        `Simulated loss: ${simLoss.toFixed(4)} SOL`,
      ].join("\n")
    );

    const realizedSol = computeRealizedSol(trade, currentMultiple);
    trade.realized_sol = realizedSol;
    trade.realized_multiple = trade.size_sol > 0 ? realizedSol / trade.size_sol : 0;
    trade.status = "CLOSED";
    trade.closed_at = now;
    return;
  }

  // Check 72h hard exit
  const enteredMs = Date.parse(trade.entered_at);
  if (!Number.isNaN(enteredMs) && Date.now() - enteredMs > MS_72H) {
    const realizedSol = computeRealizedSol(trade, currentMultiple);
    trade.realized_sol = realizedSol;
    trade.realized_multiple = trade.size_sol > 0 ? realizedSol / trade.size_sol : 0;
    trade.status = "CLOSED";
    trade.closed_at = now;

    await sendTelegram(
      [
        "📄 PAPER HARD EXIT (72h)",
        "",
        `Token: ${mintShort}...`,
        `Final multiple: ${currentMultiple.toFixed(2)}x`,
        `Simulated result: ${realizedSol.toFixed(4)} SOL`,
      ].join("\n")
    );
    return;
  }

  // Close if all TPs hit
  if (trade.tp_levels.every((tp) => tp.hit)) {
    const realizedSol = computeRealizedSol(trade, currentMultiple);
    trade.realized_sol = realizedSol;
    trade.realized_multiple = trade.size_sol > 0 ? realizedSol / trade.size_sol : 0;
    trade.status = "CLOSED";
    trade.closed_at = now;
  }
}

// --- Main loop ---

async function tick(): Promise<void> {
  log("Running tick...");

  const trades = loadTrades();

  for (const trade of trades) {
    if (trade.status !== "OPEN") continue;
    try {
      await processOpenTrade(trade);
    } catch (e) {
      log(`Error processing trade ${trade.id}:`, e);
    }
  }

  saveTrades(trades);

  const prevStats = loadStats();
  const stats = computeStats(trades, prevStats);

  if (shouldSendDailySummary(stats)) {
    await sendDailySummary(trades, stats);
  }

  saveStats(stats);

  log(`Tick complete. Open: ${stats.open_trades}, Closed: ${stats.closed_trades}`);
}

async function main() {
  log("Starting paper trade tracker...");
  await tick();
  setInterval(() => tick().catch((e) => log("Tick error:", e)), POLL_INTERVAL_MS);
}

main().catch((e) => {
  console.error("[PAPER-TRACKER] Fatal error:", e);
  process.exit(1);
});
