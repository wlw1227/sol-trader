"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.computePositionStats = computePositionStats;
exports.tradeMintAndRecord = tradeMintAndRecord;
// src/trader.ts
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, "../.env") });
const trade_logic_1 = require("./trade_logic");
const telegram_1 = require("./telegram");
function mustEnv(k) {
    const v = process.env[k];
    if (!v)
        throw new Error(`Missing env: ${k}`);
    return v;
}
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
// ------------------------------------------------------------
// Dynamic regime selection (based on your sim findings)
// ------------------------------------------------------------
function pickRegime(meta) {
    const fdvLiq = meta?.fdv_liq_ratio;
    const volLiq = meta?.vol_liq_ratio;
    // Regime A (Momentum)
    if (typeof fdvLiq === "number" &&
        typeof volLiq === "number" &&
        fdvLiq <= 0.71 &&
        volLiq >= 0.12) {
        return "A_MOMENTUM";
    }
    // Regime C (Chop / harvest)
    if (typeof fdvLiq === "number" && fdvLiq >= 2.13) {
        return "C_CHOP";
    }
    // Default
    return "B_BASE";
}
function fmtRegime(r) {
    if (r === "A_MOMENTUM")
        return "A (Momentum)";
    if (r === "C_CHOP")
        return "C (Chop)";
    return "B (Base)";
}
// Convert "percent of original" plan into fractions-of-remaining ladder entries
function ladderFractionsFromOriginalPercents(originalPercents) {
    const out = [];
    let remaining = 1;
    for (let i = 0; i < originalPercents.length; i++) {
        const p = originalPercents[i];
        if (i === originalPercents.length - 1) {
            out.push(1.0);
            remaining = 0;
            break;
        }
        const frac = remaining > 0 ? p / remaining : 1.0;
        out.push(Number(frac.toFixed(10)));
        remaining = remaining - p;
        if (remaining < 0)
            remaining = 0;
    }
    return out;
}
function buildLadders(entrySolPerToken, regime) {
    if (regime === "A_MOMENTUM") {
        // 30 / 20 / 50 (runner) at 1.5x / 3x / 6x
        const orig = [0.30, 0.20, 0.50];
        const fracs = ladderFractionsFromOriginalPercents(orig);
        return [
            { multiple: 1.5, targetSolPerToken: entrySolPerToken * 1.5, fraction: fracs[0] },
            { multiple: 3.0, targetSolPerToken: entrySolPerToken * 3.0, fraction: fracs[1] },
            { multiple: 6.0, targetSolPerToken: entrySolPerToken * 6.0, fraction: fracs[2] },
        ];
    }
    if (regime === "C_CHOP") {
        // 70 / 20 / 10 at 1.5x / 2x / 4x
        const orig = [0.70, 0.20, 0.10];
        const fracs = ladderFractionsFromOriginalPercents(orig);
        return [
            { multiple: 1.5, targetSolPerToken: entrySolPerToken * 1.5, fraction: fracs[0] },
            { multiple: 2.0, targetSolPerToken: entrySolPerToken * 2.0, fraction: fracs[1] },
            { multiple: 4.0, targetSolPerToken: entrySolPerToken * 4.0, fraction: fracs[2] },
        ];
    }
    // B_BASE: 40 / 40 / 20 at 1.5x / 2x / 4x
    const orig = [0.40, 0.40, 0.20];
    const fracs = ladderFractionsFromOriginalPercents(orig);
    return [
        { multiple: 1.5, targetSolPerToken: entrySolPerToken * 1.5, fraction: fracs[0] },
        { multiple: 2.0, targetSolPerToken: entrySolPerToken * 2.0, fraction: fracs[1] },
        { multiple: 4.0, targetSolPerToken: entrySolPerToken * 4.0, fraction: fracs[2] },
    ];
}
function ladderSummaryForTelegram(regime) {
    if (regime === "A_MOMENTUM")
        return ["• 1.5x → 30%", "• 3.0x → 20%", "• 6.0x → 50% (runner)"];
    if (regime === "C_CHOP")
        return ["• 1.5x → 70%", "• 2.0x → 20%", "• 4.0x → 10% (runner)"];
    return ["• 1.5x → 40%", "• 2.0x → 40%", "• 4.0x → 20% (runner)"];
}
function computePositionStats() {
    const positions = loadPositions();
    const total = positions.length;
    const open = positions.filter((p) => p.status === "OPEN").length;
    const closedPositions = positions.filter((p) => p.status === "CLOSED");
    const closed = closedPositions.length;
    const wins = closedPositions.filter((p) => p.outcome === "WIN").length;
    const lossRug = closedPositions.filter((p) => p.outcome === "LOSS_RUG").length;
    const lossOther = closedPositions.filter((p) => p.outcome === "LOSS_OTHER").length;
    const winRate = closed > 0 ? wins / closed : 0;
    return { total, open, closed, wins, lossRug, lossOther, winRate };
}
function normalizeInput(input) {
    if (typeof input === "string")
        return { mint: input };
    const mint = input.mint_address || input.mint || input.outputMint;
    if (!mint)
        throw new Error("tradeMintAndRecord() missing mint");
    const meta = {
        fdv_liq_ratio: typeof input.fdv_liq_ratio === "number" ? input.fdv_liq_ratio : undefined,
        vol_liq_ratio: typeof input.vol_liq_ratio === "number" ? input.vol_liq_ratio : undefined,
        symbol: input.symbol,
        source: input.source,
    };
    return { mint, meta };
}
async function tradeMintAndRecord(input) {
    const { mint: outputMint, meta } = normalizeInput(input);
    const RPC_URL = mustEnv("RPC_URL");
    const PRIV = mustEnv("PRIVKEY_BASE58");
    const slippageBps = Number(process.env.SLIPPAGE_BPS ?? 100);
    const priorityMicroLamports = Number(process.env.PRIORITY_MICRO_LAMPORTS ?? 0);
    const maxPerTradeSol = process.env.MAX_PER_TRADE_SOL && Number(process.env.MAX_PER_TRADE_SOL) > 0
        ? Number(process.env.MAX_PER_TRADE_SOL)
        : undefined;
    const positionPct = Number(process.env.POSITION_PCT ?? 0.02);
    // trade_logic expects a takeProfitMultiple, but exits are managed by tp_watcher
    const takeProfitMultiple = Number(process.env.TAKE_PROFIT_MULTIPLE ?? 1.5);
    let result;
    try {
        result = await (0, trade_logic_1.executeTrade)({
            rpcUrl: RPC_URL,
            privKeyBase58: PRIV,
            outputMint,
            mode: "LIVE",
            slippageBps,
            priorityMicroLamports,
            takeProfitMultiple,
            maxPerTradeSol,
            positionPct,
        });
        console.log("[Trader] executeTrade result:", JSON.stringify(result, null, 2));
    }
    catch (e) {
        console.error("[Trader] executeTrade threw:", e);
        if ((0, telegram_1.telegramConfigured)()) {
            await (0, telegram_1.sendTelegramMessage)(["❌ *TRADE ERROR*", `Mint: \`${outputMint}\``, `Error: ${e?.message || String(e)}`].join("\n"));
        }
        return { ok: false, error: e?.message || String(e) };
    }
    if (result.ok && result.live?.signature && result.mode === "LIVE") {
        const positions = loadPositions();
        const entry = result.prices.entry_SOL_per_token;
        const sizeSol = result.sizing.cappedSol;
        const regime = pickRegime(meta);
        const ladders = buildLadders(entry, regime);
        positions.push({
            mint: result.mint,
            entrySolPerToken: entry,
            entrySizeSol: sizeSol,
            createdAt: new Date().toISOString(),
            status: "OPEN",
            regime,
            signal: meta,
            ladders,
        });
        savePositions(positions);
        if ((0, telegram_1.telegramConfigured)()) {
            const lines = [
                "✅ *BUY EXECUTED*",
                `Mint: \`${result.mint}\``,
                meta?.symbol ? `Symbol: *${meta.symbol}*` : "",
                `Regime: *${fmtRegime(regime)}*`,
                `Size: ${sizeSol.toFixed(4)} SOL`,
                `Entry: ${entry.toFixed(9)} SOL/token`,
                "Ladders:",
                ...ladderSummaryForTelegram(regime),
            ].filter(Boolean);
            if (typeof meta?.fdv_liq_ratio === "number")
                lines.push(`FDV/Liq: ${meta.fdv_liq_ratio.toFixed(2)}`);
            if (typeof meta?.vol_liq_ratio === "number")
                lines.push(`Vol/Liq: ${meta.vol_liq_ratio.toFixed(2)}`);
            if (result.live.explorer)
                lines.push(`Tx: ${result.live.explorer}`);
            await (0, telegram_1.sendTelegramMessage)(lines.join("\n"));
        }
    }
    else {
        if ((0, telegram_1.telegramConfigured)()) {
            await (0, telegram_1.sendTelegramMessage)([
                "⚠️ *TRADE FAILED*",
                `Mint: \`${outputMint}\``,
                `Reason: ${result?.error || result?.build_check?.error || "Unknown (no signature returned)"}`,
            ].join("\n"));
        }
    }
    return result;
}
async function mainCli() {
    const outputMint = process.argv[2];
    if (!outputMint)
        throw new Error("Usage: ts-node trader.ts <OUTPUT_MINT>");
    try {
        const result = await tradeMintAndRecord(outputMint);
        process.exit(result.ok ? 0 : 1);
    }
    catch (e) {
        console.error(JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
        process.exit(1);
    }
}
if (require.main === module) {
    mainCli().catch((e) => {
        console.error("Fatal trader CLI error:", e);
        process.exit(1);
    });
}
