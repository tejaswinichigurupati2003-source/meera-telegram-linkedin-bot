# Meera Telegram → LinkedIn Draft Bot

Meera posts a raw thought into her Telegram channel. Gemini rewrites it into a
LinkedIn draft in her voice, and the bot replies with that draft in the same
channel — no copy-pasting between apps.

## How it works

1. Meera posts a raw note in the Telegram channel.
2. Telegram sends a `channel_post` update to `POST /api/webhook`.
3. The handler verifies Telegram's secret token header, confirms the post
   wasn't authored by the bot itself, confirms it's plain text, and does a
   best-effort in-memory dedupe on `update_id`.
4. It returns `200 OK` immediately, then asynchronously (via
   [`waitUntil`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil)):
   1. **Scores the note against the voice-skill's quality gate**, 0-10 on
      each of four criteria — specificity (a checkable fact), shape clarity
      (maps to one of the six post types), creativity (a non-obvious angle,
      not a generic take), and brand fit (no invented Skinstinct claim
      needed). Gemini returns the breakdown, a postType, and a reason as
      structured JSON. A note scoring below 24/40 gets a
      `🚫 Not post-ready yet:` reply with the reason and the full score
      breakdown — no draft is forced.
   2. If it passes, the same Gemini call also produces a precise,
      topic-specific search phrase (not the whole note), which
      `lib/context.ts` uses against **Google News RSS** — first as an exact
      quoted phrase, then as loose keywords, then a generic
      skincare-industry query — so headlines are actually on-topic instead
      of matching on generic words like "skincare".
   3. Loads `voice-skill/meera-voice.txt`, calls Gemini with the note + the
      identified shape + those candidate headlines, and asks it to report
      which headline (if any) it genuinely cited — the reply's `Source:`
      link is that exact headline, not just the top search result, so the
      link always matches what the draft is actually about. Replies with
      `📝 Draft:` prefixed to the generated post (plus its score breakdown)
      and the source link at the end, using `reply_to_message_id` so it
      threads under Meera's original note, with three inline buttons
      attached: **👍 Like it**, **🔁 Redraft**, **🗑️ Kill it**.
5. On failure it logs the error and posts a short `⚠️ Draft generation
   failed` reply so Meera isn't left wondering.
6. Tapping a button sends Telegram a `callback_query` update to the same
   webhook. The handler looks up that note's context (text, identified
   shape, search query) from an in-memory store keyed by the note's
   message id, then:
   - **Like it** — clears the buttons, posts a short "✅ Liked" confirmation.
   - **Kill it** — clears the buttons, posts a "🗑️ Killed" confirmation.
   - **Redraft** — clears the old buttons and generates a fresh draft from
     the same note (skipping re-scoring), replying with a new draft +
     buttons threaded under the original note.

   Every tap is logged as a `MEERA_FEEDBACK` line (action, note text,
   identified post type) in Vercel's function logs — the intended record
   for later analysis of what she likes, redrafts, or kills. There's no
   database in v1 (see tradeoffs), so this is grep-in-the-dashboard
   analysis today; the same small KV/DB addition mentioned below would
   make it queryable.

## Known tradeoffs (v1, no database)

- **Dedupe is best-effort, in-memory only.** It survives within a warm
  function instance but resets on cold starts. Worst case: an occasional
  duplicate draft reply. If this becomes annoying, swap `lib/dedupe.ts` for
  Vercel KV (~10 lines).
- **Draft history and like/redraft/kill feedback both live in Vercel's
  function logs**, not a queryable store. Fine for eyeballing recent drafts
  or a stretch of `MEERA_FEEDBACK` lines; not for querying "every draft
  from March" or aggregating her preferences over time. Same fix (a small
  KV/DB addition) applies if you outgrow this.
- **Button context is best-effort in-memory too** (`lib/draftStore.ts`),
  same tradeoff as dedupe: a cold start between posting a note and tapping
  its button loses that note's context, and the button replies "context
  expired — repost the note to try again."

## Project layout

- `api/webhook.ts` — Telegram webhook receiver: secret-token check,
  self-post guard, content-type guard, dedupe, fast ACK, async generation,
  and `callback_query` handling for the like/redraft/kill buttons.
- `lib/telegram.ts` — thin Telegram Bot API wrapper (`sendMessage` with an
  optional inline keyboard, `editMessageReplyMarkup`,
  `answerCallbackQuery`, `getMe`).
- `lib/draftStore.ts` — in-memory map from a note's message id to its
  drafting context (text, shape, search query), so a button tap can act on
  it without re-fetching from Telegram.
- `lib/gemini.ts` — `scoreNoteEligibility` (4-criterion 0-10 quality-gate
  rubric, structured JSON output) and `draftLinkedInPost` (prompt assembly:
  voice skill + note + identified shape + news headlines, returns the draft
  plus the real source link to attach), both against Gemini with a timeout.
- `lib/context.ts` — fetches and parses relevant headlines from Google News
  RSS for the note's topic, with a generic-query fallback so a real link is
  (almost) always available; returns `[]` on total failure.
- `lib/dedupe.ts` — in-memory `Set<update_id>`, size-capped.
- `voice-skill/meera-voice.txt` — the versioned voice-skill prompt. Refine
  Meera's voice over time by editing this file and redeploying; git history
  is the changelog.

## Environment variables

```
TELEGRAM_BOT_TOKEN=      # from BotFather
TELEGRAM_WEBHOOK_SECRET= # random string, used in setWebhook + verified per-request
GEMINI_API_KEY=          # Gemini API key
```

Copy `.env.example` to `.env.local` for local reference — Vercel env vars are
set in the dashboard, not read from this file at runtime. Code runs and
deploys fine with these unset; Telegram/Gemini calls just fail gracefully
(and Meera gets the `⚠️` reply) until real keys are added.

## Deploying

```bash
npm install
```

1. Push this repo to GitHub.
2. Import it into Vercel, and set `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET`, and `GEMINI_API_KEY` in the Vercel project's
   environment variables.
3. Deploy.
4. Register the webhook once, so Telegram forwards channel updates to
   `/api/webhook`:

   ```bash
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://<your-vercel-deployment>.vercel.app/api/webhook",
       "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
     }'
   ```

5. Add the bot as an **admin** of Meera's channel — required for both
   receiving `channel_post` updates and posting replies back into it.

## Explicitly out of scope for v1

- No approval/edit step before an eligible note's draft is posted — it goes
  straight back as a labeled reply for Meera to review, edit, or post from
  there.
- No database — see tradeoffs above.
