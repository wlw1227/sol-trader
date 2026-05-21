// src/signal_server.ts
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.WS_SERVER_PORT ?? 4000);

interface IncomingSignal {
  mint_address: string;
  symbol?: string;
  fdv_liq_ratio?: number;
  vol_liq_ratio?: number;
  score?: number;
  confidence?: "high" | "medium";
  regime_hint?: "A_MOMENTUM" | "B_BASE" | "C_CHOP";
  tp_ladder?: Array<{ multiple: number; pct_of_original: number }>;
  stop_cushion_pct?: number;
  reasoning?: string;
  source?: string;
}

function isValidSignal(obj: any): obj is IncomingSignal {
  return (
    obj !== null &&
    typeof obj === "object" &&
    typeof obj.mint_address === "string" &&
    obj.mint_address.length > 0
  );
}

export function startSignalServer(): WebSocketServer {
  const wss = new WebSocketServer({ port: PORT });
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    clients.add(ws);
    console.log(`[SIGNAL-SERVER] Client connected: ${ip} (total: ${clients.size})`);

    ws.on("message", (data) => {
      let parsed: any;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        console.warn("[SIGNAL-SERVER] Non-JSON message received, ignoring.");
        return;
      }

      if (!isValidSignal(parsed)) {
        console.warn("[SIGNAL-SERVER] Malformed signal (missing/empty mint_address), dropping:", parsed);
        return;
      }

      const ts = new Date().toISOString();
      console.log(
        `[SIGNAL-SERVER] ${ts} | mint=${parsed.mint_address} symbol=${parsed.symbol ?? "n/a"} ` +
        `score=${parsed.score ?? "n/a"} regime=${parsed.regime_hint ?? "n/a"}`
      );

      const forward = JSON.stringify({ type: "signal", ...parsed });

      for (const client of clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(forward);
        }
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[SIGNAL-SERVER] Client disconnected: ${ip} (total: ${clients.size})`);
    });

    ws.on("error", (err) => {
      console.error(`[SIGNAL-SERVER] Client error (${ip}):`, err);
      clients.delete(ws);
    });
  });

  wss.on("listening", () => {
    console.log(`[SIGNAL-SERVER] Listening on ws://localhost:${PORT}`);
  });

  wss.on("error", (err) => {
    console.error("[SIGNAL-SERVER] Server error:", err);
  });

  return wss;
}

if (require.main === module) {
  startSignalServer();
}
