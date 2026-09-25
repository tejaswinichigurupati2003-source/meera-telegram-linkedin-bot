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
   2. If it passes, pulls a few real, current headlines relevant to the
      note's topic from **Google News RSS** (`lib/context.ts`), falling
      back to a generic skincare-industry query if nothing topic-specific
      comes back, so there's always a real link to cite.
   3. Loads `voice-skill/meera-voice.txt`, calls Gemini with the note + the
      identified shape + those headlines, and replies into the channel with
      `📝 Draft:` prefixed to the generated post (plus its score breakdown),
      a `Source:` line with the real headline link at the end, using
      `reply_to_message_id` so it threads under Meera's original note.
5. On failure it logs the error and posts a short `⚠️ Draft generation
   failed` reply so Meera isn't left wondering.

## Known tradeoffs (v1, no database)

- **Dedupe is best-effort, in-memory only.** It survives within a warm
  function instance but resets on cold starts. Worst case: an occasional
  duplicate draft reply. If this becomes annoying, swap `lib/dedupe.ts` for
  Vercel KV (~10 lines).
- **Draft history lives in Vercel's function logs**, not a queryable store.
  Fine for eyeballing recent drafts; not for querying "every draft from
  March." Same fix (a small KV/DB addition) applies if you outgrow this.

## Project layout

- `api/webhook.ts` — Telegram webhook receiver: secret-token check,
  self-post guard, content-type guard, dedupe, fast ACK, async generation.
- `lib/telegram.ts` — thin Telegram Bot API wrapper (`sendMessage`,
  `getMe`).
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
