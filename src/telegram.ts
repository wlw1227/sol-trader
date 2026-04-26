import dotenv from "dotenv";
dotenv.config();

// If TypeScript whines about fetch, you can either:
// - add "DOM" to tsconfig lib, or
// - uncomment this next line:
// declare const fetch: any;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export function telegramConfigured(): boolean {
  return !!BOT_TOKEN && !!CHAT_ID;
}

export async function sendTelegramMessage(text: string) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("[TG] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID, skipping Telegram send.");
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("[TG] sendMessage failed:", res.status, body);
    }
  } catch (e) {
    console.error("[TG] Error sending Telegram message:", e);
  }
}
