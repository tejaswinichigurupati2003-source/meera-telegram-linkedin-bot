import { readFileSync } from "fs";
import { join } from "path";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { getTrendingContext } from "./context";

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

export interface EligibilityResult {
  eligible: boolean;
  score: number;
  postType: string | null;
  reason: string;
}

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
 * Runs the voice-skill's quality gate against a raw note: does it have a
 * checkable fact, does it map to one of the six post shapes, does it avoid
 * needing an unbacked Skinstinct claim? Scored 0-100; a flagged note gets an
 * explanation instead of a forced draft.
 */
export async function scoreNoteEligibility(noteText: string): Promise<EligibilityResult> {
  const model = getClient().getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          eligible: { type: SchemaType.BOOLEAN },
          score: { type: SchemaType.INTEGER },
          postType: { type: SchemaType.STRING, enum: [...POST_TYPES, "none"] },
          reason: { type: SchemaType.STRING },
        },
        required: ["eligible", "score", "postType", "reason"],
      },
    },
  });

  const prompt = [
    "You are gatekeeping raw Telegram notes for Meera Pillai (Skinstinct) before they",
    "become LinkedIn drafts. Apply this quality gate strictly:",
    "",
    "1. Does the note contain (or point to) a specific, checkable fact - a number, an",
    "   incident, a named mechanism? A mood or vague opinion with nothing concrete",
    "   underneath fails this.",
    "2. Does it clearly map to one of these six post shapes: " + POST_TYPES.join(", ") + "?",
    "   If it could go three directions with equal weight, it fails this.",
    "3. Would drafting it require inventing a Skinstinct product claim or a study that",
    "   isn't in the note? If yes, it fails this.",
    "",
    "Score 0-100 (0 = not postable at all, 100 = ready as-is). Treat scores below 60 as",
    "not eligible. Set postType to the single best-matching shape from the list above,",
    'or "none" if it fails the gate. reason must be one or two concrete sentences: if',
    "eligible, name the shape and the checkable fact; if not, say plainly what's",
    "missing (e.g. \"has the observation but no specific number behind it yet\").",
    "",
    "RAW NOTE:",
    noteText,
  ].join("\n");

  const result = await withTimeout(model.generateContent(prompt), GENERATION_TIMEOUT_MS);
  const parsed = JSON.parse(result.response.text()) as {
    eligible: boolean;
    score: number;
    postType: string;
    reason: string;
  };

  return {
    eligible: parsed.eligible && parsed.score >= 60,
    score: parsed.score,
    postType: parsed.postType === "none" ? null : parsed.postType,
    reason: parsed.reason,
  };
}

/** Assembles the voice-skill prompt and asks Gemini to draft a LinkedIn post from the raw note. */
export async function draftLinkedInPost(noteText: string, postType: string | null): Promise<string> {
  const voiceSkill = loadVoiceSkill();
  const trendingContext = await getTrendingContext(noteText);

  const prompt = [
    voiceSkill,
    "",
    postType ? `IDENTIFIED POST TYPE: ${postType}` : "",
    "RAW NOTE FROM MEERA:",
    noteText,
    trendingContext
      ? `\nRECENT REAL HEADLINES (ground the post in one of these if relevant, and cite it inline; otherwise ignore them):\n${trendingContext}`
      : "",
  ].join("\n");

  const model = getClient().getGenerativeModel({ model: MODEL_NAME });
  const result = await withTimeout(model.generateContent(prompt), GENERATION_TIMEOUT_MS);
  const text = result.response.text().trim();

  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return text;
}
