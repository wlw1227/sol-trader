"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/ws_client.ts
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, "../.env") });
const ws_1 = __importDefault(require("ws"));
const trader_1 = require("./trader");
const telegram_1 = require("./telegram");
const kill_switch_1 = require("./kill_switch"); // 🔹 NEW
const DEFAULT_WS_URL = "ws://159.89.35.33:4000";
// Prefer SIGNAL_WS_URL, then WS_SIGNAL_URL, then default
const WS_URL = process.env.SIGNAL_WS_URL ||
    process.env.WS_SIGNAL_URL ||
    DEFAULT_WS_URL;
// --- Heartbeat settings (tweak via env if desired) ---
const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS ?? 25000); // ping every 25s
const WS_PONG_TIMEOUT_MS = Number(process.env.WS_PONG_TIMEOUT_MS ?? 10000); // if no pong in 10s => terminate
// avoid double-trading same mint in one session
const seenMints = new Set();
function log(...args) {
    console.log("[WS-TRADER]", ...args);
}
let killNotified = false;
// Small helper so we only notify once on kill
async function handleKillAndExit(context) {
    log(`[KILL] Kill switch engaged (${context}). Shutting down WS trader.`);
    if ((0, telegram_1.telegramConfigured)() && !killNotified) {
        killNotified = true;
        await (0, telegram_1.sendTelegramMessage)("☠️ *Kill switch engaged* – WS trader exiting and will not reconnect.");
    }
    process.exit(0);
}
async function connect() {
    // 🔹 Do not start at all if kill switch is already on
    if ((0, kill_switch_1.isKillEngaged)()) {
        await handleKillAndExit("startup");
        return;
    }
    log("Connecting to", WS_URL);
    // Handshake timeout prevents hangs on connect
    const ws = new ws_1.default(WS_URL, { handshakeTimeout: 15000 });
    // Periodic kill-check while connected
    const killInterval = setInterval(async () => {
        if ((0, kill_switch_1.isKillEngaged)()) {
            log("[KILL] Kill switch engaged during active connection. Closing socket.");
            try {
                ws.close();
            }
            catch {
                // ignore
            }
            // on("close") will fire next and we’ll exit
        }
    }, 5000);
    // --- Heartbeat timers ---
    let pingInterval = null;
    let pongTimeout = null;
    function clearHeartbeat() {
        if (pingInterval)
            clearInterval(pingInterval);
        if (pongTimeout)
            clearTimeout(pongTimeout);
        pingInterval = null;
        pongTimeout = null;
    }
    function armPongTimeout() {
        if (pongTimeout)
            clearTimeout(pongTimeout);
        pongTimeout = setTimeout(() => {
            log("[HB] Pong timeout — terminating socket to force reconnect.");
            try {
                ws.terminate(); // hard close; triggers "close" => reconnect
            }
            catch {
                // ignore
            }
        }, WS_PONG_TIMEOUT_MS);
    }
    ws.on("open", async () => {
        // Double-check kill on open (in case it flipped right before)
        if ((0, kill_switch_1.isKillEngaged)()) {
            clearInterval(killInterval);
            clearHeartbeat();
            await handleKillAndExit("on open");
            return;
        }
        log("Connected to remote signal server");
        if ((0, telegram_1.telegramConfigured)()) {
            await (0, telegram_1.sendTelegramMessage)("🔌 *Trader connected to signal server*");
        }
        // Start heartbeat: ping server, require pong
        if (WS_PING_INTERVAL_MS > 0) {
            pingInterval = setInterval(() => {
                if (ws.readyState !== ws_1.default.OPEN)
                    return;
                try {
                    armPongTimeout();
                    ws.ping();
                }
                catch (e) {
                    log("[HB] Ping error — terminating:", e);
                    try {
                        ws.terminate();
                    }
                    catch {
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
            if ((0, kill_switch_1.isKillEngaged)()) {
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
            const isSignal = msg?.type === "signal" ||
                typeof msg?.mint_address === "string" ||
                typeof msg?.mint === "string";
            if (!isSignal)
                return;
            // Accept either `mint_address` or `mint` from the signal
            const mint = msg.mint_address || msg.mint;
            if (!mint) {
                log("Received signal without mint or mint_address, ignoring. Raw message:", msg);
                return;
            }
            if (seenMints.has(mint)) {
                log("Already traded mint this session, skipping:", mint);
                return;
            }
            seenMints.add(mint);
            log(`Received signal for mint ${mint} symbol=${msg.symbol} liq=${msg.liq} holders=${msg.holder_count}`);
            if ((0, telegram_1.telegramConfigured)()) {
                await (0, telegram_1.sendTelegramMessage)([
                    "📡 *NEW SIGNAL*",
                    `Mint: \`${mint}\``,
                    `Symbol: ${msg.symbol || "n/a"}`,
                    `Price: ${msg.price ?? "n/a"}`,
                    `Liq: ${msg.liq ?? "n/a"}`,
                    `FDV: ${msg.fdv ?? "n/a"}`,
                    `Holders: ${msg.holder_count ?? "n/a"}`,
                    `Age (s): ${msg.age_seconds ?? "n/a"}`,
                ].join("\n"));
            }
            const result = await (0, trader_1.tradeMintAndRecord)(mint);
            if ((0, telegram_1.telegramConfigured)()) {
                if (result.ok && result.live?.signature) {
                    await (0, telegram_1.sendTelegramMessage)([
                        "✅ *TRADE EXECUTED*",
                        `Mint: \`${result.mint}\``,
                        `Entry price: ${result.prices.entry_SOL_per_token.toFixed(9)} SOL/token`,
                        `TP target: ${result.prices.target_SOL_per_token.toFixed(9)} SOL/token`,
                        `Size: ${result.sizing.cappedSol.toFixed(4)} SOL`,
                        result.live.explorer
                            ? `Tx: ${result.live.explorer}`
                            : "Signature: " + result.live.signature,
                    ].join("\n"));
                }
                else {
                    await (0, telegram_1.sendTelegramMessage)([
                        "❌ *TRADE FAILED / DRY*",
                        `Mint: \`${mint}\``,
                        `Mode: ${result.mode}`,
                        result.ok
                            ? "Unknown failure (no signature returned)"
                            : `Error: ${result.error ?? "unknown"}`,
                    ].join("\n"));
                }
            }
        }
        catch (e) {
            log("Error handling message:", e);
        }
    });
    ws.on("close", async (code, reason) => {
        clearInterval(killInterval);
        clearHeartbeat();
        log("Connection closed", code, reason.toString());
        // 🔹 If kill is on, do NOT reconnect – just exit.
        if ((0, kill_switch_1.isKillEngaged)()) {
            await handleKillAndExit("on close");
            return;
        }
        if ((0, telegram_1.telegramConfigured)()) {
            await (0, telegram_1.sendTelegramMessage)("⚠️ *Trader disconnected from signal server* – attempting reconnect.");
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
        }
        catch {
            // ignore
        }
    });
}
// Entrypoint
void connect();
