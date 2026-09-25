import { readFileSync } from "fs";
import { join } from "path";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { getTrendingNews, formatNewsForPrompt } from "./context";

const GENERATION_TIMEOUT_MS = 30_000;
const MODEL_NAME = "gemini-3.6-flash";

const POST_TYPES = [
  "Ingredient Deep-Dive",
  "Founder Story",
  "India-Specific Context",
  "Industry Transparency",
  "Consumer Education / Formulation Science",
  "Brand Philosophy",
] as const;

/** Each rubric criterion is scored 0-10; total out of 40. */
export interface EligibilityScores {
  specificity: number; // has a checkable number/incident/mechanism, not just a mood
  shapeClarity: number; // cleanly maps to one of the six post shapes
  creativity: number; // how fresh/non-obvious the angle is, vs. a generic take
  brandFit: number; // doesn't need an invented Skinstinct claim; implicates the brand where honest
}

export interface EligibilityResult {
  eligible: boolean;
  scores: EligibilityScores;
  total: number;
  postType: string | null;
  reason: string;
  searchQuery: string;
}

const ELIGIBILITY_THRESHOLD = 24; // 60% of 40

let cachedVoiceSkill: string | null = null;
let cachedClient: GoogleGenerativeAI | null = null;

function loadVoiceSkill(): string {
  if (cachedVoiceSkill) {
    return cachedVoiceSkill;
  }
  const path = join(process.cwd(), "voice-skill", "meera-voice.txt");
  cachedVoiceSkill = readFileSync(path, "utf-8");
  return cachedVoiceSkill;
}

function getClient(): GoogleGenerativeAI {
  if (cachedClient) {
    return cachedClient;
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  cachedClient = new GoogleGenerativeAI(apiKey);
  return cachedClient;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gemini call timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Scores a raw note 0-10 on four criteria (specificity, shape clarity,
 * creativity, brand fit) per the voice-skill's quality gate. A note scoring
 * below the eligibility threshold gets flagged back to Meera instead of
 * forcing a draft.
 */
export async function scoreNoteEligibility(noteText: string): Promise<EligibilityResult> {
  const model = getClient().getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          scores: {
            type: SchemaType.OBJECT,
            properties: {
              specificity: { type: SchemaType.INTEGER },
              shapeClarity: { type: SchemaType.INTEGER },
              creativity: { type: SchemaType.INTEGER },
              brandFit: { type: SchemaType.INTEGER },
            },
            required: ["specificity", "shapeClarity", "creativity", "brandFit"],
          },
          postType: { type: SchemaType.STRING, enum: [...POST_TYPES, "none"] },
          reason: { type: SchemaType.STRING },
          searchQuery: { type: SchemaType.STRING },
        },
        required: ["scores", "postType", "reason", "searchQuery"],
      },
    },
  });

  const prompt = [
    "You are gatekeeping raw Telegram notes for Meera Pillai (Skinstinct) before they",
    "become LinkedIn drafts. Score the note 0-10 on each of these four criteria:",
    "",
    "- specificity: does it contain (or point to) a specific, checkable fact - a",
    "  number, an incident, a named mechanism? 0 = only a mood or vague opinion with",
    "  nothing concrete underneath. 10 = a precise, checkable number or incident.",
    "- shapeClarity: how cleanly does it map to exactly one of these six post shapes:",
    "  " + POST_TYPES.join(", ") + "? 0 = could go three different directions with",
    "  equal weight. 10 = unmistakably one shape.",
    "- creativity: how fresh and non-obvious is the angle, versus a generic skincare",
    "  take anyone could write? 0 = generic/predictable. 10 = a genuinely original",
    "  observation or framing.",
    "- brandFit: would drafting this require inventing a Skinstinct product claim or a",
    "  study that isn't in the note? 0 = yes, it would need an invented claim. 10 = no",
    "  invention needed, and it fits her pattern of implicating her own brand rather",
    "  than only praising it.",
    "",
    "Set postType to the single best-matching shape, or \"none\" if the note doesn't",
    'clearly map to one. reason must be one or two concrete sentences justifying the',
    "scores - if they're low, say plainly what's missing (e.g. \"has the observation",
    'but no specific number behind it yet").',
    "",
    "Also set searchQuery: a precise 3-6 word Google News search phrase for the note's",
    "core factual subject (the specific ingredient, mechanism, product category, or",
    "incident type) - specific enough to surface a genuinely relevant article, not a",
    'generic skincare phrase. E.g. for a note about physical sunscreen filters',
    'degrading after opening, use something like "sunscreen physical filter shelf',
    'life", not just "sunscreen" or "skincare".',
    "",
    "RAW NOTE:",
    noteText,
  ].join("\n");

  const result = await withTimeout(model.generateContent(prompt), GENERATION_TIMEOUT_MS);
  const parsed = JSON.parse(result.response.text()) as {
    scores: EligibilityScores;
    postType: string;
    reason: string;
    searchQuery: string;
  };

  const total =
    parsed.scores.specificity + parsed.scores.shapeClarity + parsed.scores.creativity + parsed.scores.brandFit;

  return {
    eligible: total >= ELIGIBILITY_THRESHOLD,
    scores: parsed.scores,
    total,
    postType: parsed.postType === "none" ? null : parsed.postType,
    reason: parsed.reason,
    searchQuery: parsed.searchQuery,
  };
}

export interface DraftResult {
  text: string;
  sourceLink: string | null;
}

/**
 * Assembles the voice-skill prompt, grounds it in real Google News RSS
 * headlines fetched with a precise, topic-specific query, and asks Gemini
 * to draft a LinkedIn post plus report which headline (if any) it actually
 * used. The returned sourceLink always matches what the draft references,
 * rather than blindly attaching the top search result - falling back to
 * that top result only when Gemini didn't need to cite anything specific.
 */
export async function draftLinkedInPost(
  noteText: string,
  postType: string | null,
  searchQuery: string
): Promise<DraftResult> {
  const voiceSkill = loadVoiceSkill();
  const newsItems = await getTrendingNews(searchQuery);
  console.log("News lookup", { searchQuery, postType, itemCount: newsItems.length });

  const headlineIndices = newsItems.map((_, i) => String(i));

  const model = getClient().getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          post: { type: SchemaType.STRING },
          citedHeadlineIndex: {
            type: SchemaType.STRING,
            enum: headlineIndices.length > 0 ? [...headlineIndices, "none"] : ["none"],
          },
        },
        required: ["post", "citedHeadlineIndex"],
      },
    },
  });

  const prompt = [
    voiceSkill,
    "",
    postType ? `IDENTIFIED POST TYPE: ${postType}` : "",
    "RAW NOTE FROM MEERA:",
    noteText,
    newsItems.length > 0
      ? `\nCANDIDATE REAL HEADLINES (indexed). Only cite one inline if it is genuinely` +
        ` relevant to this specific note's topic - do not force a connection that isn't` +
        ` there:\n${formatNewsForPrompt(newsItems)}`
      : "",
    "",
    'Return JSON: "post" is the full LinkedIn draft (plain text paragraphs, no markdown).',
    '"citedHeadlineIndex" is the index (as a string, e.g. "0") of the candidate headline',
    'you actually referenced in the post, or "none" if none of them were relevant enough',
    "to cite.",
  ].join("\n");

  const result = await withTimeout(model.generateContent(prompt), GENERATION_TIMEOUT_MS);
  const parsed = JSON.parse(result.response.text()) as { post: string; citedHeadlineIndex: string };
  const text = parsed.post.trim();

  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  const citedIndex = parsed.citedHeadlineIndex === "none" ? null : Number(parsed.citedHeadlineIndex);
  const citedItem = citedIndex !== null ? newsItems[citedIndex] : undefined;
  // Fall back to the top search result (still topic-matched via searchQuery) if Gemini
  // didn't cite one specifically, so the link is at least on-topic, never unrelated.
  const usedItem = citedItem ?? newsItems[0];
  console.log("Draft source used", { citedIndex, usedTitle: usedItem?.title ?? null, usedLink: usedItem?.link ?? null });

  return { text, sourceLink: usedItem?.link ?? null };
}
