const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: TelegramUser;
  sender_chat?: { id: number; title?: string };
  text?: string;
  photo?: unknown;
  sticker?: unknown;
  forward_date?: number;
  forward_from_chat?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  channel_post?: TelegramMessage;
  message?: TelegramMessage;
}

function botToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  return token;
}

async function callTelegramApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken()}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description ?? res.statusText}`);
  }
  return data.result;
}

/** Sends a text message, optionally as a reply to another message in the same chat. */
export async function sendMessage(
  chatId: number,
  text: string,
  replyToMessageId?: number
): Promise<TelegramMessage> {
  return callTelegramApi<TelegramMessage>("sendMessage", {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMessageId,
    allow_sending_without_reply: true,
  });
}

/** Looks up the bot's own identity, used to guard against processing its own posts. */
export async function getMe(): Promise<TelegramUser> {
  return callTelegramApi<TelegramUser>("getMe", {});
}
