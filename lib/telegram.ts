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

export interface CallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  channel_post?: TelegramMessage;
  message?: TelegramMessage;
  callback_query?: CallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
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

/** Sends a text message, optionally as a reply and/or with an inline keyboard attached. */
export async function sendMessage(
  chatId: number,
  text: string,
  replyToMessageId?: number,
  replyMarkup?: InlineKeyboardMarkup
): Promise<TelegramMessage> {
  return callTelegramApi<TelegramMessage>("sendMessage", {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMessageId,
    allow_sending_without_reply: true,
    reply_markup: replyMarkup,
  });
}

/** Replaces (or clears, with an empty list) a sent message's inline keyboard. */
export async function editMessageReplyMarkup(
  chatId: number,
  messageId: number,
  replyMarkup: InlineKeyboardMarkup
): Promise<void> {
  await callTelegramApi<TelegramMessage>("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

/** Acknowledges a button tap so Telegram's client-side loading spinner clears. */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await callTelegramApi<boolean>("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

/** Looks up the bot's own identity, used to guard against processing its own posts. */
export async function getMe(): Promise<TelegramUser> {
  return callTelegramApi<TelegramUser>("getMe", {});
}
