// src/alpha_signal_detector.ts
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { Pool } from "pg";
import WebSocket from "ws";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";

const SIGNAL_SERVER_URL = "ws://localhost:4000";
const POLL_INTERVAL_MS = 120_000;
const TRADED_MINTS_FILE = path.resolve(__dirname, "../data/traded_mints.json");

const DB_URL =
  process.env.ALPHA_INDEX_DB_URL ??
  "postgresql://root:alphaindex@localhost:5432/alpha_index";

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SIGNAL_QUERY = `
WITH tier_mentions AS (
  SELECT
    tm.token_address,
    tm.mentioned_at,
    tm.source_id,
    ss.final_score,
    s.name as channel_name,
    s.handle as channel_handle,
    s.chain_focus,
    CASE
      WHEN ss.final_score > 50 THEN 'tier1'
      WHEN ss.final_score > 20 THEN 'tier2'
      ELSE 'tier3'
    END as tier
  FROM token_mentions tm
  JOIN source_scores ss ON ss.source_id = tm.source_id
  JOIN sources s ON s.id = tm.source_id
  WHERE ss.final_score > 20
),
first_tier1 AS (
  SELECT DISTINCT ON (token_address)
    token_address,
    mentioned_at as t1_at,
    source_id as t1_source,
    channel_name as t1_channel,
    channel_handle as t1_handle,
    chain_focus
  FROM tier_mentions
  WHERE tier = 'tier1'
  ORDER BY token_address, mentioned_at
),
first_tier2 AS (
  SELECT DISTINCT ON (tm.token_address)
    tm.token_address,
    tm.mentioned_at as t2_at,
    tm.source_id as t2_source,
    tm.channel_name as t2_channel,
    tm.channel_handle as t2_handle
  FROM tier_mentions tm
  JOIN first_tier1 ft ON ft.token_address = tm.token_address
  WHERE tm.tier = 'tier2'
  AND tm.source_id != ft.t1_source
  AND tm.mentioned_at > ft.t1_at + INTERVAL '6 hours'
  AND tm.mentioned_at < ft.t1_at + INTERVAL '72 hours'
  ORDER BY tm.token_address, tm.mentioned_at
),
qualified AS (
  SELECT
    ft1.token_address,
    ft1.t1_at,
    ft1.t1_channel,
    ft1.t1_handle,
    ft1.chain_focus,
    ft2.t2_at,
    ft2.t2_channel,
    ft2.t2_handle,
    EXTRACT(EPOCH FROM (ft2.t2_at - ft1.t1_at))/3600 as hours_between,
    to2.price_at_mention,
    to2.max_r_at,
    EXTRACT(EPOCH FROM (ft2.t2_at - ft1.t1_at)) /
      NULLIF(EXTRACT(EPOCH FROM (to2.max_r_at - ft1.t1_at)), 0)
      as pct_of_way_to_peak
  FROM first_tier1 ft1
  JOIN first_tier2 ft2 ON ft2.token_address = ft1.token_address
  JOIN token_outcomes to2 ON to2.token_address = ft1.token_address
  WHERE to2.price_at_mention IS NOT NULL
  AND to2.max_r_at > ft2.t2_at
  AND ft2.t2_at > NOW() - INTERVAL '72 hours'
)
SELECT *
FROM qualified
WHERE pct_of_way_to_peak < 0.20
ORDER BY t2_at DESC
`;

function log(...args: any[]) {
  console.log("[ALPHA-DETECTOR]", ...args);
}

// --- Traded mints ---

function loadTradedMints(): Set<string> {
  try {
    if (fs.existsSync(TRADED_MINTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TRADED_MINTS_FILE, "utf8"));
      return new Set<string>(Array.isArray(raw.mints) ? raw.mints : []);
    }
  } catch (e) {
    log("Failed to load traded_mints.json:", e);
  }
  return new Set();
}

function saveTradedMint(tradedMints: Set<string>, mint: string) {
  tradedMints.add(mint);
  try {
    fs.writeFileSync(
      TRADED_MINTS_FILE,
      JSON.stringify({ mints: [...tradedMints] }, null, 2)
    );
  } catch (e) {
    log("Failed to save traded_mints.json:", e);
  }
}

// --- Wallet balance ---

async function getSolBalance(): Promise<number> {
  const privKey = process.env.PRIVKEY_BASE58;
  if (!privKey) throw new Error("Missing PRIVKEY_BASE58");

  const keypair = Keypair.fromSecretKey(bs58.decode(privKey));
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const lamports = await connection.getBalance(keypair.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

function computePositionSize(solBalance: number): number {
  const raw = solBalance * 0.02;
  const rounded = Math.round(raw * 100) / 100;
  return Math.max(rounded, 0.1);
}

// --- Telegram ---

async function sendTelegram(text: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "Markdown",
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

function formatDate(d: Date | string): string {
  return new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// --- Signal server WebSocket ---

let ws: WebSocket | null = null;
let wsReady = false;

function connectSignalServer() {
  log("Connecting to signal server:", SIGNAL_SERVER_URL);
  ws = new WebSocket(SIGNAL_SERVER_URL);

  ws.on("open", () => {
    wsReady = true;
    log("Connected to signal server");
  });

  ws.on("close", () => {
    wsReady = false;
    log("Disconnected from signal server — reconnecting in 5s");
    setTimeout(connectSignalServer, 5_000);
  });

  ws.on("error", (err) => {
    log("Signal server WS error:", err.message);
    try { ws?.terminate(); } catch { /* ignore */ }
  });
}

function sendSignal(payload: object) {
  if (!ws || !wsReady) {
    log("WS not ready, signal dropped for:", (payload as any).mint_address);
    return;
  }
  ws.send(JSON.stringify(payload));
  log("Signal sent to signal server:", (payload as any).mint_address);
}

// --- DB pool ---

const pool = new Pool({ connectionString: DB_URL });

// --- Poll loop ---

async function poll(tradedMints: Set<string>) {
  const ts = new Date().toISOString();
  log(`${ts} Scanning for signals...`);

  let rows: any[];
  try {
    const result = await pool.query(SIGNAL_QUERY);
    rows = result.rows;
  } catch (e: any) {
    log("DB query error (will retry next cycle):", e?.message ?? e);
    return;
  }

  if (rows.length === 0) return;

  for (const row of rows) {
    const mint: string = row.token_address;

    if (tradedMints.has(mint)) {
      log(`Skipping already-traded mint: ${mint}`);
      continue;
    }

    log(`Signal found: ${mint} | t1=${row.t1_channel} t2=${row.t2_channel}`);

    let sizeSol: number;
    try {
      const balance = await getSolBalance();
      sizeSol = computePositionSize(balance);
    } catch (e: any) {
      log("Failed to get wallet balance, using minimum:", e?.message ?? e);
      sizeSol = 0.1;
    }

    const chain: string = row.chain_focus ?? "solana";
    const hoursBetween = Number(row.hours_between);
    const pctOfWayToPeak = Number(row.pct_of_way_to_peak);

    const signal = {
      type: "signal",
      mint_address: mint,
      tp_ladder: [
        { multiple: 2.0, pct_of_original: 0.40 },
        { multiple: 5.0, pct_of_original: 0.30 },
        { multiple: 10.0, pct_of_original: 0.20 },
      ],
      stop_cushion_pct: 0.40,
      regime: "A_MOMENTUM",
      size_sol: sizeSol,
      chain,
      metadata: {
        t1_channel: row.t1_channel,
        t1_handle: row.t1_handle,
        t2_channel: row.t2_channel,
        t2_handle: row.t2_handle,
        hours_between_calls: hoursBetween,
        pct_of_way_to_peak: pctOfWayToPeak,
        t1_at: row.t1_at,
        t2_at: row.t2_at,
      },
    };

    sendSignal(signal);
    saveTradedMint(tradedMints, mint);

    const mintShort = mint.slice(0, 8);
    await sendTelegram(
      [
        "🎯 ALPHA SIGNAL DETECTED",
        "",
        `Token: ${mintShort}...`,
        `Chain: ${chain}`,
        `Position: ${sizeSol} SOL`,
        "",
        "📡 Signal Intel:",
        `- First call: ${row.t1_channel} (${formatDate(row.t1_at)})`,
        `- Confirmed by: ${row.t2_channel} (${hoursBetween.toFixed(1)}h later)`,
        `- Entry timing: ${(pctOfWayToPeak * 100).toFixed(1)}% into move`,
        "",
        "🎚️ Exit Ladder:",
        "- 2x → sell 40%",
        "- 5x → sell 30%",
        "- 10x → sell 20%",
        "- 10% rides for moonshot",
        "",
        "⛔ Stop loss: -40% from entry",
      ].join("\n")
    );
  }
}

// --- Startup ---

async function main() {
  log("Starting alpha signal detector...");

  const tradedMints = loadTradedMints();
  log(`Loaded ${tradedMints.size} previously traded mints`);

  connectSignalServer();

  await poll(tradedMints);
  setInterval(() => poll(tradedMints), POLL_INTERVAL_MS);
}

main().catch((e) => {
  console.error("[ALPHA-DETECTOR] Fatal error:", e);
  process.exit(1);
});
