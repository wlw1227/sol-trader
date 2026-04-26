"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/tp_watcher.ts
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, "../.env") });
const web3_js_1 = require("@solana/web3.js");
const trade_logic_1 = require("./trade_logic");
const telegram_1 = require("./telegram");
const kill_switch_1 = require("./kill_switch");
const POSITIONS_FILE = path_1.default.resolve(__dirname, "../data/open_positions.json");
function loadPositions() {
    if (!fs_1.default.existsSync(POSITIONS_FILE))
        return [];
    const raw = fs_1.default.readFileSync(POSITIONS_FILE, "utf8");
    try {
        return JSON.parse(raw);
    }
    catch {
        return [];
    }
}
function savePositions(positions) {
    fs_1.default.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}
function mustEnv(k) {
    const v = process.env[k];
    if (!v)
        throw new Error(`Missing env: ${k}`);
    return v;
}
const RPC_URL = mustEnv("RPC_URL");
const PRIV = mustEnv("PRIVKEY_BASE58");
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 100);
const PRIORITY_MICROLAMPORTS = Number(process.env.PRIORITY_MICROLAMPORTS ?? 0);
// Safety knobs
const MAX_SELL_ATTEMPTS = Number(process.env.MAX_SELL_ATTEMPTS ?? 3);
const SELL_RETRY_COOLDOWN_SEC = Number(process.env.SELL_RETRY_COOLDOWN_SEC ?? 30);
const BE_CUSHION_PCT = Number(process.env.BE_CUSHION_PCT ?? 0.08); // 8% below entry
const DEAD_QUOTE_AGE_SEC = Number(process.env.DEAD_QUOTE_AGE_SEC ?? 600); // 10 min
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function fmtRegime(r) {
    if (r === "A_MOMENTUM")
        return "A (Momentum)";
    if (r === "C_CHOP")
        return "C (Chop)";
    return "B (Base)";
}
const rpcConnection = new web3_js_1.Connection(RPC_URL, "confirmed");
async function getTokenDecimalsOnChain(mint) {
    try {
        const mintPk = new web3_js_1.PublicKey(mint);
        const info = await rpcConnection.getParsedAccountInfo(mintPk, "confirmed");
        const data = info.value?.data;
        const parsed = data?.parsed;
        const decimals = parsed?.info?.decimals;
        if (typeof decimals === "number")
            return decimals;
    }
    catch (e) {
        console.warn("[TP] Failed to fetch token decimals on-chain, defaulting to 9:", e);
    }
    return 9;
}
async function getCurrentSolPerToken(mint) {
    const decimals = await getTokenDecimalsOnChain(mint);
    const amountAtomic = BigInt(10 ** decimals).toString();
    const url = new URL("/swap/v1/quote", "https://lite-api.jup.ag");
    url.searchParams.set("inputMint", mint);
    url.searchParams.set("outputMint", "So11111111111111111111111111111111111111112");
    url.searchParams.set("amount", amountAtomic);
    url.searchParams.set("slippageBps", String(SLIPPAGE_BPS));
    const res = await fetch(url.toString());
    if (!res.ok)
        throw new Error(`price quote failed ${res.status}`);
    const quote = (await res.json());
    const outAtomic = quote.outAmount;
    const sol = Number(outAtomic) / 1e9;
    const tokens = Number(amountAtomic) / 10 ** decimals;
    return tokens > 0 ? sol / tokens : 0;
}
function canAttempt(lastAttemptAt) {
    if (!lastAttemptAt)
        return true;
    const t = Date.parse(lastAttemptAt);
    if (Number.isNaN(t))
        return true;
    const ageSec = (Date.now() - t) / 1000;
    return ageSec >= SELL_RETRY_COOLDOWN_SEC;
}
function computeRealizedPnl(pos) {
    const entrySizeSol = pos.entrySizeSol ?? 0;
    const realizedSolTotal = (pos.ladders ?? []).reduce((sum, l) => sum + (l.realizedSolProceeds ?? 0), 0);
    pos.realizedSolTotal = realizedSolTotal;
    pos.pnlMultiple = entrySizeSol > 0 ? realizedSolTotal / entrySizeSol : undefined;
    return { entrySizeSol, realizedSolTotal };
}
function closePositionWithOutcome(pos, baseOutcome, notes) {
    pos.status = "CLOSED";
    pos.closedAt = new Date().toISOString();
    const { entrySizeSol, realizedSolTotal } = computeRealizedPnl(pos);
    if (entrySizeSol > 0 && realizedSolTotal > entrySizeSol)
        pos.outcome = "WIN";
    else
        pos.outcome = baseOutcome;
    if (notes)
        pos.notes = notes;
}
async function maybeSend(msg) {
    if (!(0, telegram_1.telegramConfigured)())
        return;
    await (0, telegram_1.sendTelegramMessage)(msg);
}
async function armBreakevenStopIfNeeded(pos) {
    if (pos.beStopEnabled)
        return;
    const entry = pos.entrySolPerToken;
    if (!entry || entry <= 0)
        return;
    const stop = entry * (1 - BE_CUSHION_PCT);
    pos.beStopEnabled = true;
    pos.beStopSolPerToken = stop;
    pos.beStopArmedAt = new Date().toISOString();
    await maybeSend([
        "🛡️ *PROTECT STOP ARMED*",
        `Mint: \`${pos.mint}\``,
        `Regime: *${fmtRegime(pos.regime)}*`,
        `Stop: ${stop.toFixed(9)} SOL/token`,
        `Cushion: ${(BE_CUSHION_PCT * 100).toFixed(0)}% below entry`,
    ].join("\n"));
}
async function triggerBreakevenStop(pos, currentPrice) {
    if (!pos.beStopEnabled || pos.beStopTriggered)
        return;
    if (pos.beStopSolPerToken == null)
        return;
    const hasRemaining = (pos.ladders ?? []).some((l) => !l.hit);
    if (!hasRemaining)
        return;
    pos.beStopAttemptCount = (pos.beStopAttemptCount ?? 0) + 1;
    if (pos.beStopAttemptCount > MAX_SELL_ATTEMPTS) {
        closePositionWithOutcome(pos, "LOSS_OTHER", `[TP] BE stop max attempts exceeded (${MAX_SELL_ATTEMPTS}).`);
        await maybeSend([
            "🧨 *BE STOP ABORTED*",
            `Mint: \`${pos.mint}\``,
            `Regime: *${fmtRegime(pos.regime)}*`,
            `Reason: Max BE sell attempts exceeded (${MAX_SELL_ATTEMPTS}).`,
            `Outcome: ${pos.outcome}`,
        ].join("\n"));
        return;
    }
    if (!canAttempt(pos.beStopLastAttemptAt))
        return;
    pos.beStopLastAttemptAt = new Date().toISOString();
    try {
        const sellResult = await (0, trade_logic_1.executeSellFraction)({
            rpcUrl: RPC_URL,
            privKeyBase58: PRIV,
            mint: pos.mint,
            fraction: 1.0,
            mode: "LIVE",
            slippageBps: SLIPPAGE_BPS,
            priorityMicroLamports: PRIORITY_MICROLAMPORTS,
        });
        // Mark all remaining ladders as hit so the position closes cleanly.
        for (const l of pos.ladders ?? []) {
            if (!l.hit) {
                l.hit = true;
                l.hitAt = new Date().toISOString();
                l.sellSignature = sellResult.live?.signature ?? l.sellSignature;
                const realizedPrice = sellResult.prices?.realized_SOL_per_token ?? currentPrice;
                if (realizedPrice != null)
                    l.realizedPriceSolPerToken = realizedPrice;
                const realizedSolProceeds = sellResult.quote?.outSol;
                if (realizedSolProceeds != null) {
                    l.realizedSolProceeds = (l.realizedSolProceeds ?? 0) + realizedSolProceeds;
                    break;
                }
            }
        }
        pos.beStopTriggered = true;
        pos.beStopTriggerTx = sellResult.live?.signature ?? undefined;
        await maybeSend([
            "🛑 *PROTECT STOP SOLD REMAINDER*",
            `Mint: \`${pos.mint}\``,
            `Regime: *${fmtRegime(pos.regime)}*`,
            `Price: ${(sellResult.prices?.realized_SOL_per_token ?? currentPrice).toFixed(9)} SOL/token`,
            sellResult.live?.explorer ? `Tx: ${sellResult.live.explorer}` : "",
        ].filter(Boolean).join("\n"));
    }
    catch (e) {
        await maybeSend([
            "❌ *BE STOP SELL ERROR*",
            `Mint: \`${pos.mint}\``,
            `Regime: *${fmtRegime(pos.regime)}*`,
            `Attempt: ${pos.beStopAttemptCount}/${MAX_SELL_ATTEMPTS}`,
            `Error: ${e instanceof Error ? e.message : String(e)}`,
        ].join("\n"));
    }
}
async function processPosition(pos) {
    if (pos.status !== "OPEN")
        return pos;
    if (!pos.ladders || pos.ladders.length === 0)
        return pos;
    let currentPrice;
    try {
        currentPrice = await getCurrentSolPerToken(pos.mint);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("price quote failed 400")) {
            const createdMs = Date.parse(pos.createdAt);
            const ageSec = !Number.isNaN(createdMs) ? (Date.now() - createdMs) / 1000 : 9e9;
            if (ageSec > DEAD_QUOTE_AGE_SEC) {
                closePositionWithOutcome(pos, "LOSS_RUG", `[TP] No Jupiter route (HTTP 400 quote) after ${Math.round(ageSec)}s; marking dead.`);
                await maybeSend([
                    "⚰️ *POSITION MARKED DEAD*",
                    `Mint: \`${pos.mint}\``,
                    `Regime: *${fmtRegime(pos.regime)}*`,
                    `Reason: No quote route on Jupiter (HTTP 400) after ${Math.round(ageSec)}s.`,
                    `Outcome: ${pos.outcome}`,
                ].join("\n"));
            }
        }
        return pos;
    }
    // BE/protect stop check
    if (pos.beStopEnabled && !pos.beStopTriggered && pos.beStopSolPerToken != null) {
        if (currentPrice <= pos.beStopSolPerToken) {
            await triggerBreakevenStop(pos, currentPrice);
        }
    }
    if (pos.status !== "OPEN")
        return pos;
    // Ladder checks
    for (const ladder of pos.ladders) {
        if (ladder.hit)
            continue;
        if (currentPrice >= ladder.targetSolPerToken) {
            ladder.attemptCount = ladder.attemptCount ?? 0;
            if (ladder.attemptCount >= MAX_SELL_ATTEMPTS) {
                closePositionWithOutcome(pos, "LOSS_OTHER", `[TP] Max sell attempts reached for ladder ${ladder.multiple}x (${MAX_SELL_ATTEMPTS}).`);
                await maybeSend([
                    "🧯 *POSITION ABORTED*",
                    `Mint: \`${pos.mint}\``,
                    `Regime: *${fmtRegime(pos.regime)}*`,
                    `Reason: Max sell attempts reached on ${ladder.multiple}x.`,
                    `Outcome: ${pos.outcome}`,
                ].join("\n"));
                return pos;
            }
            if (!canAttempt(ladder.lastAttemptAt))
                continue;
            ladder.attemptCount += 1;
            ladder.lastAttemptAt = new Date().toISOString();
            try {
                const sellResult = await (0, trade_logic_1.executeSellFraction)({
                    rpcUrl: RPC_URL,
                    privKeyBase58: PRIV,
                    mint: pos.mint,
                    fraction: ladder.fraction,
                    mode: "LIVE",
                    slippageBps: SLIPPAGE_BPS,
                    priorityMicroLamports: PRIORITY_MICROLAMPORTS,
                });
                ladder.hit = true;
                ladder.hitAt = new Date().toISOString();
                ladder.sellSignature = sellResult.live?.signature ?? undefined;
                const realizedPrice = sellResult.prices?.realized_SOL_per_token ?? currentPrice;
                const realizedSolProceeds = sellResult.quote?.outSol;
                if (realizedPrice != null)
                    ladder.realizedPriceSolPerToken = realizedPrice;
                if (realizedSolProceeds != null)
                    ladder.realizedSolProceeds = realizedSolProceeds;
                await maybeSend([
                    "💰 *TAKE PROFIT HIT*",
                    `Mint: \`${pos.mint}\``,
                    `Regime: *${fmtRegime(pos.regime)}*`,
                    `Ladder: ${ladder.multiple}x (${(ladder.fraction * 100).toFixed(0)}% of remaining)`,
                    `Price: ${realizedPrice.toFixed(9)} SOL/token`,
                    sellResult.live?.explorer ? `Tx: ${sellResult.live.explorer}` : "",
                ].filter(Boolean).join("\n"));
                // Arm stop after first TP
                await armBreakevenStopIfNeeded(pos);
            }
            catch (e) {
                await maybeSend([
                    "❌ *TP SELL ERROR*",
                    `Mint: \`${pos.mint}\``,
                    `Regime: *${fmtRegime(pos.regime)}*`,
                    `Ladder: ${ladder.multiple}x (attempt ${ladder.attemptCount}/${MAX_SELL_ATTEMPTS})`,
                    `Error: ${e instanceof Error ? e.message : String(e)}`,
                ].join("\n"));
            }
        }
    }
    if (pos.ladders.every((l) => l.hit)) {
        closePositionWithOutcome(pos, "WIN");
        const hitMultiples = pos.ladders.map((l) => `${l.multiple}x`).join(", ");
        const pnlStr = pos.pnlMultiple != null ? pos.pnlMultiple.toFixed(2) + "x" : "n/a";
        const realized = pos.realizedSolTotal ?? 0;
        const entrySizeSol = pos.entrySizeSol ?? 0;
        await maybeSend([
            "✅ *POSITION CLOSED*",
            `Mint: \`${pos.mint}\``,
            `Regime: *${fmtRegime(pos.regime)}*`,
            `Ladders hit: ${hitMultiples}`,
            `Realized: ${realized.toFixed(4)} SOL`,
            `Entry size: ${entrySizeSol.toFixed(4)} SOL`,
            `PnL multiple: ${pnlStr}`,
            `Outcome: ${pos.outcome}`,
            `Closed at: ${pos.closedAt}`,
        ].join("\n"));
    }
    return pos;
}
async function mainLoop() {
    console.log("[TP] Ladder watcher started");
    let killNotified = false;
    while (true) {
        if ((0, kill_switch_1.isKillEngaged)()) {
            if ((0, telegram_1.telegramConfigured)() && !killNotified) {
                killNotified = true;
                await (0, telegram_1.sendTelegramMessage)("☠️ *Kill switch engaged* – TP watcher exiting.");
            }
            process.exit(0);
        }
        try {
            const positions = loadPositions();
            const updated = [];
            for (const p of positions)
                updated.push(await processPosition(p));
            savePositions(updated);
        }
        catch (e) {
            console.error("[TP] Loop error:", e);
        }
        await sleep(15000);
    }
}
mainLoop().catch((e) => {
    console.error("[TP] Fatal error in watcher:", e);
    process.exit(1);
});
