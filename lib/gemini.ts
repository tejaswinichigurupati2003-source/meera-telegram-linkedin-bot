import { readFileSync } from "fs";
import { join } from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getTrendingContext } from "./context";

const GENERATION_TIMEOUT_MS = 30_000;
const MODEL_NAME = "gemini-3.6-flash";

let cachedVoiceSkill: string | null = null;

function loadVoiceSkill(): string {
  if (cachedVoiceSkill) {
    return cachedVoiceSkill;
  }
  const path = join(process.cwd(), "voice-skill", "meera-voice.txt");
  cachedVoiceSkill = readFileSync(path, "utf-8");
  return cachedVoiceSkill;
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

/** Assembles the voice-skill prompt and asks Gemini to draft a LinkedIn post from the raw note. */
export async function draftLinkedInPost(noteText: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const voiceSkill = loadVoiceSkill();
  const trendingContext = await getTrendingContext(noteText);

  const prompt = [
    voiceSkill,
    "",
    "RAW NOTE FROM MEERA:",
    noteText,
    trendingContext ? `\nRELEVANT CURRENT CONTEXT:\n${trendingContext}` : "",
  ].join("\n");

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: MODEL_NAME });

  const result = await withTimeout(model.generateContent(prompt), GENERATION_TIMEOUT_MS);
  const text = result.response.text().trim();

  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return text;
}
