const RSS_TIMEOUT_MS = 8_000;
const MAX_ITEMS = 3;
const FALLBACK_QUERY = "skincare industry India";

export interface NewsItem {
  title: string;
  source: string | null;
  link: string;
  pubDate: string | null;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTag(block: string, tag: string): string | null {
  const cdataMatch = block.match(new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`));
  if (cdataMatch) {
    return decodeXmlEntities(cdataMatch[1].trim());
  }
  const plainMatch = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return plainMatch ? decodeXmlEntities(plainMatch[1].trim()) : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RSS fetch timed out after ${ms}ms`)), ms);
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

function parseRssItems(xml: string): NewsItem[] {
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

  return itemBlocks
    .map((block): NewsItem | null => {
      const rawTitle = extractTag(block, "title");
      const link = extractTag(block, "link");
      if (!rawTitle || !link) {
        return null;
      }
      const source = extractTag(block, "source");
      const pubDate = extractTag(block, "pubDate");
      // Google News suffixes titles with " - <source>"; drop it since we report source separately.
      const title = source ? rawTitle.replace(new RegExp(`\\s*-\\s*${escapeRegExp(source)}$`), "") : rawTitle;
      return { title, source, link, pubDate };
    })
    .filter((item): item is NewsItem => item !== null);
}

async function fetchNews(query: string): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;

  const res = await withTimeout(fetch(url), RSS_TIMEOUT_MS);
  if (!res.ok) {
    console.error("Google News RSS request failed", { status: res.status, query });
    return [];
  }

  const xml = await res.text();
  return parseRssItems(xml).slice(0, MAX_ITEMS);
}

/**
 * Pulls a handful of recent, real headlines from Google News RSS for a given
 * search query (a precise, topic-specific phrase - see
 * scoreNoteEligibility's searchQuery output). Tries the phrase as an exact
 * quoted match first (tightest relevance), then as loose keywords, then
 * falls back to a generic skincare-industry query so a draft still has an
 * on-topic source when nothing precise matches.
 */
export async function getTrendingNews(query: string): Promise<NewsItem[]> {
  if (!query) {
    return [];
  }

  try {
    for (const candidate of [`"${query}"`, query, FALLBACK_QUERY]) {
      const items = await fetchNews(candidate);
      if (items.length > 0) {
        console.log("News query matched", { candidate, itemCount: items.length });
        return items;
      }
    }
    return [];
  } catch (err) {
    console.error("Failed to fetch trending news", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Formats news items as a block for injection into the Gemini prompt. */
export function formatNewsForPrompt(items: NewsItem[]): string {
  return items
    .map((item) => {
      const meta = [item.source, item.pubDate].filter(Boolean).join(", ");
      return `- ${item.title}${meta ? ` (${meta})` : ""} — ${item.link}`;
    })
    .join("\n");
}
