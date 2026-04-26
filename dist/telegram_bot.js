"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/telegram_bot.ts
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, "../.env") });
// If TS complains about fetch, either:
//  - add "DOM" to tsconfig's lib, or
//  - uncomment this line:
// declare const fetch: any;
const web3_js_1 = require("@solana/web3.js");
const bs58_1 = __importDefault(require("bs58"));
const trader_1 = require("./trader");
const telegram_1 = require("./telegram");
const kill_switch_1 = require("./kill_switch");
function mustEnv(k) {
    const v = process.env[k];
    if (!v) {
        throw new Error(`Missing env: ${k}`);
    }
    return v;
}
const BOT_TOKEN = mustEnv("TELEGRAM_BOT_TOKEN");
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? ""; // if set, restrict replies to this chat
const RPC_URL = mustEnv("RPC_URL");
const PRIV = mustEnv("PRIVKEY_BASE58");
// --------------------------------------------------
// Helpers
// --------------------------------------------------
async function getSolBalance() {
    const connection = new web3_js_1.Connection(RPC_URL, "confirmed");
    const wallet = web3_js_1.Keypair.fromSecretKey(bs58_1.default.decode(PRIV));
    const lamports = await connection.getBalance(wallet.publicKey, "confirmed");
    return lamports / 1e9;
}
async function handleStatsCommand() {
    const stats = (0, trader_1.computePositionStats)();
    const solBalance = await getSolBalance();
    const winRatePct = stats.winRate * 100;
    const killLine = (0, kill_switch_1.isKillEngaged)()
        ? "📛 *Kill switch*: ENGAGED"
        : "✅ *Kill switch*: OFF";
    const lines = [
        "📊 *BOT STATS*",
        "",
        `💰 *SOL Balance*: ${solBalance.toFixed(4)} SOL`,
        "",
        killLine,
        "",
        `📈 *Positions*`,
        `• Total: ${stats.total}`,
        `• Open: ${stats.open}`,
        `• Closed: ${stats.closed}`,
        "",
        `🏁 *Outcomes (closed only)*`,
        `• Wins: ${stats.wins}`,
        `• Loss (rug): ${stats.lossRug}`,
        `• Loss (other): ${stats.lossOther}`,
        `• Win rate: ${isNaN(winRatePct) ? "0.0" : winRatePct.toFixed(1)}%`,
    ];
    await (0, telegram_1.sendTelegramMessage)(lines.join("\n"));
}
async function handleKillCommand() {
    if ((0, kill_switch_1.isKillEngaged)()) {
        await (0, telegram_1.sendTelegramMessage)("☠️ Kill switch is *already* engaged.");
        return;
    }
    (0, kill_switch_1.engageKillSwitch)();
    await (0, telegram_1.sendTelegramMessage)("☠️ *Kill switch engaged.*\nAll trading processes that check the kill flag will exit shortly.");
}
async function handleResumeCommand() {
    if (!(0, kill_switch_1.isKillEngaged)()) {
        await (0, telegram_1.sendTelegramMessage)("ℹ️ Kill switch is already *OFF*.");
        return;
    }
    (0, kill_switch_1.clearKillSwitch)();
    await (0, telegram_1.sendTelegramMessage)("✅ Kill switch *cleared*.\nYou can safely restart your trader/poller processes.");
}
// --------------------------------------------------
// Telegram long-polling loop
// --------------------------------------------------
async function pollTelegramUpdates() {
    if (!(0, telegram_1.telegramConfigured)()) {
        throw new Error("Telegram not configured – set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env");
    }
    console.log("[TG-BOT] Starting Telegram bot polling loop");
    let offset = 0;
    while (true) {
        try {
            const url = new URL(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
            url.searchParams.set("timeout", "50");
            if (offset) {
                url.searchParams.set("offset", String(offset));
            }
            const res = await fetch(url.toString(), { method: "GET" });
            if (!res.ok) {
                const body = await res.text();
                console.error("[TG-BOT] getUpdates failed:", res.status, body);
                // small delay then retry
                await new Promise((r) => setTimeout(r, 5000));
                continue;
            }
            const json = (await res.json());
            const updates = json.result ?? [];
            for (const update of updates) {
                offset = update.update_id + 1;
                const msg = update.message || update.edited_message;
                if (!msg || typeof msg.text !== "string")
                    continue;
                const chatId = String(msg.chat?.id ?? "");
                const text = msg.text.trim();
                // If a CHAT_ID is configured, only respond to that chat
                if (CHAT_ID && chatId !== CHAT_ID) {
                    continue;
                }
                const lower = text.toLowerCase();
                // /stats, stats, /status, status → show stats (including kill status)
                if (lower === "/stats" ||
                    lower === "stats" ||
                    lower.startsWith("/stats@") ||
                    lower === "/status" ||
                    lower === "status") {
                    console.log("[TG-BOT] Received stats request");
                    await handleStatsCommand();
                }
                else if (lower === "/start") {
                    await (0, telegram_1.sendTelegramMessage)([
                        "🤖 *Sniper Bot Online*",
                        "",
                        "Available commands:",
                        "• `/stats` – show win rate, SOL balance, position counts, and kill switch status",
                        "• `kill` – engage kill switch (running processes will exit if they check it)",
                        "• `resume` / `unkill` – clear kill switch flag",
                        "• `status` – same as /stats, includes kill switch state",
                    ].join("\n"));
                }
                // Kill switch commands
                else if (lower === "kill" || lower === "/kill") {
                    console.log("[TG-BOT] Received kill command");
                    await handleKillCommand();
                }
                else if (lower === "resume" ||
                    lower === "unkill" ||
                    lower === "/resume" ||
                    lower === "/unkill") {
                    console.log("[TG-BOT] Received resume command");
                    await handleResumeCommand();
                }
            }
        }
        catch (e) {
            console.error("[TG-BOT] Error in polling loop:", e);
            // Small backoff before retrying
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}
pollTelegramUpdates().catch((e) => {
    console.error("[TG-BOT] Fatal error:", e);
    process.exit(1);
});
