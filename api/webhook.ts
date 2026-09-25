import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { getMe, sendMessage, type TelegramMessage, type TelegramUpdate } from "../lib/telegram";
import { draftLinkedInPost, scoreNoteEligibility } from "../lib/gemini";
import { isDuplicate } from "../lib/dedupe";

const DRAFT_LABEL = "📝 Draft:";
const NOT_ELIGIBLE_LABEL = "🚫 Not post-ready yet:";
const FAILURE_LABEL = "⚠️ Draft generation failed — check the logs.";

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

    const { text: draft, sourceLink } = await draftLinkedInPost(noteText, eligibility.postType);
    const sourceLine = sourceLink ? `\n\nSource: ${sourceLink}` : "";
    await sendMessage(
      message.chat.id,
      `${DRAFT_LABEL} (${scoreLine})\n\n${draft}${sourceLine}`,
      message.message_id
    );
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
  const message = update.channel_post ?? update.message;

  if (!message) {
    res.status(200).send("OK");
    return;
  }

  if (isDuplicate(update.update_id)) {
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
