/**
 * Best-effort in-memory record of a note's drafting context, keyed by the
 * original note's message_id, so a button tap (like/redraft/kill) can find
 * the note text again without re-fetching it from Telegram (bots can't read
 * arbitrary historical messages) or standing up a database.
 *
 * Same tradeoff as lib/dedupe.ts: survives within a warm function instance,
 * resets on cold starts. Worst case a stale button after a cold start gets
 * a "context expired, repost the note" reply.
 */

const MAX_ENTRIES = 200;

export interface DraftContext {
  chatId: number;
  noteText: string;
  postType: string | null;
  searchQuery: string;
  draftMessageId: number;
}

const store = new Map<number, DraftContext>();

export function saveDraftContext(originalMessageId: number, context: DraftContext): void {
  store.set(originalMessageId, context);
  if (store.size > MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) {
      store.delete(oldestKey);
    }
  }
}

export function getDraftContext(originalMessageId: number): DraftContext | undefined {
  return store.get(originalMessageId);
}

export function updateDraftMessageId(originalMessageId: number, newDraftMessageId: number): void {
  const context = store.get(originalMessageId);
  if (context) {
    context.draftMessageId = newDraftMessageId;
  }
}
