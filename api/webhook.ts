import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
  getMe,
  sendMessage,
  type CallbackQuery,
  type InlineKeyboardMarkup,
  type TelegramMessage,
  type TelegramUpdate,
} from "../lib/telegram";
import { draftLinkedInPost, scoreNoteEligibility } from "../lib/gemini";
import { isDuplicate } from "../lib/dedupe";
import { getDraftContext, saveDraftContext, updateDraftMessageId, type DraftContext } from "../lib/draftStore";

const DRAFT_LABEL = "📝 Draft:";
const NOT_ELIGIBLE_LABEL = "🚫 Not post-ready yet:";
const FAILURE_LABEL = "⚠️ Draft generation failed — check the logs.";

type FeedbackAction = "like" | "redraft" | "kill";

function feedbackKeyboard(originalMessageId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "👍 Like it", callback_data: `like:${originalMessageId}` },
        { text: "🔁 Redraft", callback_data: `redraft:${originalMessageId}` },
        { text: "🗑️ Kill it", callback_data: `kill:${originalMessageId}` },
      ],
    ],
  };
}

/** Distinctly tagged so this becomes the queryable-in-logs record of Meera's reactions to drafts. */
function logFeedback(action: FeedbackAction, originalMessageId: number, context: DraftContext): void {
  console.log("MEERA_FEEDBACK", {
    action,
    originalMessageId,
    chatId: context.chatId,
    postType: context.postType,
    noteText: context.noteText,
  });
}

let cachedBotId: number | null = null;

async function getBotId(): Promise<number> {
  if (cachedBotId !== null) {
    return cachedBotId;
  }
  const me = await getMe();
  cachedBotId = me.id;
  return cachedBotId;
}

function isPlainTextNote(message: TelegramMessage): boolean {
  if (!message.text) {
    return false;
  }
  if (message.photo || message.sticker) {
    return false;
  }
  if (message.forward_date || message.forward_from_chat) {
    return false;
  }
  return true;
}

async function generateAndReply(message: TelegramMessage): Promise<void> {
  const noteText = message.text as string;

  try {
    const eligibility = await scoreNoteEligibility(noteText);
    console.log("Eligibility scored", {
      chatId: message.chat.id,
      messageId: message.message_id,
      ...eligibility,
    });

    const scoreLine =
      `Specificity ${eligibility.scores.specificity}/10 · Shape clarity ${eligibility.scores.shapeClarity}/10 · ` +
      `Creativity ${eligibility.scores.creativity}/10 · Brand fit ${eligibility.scores.brandFit}/10 ` +
      `(Total: ${eligibility.total}/40)`;

    if (!eligibility.eligible) {
      await sendMessage(
        message.chat.id,
        `${NOT_ELIGIBLE_LABEL}\n\n${eligibility.reason}\n\n${scoreLine}`,
        message.message_id
      );
      return;
    }

    const { text: draft, sourceLink } = await draftLinkedInPost(noteText, eligibility.postType, eligibility.searchQuery);
    const sourceLine = sourceLink ? `\n\nSource: ${sourceLink}` : "";
    const sent = await sendMessage(
      message.chat.id,
      `${DRAFT_LABEL} (${scoreLine})\n\n${draft}${sourceLine}`,
      message.message_id,
      feedbackKeyboard(message.message_id)
    );

    saveDraftContext(message.message_id, {
      chatId: message.chat.id,
      noteText,
      postType: eligibility.postType,
      searchQuery: eligibility.searchQuery,
      draftMessageId: sent.message_id,
    });
  } catch (err) {
    console.error("Draft generation failed", {
      chatId: message.chat.id,
      messageId: message.message_id,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await sendMessage(message.chat.id, FAILURE_LABEL, message.message_id);
    } catch (notifyErr) {
      console.error("Failed to post failure notice", notifyErr);
    }
  }
}

async function handleCallbackQuery(callbackQuery: CallbackQuery): Promise<void> {
  const [action, originalMessageIdRaw] = (callbackQuery.data ?? "").split(":");
  const originalMessageId = Number(originalMessageIdRaw);
  const context = getDraftContext(originalMessageId);

  if (!context || !["like", "redraft", "kill"].includes(action)) {
    await answerCallbackQuery(callbackQuery.id, "This draft's context expired — repost the note to try again.");
    return;
  }

  const typedAction = action as FeedbackAction;
  logFeedback(typedAction, originalMessageId, context);

  try {
    if (typedAction === "like") {
      await answerCallbackQuery(callbackQuery.id, "👍 Noted!");
      await editMessageReplyMarkup(context.chatId, context.draftMessageId, { inline_keyboard: [] });
      await sendMessage(context.chatId, "✅ Liked — noted for future drafts.", context.draftMessageId);
      return;
    }

    if (typedAction === "kill") {
      await answerCallbackQuery(callbackQuery.id, "🗑️ Killed");
      await editMessageReplyMarkup(context.chatId, context.draftMessageId, { inline_keyboard: [] });
      await sendMessage(context.chatId, "🗑️ Killed — won't suggest a similar angle again.", context.draftMessageId);
      return;
    }

    // redraft
    await answerCallbackQuery(callbackQuery.id, "🔁 Redrafting…");
    await editMessageReplyMarkup(context.chatId, context.draftMessageId, { inline_keyboard: [] });

    const { text: draft, sourceLink } = await draftLinkedInPost(context.noteText, context.postType, context.searchQuery);
    const sourceLine = sourceLink ? `\n\nSource: ${sourceLink}` : "";
    const sent = await sendMessage(
      context.chatId,
      `${DRAFT_LABEL} (redrafted)\n\n${draft}${sourceLine}`,
      originalMessageId,
      feedbackKeyboard(originalMessageId)
    );
    updateDraftMessageId(originalMessageId, sent.message_id);
  } catch (err) {
    console.error("Failed to handle feedback button", {
      action: typedAction,
      originalMessageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const providedSecret = req.headers["x-telegram-bot-api-secret-token"];
  if (!expectedSecret || providedSecret !== expectedSecret) {
    res.status(401).send("Unauthorized");
    return;
  }

  const update = req.body as TelegramUpdate;

  if (isDuplicate(update.update_id)) {
    res.status(200).send("OK");
    return;
  }

  if (update.callback_query) {
    if (update.callback_query.from.is_bot) {
      res.status(200).send("OK");
      return;
    }
    waitUntil(handleCallbackQuery(update.callback_query));
    res.status(200).send("OK");
    return;
  }

  const message = update.channel_post ?? update.message;

  if (!message) {
    res.status(200).send("OK");
    return;
  }

  try {
    const botId = await getBotId();
    if (message.from?.id === botId || message.from?.is_bot) {
      res.status(200).send("OK");
      return;
    }
  } catch (err) {
    console.error("Failed to resolve bot identity, skipping to be safe", err);
    res.status(200).send("OK");
    return;
  }

  if (!isPlainTextNote(message)) {
    res.status(200).send("OK");
    return;
  }

  waitUntil(generateAndReply(message));

  res.status(200).send("OK");
}
