// src/trade_logic.ts
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const JUP_BASE = "https://lite-api.jup.ag";

export type TradeMode = "DRY" | "LIVE";

export interface ExecuteTradeParams {
  rpcUrl: string;
  privKeyBase58: string;
  outputMint: string;
  mode?: TradeMode;
  slippageBps?: number;
  priorityMicroLamports?: number;
  takeProfitMultiple?: number;
  maxPerTradeSol?: number; // optional cap
  positionPct?: number; // default 0.02 (2%)
}

/**
 * BUY SIDE – enter a position
 */
export async function executeTrade(params: ExecuteTradeParams) {
  const {
    rpcUrl,
    privKeyBase58,
    outputMint,
    mode = "DRY",
    slippageBps = 100,
    priorityMicroLamports = 0,
    takeProfitMultiple = 1.5,
    maxPerTradeSol,
    positionPct = 0.02,
  } = params;

  const isLive = mode === "LIVE";

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = Keypair.fromSecretKey(bs58.decode(privKeyBase58));
  const outputMintPk = new PublicKey(outputMint);

  // 1) dynamic sizing from SOL balance
  const solLamports = await connection.getBalance(
    wallet.publicKey,
    "confirmed"
  );
  const solBalance = solLamports / 1e9;
  if (solBalance <= 0.01) {
    throw new Error(`Low SOL balance: ${solBalance.toFixed(4)} SOL`);
  }

  const posSol = solBalance * positionPct;
  const cappedSol = maxPerTradeSol ? Math.min(posSol, maxPerTradeSol) : posSol;

  if (cappedSol <= 0) {
    throw new Error(
      "Capped position size is 0; check maxPerTradeSol / positionPct."
    );
  }

  const inDecimals = 9; // WSOL

  // ✅ Use on-chain decimals via RPC instead of token.jup.ag
  const outDecimals = await getTokenDecimalsOnChain(connection, outputMintPk);

  const amountInAtomic = toAtomic(cappedSol, inDecimals);

  // 2) get quote from Jupiter
  const quote = await jupQuote(
    WSOL.toBase58(),
    outputMintPk.toBase58(),
    amountInAtomic,
    slippageBps
  );

  // 3) build swap tx (needed for LIVE to send)
  let swapBuilt = false;
  let swapTxSize = 0;
  let swapSignature: string | null = null;

  const shouldBuild = true; // always build for sanity-check

  if (shouldBuild) {
    const b64 = await jupBuildSwapTx(
      quote,
      wallet.publicKey.toBase58(),
      priorityMicroLamports
    );
    swapBuilt = !!b64;

    const txBuf = Buffer.from(b64, "base64");
    swapTxSize = txBuf.byteLength;

    if (isLive) {
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([wallet]);

      const sig = await connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3,
      });

      // ✅ Wait for confirmation & mark as failure if tx errored
      const confirmation = await connection.confirmTransaction(
        sig,
        "confirmed"
      );
      if (confirmation.value.err) {
        throw new Error(
          "Swap transaction failed: " +
            JSON.stringify(confirmation.value.err)
        );
      }

      swapSignature = sig;
    }
  }

  // 4) compute expected amounts and prices
  const expectedOutAtomic: string = quote.outAmount;
  const expectedTokens = fromAtomic(expectedOutAtomic, outDecimals);

  const entryPrice_SOL_per_token =
    expectedTokens > 0 ? cappedSol / expectedTokens : 0;
  const targetPrice = entryPrice_SOL_per_token * takeProfitMultiple;

  // 5) compute "limit order" info (informational TP amounts)
  const inAmountLOAtomic = toAtomic(expectedTokens, outDecimals); // sell all tokens
  const outAmountWSOLAtomic = toAtomic(
    expectedTokens * targetPrice,
    inDecimals
  );

  // 6) return JSON shape
  return {
    ok: true,
    mode: isLive ? "LIVE" : "DRY_RUN",
    mint: outputMintPk.toBase58(),
    rpc: rpcUrl.split("?")[0],
    sizing: {
      solBalance,
      posSol,
      cappedSol,
    },
    quote: {
      inAtomic: amountInAtomic,
      outAtomic: expectedOutAtomic,
      outTokens: expectedTokens,
      slippageBps,
    },
    prices: {
      entry_SOL_per_token: entryPrice_SOL_per_token,
      tpMultiple: takeProfitMultiple,
      target_SOL_per_token: targetPrice,
    },
    limit_order: {
      inAmountAtomic: inAmountLOAtomic,
      outAmountAtomic: outAmountWSOLAtomic,
    },
    build_check: {
      swapBuilt,
      swapTxBytes: swapTxSize,
    },
    live: {
      isLive,
      signature: swapSignature,
      explorer: swapSignature
        ? `https://solscan.io/tx/${swapSignature}`
        : null,
    },
  };
}

// ---------- shared helpers ----------

function toAtomic(amount: number, decimals: number) {
  return BigInt(Math.floor(amount * 10 ** decimals)).toString();
}

function fromAtomic(atomic: string, decimals: number) {
  return Number(atomic) / 10 ** decimals;
}

// ✅ On-chain decimals helper, shared by buy + sell
async function getTokenDecimalsOnChain(
  connection: Connection,
  mint: PublicKey
): Promise<number> {
  try {
    const info = await connection.getParsedAccountInfo(mint, "confirmed");
    const data: any = info.value?.data;
    const parsed = data?.parsed;
    const decimals = parsed?.info?.decimals;
    if (typeof decimals === "number") return decimals;
  } catch (e) {
    console.warn(
      "[TRADE] Failed to fetch token decimals on-chain, defaulting to 9:",
      e
    );
  }
  return 9;
}

async function jupQuote(
  inputMint: string,
  outputMint: string,
  amountAtomic: string,
  slippageBps: number
) {
  const url = new URL("/swap/v1/quote", JUP_BASE);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amountAtomic);
  url.searchParams.set("slippageBps", String(slippageBps));

  const res = await fetch(url.toString());
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`quote ${res.status}: ${text}`);
  }

  return JSON.parse(text);
}

async function jupBuildSwapTx(
  quoteResponse: any,
  userPublicKey: string,
  priorityMicroLamports: number
) {
  const body: any = {
    quoteResponse,
    userPublicKey,
    asLegacyTransaction: false,
    wrapAndUnwrapSol: true,
    useSharedAccounts: false,
    dynamicComputeUnitLimit: true,
  };

  if (priorityMicroLamports > 0) {
    body.computeUnitPriceMicroLamports = priorityMicroLamports;
  }

  const res = await fetch(`${JUP_BASE}/swap/v1/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`swap ${res.status}: ${text}`);
  }

  const data = JSON.parse(text);
  return data.swapTransaction as string; // base64 v0 tx
}

// ---------- SELL ALL SIDE ----------

export interface ExecuteSellAllParams {
  rpcUrl: string;
  privKeyBase58: string;
  mint: string; // token to sell
  mode?: TradeMode; // "DRY" or "LIVE"
  slippageBps?: number;
  priorityMicroLamports?: number;
}

/**
 * Market-sell ALL of the given token mint for SOL using Jupiter.
 */
export async function executeSellAll(params: ExecuteSellAllParams) {
  const {
    rpcUrl,
    privKeyBase58,
    mint,
    mode = "DRY",
    slippageBps = 100,
    priorityMicroLamports = 0,
  } = params;

  const isLive = mode === "LIVE";

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = Keypair.fromSecretKey(bs58.decode(privKeyBase58));
  const mintPk = new PublicKey(mint);

  // SOL balance before sell (for reference)
  const solLamportsBefore = await connection.getBalance(
    wallet.publicKey,
    "confirmed"
  );
  const solBalanceBefore = solLamportsBefore / 1e9;

  // 1) figure out token decimals (on-chain)
  const tokenDecimals = await getTokenDecimalsOnChain(connection, mintPk);

  // 2) load all token accounts for this mint
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { mint: mintPk },
    "confirmed"
  );

  let totalTokenAtomic = 0n;

  for (const { account } of tokenAccounts.value) {
    const data: any = account.data;
    const parsed = data.parsed;
    const info = parsed?.info;
    const tokenAmount = info?.tokenAmount?.amount;
    if (typeof tokenAmount === "string") {
      totalTokenAtomic += BigInt(tokenAmount);
    }
  }

  if (totalTokenAtomic <= 0n) {
    throw new Error(`No balance found for mint ${mintPk.toBase58()}`);
  }

  const totalTokens = fromAtomic(
    totalTokenAtomic.toString(),
    tokenDecimals
  );

  // 3) quote selling that many tokens into WSOL
  const amountInAtomic = totalTokenAtomic.toString();

  const quote = await jupQuote(
    mintPk.toBase58(), // input = token
    WSOL.toBase58(), // output = WSOL/SOL
    amountInAtomic,
    slippageBps
  );

  // 4) build swap tx, maybe send it
  let swapBuilt = false;
  let swapTxSize = 0;
  let swapSignature: string | null = null;

  const b64 = await jupBuildSwapTx(
    quote,
    wallet.publicKey.toBase58(),
    priorityMicroLamports
  );
  swapBuilt = !!b64;

  const txBuf = Buffer.from(b64, "base64");
  swapTxSize = txBuf.byteLength;

  if (isLive) {
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    const sig = await connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
    });

    const confirmation = await connection.confirmTransaction(
      sig,
      "confirmed"
    );
    if (confirmation.value.err) {
      throw new Error(
        "Sell-all transaction failed: " +
          JSON.stringify(confirmation.value.err)
      );
    }

    swapSignature = sig;
  }

  // 5) compute expected SOL received and implied price
  const expectedOutAtomic: string = quote.outAmount;
  const expectedSol = fromAtomic(expectedOutAtomic, 9); // WSOL has 9 decimals
  const realizedPrice_SOL_per_token =
    totalTokens > 0 ? expectedSol / totalTokens : 0;

  return {
    ok: true,
    side: "SELL",
    mode: isLive ? "LIVE" : "DRY_RUN",
    mint: mintPk.toBase58(),
    rpc: rpcUrl.split("?")[0],
    sizing: {
      solBalanceBefore,
      tokenBalanceTokens: totalTokens,
    },
    quote: {
      inAtomic: amountInAtomic,
      outAtomic: expectedOutAtomic,
      outSol: expectedSol,
      slippageBps,
    },
    prices: {
      realized_SOL_per_token: realizedPrice_SOL_per_token,
    },
    build_check: {
      swapBuilt,
      swapTxBytes: swapTxSize,
    },
    live: {
      isLive,
      signature: swapSignature,
      explorer: swapSignature
        ? `https://solscan.io/tx/${swapSignature}`
        : null,
    },
  };
}

// ---------- SELL FRACTION SIDE ----------

export interface ExecuteSellFractionParams {
  rpcUrl: string;
  privKeyBase58: string;
  mint: string; // token to sell
  fraction: number; // 0–1 of total token balance to sell
  mode?: TradeMode; // "DRY" or "LIVE"
  slippageBps?: number;
  priorityMicroLamports?: number;
}

/**
 * Market-sell a FRACTION of the given token mint for SOL using Jupiter.
 * Returns outSol and realized_SOL_per_token so the watcher can track actual SOL proceeds.
 */
export async function executeSellFraction(
  params: ExecuteSellFractionParams
) {
  const {
    rpcUrl,
    privKeyBase58,
    mint,
    fraction,
    mode = "DRY",
    slippageBps = 100,
    priorityMicroLamports = 0,
  } = params;

  const isLive = mode === "LIVE";

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = Keypair.fromSecretKey(bs58.decode(privKeyBase58));
  const mintPk = new PublicKey(mint);

  // SOL balance before sell (for reference)
  const solLamportsBefore = await connection.getBalance(
    wallet.publicKey,
    "confirmed"
  );
  const solBalanceBefore = solLamportsBefore / 1e9;

  // 1) figure out token decimals (on-chain)
  const tokenDecimals = await getTokenDecimalsOnChain(connection, mintPk);

  // 2) load all token accounts for this mint & sum total token balance
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { mint: mintPk },
    "confirmed"
  );

  let totalTokenAtomic = 0n;

  for (const { account } of tokenAccounts.value) {
    const data: any = account.data;
    const parsed = data.parsed;
    const info = parsed?.info;
    const tokenAmount = info?.tokenAmount?.amount;
    if (typeof tokenAmount === "string") {
      totalTokenAtomic += BigInt(tokenAmount);
    }
  }

  if (totalTokenAtomic <= 0n) {
    throw new Error(`No balance found for mint ${mintPk.toBase58()}`);
  }

  const totalTokens = fromAtomic(
    totalTokenAtomic.toString(),
    tokenDecimals
  );
  const frac = Math.max(0, Math.min(1, fraction || 0));
  const tokensToSell = totalTokens * frac;

  if (tokensToSell <= 0) {
    throw new Error(
      `Fraction too small, tokensToSell is 0 for mint ${mintPk.toBase58()}`
    );
  }

  const amountInAtomic = toAtomic(tokensToSell, tokenDecimals);

  // 3) quote selling that many tokens into WSOL
  const quote = await jupQuote(
    mintPk.toBase58(), // input = token
    WSOL.toBase58(), // output = WSOL/SOL
    amountInAtomic,
    slippageBps
  );

  // 4) build swap tx, maybe send it
  let swapBuilt = false;
  let swapTxSize = 0;
  let swapSignature: string | null = null;

  const b64 = await jupBuildSwapTx(
    quote,
    wallet.publicKey.toBase58(),
    priorityMicroLamports
  );
  swapBuilt = !!b64;

  const txBuf = Buffer.from(b64, "base64");
  swapTxSize = txBuf.byteLength;

  if (isLive) {
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    const sig = await connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
    });

    const confirmation = await connection.confirmTransaction(
      sig,
      "confirmed"
    );
    if (confirmation.value.err) {
      throw new Error(
        "Sell-fraction transaction failed: " +
          JSON.stringify(confirmation.value.err)
      );
    }

    swapSignature = sig;
  }

  // 5) compute expected SOL received and implied price for THIS SLICE
  const expectedOutAtomic: string = quote.outAmount;
  const expectedSol = fromAtomic(expectedOutAtomic, 9); // WSOL has 9 decimals
  const realizedPrice_SOL_per_token =
    tokensToSell > 0 ? expectedSol / tokensToSell : 0;

  return {
    ok: true,
    side: "SELL",
    mode: isLive ? "LIVE" : "DRY_RUN",
    mint: mintPk.toBase58(),
    rpc: rpcUrl.split("?")[0],
    fractionSold: frac,
    sizing: {
      solBalanceBefore,
      tokenBalanceTokens: totalTokens,
      tokensSold: tokensToSell,
    },
    quote: {
      inAtomic: amountInAtomic,
      outAtomic: expectedOutAtomic,
      outSol: expectedSol,
      slippageBps,
    },
    prices: {
      realized_SOL_per_token: realizedPrice_SOL_per_token,
    },
    build_check: {
      swapBuilt,
      swapTxBytes: swapTxSize,
    },
    live: {
      isLive,
      signature: swapSignature,
      explorer: swapSignature
        ? `https://solscan.io/tx/${swapSignature}`
        : null,
    },
  };
}
