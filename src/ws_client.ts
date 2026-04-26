// src/ws_client.ts
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import WebSocket from "ws";
import { tradeMintAndRecord } from "./trader";
import { telegramConfigured, sendTelegramMessage } from "./telegram";
import { isKillEngaged } from "./kill_switch"; // 🔹 NEW

const DEFAULT_WS_URL = "ws://159.89.35.33:4000";

// Prefer SIGNAL_WS_URL, then WS_SIGNAL_URL, then default
const WS_URL =
  process.env.SIGNAL_WS_URL ||
  process.env.WS_SIGNAL_URL ||
  DEFAULT_WS_URL;

// --- Heartbeat settings (tweak via env if desired) ---
const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS ?? 25_000); // ping every 25s
const WS_PONG_TIMEOUT_MS = Number(process.env.WS_PONG_TIMEOUT_MS ?? 10_000);   // if no pong in 10s => terminate

// avoid double-trading same mint in one session
const seenMints = new Set<string>();

function log(...args: any[]) {
  console.log("[WS-TRADER]", ...args);
}

let killNotified = false;

// Small helper so we only notify once on kill
async function handleKillAndExit(context: string) {
  log(`[KILL] Kill switch engaged (${context}). Shutting down WS trader.`);
  if (telegramConfigured() && !killNotified) {
    killNotified = true;
    await sendTelegramMessage(
      "☠️ *Kill switch engaged* – WS trader exiting and will not reconnect."
    );
  }
  process.exit(0);
}

async function connect() {
  // 🔹 Do not start at all if kill switch is already on
  if (isKillEngaged()) {
    await handleKillAndExit("startup");
    return;
  }

  log("Connecting to", WS_URL);

  // Handshake timeout prevents hangs on connect
  const ws = new WebSocket(WS_URL, { handshakeTimeout: 15_000 });

  // Periodic kill-check while connected
  const killInterval = setInterval(async () => {
    if (isKillEngaged()) {
      log("[KILL] Kill switch engaged during active connection. Closing socket.");
      try {
        ws.close();
      } catch {
        // ignore
      }
      // on("close") will fire next and we’ll exit
    }
  }, 5000);

  // --- Heartbeat timers ---
  let pingInterval: NodeJS.Timeout | null = null;
  let pongTimeout: NodeJS.Timeout | null = null;

  function clearHeartbeat() {
    if (pingInterval) clearInterval(pingInterval);
    if (pongTimeout) clearTimeout(pongTimeout);
    pingInterval = null;
    pongTimeout = null;
  }

  function armPongTimeout() {
    if (pongTimeout) clearTimeout(pongTimeout);
    pongTimeout = setTimeout(() => {
      log("[HB] Pong timeout — terminating socket to force reconnect.");
      try {
        ws.terminate(); // hard close; triggers "close" => reconnect
      } catch {
        // ignore
      }
    }, WS_PONG_TIMEOUT_MS);
  }

  ws.on("open", async () => {
    // Double-check kill on open (in case it flipped right before)
    if (isKillEngaged()) {
      clearInterval(killInterval);
      clearHeartbeat();
      await handleKillAndExit("on open");
      return;
    }

    log("Connected to remote signal server");
    if (telegramConfigured()) {
      await sendTelegramMessage("🔌 *Trader connected to signal server*");
    }

    // Start heartbeat: ping server, require pong
    if (WS_PING_INTERVAL_MS > 0) {
      pingInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          armPongTimeout();
          ws.ping();
        } catch (e) {
          log("[HB] Ping error — terminating:", e);
          try {
            ws.terminate();
          } catch {
            // ignore
          }
        }
      }, WS_PING_INTERVAL_MS);
    }
  });

  // Clear pong timeout whenever we get pong
  ws.on("pong", () => {
    if (pongTimeout) {
      clearTimeout(pongTimeout);
      pongTimeout = null;
    }
  });

  ws.on("message", async (data) => {
    try {
      // 🔹 If kill flipped between polls, bail before handling the signal
      if (isKillEngaged()) {
        log("[KILL] Kill switch engaged – ignoring incoming signal and shutting down.");
        clearInterval(killInterval);
        clearHeartbeat();
        await handleKillAndExit("on message");
        return;
      }

      const msg = JSON.parse(data.toString());

      // ✅ Backward compatible signal detection:
      // - Accept explicit { type: "signal" }
      // - OR accept anything that includes a mint field (old/bare format)
      const isSignal =
        msg?.type === "signal" ||
        typeof msg?.mint_address === "string" ||
        typeof msg?.mint === "string";

      if (!isSignal) return;

      // Accept either `mint_address` or `mint` from the signal
      const mint: string | undefined = msg.mint_address || msg.mint;

      if (!mint) {
        log(
          "Received signal without mint or mint_address, ignoring. Raw message:",
          msg
        );
        return;
      }

      if (seenMints.has(mint)) {
        log("Already traded mint this session, skipping:", mint);
        return;
      }
      seenMints.add(mint);

      log(
        `Received signal for mint ${mint} symbol=${msg.symbol} liq=${msg.liq} holders=${msg.holder_count}`
      );

      if (telegramConfigured()) {
        await sendTelegramMessage(
          [
            "📡 *NEW SIGNAL*",
            `Mint: \`${mint}\``,
            `Symbol: ${msg.symbol || "n/a"}`,
            `Price: ${msg.price ?? "n/a"}`,
            `Liq: ${msg.liq ?? "n/a"}`,
            `FDV: ${msg.fdv ?? "n/a"}`,
            `Holders: ${msg.holder_count ?? "n/a"}`,
            `Age (s): ${msg.age_seconds ?? "n/a"}`,
          ].join("\n")
        );
      }

      const result = await tradeMintAndRecord(mint);

      if (telegramConfigured()) {
        if (result.ok && result.live?.signature) {
          await sendTelegramMessage(
            [
              "✅ *TRADE EXECUTED*",
              `Mint: \`${result.mint}\``,
              `Entry price: ${result.prices.entry_SOL_per_token.toFixed(
                9
              )} SOL/token`,
              `TP target: ${result.prices.target_SOL_per_token.toFixed(
                9
              )} SOL/token`,
              `Size: ${result.sizing.cappedSol.toFixed(4)} SOL`,
              result.live.explorer
                ? `Tx: ${result.live.explorer}`
                : "Signature: " + result.live.signature,
            ].join("\n")
          );
        } else {
          await sendTelegramMessage(
            [
              "❌ *TRADE FAILED / DRY*",
              `Mint: \`${mint}\``,
              `Mode: ${result.mode}`,
              result.ok
                ? "Unknown failure (no signature returned)"
                : `Error: ${result.error ?? "unknown"}`,
            ].join("\n")
          );
        }
      }
    } catch (e) {
      log("Error handling message:", e);
    }
  });

  ws.on("close", async (code, reason) => {
    clearInterval(killInterval);
    clearHeartbeat();
    log("Connection closed", code, reason.toString());

    // 🔹 If kill is on, do NOT reconnect – just exit.
    if (isKillEngaged()) {
      await handleKillAndExit("on close");
      return;
    }

    if (telegramConfigured()) {
      await sendTelegramMessage(
        "⚠️ *Trader disconnected from signal server* – attempting reconnect."
      );
    }

    setTimeout(() => {
      void connect();
    }, 5000); // auto-reconnect
  });

  ws.on("error", (err) => {
    log("WebSocket error:", err);
    // If it errors but doesn't close, terminate so we actually reconnect
    try {
      ws.terminate();
    } catch {
      // ignore
    }
  });
}

// Entrypoint
void connect();
